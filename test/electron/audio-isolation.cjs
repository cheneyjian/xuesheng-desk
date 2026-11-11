'use strict';

// Runs the production recording pipeline against two real browser audio sources.
// A third tone plays through afplay, outside this Electron app on macOS.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Library } = require('../../src/main/library');
const { RecordingWriter } = require('../../src/main/recorder');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-tab-audio-'));
app.setPath('userData', path.join(root, 'profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let writer;
let server;
let external;
const windows = [];

function makeWav(file, frequency, seconds = 4) {
  const count = 48000 * seconds;
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) wav.writeInt16LE(Math.round(0.025 * 32767 * Math.sin(2 * Math.PI * frequency * i / 48000)), 44 + i * 2);
  fs.writeFileSync(file, wav);
}

function amplitude(pcm, frequency) {
  let re = 0; let im = 0;
  // The fixture tones are stable; skip startup and encoder delay.
  const offset = Math.min(48000, Math.floor(pcm.length / 4));
  const count = Math.min(96000, pcm.length - offset);
  for (let i = 0; i < count; i++) {
    const angle = 2 * Math.PI * frequency * i / 48000;
    re += pcm[offset + i] * Math.cos(angle);
    im += pcm[offset + i] * Math.sin(angle);
  }
  return 2 * Math.hypot(re, im) / count;
}

function decode(file) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'], { maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return new Float32Array(Uint8Array.from(result.stdout).buffer);
}

async function waitForAudio(wc) {
  const deadline = Date.now() + 7000;
  while (!wc.isCurrentlyAudible() && Date.now() < deadline) await delay(100);
  assert.equal(wc.isCurrentlyAudible(), true, '测试网页必须真实发声');
}

async function record(source, title) {
  let captureError;
  const recording = await writer.start(title, {
    sourceWebContents: source,
    onError: (error) => { captureError = error; },
  });
  await delay(4200);
  assert.ifError(captureError);
  const saved = await writer.stop(recording.id, 4200);
  const file = writer.library.audioPath(saved.id);
  assert.equal(path.extname(file), '.mp3');
  return { file, pcm: decode(file), saved };
}

app.whenReady().then(async () => {
  try {
    const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/audio-tone.html'));
    server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(fixture); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const siteSession = session.fromPartition(`tone-${Date.now()}`);
    siteSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    siteSession.setPermissionCheckHandler(() => false);
    for (const frequency of [440, 660]) {
      const win = new BrowserWindow({ width: 580, height: 220, webPreferences: { session: siteSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      windows.push(win);
      await win.loadURL(`${origin}/?frequency=${frequency}`);
      assert.equal(await win.webContents.executeJavaScript('window.ready'), 'running');
      await waitForAudio(win.webContents);
    }
    const mic = await windows[0].webContents.executeJavaScript('navigator.mediaDevices.getUserMedia({audio:true}).then(() => "GRANTED", e => e.name)');
    assert.equal(mic, 'NotAllowedError', '网页麦克风访问必须被拒绝');
    writer = new RecordingWriter(new Library(path.join(root, 'library')));
    if (process.platform === 'darwin') {
      const wav = path.join(root, 'external-880.wav');
      makeWav(wav, 880);
      external = spawn('/usr/bin/afplay', [wav]);
    }
    const first = await record(windows[0].webContents, '440 Hz 目标网页');
    const levels = Object.fromEntries([440, 660, 880].map(f => [f, amplitude(first.pcm, f)]));
    assert.ok(levels[440] > 0.005, `目标网页未录到：${JSON.stringify(levels)}`);
    assert.ok(levels[660] < levels[440] / 100, `串入同应用另一网页：${JSON.stringify(levels)}`);
    assert.ok(levels[880] < levels[440] / 100, `串入外部进程音频：${JSON.stringify(levels)}`);
    if (external) { assert.equal(external.exitCode, 0, '外部测试音必须完整播放'); external = null; }
    const second = await record(windows[1].webContents, '660 Hz 切换录音目标');
    const secondLevels = Object.fromEntries([440, 660].map(f => [f, amplitude(second.pcm, f)]));
    assert.ok(secondLevels[660] > 0.005, '切换网页后应录到新目标');
    assert.ok(secondLevels[440] < secondLevels[660] / 100, '切换网页后不得继续录旧目标');
    const result = { passed: true, root, microphone: mic, first: { file: first.file, samples: first.pcm.length, levels }, second: { file: second.file, samples: second.pcm.length, levels: secondLevels } };
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    console.error(`验收资料保留在 ${root}`);
    app.exit(1);
  } finally {
    if (writer) writer.abort();
    if (external && external.exitCode === null) external.kill();
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    if (server) server.close();
  }
});

setTimeout(() => { console.error('音频隔离验收超时'); app.exit(1); }, 30000).unref();
