'use strict';

/**
 * DeepSeek Harness 本地桌面客户端主进程。
 *
 * 职责：
 *  1. 内嵌启动 DSH 后端（dsh web --port <port>），通过 ELECTRON_RUN_AS_NODE
 *     把当前 Electron 可执行文件当 Node 用，不依赖系统 PATH 上的 node。
 *  2. 若 127.0.0.1:3080 已有一个可用的 DSH Web 实例，则直接复用（可在设置关闭）。
 *  3. 轮询后端就绪后，把原生窗口导航到本地界面。
 *  4. 后端崩溃自动重启（退避重试），托盘常驻，退出时清理整个进程树。
 *  5. 设置面板（托盘/设置窗口）、系统通知、开机自启、dsh 版本检测。
 */

const {
  app,
  BrowserWindow,
  dialog,
  shell,
  Tray,
  Menu,
  Notification,
  ipcMain,
} = require('electron');
const { spawn, execFile } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const settingsStore = require('./settings-store');

const APP_TITLE = 'DeepSeek Harness';
const APP_ROOT = path.join(__dirname, '..');
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const PROBE_COUNT = 40; // 从 portStart 向后探测的端口数
const MAX_RESTARTS = 5; // 后端连续崩溃自动重启上限
const RESTART_BACKOFF_MS = 5000;
const STABILITY_RESET_MS = 120_000; // 稳定运行 2 分钟后重置重启计数
const VERSION_CHECK_URL = 'https://registry.npmmirror.com/@deepseek-ai%2Fdsh';

let userData = null;
let settings = { ...settingsStore.DEFAULTS };
let mainWindow = null;
let settingsWindow = null;
let tray = null;
let dshChild = null;
let backendUrl = null;
let backendReady = false;
let backendPlan = null; // { bin, port }
let logStream = null;
let quitting = false;
let restartCount = 0;
let lastRestartAt = 0;
let trayHintShown = false;
let localDshVersion = null;
let latestDshVersion = null;
let dshVersionChecked = false;

// ---------------------------------------------------------------- helpers

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { process.stdout.write(line + '\n'); } catch { /* ignore */ }
  if (logStream) {
    try { logStream.write(line + '\n'); } catch { /* ignore */ }
  }
}

function tail(buf, max) {
  const s = String(buf || '');
  return s.length > max ? '…' + s.slice(-max) : s;
}

function resolveDshBin() {
  const candidates = [
    path.join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    return require.resolve('@deepseek-ai/dsh/lib/bin.js');
  } catch {
    return null;
  }
}

function readLocalDshVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        'utf8'
      )
    );
    return pkg.version || null;
  } catch {
    return null;
  }
}

/** 探测某个端口是否空闲；返回 true 表示可以绑定。 */
function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findFreePort() {
  const start = settings.portStart;
  for (let i = 0; i < PROBE_COUNT; i++) {
    if (await probePort(start + i)) return start + i;
  }
  return null;
}

/** 探测 3080 是否已经是一个可用的 DSH Web 实例（避免重复起后端）。 */
function isDshWebAlive(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(false);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 64 * 1024) { req.destroy(); resolve(false); }
      });
      res.on('end', () => {
        resolve(body.includes('__DSH_BOOT__') || body.includes('dsh'));
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 轮询后端直到可访问。 */
function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (quitting) return resolve(false);
      if (Date.now() > deadline) return resolve(false);
      const req = http.get(url, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => setTimeout(tick, POLL_INTERVAL_MS));
      req.on('timeout', () => { req.destroy(); setTimeout(tick, POLL_INTERVAL_MS); });
    };
    tick();
  });
}

function notify(title, body) {
  if (!settings.notifications) return;
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, icon: path.join(APP_ROOT, 'assets', 'icon.png') }).show();
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- backend

