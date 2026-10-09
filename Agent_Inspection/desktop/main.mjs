import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { buildUiIfNeeded, buildUiUrl, redactToken, towerHome } from '../scripts/waystation.mjs';
import { DesktopRuntime, requestDaemon, verifyNode } from './runtime.mjs';
import { daemonEnvironment, effectivePaths, PATH_KEYS, readSettings, validatePreferences, writeSettings } from './settings.mjs';
import { AttentionTracker, externalUrl, isStationUrl, trustedSender } from './security.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = resolve(towerHome());
mkdirSync(join(home, 'desktop-profile'), { recursive: true });
app.setName('Waystation');
app.setPath('userData', join(home, 'desktop-profile'));
app.setAppUserModelId('Waystation.Desktop');

let settings = readSettings(home);
let mainWindow;
let tray;
let runtime;
let nodeVersion;
let stationOrigin;
let socket;
let reconnectTimer;
let finalQuit = false;
let quitPromise;
let connecting = false;
let notice;
let status = 'Starting Waystation';

function stationIcon() {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const dx = x - 15.5, dy = y - 15.5;
    const ring = Math.abs(Math.hypot(dx / 14, (dy + dx * 0.35) / 4.5) - 1) < 0.16;
    const planet = Math.hypot(dx, dy) < 9;
    const dot = Math.hypot(x - 24, y - 5) < 2.5;
    const color = dot ? [208, 138, 89] : ring ? [243, 224, 192] : planet ? [128, 97, 135] : undefined;
    if (color) { const offset = (y * size + x) * 4; pixels[offset] = color[2]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[0]; pixels[offset + 3] = 255; }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}

function showWindow(destination) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (destination && stationOrigin) mainWindow.webContents.send('desktop:navigate', destination);
}

function updateTray(summary) {
  if (!tray) return;
  status = summary ? `${summary.busy} working · ${summary.attention} need attention · ${summary.approvals} approvals` : status;
  tray.setToolTip(`Waystation — ${status}`.slice(0, 127));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Waystation', click: () => showWindow() },
    { label: 'Needs attention', enabled: Boolean(stationOrigin), click: () => showWindow('attention') },
    { type: 'separator' },
    { label: 'Desktop setup', enabled: Boolean(stationOrigin), click: () => showWindow('setup') },
    { label: 'Attention notifications', type: 'checkbox', checked: settings.notifications, click: (item) => {
      settings.notifications = item.checked;
      writeSettings(home, settings);
      updateTray();
    } },
    { type: 'separator' },
    { label: 'Quit Waystation', click: () => app.quit() },
  ]));
}

function persistWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  settings.window = { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
  try { writeSettings(home, settings); } catch (error) { console.error('Could not save window preferences:', redactToken(error.message)); }
}

function createWindow() {
  const display = screen.getPrimaryDisplay().workArea;
  const saved = settings.window;
  const width = Math.min(saved.width, display.width);
  const height = Math.min(saved.height, display.height);
  // Restore only if the window still intersects a connected display.
  const position = Number.isInteger(saved.x) && Number.isInteger(saved.y)
    && screen.getAllDisplays().some(({ workArea: area }) => saved.x + width > area.x + 80 && saved.x < area.x + area.width - 80 && saved.y >= area.y && saved.y < area.y + area.height - 80)
    ? { x: saved.x, y: saved.y } : {};
  mainWindow = new BrowserWindow({
    width, height, ...position, minWidth: Math.min(900, display.width), minHeight: Math.min(620, display.height),
    title: 'Waystation', icon: stationIcon(), backgroundColor: '#fffcf5', show: false,
    webPreferences: { preload: join(projectRoot, 'desktop', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  mainWindow.once('ready-to-show', () => { if (saved.maximized) mainWindow.maximize(); if (process.env.WAYSTATION_DESKTOP_HIDDEN !== '1') mainWindow.show(); });
  mainWindow.on('close', (event) => {
    persistWindow();
    if (!finalQuit && tray) { event.preventDefault(); mainWindow.hide(); }
  });
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) mainWindow.on(event, persistWindow);
  mainWindow.on('page-title-updated', (event) => { event.preventDefault(); });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (stationOrigin && isStationUrl(url, stationOrigin)) return;
    event.preventDefault();
    const external = externalUrl(url);
    if (external) void shell.openExternal(external).catch(() => undefined);
  });
  mainWindow.webContents.on('will-redirect', (event, url) => { if (!stationOrigin || !isStationUrl(url, stationOrigin)) event.preventDefault(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url);
    if (external) void shell.openExternal(external).catch(() => undefined);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const session = mainWindow.webContents.session;
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.on('render-process-gone', () => {
    if (!finalQuit) void recover('The station window stopped responding. The daemon is still running.', true);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Waystation', submenu: [
      { label: 'Desktop setup', accelerator: 'CmdOrCtrl+,', click: () => showWindow('setup') },
      { label: 'Hide to tray', click: () => mainWindow.hide() }, { type: 'separator' },
      { label: 'Quit Waystation', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'toggleDevTools' }] },
  ]));
}

