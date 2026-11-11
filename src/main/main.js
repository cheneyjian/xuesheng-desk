'use strict';

const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  dialog,
  ipcMain,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Keep Electron's library/config path in sync with Chromium's profile switch.
const userDataDir = app.commandLine.getSwitchValue('user-data-dir');
if (userDataDir) app.setPath('userData', path.resolve(userDataDir));

const { loadConfig } = require('./config');
const { Library } = require('./library');
const { RecordingWriter } = require('./recorder');
const { toMarkdown, toSrt, safeFileName } = require('./exporter');
const { transcribe } = require('./asr');
const { isAllowedNavigation, isSafeExternal } = require('./urlPolicy');

const WEB_PARTITION = 'persist:xuesheng-web'; // 远程站点独占的会话，与本地面板隔离
const PANEL_HTML = path.join(__dirname, '..', 'renderer', 'panel.html');
const PANEL_URL = pathToFileURL(PANEL_HTML).href;
const PANEL_WIDTH = 420;
const WINDOW_DEFAULTS = { width: 1360, height: 900, minWidth: 980, minHeight: 700 };

let config;
let library;
let writer;
let mainWin = null;
let webView = null;
let panelView = null;
let asrBusy = false;
let recordingOrigin = null;

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function siteForUrl(url) {
  const origin = originOf(url);
  return origin && config.sites.find((site) => originOf(site.url) === origin);
}

function notifyPanel(channel, payload) {
  if (panelView && !panelView.webContents.isDestroyed()) panelView.webContents.send(channel, payload);
}

// ---------- 远程站点视图（不加载 preload，没有通往本地能力的桥） ----------