function spawnBackend(bin, port) {
  logLine(`spawning backend: ${process.execPath} (as node) --expose-internals ${bin} web --port ${port}`);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  // cordis-plugin-hmr / loader 需要 node 以 --expose-internals 启动
  dshChild = spawn(
    process.execPath,
    ['--expose-internals', bin, 'web', '--port', String(port)],
    {
      cwd: APP_ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let outBuf = '';
  dshChild.stdout.on('data', (d) => {
    outBuf += d;
    logLine('[backend] ' + String(d).trim());
  });
  dshChild.stderr.on('data', (d) => {
    outBuf += d;
    logLine('[backend:err] ' + String(d).trim());
  });
  dshChild.on('exit', (code, signal) => onBackendExit(code, signal, outBuf));
}

function onBackendExit(code, signal, outBuf) {
  logLine(`backend exited code=${code} signal=${signal}`);
  if (quitting || !backendPlan) return;
  backendReady = false;

  // 稳定运行过一段时间后再崩溃，视为新一轮故障，重置计数
  const now = Date.now();
  if (now - lastRestartAt > STABILITY_RESET_MS) restartCount = 0;
  lastRestartAt = now;
  restartCount += 1;

  if (restartCount <= MAX_RESTARTS) {
    const n = restartCount;
    logLine(`scheduling backend restart (attempt ${n}/${MAX_RESTARTS}) in ${RESTART_BACKOFF_MS}ms`);
    sendStatus(`后端已退出（code ${code}），${RESTART_BACKOFF_MS / 1000}s 后自动重启（第 ${n} 次）…`);
    notify('DSH 后端已退出', `正在自动重启（第 ${n} 次）…`);
    // 窗口回到加载页，展示重启状态
    if (mainWindow && !mainWindow.isDestroyed() && backendUrl) {
      mainWindow.loadFile(path.join(__dirname, 'loading.html'));
    }
    setTimeout(() => {
      startBackend().catch((err) =>
        showFatal(err && err.message ? err.message : String(err))
      );
    }, RESTART_BACKOFF_MS);
  } else {
    showFatal(
      `DSH 后端异常退出（code ${code}${signal ? ', signal ' + signal : ''}），` +
        `已自动重启 ${MAX_RESTARTS} 次仍失败。\n\n最近日志：\n${tail(outBuf, 1200)}`
    );
  }
}

async function startBackend() {
  const bin = resolveDshBin();
  if (!bin) throw new Error('未找到 @deepseek-ai/dsh 安装，请先在项目目录执行 npm install');
  const port = await findFreePort();
  if (!port) {
    throw new Error(
      `找不到可用端口（${settings.portStart}-${settings.portStart + PROBE_COUNT - 1} 均被占用）`
    );
  }
  backendPlan = { bin, port };
  const url = `http://127.0.0.1:${port}`;
  sendStatus(`正在启动 DSH 后端（端口 ${port}）…`);
  spawnBackend(bin, port);

  const ok = await waitForReady(url, READY_TIMEOUT_MS);
  if (!ok) throw new Error(`后端启动超时（${READY_TIMEOUT_MS / 1000}s 内未就绪）`);
  backendReady = true;
  logLine(`backend ready at ${url}`);
  openBackend(url);
  // 稳定运行一段时间后，重置自动重启计数
  setTimeout(() => {
    if (backendReady) restartCount = 0;
  }, STABILITY_RESET_MS);
}

function stopBackend() {
  quitting = true;
  const child = dshChild;
  dshChild = null;
  if (child && child.pid) {
    logLine(`stopping backend pid=${child.pid}`);
    try {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
  }
  if (logStream) {
    try { logStream.end(); } catch { /* ignore */ }
    logStream = null;
  }
}

// ---------------------------------------------------------------- window / tray

function sendStatus(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', text);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: APP_TITLE,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 外部链接交给系统浏览器；窗口内只允许本地后端导航。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (backendUrl && url.startsWith(backendUrl)) {
      mainWindow.loadURL(url);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (backendUrl && !url.startsWith(backendUrl)) event.preventDefault();
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (backendUrl && url.startsWith(backendUrl) && code !== -3) {
      sendStatus(`界面加载失败（${code}: ${desc}）`);
    }
  });

  // 关闭到托盘（可设置关闭）
  mainWindow.on('close', (e) => {
    if (!quitting && settings.closeBehavior === 'tray') {
      e.preventDefault();
      mainWindow.hide();
      if (!trayHintShown) {
        trayHintShown = true;
        notify('DeepSeek Harness 仍在后台运行', '已最小化到系统托盘，点击托盘图标恢复窗口');
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(path.join(APP_ROOT, 'assets', 'icon-16.png'));
  tray.setToolTip(APP_TITLE);
  rebuildTrayMenu();
  tray.on('click', showMainWindow); // 左键单击显示窗口
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      {
        label: '在浏览器中打开',
        enabled: !!backendUrl,
        click: () => { if (backendUrl) shell.openExternal(backendUrl); },
      },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: settings.autoLaunch,
        click: (item) => applySettings({ autoLaunch: item.checked }),
      },
      {
        label: '系统通知',
        type: 'checkbox',
        checked: settings.notifications,
        click: (item) => applySettings({ notifications: item.checked }),
      },
      { label: '设置…', click: openSettingsWindow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function openBackend(url) {
  backendUrl = url;
  if (tray) tray.setToolTip(`${APP_TITLE} — ${url}`);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitle(`${APP_TITLE} — ${url}`);
  sendStatus('服务已就绪，正在打开界面…');
  mainWindow.loadURL(url);
}

function showFatal(message) {
  logLine('FATAL: ' + message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendStatus(message);
  } else {
    dialog.showErrorBox(APP_TITLE, message);
  }
}

// ---------------------------------------------------------------- settings window / ipc

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 400,
    height: 480,
    title: '设置 — ' + APP_TITLE,
    autoHideMenuBar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#0d1117',
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function applySettings(patch) {
  settings = settingsStore.save(userData, { ...settings, ...patch });
  applyAutoLaunch();
  rebuildTrayMenu();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('version', {
      local: localDshVersion,
      latest: latestDshVersion,
    });
  }
  return { ...settings };
}

function applyAutoLaunch() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.autoLaunch });
  } catch (err) {
    logLine('setLoginItemSettings failed: ' + (err && err.message));
  }
}

function registerIpc() {
  ipcMain.handle('settings:get', () => ({ ...settings }));
  ipcMain.handle('settings:set', (_e, patch) => applySettings(patch));
  ipcMain.handle('status:get', () => ({
    backendUrl,
    backendReady,
    localDshVersion,
    latestDshVersion,
    dshVersionChecked,
  }));
}

// ---------------------------------------------------------------- version check

async function checkDshUpdate() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(VERSION_CHECK_URL, {
      signal: ctl.signal,
      headers: { accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return;
    const data = await res.json();
    latestDshVersion = (data['dist-tags'] && data['dist-tags'].latest) || null;
    dshVersionChecked = true;
    logLine(`dsh version: local=${localDshVersion} latest=${latestDshVersion}`);
    if (latestDshVersion && localDshVersion && latestDshVersion !== localDshVersion) {
      notify('DSH 内核有新版本', `${localDshVersion} → ${latestDshVersion}`);
      if (tray) tray.setToolTip(`${APP_TITLE} — DSH 新版本 ${latestDshVersion}`);
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('version', {
        local: localDshVersion,
        latest: latestDshVersion,
      });
    }
  } catch (err) {
    logLine('version check failed: ' + (err && err.message));
  }
}

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    checkDshUpdate(); // 网络检查，失败静默

    // 复用已有实例（可在设置关闭；DSH_DESKTOP_REUSE=0 强制独立实例）
    if (settings.reuseExisting && process.env.DSH_DESKTOP_REUSE !== '0') {
      const existing = await isDshWebAlive('http://127.0.0.1:3080');
      if (existing) {
        logLine('reusing existing DSH web instance at :3080');
        sendStatus('检测到已运行的 DSH 实例，正在连接…');
        openBackend('http://127.0.0.1:3080');
        return;
      }
    }

    await startBackend();
  } catch (err) {
    showFatal(err && err.message ? err.message : String(err));
  }
}

// ---------------------------------------------------------------- lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.dsh.desktop');

  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    userData = app.getPath('userData');
    settings = settingsStore.load(userData);
    localDshVersion = readLocalDshVersion();
    applyAutoLaunch();
    try {
      fs.mkdirSync(userData, { recursive: true });
      logStream = fs.createWriteStream(path.join(userData, 'dsh-backend.log'), { flags: 'a' });
    } catch { /* 日志写不了也不阻塞启动 */ }
    registerIpc();
    createWindow();
    createTray();
    boot();
  });

  app.on('window-all-closed', () => {
    if (settings.closeBehavior !== 'tray') app.quit();
  });

  app.on('before-quit', () => {
    stopBackend();
  });
}
