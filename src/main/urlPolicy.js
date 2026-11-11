'use strict';

// 导航白名单：远程内容窗口只能停留在这些域名上，其余一律交给系统浏览器。

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hostAllowed(host, allowedHosts) {
  const h = host.toLowerCase();
  return allowedHosts.some((a) => {
    const x = String(a).toLowerCase();
    return h === x || h.endsWith('.' + x);
  });
}

function isAllowedNavigation(url, allowedHosts) {
  const u = parse(url);
  if (!u || u.protocol !== 'https:') return false;
  return hostAllowed(u.hostname, allowedHosts);
}

// 只允许把 https 链接交给系统浏览器，避免远程页面诱导打开 file:、自定义协议等
function isSafeExternal(url) {
  const u = parse(url);
  return !!u && u.protocol === 'https:';
}

module.exports = { isAllowedNavigation, isSafeExternal, hostAllowed };