function createWebView() {
  webView = new WebContentsView({
    webPreferences: {
      partition: WEB_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  const ses = webView.webContents.session;
  // Electron 默认批准所有权限请求，这里反过来：默认全部拒绝，只放行少数无害权限
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  const wc = webView.webContents;
  const guard = (event, url) => {
    if (writer && writer.isActive && originOf(url) !== recordingOrigin) {
      event.preventDefault();
      notifyPanel('desk:siteNotice', { message: '录音期间不能切换网站，请先停止录音。' });
      return;
    }
    if (isAllowedNavigation(url, config.allowedHosts)) return;
    event.preventDefault();
    let host = '';
    try { host = new URL(url).hostname; } catch { /* 非网页协议不展示地址 */ }
    if (host) {
      notifyPanel('desk:siteNotice', {
        message: `登录跳转到 ${host}，已因安全白名单拦截。若这是学升认证页面，请将该域名加入配置文件的 allowedHosts 后重启。`,
      });
    }
    if (isSafeExternal(url)) shell.openExternal(url);
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.setWindowOpenHandler(({ url }) => {
    if (writer && writer.isActive && originOf(url) !== recordingOrigin) {
      notifyPanel('desk:siteNotice', { message: '录音期间不能切换网站，请先停止录音。' });
    } else if (isAllowedNavigation(url, config.allowedHosts)) {
      setImmediate(() => webView && webView.webContents.loadURL(url));
    } else if (isSafeExternal(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  wc.on('did-navigate', (_event, url) => {
    const site = siteForUrl(url);
    notifyPanel('desk:siteChanged', { id: site ? site.id : '' });
  });
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    let host = '';
    try { host = new URL(validatedURL).hostname; } catch { /* 保留错误描述 */ }
    notifyPanel('desk:siteNotice', {
      message: `课程网页打开失败${host ? `（${host}）` : ''}：${errorDescription}。可在“视图”菜单重新加载网页。`,
    });
  });

  wc.on('context-menu', (_event, params) => {
    if (!mainWin || mainWin.isDestroyed()) return;
    const selected = String(params.selectionText || '').trim();
    const items = [
      {
        label: '记为当前时间戳笔记',
        enabled: selected.length > 0 && writer.isActive,
        click: () => {
          if (!selected || !writer.isActive || !panelView || panelView.webContents.isDestroyed()) return;
          panelView.webContents.send('desk:webSelection', {
            text: selected.slice(0, 2000),
          });
        },
      },
    ];
    if (params.isEditable) {
      items.push({ type: 'separator' });
      items.push({ label: '剪切', role: 'cut', enabled: params.editFlags.canCut });
      items.push({ label: '复制', role: 'copy', enabled: params.editFlags.canCopy });
      items.push({ label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste });
      items.push({ label: '全选', role: 'selectAll' });
    } else if (params.editFlags.canCopy) {
      items.push({ type: 'separator' });
      items.push({ label: '复制', role: 'copy' });
    }
    Menu.buildFromTemplate(items).popup({ window: mainWin });
  });

  wc.loadURL(config.startUrl);
}

// ---------- 本地侧边面板（录音、笔记、导出都在这里） ----------

function createPanelView() {
  panelView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'panel.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  panelView.webContents.loadURL(PANEL_URL);
}

function layoutViews() {
  if (!mainWin || mainWin.isDestroyed() || !webView || !panelView) return;
  const { width, height } = mainWin.getContentBounds();
  const panelWidth = Math.min(PANEL_WIDTH, Math.max(320, width - 560));
  webView.setBounds({ x: 0, y: 0, width: Math.max(0, width - panelWidth), height });
  panelView.setBounds({ x: width - panelWidth, y: 0, width: panelWidth, height });
}

function createWorkspaceWindow() {
  const configuredWidth = Number(config.webWindow && config.webWindow.width);
  const configuredHeight = Number(config.webWindow && config.webWindow.height);
  mainWin = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    width: Number.isFinite(configuredWidth) && configuredWidth >= WINDOW_DEFAULTS.minWidth
      ? configuredWidth
      : WINDOW_DEFAULTS.width,
    height: Number.isFinite(configuredHeight) && configuredHeight >= WINDOW_DEFAULTS.minHeight
      ? configuredHeight
      : WINDOW_DEFAULTS.height,
    title: '学升桌面版',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  createWebView();
  createPanelView();
  mainWin.contentView.addChildView(webView);
  mainWin.contentView.addChildView(panelView);
  layoutViews();
  mainWin.on('resize', layoutViews);

  mainWin.on('close', (event) => {
    if (!writer.isActive) return;
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: 'warning',
      buttons: ['继续录音', '放弃并关闭'],
      defaultId: 0,
      cancelId: 0,
      message: '正在录音',
      detail: '现在关闭会中断这段录音（已写入磁盘的部分会保留）。',
    });
    if (choice === 0) event.preventDefault();
  });
  mainWin.on('closed', () => {
    writer.abort();
    recordingOrigin = null;
    for (const view of [webView, panelView]) {
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
    }
    mainWin = null;
    webView = null;
    panelView = null;
  });
}

// ---------- IPC：每个处理器都校验调用方就是本地面板 ----------

function handle(channel, fn) {
  ipcMain.handle(`desk:${channel}`, async (event, ...args) => {
    const url = event.senderFrame && event.senderFrame.url;
    if (url !== PANEL_URL) throw new Error('拒绝：调用方不是本地面板');
    return fn(...args);
  });
}

function registerIpc() {
  handle('sites', () => ({
    sites: config.sites.map(({ id, name, url, recordAudio }) => ({ id, name, url, recordAudio })),
    currentId: siteForUrl(webView && webView.webContents.getURL())?.id || '',
  }));
  handle('navigateSite', async (id) => {
    if (writer.isActive) throw new Error('录音期间不能切换网站，请先停止录音');
    const site = config.sites.find((candidate) => candidate.id === String(id));
    if (!site || !isAllowedNavigation(site.url, config.allowedHosts)) {
      throw new Error('这个固定网站不在允许列表中');
    }
    await webView.webContents.loadURL(site.url);
    return { id: site.id };
  });

  handle('courses', () => library.data.courses.map((course) => ({
    ...course, lessons: course.lessons.map((lesson) => ({ ...lesson })),
  })));
  handle('createCourse', (title) => library.createCourse(title));
  handle('createLesson', (courseId, title) => {
    const currentUrl = webView && webView.webContents.getURL();
    const site = currentUrl && siteForUrl(currentUrl);
    if (!site) throw new Error('请先打开固定网站，再创建关联课时');
    return library.createLesson(String(courseId || ''), {
      title, siteId: site.id, sourceUrl: currentUrl,
    });
  });

  handle('recStart', async (title, courseId, lessonId) => {
    const currentUrl = webView && webView.webContents.getURL();
    const site = currentUrl && siteForUrl(currentUrl);
    if (!currentUrl || !isAllowedNavigation(currentUrl, config.allowedHosts) || !site || !site.recordAudio) {
      throw new Error('当前网站不允许录音，请切换到学升课程网站后再开始');
    }
    const lesson = library.getLesson(String(courseId || ''), String(lessonId || ''));
    if (lesson.siteId !== site.id || originOf(lesson.sourceUrl) !== originOf(currentUrl)) {
      throw new Error('所选课时关联了其他网站，请切换到该网站或新建课时');
    }
    recordingOrigin = originOf(currentUrl);
    try {
      return await writer.start(String(title || ''), {
        sourceWebContents: webView.webContents,
        courseId: String(courseId),
        lessonId: String(lessonId),
        siteId: site.id,
        sourceUrl: currentUrl,
        onLevel: (rms) => {
          if (panelView && !panelView.webContents.isDestroyed()) {
            panelView.webContents.send('desk:audioLevel', { rms });
          }
        },
        onError: (err) => {
          if (panelView && !panelView.webContents.isDestroyed()) {
            panelView.webContents.send('desk:recError', { message: err.message });
          }
        },
      });
    } catch (err) {
      recordingOrigin = null;
      throw err;
    }
  });
  handle('recStop', async (id, durationMs) => {
    try { return await writer.stop(id, durationMs); }
    finally { recordingOrigin = null; }
  });
  handle('addNote', (id, t, text) => library.addNote(id, { t, text }));
  handle('list', () => library.list());
  handle('saveTranscript', (id, segments) => {
    if (!Array.isArray(segments) || segments.length > 100000) throw new Error('转写稿格式无效');
    const clean = [];
    for (const segment of segments) {
      if (!segment || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start) {
        throw new Error('转写稿时间戳无效');
      }
      const text = String(segment.text || '').trim().slice(0, 2000);
      if (text) clean.push({ start: Math.round(segment.start), end: Math.round(segment.end), text });
    }
    return library.setTranscript(String(id), clean);
  });
  handle('audioUrl', (id) => pathToFileURL(library.audioPath(String(id))).href);

  handle('reveal', (id) => {
    shell.showItemInFolder(library.audioPath(id));
  });

  handle('export', async (id, kind) => {
    const s = library.get(id);
    const base = safeFileName(s.title);
    const kinds = {
      md: { ext: 'md', name: 'Markdown', build: () => toMarkdown(s) },
      srt: { ext: 'srt', name: '字幕', build: () => toSrt(s.transcript) },
      audio: { ext: library.audioExtension(id), name: '音频', build: null },
    };
    const k = kinds[kind];
    if (!k) throw new Error('不支持的导出类型');
    const content = k.build ? k.build() : null; // 先构建，缺文字稿时直接报错，不弹对话框

    const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
      defaultPath: path.join(app.getPath('documents'), `${base}.${k.ext}`),
      filters: [{ name: k.name, extensions: [k.ext] }],
    });
    if (canceled || !filePath) return { canceled: true };
    if (content === null) fs.copyFileSync(library.audioPath(id), filePath);
    else fs.writeFileSync(filePath, content);
    return { saved: filePath };
  });

  handle('asr', async (id) => {
    if (asrBusy) throw new Error('已有转写任务在进行');
    if (writer.isActive && writer.active.id === id) throw new Error('这段录音还在进行，请先停止');
    const s = library.get(id);
    const audioPath = library.audioPath(id);
    if (!fs.existsSync(audioPath)) throw new Error('找不到音频文件');

    asrBusy = true;
    const send = (message) => {
      if (panelView && !panelView.webContents.isDestroyed()) panelView.webContents.send('desk:asrStatus', { id, message });
    };
    try {
      send('转写中，长音频可能需要较长时间……');
      const segments = await transcribe({
        command: config.asr.command,
        args: config.asr.args,
        timeoutMs: (config.asr.timeoutMin || 120) * 60000,
        audioPath,
        outPath: path.join(library.sessionDir(id), 'transcript.raw.json'),
        appRoot: app.isPackaged ? process.resourcesPath : app.getAppPath(),
      });
      library.setTranscript(id, segments);
      send(`转写完成，共 ${segments.length} 句`);
      return { count: segments.length, title: s.title };
    } finally {
      asrBusy = false;
    }
  });
}

// ---------- 菜单与生命周期 ----------

function buildMenu() {
  const userData = app.getPath('userData');
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { label: '重新加载网页', accelerator: 'CmdOrCtrl+R', click: () => webView && webView.webContents.reload() },
        { label: '回到首页', click: () => webView && webView.webContents.loadURL(config.startUrl) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '工具',
      submenu: [
        { label: '打开资料库文件夹', click: () => shell.openPath(path.join(userData, 'library')) },
        { label: '打开配置文件', click: () => shell.openPath(path.join(userData, 'config.json')) },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindows() {
  createWorkspaceWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    config = loadConfig(path.join(userData, 'config.json'));
    library = new Library(path.join(userData, 'library'));
    writer = new RecordingWriter(library);
    registerIpc();
    buildMenu();
    createWindows();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindows();
    });
  });

  app.on('before-quit', () => {
    if (writer) writer.abort();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
