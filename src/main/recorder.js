'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeChunk(stream, chunk) {
  if (!chunk || chunk.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve());
  });
}

// Encode only the PCM supplied by the selected WebContents capture. Audio is
// streamed to disk so a long course does not accumulate in renderer memory.
class RecordingWriter {
  constructor(library, { createCapture } = {}) {
    this.library = library;
    this.createCapture = createCapture || (() => {
      const { WebContentsAudioCapture } = require('./webContentsAudio');
      return new WebContentsAudioCapture();
    });
    this.active = null;
  }

  get isActive() { return this.active !== null; }

  async start(title, { sourceWebContents, courseId = null, lessonId = null, siteId = null, sourceUrl = null, onLevel = () => {}, onError = () => {} } = {}) {
    if (this.active) throw new Error('已有一段录音正在进行');
    if (!sourceWebContents || sourceWebContents.isDestroyed()) throw new Error('请先打开有效的课程网页');
    const state = {
      id: null, stream: null, encoder: null, capture: null,
      samples: 0, error: null, stopping: false, closed: false,
      writeQueue: Promise.resolve(), onError, onLevel,
    };
    // Reserve before the first await, including encoder and capture startup.
    this.active = state;
    try {
      const { default: createMp3Encoder } = await import('@audio/encode-mp3');
      state.encoder = await createMp3Encoder({ sampleRate: 48000, channels: 1, bitrate: 128, stream: true });
      const recording = this.library.create({ title, courseId, lessonId, siteId, sourceUrl });
      state.id = recording.id;
      state.file = this.library.newAudioPath(recording.id);
      fs.mkdirSync(path.dirname(state.file), { recursive: true });
      state.stream = fs.createWriteStream(state.file, { flags: 'w' });
      state.stream.on('error', error => this._fail(state, error));
      await new Promise((resolve, reject) => {
        state.stream.once('open', resolve);
        state.stream.once('error', reject);
      });
      await writeChunk(state.stream, state.encoder.head());
      state.capture = this.createCapture();
      await state.capture.start(sourceWebContents, {
        onAudio: packet => this._append(state, packet),
        onError: error => this._fail(state, error),
      });
      if (state.error) throw state.error;
      return recording;
    } catch (error) {
      this.active = null;
      state.closed = true;
      if (state.capture) state.capture.dispose();
      if (state.encoder) state.encoder.free();
      if (state.stream) state.stream.destroy();
      if (state.id) this.library.remove(state.id);
      throw new Error(`无法开始课程网页录音：${error.message || String(error)}`);
    }
  }

  _fail(state, error) {
    if (state.error) return;
    state.error = error;
    if (!state.stopping && !state.closed) state.onError(error);
  }

  async _append(state, packet) {
    if (this.active !== state || state.closed) throw new Error('这段录音已经结束或不存在');
    if (state.error) throw state.error;
    const buffer = packet && packet.pcm;
    if (!(buffer instanceof ArrayBuffer) || packet.sampleRate !== 48000 || buffer.byteLength === 0 || buffer.byteLength % 4 !== 0 || buffer.byteLength > 48000 * 4) {
      const error = new Error('网页音频数据格式无效，已停止录音');
      this._fail(state, error);
      throw error;
    }
    const pcm = new Float32Array(buffer);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      if (!Number.isFinite(pcm[i])) {
        const error = new Error('网页音频包含无效采样，已停止录音');
        this._fail(state, error);
        throw error;
      }
      pcm[i] = Math.max(-1, Math.min(1, pcm[i]));
      sum += pcm[i] * pcm[i];
    }
    state.samples += pcm.length;
    const encoded = state.encoder.encode([pcm]);
    state.writeQueue = state.writeQueue.then(() => writeChunk(state.stream, encoded));
    // Keep the queue rejection handled even if a renderer exits mid-request.
    state.writeQueue.catch(error => this._fail(state, error));
    await state.writeQueue;
    state.onLevel(Math.sqrt(sum / pcm.length));
  }

  _check(id) {
    if (!this.active || this.active.id !== id) throw new Error('这段录音已经结束或不存在');
    return this.active;
  }

  async stop(id, durationMs) {
    const state = this._check(id);
    if (state.stopping) throw new Error('录音正在保存');
    state.stopping = true;
    try { await state.capture.stop(); } catch (error) { this._fail(state, error); }
    // capture.stop flushes the last partial PCM packet before returning.
    state.closed = true;
    try {
      await state.writeQueue;
      await writeChunk(state.stream, state.encoder.flush());
      await new Promise((resolve, reject) => {
        state.stream.once('error', reject);
        state.stream.end(resolve);
      });
      const header = state.encoder.head();
      if (header && header.length) {
        const handle = await fs.promises.open(state.file, 'r+');
        try { await handle.write(header, 0, header.length, 0); }
        finally { await handle.close(); }
      }
      if (state.samples === 0) {
        this.library.remove(id);
        throw new Error('没有收到课程网页音轨，请确认网页正在播放并重试');
      }
      const updated = this.library.update(id, {
        endedAt: new Date().toISOString(),
        durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
        bytes: fs.statSync(state.file).size,
      });
      if (state.error) throw new Error(`录音中断，已保留 MP3 文件：${state.error.message}`);
      return updated;
    } catch (error) {
      if (state.stream && !state.stream.destroyed) state.stream.destroy();
      throw error;
    } finally {
      state.encoder.free();
      this.active = null;
    }
  }

  abort() {
    const state = this.active;
    if (!state) return;
    this.active = null;
    state.stopping = true;
    state.closed = true;
    if (state.capture) state.capture.dispose();
    if (state.stream) state.writeQueue.catch(() => {}).finally(() => state.stream.end());
    if (state.encoder) state.encoder.free();
  }
}

module.exports = { RecordingWriter };
