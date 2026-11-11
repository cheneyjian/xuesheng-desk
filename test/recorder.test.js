'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Library } = require('../src/main/library');
const { RecordingWriter } = require('../src/main/recorder');

function setup() {
  const library = new Library(fs.mkdtempSync(path.join(os.tmpdir(), 'xs-rec-')));
  let send;
  const capture = {
    start: async (_source, handlers) => { send = handlers.onAudio; },
    stop: async () => { if (send) await send(pcm(0.25)); },
    dispose() {},
    emit: (...args) => send(...args),
  };
  const writer = new RecordingWriter(library, { createCapture: () => capture });
  const sourceWebContents = { isDestroyed: () => false };
  return { library, writer, capture, sourceWebContents };
}

function pcm(value, count = 4800) {
  const samples = new Float32Array(count).fill(value);
  return { pcm: samples.buffer, sampleRate: 48000 };
}

test('录制目标网页 PCM 并保存为非空 MP3，停止时刷入尾块和时长', async () => {
  const { library, writer, capture, sourceWebContents } = setup();
  const session = await writer.start('测试网页', { sourceWebContents });
  await capture.emit(pcm(0.1));
  const saved = await writer.stop(session.id, 12345.6);
  const file = library.audioPath(session.id);
  assert.equal(path.extname(file), '.mp3');
  assert.ok(fs.statSync(file).size > 1000);
  assert.equal(saved.durationMs, 12346);
  assert.equal(saved.bytes, fs.statSync(file).size);
  assert.equal(writer.isActive, false);
});

test('同时只能录一个网页，结束后拒绝追加', async () => {
  const { writer, capture, sourceWebContents } = setup();
  const session = await writer.start('第一段', { sourceWebContents });
  await assert.rejects(writer.start('第二段', { sourceWebContents }), /已有一段录音/);
  await writer.stop(session.id, 1);
  await assert.rejects(capture.emit(pcm(0.1)), /已经结束/);
});

test('拒绝错误网页 PCM 参数且没有音频时移除空 MP3', async () => {
  const { writer, capture, sourceWebContents } = setup();
  let notified;
  const session = await writer.start('坏数据测试', { sourceWebContents, onError: error => { notified = error; } });
  await assert.rejects(capture.emit({ pcm: new ArrayBuffer(8), sampleRate: 44100 }), /格式无效/);
  assert.match(notified.message, /格式无效/);
  await assert.rejects(writer.stop(session.id, 100), /没有收到课程网页音轨/);
  assert.equal(fs.existsSync(writer.library.audioPath(session.id)), false);
});

test('网页音轨启动失败时删除未开始的空录音并释放 reservation', async () => {
  const library = new Library(fs.mkdtempSync(path.join(os.tmpdir(), 'xs-rec-')));
  const writer = new RecordingWriter(library, { createCapture: () => ({ start: async () => { throw new Error('权限拒绝'); }, dispose() {} }) });
  await assert.rejects(writer.start('失败', { sourceWebContents: { isDestroyed: () => false } }), /权限拒绝/);
  assert.equal(writer.isActive, false);
  assert.equal(library.list().length, 0);
});
