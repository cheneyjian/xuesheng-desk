'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatClock, srtTime, toSrt, toMarkdown, safeFileName } = require('../src/main/exporter');

test('时间格式', () => {
  assert.equal(formatClock(59000), '00:59');
  assert.equal(formatClock(3723000), '1:02:03');
  assert.equal(formatClock(-5), '00:00');
  assert.equal(srtTime(3723456), '01:02:03,456');
});

test('SRT：缺结束时间时用下一句开始时间补', () => {
  const srt = toSrt([
    { start: 1000, end: 0, text: '第一句' },
    { start: 4000, end: 6500, text: '第二句' },
  ]);
  assert.match(srt, /1\n00:00:01,000 --> 00:00:04,000\n第一句/);
  assert.match(srt, /2\n00:00:04,000 --> 00:00:06,500\n第二句/);
});

test('SRT：没有文字稿时报错', () => {
  assert.throws(() => toSrt(null), /先转写/);
  assert.throws(() => toSrt([]), /先转写/);
});

test('Markdown 含笔记与文字稿，缺文字稿时有占位', () => {
  const base = {
    title: '第 3 讲',
    createdAt: '2026-10-23T10:00:00.000Z',
    durationMs: 65000,
    notes: [{ t: 12000, text: '重点：边界' }],
    transcript: null,
  };
  const md = toMarkdown(base, { timeZone: 'UTC' });
  assert.match(md, /^# 第 3 讲/);
  assert.match(md, /时长：01:05/);
  assert.match(md, /- \[00:12\] 重点：边界/);
  assert.match(md, /（尚未转写）/);

  const withText = toMarkdown({ ...base, transcript: [{ start: 3000, end: 5000, text: '大家好' }] }, { timeZone: 'UTC' });
  assert.match(withText, /\[00:03\] 大家好/);
  assert.doesNotMatch(withText, /尚未转写/);
});

test('文件名清洗', () => {
  assert.equal(safeFileName('a/b:c*?"<>|d'), 'a_b_c______d');
  assert.equal(safeFileName('   '), '未命名课程');
});
