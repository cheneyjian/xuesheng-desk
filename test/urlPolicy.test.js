'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedNavigation, isSafeExternal } = require('../src/main/urlPolicy');

const hosts = ['webapp.songy.info'];

test('允许白名单域名及其子域名', () => {
  assert.equal(isAllowedNavigation('https://webapp.songy.info/#/home', hosts), true);
  assert.equal(isAllowedNavigation('https://a.webapp.songy.info/x', hosts), true);
});

test('拒绝仿冒域名、非 https、非法地址', () => {
  assert.equal(isAllowedNavigation('https://webapp.songy.info.evil.com/', hosts), false);
  assert.equal(isAllowedNavigation('https://evilwebapp.songy.info/', hosts), false);
  assert.equal(isAllowedNavigation('http://webapp.songy.info/', hosts), false);
  assert.equal(isAllowedNavigation('file:///etc/passwd', hosts), false);
  assert.equal(isAllowedNavigation('not a url', hosts), false);
});

test('只把 https 链接交给系统浏览器', () => {
  assert.equal(isSafeExternal('https://example.com/a'), true);
  assert.equal(isSafeExternal('file:///Applications'), false);
  assert.equal(isSafeExternal('javascript:alert(1)'), false);
  assert.equal(isSafeExternal('x-apple.systempreferences:foo'), false);
});