function closeFeed() {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (socket) { socket.removeAllListeners(); socket.on('error', () => {}); socket.terminate(); socket = undefined; }
}

function attentionFeed(info) {
  closeFeed();
  const tracker = new AttentionTracker();
  let agents = [], pending = [];
  const connect = () => {
    if (finalQuit || connecting || runtime?.info !== info) return;
    const feed = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, ['agent-tower', info.token], { maxPayload: 8 * 1024 * 1024 });
    socket = feed;
    feed.on('error', () => {});
    feed.on('close', () => {
      status = 'Disconnected — reconnecting'; updateTray();
      if (!finalQuit && !connecting && runtime?.info === info) reconnectTimer = setTimeout(connect, 2000);
    });
    feed.on('message', (data) => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.type === 'snapshot') { agents = message.agents ?? []; pending = message.pending ?? []; }
      else if (message.type === 'agents') agents = message.agents ?? [];
      else if (message.type === 'pending') pending = message.pending ?? [];
      else return;
      const summary = tracker.update(agents, pending);
      updateTray(summary);
      if (summary.raised && settings.notifications && Notification.isSupported()) {
        notice?.close();
        notice = new Notification({ title: 'Waystation needs your attention', body: 'An agent needs input, a tool decision, or a guard review. Open the station to respond.', icon: stationIcon() });
        notice.on('click', () => showWindow('attention'));
        notice.on('error', () => {});
        notice.show();
      }
    });
  };
  connect();
}

function preferences() {
  return { ...settings, home, effectivePaths: effectivePaths(settings), nodeVersion, ownsDaemon: runtime?.owned ?? false, version: app.getVersion(), notificationsSupported: Notification.isSupported() };
}

function registerBridge() {
  const handle = (channel, action) => ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event, mainWindow, stationOrigin)) throw new Error('This action is only available inside the Waystation window.');
    return action(...args);
  });
  handle('desktop:settings', () => preferences());
  handle('desktop:choose-path', async (kind) => {
    const choices = {
      project: { title: 'Choose a project folder', properties: ['openDirectory'] },
      claudeHome: { title: 'Choose the Claude session folder', properties: ['openDirectory'] },
      codexHome: { title: 'Choose the Codex session folder', properties: ['openDirectory'] },
      claudeExe: { title: 'Choose Claude Code', properties: ['openFile'], filters: [{ name: 'Executables', extensions: ['exe'] }] },
      codexJs: { title: 'Choose the Codex JavaScript entry', properties: ['openFile'], filters: [{ name: 'JavaScript', extensions: ['js', 'mjs'] }] },
    };
    if (typeof kind !== 'string' || !Object.hasOwn(choices, kind)) throw new Error('That kind of path cannot be selected.');
    const result = await dialog.showOpenDialog(mainWindow, choices[kind]);
    return result.canceled ? undefined : result.filePaths[0];
  });
  handle('desktop:save-settings', async (raw) => {
    if (connecting || quitPromise) throw new Error('Waystation is restarting or shutting down. Try again when it is ready.');
    const next = validatePreferences(raw);
    const pathsChanged = PATH_KEYS.some((key) => settings.paths[key] !== next.paths[key]);
    if (pathsChanged) {
      if (!runtime.owned) throw new Error('These paths belong to a daemon started in a terminal. Stop that daemon, then reopen the desktop app to configure it.');
      const state = await requestDaemon(runtime.info, '/api/state');
      if (state.agents.some((agent) => (agent.tier === 'A' || agent.managed || agent.inTerminal) && agent.status !== 'stopped') || state.pending.length) {
        throw new Error('Stop agents launched by Waystation and resolve held approvals before changing session paths.');
      }
    }
    settings = { ...settings, ...next };
    writeSettings(home, settings);
    updateTray();
    if (pathsChanged) setImmediate(() => { void connectStation(true).catch((error) => recover(error.message)); });
    return preferences();
  });
}

