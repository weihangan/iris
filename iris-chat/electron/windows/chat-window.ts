// Chat 窗口工厂
// 职责：创建标准 BrowserWindow 加载聊天页面，使用 chat-preload
// 发布模式：加载 Express 服务的 chat5.2 完整 UI（http://localhost:3013/）
//   - 复用 chat5.2 的完整设置面板（API/人物/声音/克隆/历史）
//   - chat-preload 注入 window.chatx2 API（桌宠模式切换、模型管理）
//   - start.bat 已确保 Express 服务先启动，但仍需重试应对启动延迟
// 开发模式：加载 Vite dev server（src/index.html，HMR 调试）
import { BrowserWindow, app } from 'electron';
import { join, resolve } from 'node:path';

const EXPRESS_URL = 'http://localhost:3013/';
const EXPRESS_LOAD_MAX_RETRIES = 8;
const EXPRESS_LOAD_RETRY_INTERVAL_MS = 1000;

async function loadExpressUIWithRetry(win: BrowserWindow): Promise<boolean> {
  for (let attempt = 1; attempt <= EXPRESS_LOAD_MAX_RETRIES; attempt++) {
    try {
      await win.loadURL(EXPRESS_URL);
      console.log(`[chat-window] Express UI loaded on attempt ${attempt}`);
      return true;
    } catch (err) {
      console.warn(`[chat-window] Express UI load attempt ${attempt}/${EXPRESS_LOAD_MAX_RETRIES} failed:`, (err as Error).message);
      if (attempt < EXPRESS_LOAD_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, EXPRESS_LOAD_RETRY_INTERVAL_MS));
      }
    }
  }
  return false;
}

export function createChatWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: '伊利斯 ChatX2',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, 'chat-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const isTest = process.env.NODE_ENV === 'test';
  const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;
  if (isTest) {
    const rendererPath = resolve(__dirname, '..', 'renderer', 'index.html');
    void win.loadFile(rendererPath);
  } else if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // 发布模式：加载 Express 服务的 chat5.2 完整 UI
    // start.bat 先启动 Express（等待 3s），再启动 Electron
    // 此处重试以应对 Express 启动较慢的情况
    loadExpressUIWithRetry(win).then(loaded => {
      if (!loaded) {
        console.error('[chat-window] Express UI failed to load after retries, falling back to local renderer');
        const rendererPath = resolve(__dirname, '..', 'renderer', 'index.html');
        win.loadFile(rendererPath).catch(e => {
          console.error('[chat-window] Fallback renderer also failed:', e);
        });
      }
    });
  }

  return win;
}
