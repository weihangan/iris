// Desktop Composer 窗口工厂
// 职责：创建小型无边框输入栏窗口，位于屏幕底部居中
// 使用 composer-preload（无 signalAvatarReady/transition 权限）
// Composer 使用 screen-saver 级别 alwaysOnTop，确保始终在所有窗口（包括 Avatar）前面
import { BrowserWindow, screen, app } from 'electron';
import { join, resolve } from 'node:path';
import { getDesktopComposerBounds } from './desktop-composer-layout';

export function createDesktopComposerWindow(_avatarBounds?: { x: number; y: number; width: number; height: number }): BrowserWindow {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const bounds = getDesktopComposerBounds({ width: screenW, height: screenH });

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: bounds.minWidth,
    minHeight: bounds.minHeight,
    maxWidth: bounds.maxWidth,
    maxHeight: bounds.maxHeight,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    resizable: true,
    // modal-panel 级别：高于默认 floating 级别，确保 Composer 始终在 Avatar 和其他窗口前面
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: 'ChatX2-Composer',
    webPreferences: {
      preload: join(__dirname, 'composer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // 使用 screen-saver 级别确保 Composer 始终在最前面（高于 Avatar 的 floating 级别）
  win.setAlwaysOnTop(true, 'screen-saver');

  const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;
  if (isDev) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL!}/composer.html`);
  } else {
    const rendererPath = resolve(__dirname, '..', 'renderer', 'composer.html');
    win.loadFile(rendererPath);
  }

  return win;
}
