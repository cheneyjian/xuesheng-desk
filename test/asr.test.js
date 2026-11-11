'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transcribe, fillArgs, normalize } = require('../src/main/asr');

function fixture(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-asr-'));
  const file = path.join(dir, 'fake.js');
  fs.writeFileSync(file, script);
  return { dir, file, out: path.join(dir, 'out.json') };
}

test('占位符替换，未知占位符保持原样', () => {
  assert.deepEqual(fillArgs(['{app}/x', '{audio}', '{nope}'], { app: '/A', audio: '/a.webm' }), [
    '/A/x',
    '/a.webm',
    '{nope}',
  ]);
});

test('结果规整：秒转毫秒，丢掉空句', () => {
  const segs = normalize({ segments: [{ start: 1.5, end: 2.25, text: ' 你好 ' }, { start: 3, end: 4, text: '  ' }] });
  assert.deepEqual(segs, [{ start: 1500, end: 2250, text: '你好' }]);
  assert.throws(() => normalize({ segments: [] }), /为空/);
});

test('接入符合约定的外部命令', async () => {
  const f = fixture(`
    const fs = require('fs');
    const out = process.argv[process.argv.indexOf('--out') + 1];
    fs.writeFileSync(out, JSON.stringify({ segments: [{ start: 0.5, end: 1, text: '测试' }] }));
  `);
  const segs = await transcribe({
    command: process.execPath,
    args: [f.file, '--audio', '{audio}', '--out', '{out}'],
    audioPath: '/dev/null',
    outPath: f.out,
    appRoot: f.dir,
  });
  assert.deepEqual(segs, [{ start: 500, end: 1000, text: '测试' }]);
});

test('命令失败时带出末尾报错信息', async () => {
  const f = fixture(`console.error('缺少模型'); process.exit(3);`);
  await assert.rejects(
    transcribe({ command: process.execPath, args: [f.file], audioPath: 'x', outPath: f.out, appRoot: f.dir }),
    /退出码 3.*缺少模型/
  );
});

test('命令不存在、未配置、超时都给出可读错误', async () => {
  await assert.rejects(
    transcribe({ command: '/不存在/命令', args: [], audioPath: 'x', outPath: '/tmp/x', appRoot: '/' }),
    /无法启动/
  );
  await assert.rejects(transcribe({ command: null }), /还没有配置/);
  const f = fixture(`setTimeout(() => {}, 60000);`);
  await assert.rejects(
    transcribe({ command: process.execPath, args: [f.file], timeoutMs: 300, audioPath: 'x', outPath: f.out, appRoot: f.dir }),
    /超时/
  );
});
