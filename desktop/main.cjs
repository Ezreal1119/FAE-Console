const { app, BrowserWindow, dialog, Menu, session } = require('electron');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const workspace = new URL('https://fae-work-console.patrick-shenzhen.cn/');
const desktopTheme = readFileSync(path.join(__dirname, 'classic.css'), 'utf8');
const isMac = process.platform === 'darwin';
let mainWindow;

function isWorkspace(url) {
  return URL.parse(url)?.origin === workspace.origin;
}

async function loadWorkspace(window) {
  while (!window.isDestroyed()) {
    try {
      await window.loadURL(workspace.href);
      return;
    } catch {
      if (window.isDestroyed()) return;
      const { response } = await dialog.showMessageBox(window, {
        type: 'error',
        title: '工程小管家',
        message: '无法连接工作台',
        detail: '请检查网络连接，然后重试。',
        buttons: ['重试', '关闭'],
        defaultId: 0,
        cancelId: 1
      });
      if (response !== 0 && !window.isDestroyed()) window.close();
    }
  }
}

function createWindow() {
  const workspaceSession = session.fromPartition('persist:fae-console');
  workspaceSession.setPermissionCheckHandler(() => false);
  workspaceSession.setPermissionRequestHandler((_contents, _permission, decide) => decide(false));
  workspaceSession.webRequest.onBeforeRequest(({ resourceType, url }, decide) => {
    decide({ cancel: resourceType === 'mainFrame' && !isWorkspace(url) });
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    title: '工程小管家 · 研发工程部任务管理系统',
    backgroundColor: '#f7f8fa',
    webPreferences: {
      session: workspaceSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = window;
  window.on('closed', () => { mainWindow = undefined; });

  const contents = window.webContents;
  const keepWorkspace = (event, destination) => {
    if (!isWorkspace(event.url ?? destination)) event.preventDefault();
  };
  contents.on('will-navigate', keepWorkspace);
  contents.on('will-frame-navigate', keepWorkspace);
  contents.on('will-redirect', keepWorkspace);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  contents.on('dom-ready', () => {
    if (isWorkspace(contents.getURL())) {
      contents.insertCSS(desktopTheme).catch(error => {
        if (!contents.isDestroyed()) console.warn('桌面样式加载失败：', error.message);
      });
    }
  });

  void loadWorkspace(window);
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (!mainWindow) {
      if (isMac && app.isReady()) createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    const menu = isMac ? Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu', label: '编辑' },
      { role: 'viewMenu', label: '显示' },
      { role: 'windowMenu', label: '窗口' }
    ]) : null;
    Menu.setApplicationMenu(menu);
    createWindow();
    app.on('activate', () => {
      if (!mainWindow) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
} else {
  app.quit();
}
