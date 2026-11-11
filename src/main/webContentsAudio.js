'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const CAPTURE_HTML = path.join(__dirname, '..', 'renderer', 'capture.html');
const CAPTURE_URL = pathToFileURL(CAPTURE_HTML).href;

// Chromium tab capture binds the audio source to one WebContents, before the
// operating system mixes output from applications. No system-loopback fallback.
class WebContentsAudioCapture {
  async start(sourceWebContents, { onAudio, onError }) {
    const { BrowserWindow, ipcMain, session } = require('electron');
    if (!sourceWebContents || sourceWebContents.isDestroyed()) throw new Error('课程网页已关闭');
    this.source = sourceWebContents;
    this.onError = onError;
    this.token = crypto.randomUUID();
    this.pcmChannel = `desk:capture:${this.token}:pcm`;
    this.errorChannel = `desk:capture:${this.token}:error`;
    this.ipcMain = ipcMain;
    this.stopping = false;
    const captureSession = session.fromPartition(`desk-capture-${this.token}`);
    this.window = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      webPreferences: {
        session: captureSession,
        preload: path.join(__dirname, '..', 'preload', 'capture.js'),
        additionalArguments: [`--desk-capture-token=${this.token}`],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    const consumer = this.window.webContents;
    const isConsumer = (wc) => wc === consumer && !consumer.isDestroyed() && consumer.getURL() === CAPTURE_URL;
    // Hardware media permission remains denied; only the trusted local recorder
    // may request this application's explicitly selected tab stream.
    captureSession.setPermissionCheckHandler((wc, permission) => isConsumer(wc) && permission === 'display-capture');
    captureSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      // Electron 39 reports display capture as "media" with no hardware types.
      // Camera/microphone requests contain video/audio types and stay denied.
      const tabRequest = permission === 'display-capture' ||
        (permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0);
      callback(isConsumer(wc) && tabRequest);
    });
    captureSession.setDisplayMediaRequestHandler((request, callback) => {
      if (!isConsumer(consumer) || request.frame !== consumer.mainFrame || this.stopping || sourceWebContents.isDestroyed()) {
        callback({});
        return;
      }
      const frame = sourceWebContents.mainFrame;
      callback({ video: frame, audio: frame, enableLocalEcho: true });
    }, { useSystemPicker: false });
    consumer.setWindowOpenHandler(() => ({ action: 'deny' }));
    consumer.on('will-navigate', event => event.preventDefault());

    const checkSender = (event) => {
      if (!isConsumer(event.sender) || event.senderFrame !== consumer.mainFrame) throw new Error('拒绝非录音页面的音频数据');
    };
    ipcMain.handle(this.pcmChannel, async (event, packet) => {
      checkSender(event);
      await onAudio(packet);
    });
    this.errorHandler = (event, message) => {
      try { checkSender(event); } catch { return; }
      this.fail(new Error(String(message || '网页音轨已中断').slice(0, 300)));
    };
    ipcMain.on(this.errorChannel, this.errorHandler);
    this.sourceClosed = () => this.fail(new Error('课程网页已关闭，录音已停止'));
    this.sourceNavigated = (_event, _url, isSameDocument, isMainFrame) => {
      if (isMainFrame && !isSameDocument) this.fail(new Error('课程网页已重新加载，录音已停止'));
    };
    this.sourceCrashed = () => this.fail(new Error('课程网页进程已退出'));
    sourceWebContents.once('destroyed', this.sourceClosed);
    sourceWebContents.on('did-start-navigation', this.sourceNavigated);
    sourceWebContents.once('render-process-gone', this.sourceCrashed);
    consumer.once('render-process-gone', () => this.fail(new Error('录音进程已退出')));
    try {
      await this.window.loadFile(CAPTURE_HTML);
      let timeout;
      try {
        const result = await Promise.race([
          consumer.executeJavaScript('window.tabAudioCapture.start().then(() => ({ ok: true }), error => ({ ok: false, message: `${error.name}: ${error.message}` }))', true),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('等待网页音轨超时')), 10000); }),
        ]);
        if (!result.ok) throw new Error(result.message);
      } finally { clearTimeout(timeout); }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  fail(error) {
    if (this.stopping || this.failed) return;
    this.failed = true;
    this.onError(error);
  }

  async stop() {
    this.stopping = true;
    try {
      if (this.window && !this.window.isDestroyed() && !this.window.webContents.isCrashed()) {
        let timeout;
        try {
          await Promise.race([
            this.window.webContents.executeJavaScript('window.tabAudioCapture.stop()'),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('等待网页音频写入完成超时')), 5000); }),
          ]);
        } finally { clearTimeout(timeout); }
      }
    } finally { this.dispose(); }
  }

  dispose() {
    this.stopping = true;
    if (this.source) {
      if (this.sourceClosed) this.source.removeListener('destroyed', this.sourceClosed);
      if (this.sourceNavigated) this.source.removeListener('did-start-navigation', this.sourceNavigated);
      if (this.sourceCrashed) this.source.removeListener('render-process-gone', this.sourceCrashed);
      this.source = null;
    }
    if (this.ipcMain) {
      if (this.pcmChannel) this.ipcMain.removeHandler(this.pcmChannel);
      if (this.errorChannel && this.errorHandler) this.ipcMain.removeListener(this.errorChannel, this.errorHandler);
      this.ipcMain = null;
    }
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { WebContentsAudioCapture };
