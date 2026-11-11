'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeChunk(stream, chunk) {
  if (!chunk || chunk.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()));
  });
}

// Captures only this Electron app with ScreenCaptureKit, then streams mono PCM
// through a WASM MP3 encoder. There is deliberately no system-loopback fallback.
class RecordingWriter {
  constructor(library) {
    this.library = library;
    this.active = null;
  }

  get isActive() {
    return this.active !== null;
  }

  async start(title, { targetPid, bundleId, onLevel = () => {}, onError = () => {} }) {
    if (this.active) throw new Error('已有一段录音正在进行');
    if (process.platform !== 'darwin') {
      throw new Error('当前版本只支持 macOS 的应用内音频采集');
    }

    const { AudioCapture } = require('screencapturekit-audio-capture');
    const { default: createMp3Encoder } = await import('@audio/encode-mp3');
    const encoder = await createMp3Encoder({
      sampleRate: 48000,
      channels: 1,
      bitrate: 128,
      stream: true,
    });
    const capture = new AudioCapture();
    const appInfo = capture.getApplicationByPid(targetPid);
    if (!appInfo || appInfo.bundleIdentifier !== bundleId) {
      capture.dispose();
      encoder.free();
      throw new Error('无法确认本应用的音频采集目标，已拒绝开始录音');
    }

    const session = this.library.create({ title });
    const file = this.library.newAudioPath(session.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stream = fs.createWriteStream(file, { flags: 'w' });
    const state = {
      id: session.id,
      file,
      stream,
      encoder,
      capture,
      bytes: 0,
      samples: 0,
      error: null,
      stopping: false,
      writeQueue: Promise.resolve(),
      onError,
      audioHandler: null,
      errorHandler: null,
    };
    this.active = state;
    stream.on('error', (err) => {
      state.error ||= err;
      if (!state.stopping) state.onError(err);
    });

    try {
      await new Promise((resolve, reject) => {
        stream.once('open', resolve);
        stream.once('error', reject);
      });
      const header = encoder.head();
      if (header && header.length) await writeChunk(stream, header);

      state.audioHandler = (sample) => {
        if (this.active !== state || state.stopping || state.error) return;
        if (sample.format !== 'float32' || sample.channels !== 1 || sample.sampleRate !== 48000) {
          state.error = new Error('系统音频格式发生变化，已停止录音以避免生成损坏文件');
          state.onError(state.error);
          return;
        }
        const pcm = new Float32Array(
          sample.data.buffer,
          sample.data.byteOffset,
          Math.floor(sample.data.byteLength / Float32Array.BYTES_PER_ELEMENT)
        );
        state.samples += pcm.length;
        const encoded = encoder.encode([pcm]);
        if (encoded && encoded.length) {
          state.writeQueue = state.writeQueue
            .then(() => writeChunk(stream, encoded))
            .then(() => { state.bytes += encoded.length; })
            .catch((err) => {
              state.error = err;
              state.onError(err);
            });
        }
        onLevel(Math.max(0, Math.min(1, Number(sample.rms) || 0)));
      };
      state.errorHandler = (err) => {
        if (!state.stopping && this.active === state) {
          state.error = err;
          state.onError(err);
        }
      };
      capture.on('audio', state.audioHandler);
      capture.on('error', state.errorHandler);

      const started = capture.startCapture(targetPid, {
        format: 'float32',
        channels: 1,
        sampleRate: 48000,
        minVolume: 0,
      });
      if (!started) throw new Error('ScreenCaptureKit 未能启动应用音频采集');
      return session;
    } catch (err) {
      this.active = null;
      try { capture.stopCapture(); } catch { /* capture may not have started */ }
      capture.dispose();
      encoder.free();
      stream.destroy();
      this.library.remove(session.id);
      throw new Error(`无法开始本应用音频录制：${err.message}`);
    }
  }

  _check(id) {
    if (!this.active || this.active.id !== id) throw new Error('这段录音已经结束或不存在');
    return this.active;
  }

  async stop(id, durationMs) {
    const state = this._check(id);
    state.stopping = true;
    this.active = null;
    state.capture.removeListener('audio', state.audioHandler);
    state.capture.removeListener('error', state.errorHandler);
    try { state.capture.stopCapture(); } catch (err) { state.error ||= err; }
    state.capture.dispose();

    await state.writeQueue;
    try {
      await writeChunk(state.stream, state.encoder.flush());
      await new Promise((resolve, reject) => {
        state.stream.once('error', reject);
        state.stream.end(resolve);
      });
      const finalHeader = state.encoder.head();
      if (finalHeader && finalHeader.length) {
        const handle = await fs.promises.open(state.file, 'r+');
        try { await handle.write(finalHeader, 0, finalHeader.length, 0); }
        finally { await handle.close(); }
      }
    } finally {
      state.encoder.free();
    }

    if (state.samples === 0) {
      this.library.remove(id);
      throw new Error('没有收到本应用的课程音频，请确认网页正在播放并重试');
    }
    const updated = this.library.update(id, {
      endedAt: new Date().toISOString(),
      durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
      bytes: fs.statSync(state.file).size,
    });
    if (state.error) throw new Error(`录音中断，已保留 MP3 文件：${state.error.message}`);
    return updated;
  }

  // On an abnormal quit, the streaming MP3 already written to disk remains usable.
  abort() {
    if (!this.active) return;
    const state = this.active;
    this.active = null;
    state.stopping = true;
    state.capture.removeListener('audio', state.audioHandler);
    state.capture.removeListener('error', state.errorHandler);
    try { state.capture.stopCapture(); } catch { /* app is exiting */ }
    state.capture.dispose();
    try { state.stream.end(); } catch { /* app is exiting */ }
    try { state.encoder.free(); } catch { /* app is exiting */ }
  }
}

module.exports = { RecordingWriter };
