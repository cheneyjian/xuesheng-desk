'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Library } = require('../src/main/library');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'xs-lib-')); }

test('创建、笔记排序、重启后仍在', () => {
  const dir = tmp();
  const lib = new Library(dir);
  const s = lib.create({ title: '  第一讲  ' });
  assert.equal(s.title, '第一讲');
  lib.addNote(s.id, { t: 9000, text: '后面的' });
  lib.addNote(s.id, { t: 1500, text: '前面的' });
  assert.deepEqual(lib.get(s.id).notes.map((n) => n.text), ['前面的', '后面的']);
  const again = new Library(dir);
  assert.equal(again.list().length, 1);
  assert.equal(again.get(s.id).notes.length, 2);
});

test('拒绝路径穿越的编号和空笔记', () => {
  const lib = new Library(tmp());
  assert.throws(() => lib.sessionDir('../../etc'), /非法/);
  assert.throws(() => lib.get('abc'), /非法/);
  const s = lib.create({ title: 'x' });
  assert.throws(() => lib.addNote(s.id, { t: 0, text: '   ' }), /不能为空/);
});

test('索引文件损坏时重新创建而不是崩溃', () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.json'), '{坏掉了');
  const lib = new Library(dir);
  assert.equal(lib.list().length, 0);
});
