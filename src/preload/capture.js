'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const prefix = '--desk-capture-token=';
const token = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
if (!token) throw new Error('缺少录音通道');

contextBridge.exposeInMainWorld('captureTransport', {
  push: (pcm, sampleRate) => ipcRenderer.invoke(`desk:capture:${token}:pcm`, { pcm, sampleRate }),
  fail: (message) => ipcRenderer.send(`desk:capture:${token}:error`, String(message)),
});
