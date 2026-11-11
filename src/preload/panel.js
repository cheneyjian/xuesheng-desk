'use strict';

// 只暴露窄接口；所有参数都是基本类型或 ArrayBuffer，主进程会再次校验。
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(`desk:${channel}`, ...args);

contextBridge.exposeInMainWorld('desk', {
  sites: () => call('sites'),
  navigateSite: (id) => call('navigateSite', String(id || '')),
  recStart: (title, courseId, lessonId) => call('recStart', String(title || ''), String(courseId || ''), String(lessonId || '')),
  recStop: (id, durationMs) => call('recStop', String(id), Number(durationMs) || 0),
  addNote: (id, t, text) => call('addNote', String(id), Number(t) || 0, String(text || '')),
  list: () => call('list'),
  courses: () => call('courses'),
  createCourse: (title) => call('createCourse', String(title || '')),
  createLesson: (courseId, title) => call('createLesson', String(courseId || ''), String(title || '')),
  saveTranscript: (id, segments) => call('saveTranscript', String(id), segments),
  audioUrl: (id) => call('audioUrl', String(id)),
  reveal: (id) => call('reveal', String(id)),
  exportFile: (id, kind) => call('export', String(id), String(kind)),
  runAsr: (id) => call('asr', String(id)),
  onAsrStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desk:asrStatus', handler);
    return () => ipcRenderer.removeListener('desk:asrStatus', handler);
  },
  onWebSelection: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desk:webSelection', handler);
    return () => ipcRenderer.removeListener('desk:webSelection', handler);
  },
  onAudioLevel: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desk:audioLevel', handler);
    return () => ipcRenderer.removeListener('desk:audioLevel', handler);
  },
  onRecError: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desk:recError', handler);
    return () => ipcRenderer.removeListener('desk:recError', handler);
  },
  onSiteChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desk:siteChanged', handler);
    return () => ipcRenderer.removeListener('desk:siteChanged', handler);
  },
  onSiteNotice: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desk:siteNotice', handler);
    return () => ipcRenderer.removeListener('desk:siteNotice', handler);
  },
});
