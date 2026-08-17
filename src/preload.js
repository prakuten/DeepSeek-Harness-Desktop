'use strict';

// 最小化 preload：只暴露启动状态事件与设置读写，不开放任何 Node 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // loading 页：后端启动状态
  onStatus: (callback) => {
    ipcRenderer.on('status', (_event, text) => callback(text));
  },
  // 设置面板
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getStatus: () => ipcRenderer.invoke('status:get'),
  onVersion: (callback) => {
    ipcRenderer.on('version', (_event, info) => callback(info));
  },
});