async function connectStation(restart = false) {
  if (connecting) return;
  connecting = true;
  stationOrigin = undefined;
  closeFeed();
  try {
    await mainWindow.loadFile(join(projectRoot, 'desktop', 'status.html'));
    if (restart) await runtime.stop();
    nodeVersion = verifyNode(process.env.WAYSTATION_NODE);
    status = 'Building the station'; updateTray();
    mainWindow.webContents.send('desktop:status', 'Preparing your workspace. The first build may take a moment.');
    await buildUiIfNeeded(process.env.WAYSTATION_NODE);
    if (!runtime || restart) runtime = new DesktopRuntime({ projectRoot, nodePath: process.env.WAYSTATION_NODE, home, env: daemonEnvironment(settings) });
    runtime.onExit = () => {
      closeFeed(); status = 'Daemon stopped'; updateTray();
      void recover('The Waystation daemon stopped. Restart it to reconnect your station.');
    };
    status = 'Connecting to your agents'; updateTray();
    mainWindow.webContents.send('desktop:status', 'Starting your local daemon and checking its connection.');
    const info = await runtime.start();
    stationOrigin = `http://127.0.0.1:${info.port}`;
    await mainWindow.loadURL(buildUiUrl({ ...info, dev: false }));
    status = 'Connected'; updateTray();
    connecting = false;
    attentionFeed(info);
  } finally { connecting = false; }
}

async function recover(message, replaceWindow = false) {
  if (finalQuit || quitPromise) return;
  showWindow();
  const result = await dialog.showMessageBox(mainWindow, { type: 'error', title: 'Waystation could not connect', message: redactToken(message), detail: 'Your saved data is kept. Check the terminal output or docs/desktop.md for setup and recovery steps.', buttons: ['Try again', 'Quit Waystation'], defaultId: 0, cancelId: 1 });
  if (result.response === 0) {
    if (replaceWindow) {
      persistWindow();
      mainWindow.destroy();
      createWindow();
    }
    try { await connectStation(); }
    catch (error) { setImmediate(() => void recover(error.message)); }
  } else { void requestQuit(false); }
}

async function finishQuit(confirm) {
  if (confirm && runtime?.owned && runtime.info) {
    let state;
    try { state = await requestDaemon(runtime.info, '/api/state', 3000); } catch { /* still shut down our process */ }
    const active = state?.agents.filter((agent) => (agent.tier === 'A' || agent.managed || agent.inTerminal) && agent.status !== 'stopped').length ?? 0;
    const held = state?.pending.length ?? 0;
    if (active || held) {
      const decision = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Quit Waystation?', message: `Quit and stop ${active} managed agent${active === 1 ? '' : 's'}?`, detail: `Schedules stop until you reopen Waystation. ${held} held approval${held === 1 ? '' : 's'} will be released. Your external agent sessions stay in their terminals.`, buttons: ['Keep running', 'Quit Waystation'], defaultId: 0, cancelId: 0 });
      if (decision.response !== 1) return;
    }
  }
  closeFeed();
  notice?.close();
  persistWindow();
  while (runtime?.owned) {
    try { await runtime.stop(); }
    catch (error) {
      const decision = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Waystation is shutting down', message: error.message, detail: 'Force quit ends the daemon and its child processes immediately. Normal approval cleanup may not finish.', buttons: ['Keep waiting', 'Force quit'], defaultId: 0, cancelId: 0 });
      if (decision.response === 1) { runtime.forceStop(); break; }
    }
  }
  finalQuit = true;
  tray?.destroy();
  // An adopted daemon needs no asynchronous stop. Finish the original
  // before-quit event before asking Electron to quit a second time.
  setImmediate(() => app.quit());
}

function requestQuit(confirm = true) {
  if (!quitPromise) quitPromise = finishQuit(confirm).catch((error) => {
    console.error('Could not quit Waystation:', redactToken(error.message));
  }).finally(() => { quitPromise = undefined; });
  return quitPromise;
}

if (!app.requestSingleInstanceLock()) {
  finalQuit = true;
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('before-quit', (event) => { if (!finalQuit) { event.preventDefault(); void requestQuit(); } });
  app.on('window-all-closed', () => { if (!tray && !finalQuit) void requestQuit(); });
  process.on('message', (message) => { if (message?.type === 'waystation:quit') void requestQuit(false); });
  if (process.connected) process.on('disconnect', () => void requestQuit(false));
  process.on('SIGINT', () => void requestQuit(false));
  process.on('SIGTERM', () => void requestQuit(false));
  app.whenReady().then(async () => {
    createWindow();
    tray = new Tray(stationIcon());
    tray.on('double-click', () => showWindow());
    updateTray();
    registerBridge();
    if (process.platform !== 'win32') throw new Error('Waystation currently supports Windows.');
    await connectStation();
  }).catch((error) => { console.error('Desktop startup failed:', redactToken(error.message)); void recover(error.message); });
}
