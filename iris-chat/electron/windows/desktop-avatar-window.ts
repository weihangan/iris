// Desktop Avatar 窗口工厂
// 职责：创建透明、无边框、全屏的桌宠窗口
// 窗口全屏覆盖整个工作区，模型在窗口内渲染，拖动移动的是模型而非窗口
// 使用 avatar-preload（只有此窗口有 signalAvatarReady 权限）
import { BrowserWindow, screen, app } from 'electron';
import { join, resolve } from 'node:path';

export function createDesktopAvatarWindow(): BrowserWindow {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workArea;

  const win = new BrowserWindow({
    width: screenW,
    height: screenH,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000', // 显式设置透明背景，消除 Windows DWM 边框/阴影
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: 'ChatX2-Avatar',
    // 防止 Chromium 在窗口隐藏时挂起 AudioContext，确保聊天模式下的口型/动作联动
    webPreferences: {
      preload: join(__dirname, 'avatar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 允许隐藏窗口继续播放音频（驱动口型同步）
      backgroundThrottling: false
    }
  });

  // 显式二次设置透明背景，防止 Windows DWM 在某些情况下忽略构造参数
  win.setBackgroundColor('#00000000');

  // 使用 screen-saver 级别确保置顶生效，与 toggle-always-on-top IPC 保持一致
  win.setAlwaysOnTop(true, 'screen-saver');

  // 默认 forward 穿透模式（2026-07-29 最终版）：
  //   setIgnoreMouseEvents(true, { forward: true })
  //   - 模型外透明区域：自动穿透（桌面可点击）
  //   - 模型区域（命中canvas）：不穿透（可拖拽交互）
  //   渲染进程启动后会再通过 IPC 重新设置一次，确保状态一致。
  try {
    win.setIgnoreMouseEvents(true, { forward: true });
  } catch (e) {
    // Electron 旧版本兼容：忽略 forward 参数不支持的情况
    try { win.setIgnoreMouseEvents(true, { forward: true } as any); } catch {}
  }

  const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;
  if (isDev) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL!}/desktop-avatar.html`);
  } else {
    const rendererPath = resolve(__dirname, '..', 'renderer', 'desktop-avatar.html');
    win.loadFile(rendererPath);
  }

  return win;
}