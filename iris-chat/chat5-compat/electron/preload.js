// preload.js — 在隔离上下文中向渲染进程暴露窗口控制 API + TTS 设备切换 API
// chat5.2gpu GPU 专用版（与 chat4.2 一致，仅暴露窗口控制 + TTS 状态查询）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // 窗口控制
  min: () => ipcRenderer.send('win-min'),
  max: () => ipcRenderer.send('win-max'),
  close: () => ipcRenderer.send('win-close'),
  // TTS 设备切换（GPU 版固定 gpu，restartTTS 仅返回当前设备，不实际切换）
  restartTTS: (device) => ipcRenderer.invoke('tts-restart', device),
  getTTSStatus: () => ipcRenderer.invoke('tts-status'),
});
