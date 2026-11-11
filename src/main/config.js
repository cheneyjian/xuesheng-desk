'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isAllowedNavigation } = require('./urlPolicy');

const DEFAULTS = {
  startUrl: 'https://webapp.songy.info/#/home',
  sites: [
    { id: 'xuesheng', name: '学升课程', url: 'https://webapp.songy.info/#/home', recordAudio: true },
  ],
  // 登录若会跳转到其他域名（统一登录、微信等），把域名加到这里
  // 学升当前网页登录流程会经过微信 OAuth 与 Mixin OAuth，再回到学升。
  allowedHosts: ['webapp.songy.info', 'open.weixin.qq.com', 'mixin-oauth.songy.info'],
  // 桌面工作区默认尺寸；左侧课程网页与右侧本地面板同窗显示
  webWindow: { width: 1360, height: 900 },
  // 转写引擎：外部命令，约定见 README。{audio} {out} {app} 会被替换
  asr: {
    command: 'python3',
    args: ['{app}/tools/funasr_transcribe.py', '--audio', '{audio}', '--out', '{out}'],
    timeoutMin: 120,
  },
};

function loadConfig(file) {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n');
    } else {
      console.warn('[config] 配置文件无法解析，使用默认值：', err.message);
    }
  }

  const cfg = {
    ...DEFAULTS,
    ...user,
    webWindow: { ...DEFAULTS.webWindow, ...(user.webWindow || {}) },
    asr: { ...DEFAULTS.asr, ...(user.asr || {}) },
  };

  const sourceSites = Array.isArray(user.sites) ? user.sites : DEFAULTS.sites;
  cfg.sites = sourceSites
    .map((site) => {
      if (!site || typeof site !== 'object') return null;
      const id = String(site.id || '').trim();
      const name = String(site.name || '').trim().slice(0, 40);
      let url;
      try { url = new URL(String(site.url || '')); } catch { return null; }
      if (!/^[a-z0-9-]{1,40}$/i.test(id) || !name || url.protocol !== 'https:') return null;
      return {
        id,
        name,
        url: url.href,
        host: url.hostname.toLowerCase(),
        recordAudio: site.recordAudio === true,
      };
    })
    .filter(Boolean)
    .filter((site, index, list) => list.findIndex((candidate) => candidate.id === site.id) === index);

  if (cfg.sites.length === 0) cfg.sites = DEFAULTS.sites.map((site) => ({ ...site, host: new URL(site.url).hostname }));

  if (!Array.isArray(cfg.allowedHosts) || cfg.allowedHosts.length === 0) {
    cfg.allowedHosts = [...DEFAULTS.allowedHosts];
  }
  cfg.allowedHosts = [...new Set([
    ...DEFAULTS.allowedHosts,
    ...cfg.allowedHosts.map((host) => String(host).toLowerCase()),
    ...cfg.sites.map((site) => site.host),
  ])];
  // 起始地址的域名必然是允许的
  try {
    const host = new URL(cfg.startUrl).hostname;
    if (!isAllowedNavigation(cfg.startUrl, cfg.allowedHosts)) cfg.allowedHosts.push(host);
  } catch {
    cfg.startUrl = DEFAULTS.startUrl;
  }
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };
