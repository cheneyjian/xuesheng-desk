'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/main/config');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xs-cfg-')), 'config.json');
}

test('首次运行写出默认配置', () => {
  const file = tmpFile();
  const cfg = loadConfig(file);
  assert.equal(cfg.startUrl, 'https://webapp.songy.info/#/home');
  assert.ok(fs.existsSync(file));
});

test('用户配置只覆盖指定项，嵌套项合并', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ allowedHosts: ['a.com'], webWindow: { width: 600 }, asr: { timeoutMin: 5 } }));
  const cfg = loadConfig(file);
  assert.equal(cfg.webWindow.width, 600);
  assert.equal(cfg.webWindow.height, 900);
  assert.equal(cfg.asr.timeoutMin, 5);
  assert.equal(cfg.asr.command, 'python3');
  // 起始地址的域名自动加入白名单
  assert.ok(cfg.allowedHosts.includes('webapp.songy.info'));
  assert.ok(cfg.allowedHosts.includes('a.com'));
});

test('旧版自定义白名单仍自动包含学升登录认证域名', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ allowedHosts: ['custom.example'] }));
  const cfg = loadConfig(file);
  assert.ok(cfg.allowedHosts.includes('open.weixin.qq.com'));
  assert.ok(cfg.allowedHosts.includes('mixin-oauth.songy.info'));
  assert.ok(cfg.allowedHosts.includes('custom.example'));
});

test('配置文件损坏时回退到默认值', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{坏');
  const cfg = loadConfig(file);
  assert.equal(cfg.startUrl, 'https://webapp.songy.info/#/home');
  assert.ok(cfg.webWindow.width > 0);
  assert.ok(Array.isArray(cfg.allowedHosts));
});
