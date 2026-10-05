'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, Notification, screen, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { createPhoneTunnel } = require('./phone-tunnel.cjs');
const { createCompletionNotifier } = require('./completion-notifications.cjs');
const { createWindowsNotificationRegistration } = require('./windows-notifications.cjs');
const tunnelManifest = require('./cloudflared.json');

app.setName('CodeWatch');
app.setPath('userData', path.join(app.getPath('appData'), 'CodeWatch'));
const smoke = process.argv.includes('--smoke-test');
if (smoke && process.env.CODEWATCH_TEST_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.CODEWATCH_TEST_USER_DATA));
}
const smokeProfileId = crypto.createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16);
const applicationId = smoke ? `local.codewatch.desktop.smoke.${smokeProfileId}` : 'local.codewatch.desktop';
const smokeIdentity = crypto.createHash('sha256').update(applicationId).digest('hex').slice(0, 32);
const toastActivatorClsid = smoke ? `{${smokeIdentity.slice(0, 8)}-${smokeIdentity.slice(8, 12)}-${smokeIdentity.slice(12, 16)}-${smokeIdentity.slice(16, 20)}-${smokeIdentity.slice(20)}}` : '{56F538D7-F88A-4507-B0B3-A251D6F85149}';
app.setAppUserModelId(applicationId);
app.setToastActivatorCLSID(toastActivatorClsid);
const owned = app.requestSingleInstanceLock();
if (!owned) app.quit();
let window, tray, child, endpoint, quitting = false, stopped = false, stopping, phoneTunnel, completionNotifier;
let backendReady = false, showRequested = false;
let settings = { alwaysOnTop: false, closeToTray: false, compact: false, tutorialCompleted: false };
let changingLayout = false;
let token;
const userData = app.getPath('userData');
const discovery = path.join(userData, 'desktop-connection.json');
const preferencesFile = path.join(userData, 'preferences.json');
const logFile = path.join(userData, 'logs', 'desktop.log');
const activeNotifications = new Set();
const notificationState = { attempted: 0, shown: 0, failed: 0, shortcut: false, activationRepaired: false };
let notificationRegistration;

function appIcon() { return nativeImage.createFromPath(path.join(__dirname, 'assets', 'codewatch.png')); }

function registerNotifications() {
  // Windows toasts require a per-user Start Menu identity. The shortcut points to
  // the original portable file, never its temporary extraction directory.
  if (process.platform !== 'win32' || !app.isPackaged) return;
  notificationRegistration = createWindowsNotificationRegistration({ app, shell, userData,
    executable: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
    icon: path.join(__dirname, 'assets', 'codewatch.ico'), applicationId, toastActivatorClsid, smoke, log });
  notificationState.shortcut = notificationRegistration.register();
}

function showCompletionNotification(value) {
  if (quitting || !Notification.isSupported()) return;
  notificationState.attempted++;
  try {
    const notification = new Notification({ title: value.title, body: value.body, icon: appIcon(),
      timeoutType: 'default', silent: false });
    activeNotifications.add(notification);
    notification.once('show', () => { notificationState.shown++;
      void notificationRegistration?.repair().then(() => {
        notificationState.activationRepaired = notificationRegistration.state.repaired;
      }); });
    notification.once('failed', () => { notificationState.failed++; activeNotifications.delete(notification);
      log('Windows did not display a completion notification. Check notification settings.'); });
    notification.once('close', () => activeNotifications.delete(notification));
    notification.once('click', () => { activeNotifications.delete(notification); openFullApp(); });
    notification.show();
    if (window && !window.isDestroyed() && !window.isFocused()) window.flashFrame(true);
  } catch { notificationState.failed++; log('Windows completion notification is unavailable.'); }
}

async function startCompletionNotifications() {
  registerNotifications();
  const supported = Notification.isSupported();
  if (supported && process.platform === 'win32') Notification.handleActivation(() => {
    if (window && !window.isDestroyed()) openFullApp(); else show();
  });
  if (supported && notificationRegistration) {
    await notificationRegistration.repair();
    notificationState.activationRepaired = notificationRegistration.state.repaired;
  }
  completionNotifier = createCompletionNotifier({
    request: async signal => {
      const response = await fetch(endpoint + '/api/notifications', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error('Completion feed unavailable');
      return response.json();
    },
    notify: showCompletionNotification, log,
  });
  await completionNotifier.start();
}

function log(message) {
  // Logging must never interrupt service shutdown or turn a handled error into a crash.
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) {
      fs.rmSync(logFile + '.previous', { force: true });
      fs.renameSync(logFile, logFile + '.previous');
    }
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${String(message).replaceAll(token || '\0', '[redacted]').slice(0, 8000)}\n`);
  } catch { /* Diagnostics are best effort when the disk is full or unavailable. */ }
}
function persist(value = settings, strict = false) {
  const temporary = preferencesFile + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, preferencesFile);
  } catch (error) {
    log(`Could not save preferences: ${error.message}`);
    if (strict) throw new Error('Could not save your preferences. Please try again.');
  }
}
function loadPreferences() {
  try {
    const saved = JSON.parse(fs.readFileSync(preferencesFile, 'utf8'));
    // Launch into the full app; a prior companion session only restores its size.
    settings = { alwaysOnTop: saved.alwaysOnTop === true, closeToTray: saved.closeToTray === true,
      compact: false, tutorialCompleted: saved.tutorialCompleted === true, bounds: saved.bounds, compactBounds: saved.compactBounds,
      fullMaximized: saved.fullMaximized === true };
  } catch { /* First launch or malformed preferences: safe defaults. */ }
}
function preferences() {
  return { alwaysOnTop: settings.alwaysOnTop, closeToTray: settings.closeToTray, compact: settings.compact, tutorialCompleted: settings.tutorialCompleted === true };
}
function notifyPreferences() {
  if (window && !window.isDestroyed()) window.webContents.send('codewatch:preferences-changed', preferences());
}
function setPreferences(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      Object.keys(patch).some(key => !['alwaysOnTop', 'closeToTray', 'compact', 'tutorialCompleted'].includes(key) || typeof patch[key] !== 'boolean')) {
    throw new Error('Invalid preferences');
  }
  // Pinning opens the companion. Opening the full app can leave it pinned.
  const targetCompact = Object.hasOwn(patch, 'compact') ? patch.compact :
    Object.hasOwn(patch, 'alwaysOnTop') && patch.alwaysOnTop !== settings.alwaysOnTop ? patch.alwaysOnTop : settings.compact;
  const layoutChanged = settings.compact !== targetCompact;
  if (layoutChanged && window && !window.isDestroyed()) {
    rememberBounds();
    if (!settings.compact) settings.fullMaximized = window.isMaximized();
  }
  const nextSettings = { ...settings, ...patch, compact: targetCompact };
  persist(nextSettings, true);
  Object.assign(settings, nextSettings);
  if (window && !window.isDestroyed()) {
    window.setAlwaysOnTop(settings.alwaysOnTop);
    if (layoutChanged) {
      changingLayout = true;
      try {
        if (window.isMaximized()) window.unmaximize();
        const target = bounds(settings.compact, window.getBounds());
        window.setMinimumSize(Math.min(settings.compact ? 440 : 380, target.width), Math.min(500, target.height));
        window.setBounds(target);
        if (!settings.compact && settings.fullMaximized) window.maximize();
      } finally { changingLayout = false; }
    }
  }
  updateTray(); notifyPreferences();
  return preferences();
}
function localPage(url) {
  try {
    const parsed = new URL(url);
    return !!endpoint && parsed.protocol === 'http:' && !parsed.username && !parsed.password && parsed.origin === endpoint;
  } catch { return false; }
}
function trusted(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame || !localPage(event.senderFrame?.url)) {
    throw new Error('Untrusted desktop request');
  }
}
function registerIPC() {
  ipcMain.handle('codewatch:choose-folder', async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, { title: 'Choose a project to watch', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('codewatch:get-preferences', (event) => { trusted(event); return preferences(); });
  ipcMain.handle('codewatch:set-preferences', (event, patch) => {
    trusted(event);
    return setPreferences(patch);
  });
  ipcMain.handle('codewatch:get-phone-status', event => { trusted(event); return getPhoneTunnel().getStatus(); });
  ipcMain.handle('codewatch:start-phone-share', event => { trusted(event); return getPhoneTunnel().start(); });
  ipcMain.handle('codewatch:stop-phone-share', event => { trusted(event); return getPhoneTunnel().stop(); });
}
function installTunnel() {
  const source = app.isPackaged ? path.join(process.resourcesPath, 'cloudflared.exe') : path.resolve(__dirname, '../build/vendor/cloudflared.exe');
  const binary = fs.readFileSync(source);
  if (crypto.createHash('sha256').update(binary).digest('hex') !== tunnelManifest.sha256) {
    throw new Error('The bundled phone connector could not be verified. Re-download CodeWatch.');
  }
  const directory = path.join(userData, 'bin');
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, `cloudflared-${tunnelManifest.version}.exe`);
  if (!fs.existsSync(destination) || crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== tunnelManifest.sha256) {
    fs.writeFileSync(destination + '.tmp', binary, { mode: 0o700 });
    fs.renameSync(destination + '.tmp', destination);
  }
  return destination;
}
function getPhoneTunnel() {
  phoneTunnel ??= createPhoneTunnel({
    executable: installTunnel,
    desktopEndpoint: () => endpoint,
    configPath: path.join(userData, 'phone-tunnel', 'empty.yml'),
    request: async (route, body) => {
      const response = await fetch(endpoint + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not update phone sharing.');
      return data;
    },
    onChange: value => { if (window && !window.isDestroyed()) window.webContents.send('codewatch:phone-status-changed', value); },
    log,
  });
  return phoneTunnel;
}
function show() {
  if (quitting) return;
  showRequested = true;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  }
}
function openFullApp() {
  if (quitting) return;
  setPreferences({ compact: false });
  show();
}
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show CodeWatch', click: show },
    { label: settings.compact ? 'Open full app' : 'Show activity companion', click: () => {
      setPreferences({ compact: !settings.compact }); show();
    } },
    { label: 'Always on top', type: 'checkbox', checked: settings.alwaysOnTop, click: () => {
      setPreferences({ alwaysOnTop: !settings.alwaysOnTop });
    } },
    { label: 'Hide window (continue watching)', click: () => window?.hide() },
    { type: 'separator' },
    { label: 'Quit CodeWatch', click: () => app.quit() },
  ]));
}
function installHelper() {
  const source = app.isPackaged ? path.join(process.resourcesPath, 'codewatch-helper.exe') :
    path.resolve(__dirname, '../build/sidecar/codewatch-helper.exe');
  const binary = fs.readFileSync(source);
  const hash = crypto.createHash('sha256').update(binary).digest('hex');
  // MCP config must survive the portable launcher's temporary extraction directory.
  const directory = path.join(userData, 'bin');
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, `codewatch-helper-${hash.slice(0, 16)}.exe`);
  if (!fs.existsSync(destination) || crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== hash) {
    fs.writeFileSync(destination + '.tmp', binary, { mode: 0o700 });
    fs.renameSync(destination + '.tmp', destination);
  }
  return destination;
}
async function startBackend() {
  token = crypto.randomBytes(32).toString('hex');
  const executable = installHelper();
  child = spawn(executable, ['serve', '--discovery', discovery], {
    windowsHide: true, cwd: userData, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEWATCH_DESKTOP_TOKEN: token, PYTHONUTF8: '1' },
  });
  child.stderr.on('data', bytes => log(bytes.toString('utf8')));
  child.on('error', error => log(`Owned service error: ${error.message}`));
  child.stdin.on('error', error => log(`Service control pipe: ${error.message}`));
  child.on('exit', (code) => {
    log(`Owned service exited (${code})`);
    if (backendReady && !quitting) {
      if (!smoke) dialog.showErrorBox('CodeWatch service stopped', `Restart CodeWatch to reconnect. Details: ${logFile}`);
      app.quit();
    }
  });
  const lines = readline.createInterface({ input: child.stdout });
  endpoint = await new Promise((resolve, reject) => {
    const finish = (error, url) => {
      clearTimeout(timeout); child.removeListener('error', fail); child.removeListener('exit', exited);
      lines.close(); child.stdout.resume();
      if (error) reject(error); else resolve(url);
    };
    const timeout = setTimeout(() => finish(new Error('Backend startup timed out')), 60_000);
    const fail = (error) => finish(error);
    const exited = () => fail(new Error('Backend exited during startup'));
    child.once('error', fail);
    child.once('exit', exited);
    lines.on('line', line => {
      try {
        const ready = JSON.parse(line);
        const url = new URL(ready.url);
        if (ready.kind === 'ready' && url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
            url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) {
          finish(null, url.origin);
        }
      } catch { log(line); }
    });
  });
  const response = await fetch(endpoint + '/health', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Backend health check failed');
  backendReady = true;
  log('Owned backend is healthy');
}
function bounds(compact = settings.compact, previous) {
  const saved = compact ? settings.compactBounds : settings.bounds;
  if (saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key])) && saved.width > 0 && saved.height > 0 &&
      screen.getAllDisplays().some(({ workArea: a }) => saved.x < a.x + a.width && saved.y < a.y + a.height &&
        saved.x + saved.width > a.x && saved.y + saved.height > a.y)) {
    const a = screen.getDisplayMatching(saved).workArea;
    const width = Math.min(Math.max(Math.round(saved.width), compact ? 440 : 380), a.width);
    const height = Math.min(Math.max(Math.round(saved.height), 500), a.height);
    return { x: Math.max(a.x, Math.min(Math.round(saved.x), a.x + a.width - width)),
      y: Math.max(a.y, Math.min(Math.round(saved.y), a.y + a.height - height)), width, height };
  }
  const a = previous ? screen.getDisplayMatching(previous).workArea : screen.getPrimaryDisplay().workArea;
  const width = Math.min(compact ? 540 : 1280, a.width);
  const height = Math.min(compact ? 720 : 900, a.height);
  return { x: a.x + Math.max(0, compact ? a.width - width - 20 : Math.round((a.width - width) / 2)),
    y: a.y + Math.max(0, Math.min(24, a.height - height)), width, height };
}
async function openWindow() {
  const rendererSession = session.fromPartition('codewatch-desktop');
  rendererSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window?.webContents && localPage(contents.getURL()) && details.isMainFrame &&
      localPage(details.requestingUrl) && permission === 'clipboard-sanitized-write');
  });
  rendererSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    contents === window?.webContents && details.isMainFrame && localPage(requestingOrigin) &&
    localPage(contents.getURL()) && permission === 'clipboard-sanitized-write');
  await rendererSession.cookies.set({ url: endpoint, name: 'codewatch_auth', value: token, httpOnly: true, sameSite: 'strict', path: '/' });
  rendererSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      const local = (url.protocol === 'http:' || url.protocol === 'ws:') &&
        url.host === new URL(endpoint).host && !url.username && !url.password;
      const embedded = ['data:', 'blob:'].includes(url.protocol) && ['image', 'media', 'font'].includes(details.resourceType);
      const exportBlob = url.protocol === 'blob:' && url.origin === endpoint;
      callback({ cancel: !local && !embedded && !exportBlob && url.protocol !== 'devtools:' });
    } catch { callback({ cancel: true }); }
  });
  rendererSession.on('will-download', (event, item, contents) => {
    // Keep the dashboard's explicit NDJSON export; other downloads are blocked.
    const urls = item.getURLChain();
    const exportOnly = contents === window?.webContents && localPage(contents.getURL()) &&
      urls.length > 0 && urls.every(url => url.startsWith(`blob:${endpoint}/`)) &&
      item.getMimeType() === 'application/x-ndjson' && item.getFilename().endsWith('-events.ndjson');
    if (!exportOnly) event.preventDefault();
  });
  const restoredBounds = bounds();
  window = new BrowserWindow({
    ...restoredBounds, minWidth: Math.min(settings.compact ? 440 : 380, restoredBounds.width), minHeight: Math.min(500, restoredBounds.height),
    title: 'CodeWatch', backgroundColor: '#111413',
    icon: appIcon(),
    show: false, alwaysOnTop: settings.alwaysOnTop,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), session: rendererSession,
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false },
  });
  if (!settings.compact && settings.fullMaximized) window.maximize();
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!localPage(url)) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame || !localPage(event.url)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!localPage(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => {
    if (!quitting && settings.closeToTray) { event.preventDefault(); window.hide(); }
  });
  window.on('resize', rememberBounds); window.on('move', rememberBounds);
  window.on('maximize', rememberBounds); window.on('unmaximize', rememberBounds);
  window.on('closed', () => { window = undefined; });
  window.on('focus', () => window?.flashFrame(false));
  window.webContents.on('render-process-gone', () => { log('Renderer process stopped'); app.quit(); });
  await window.loadURL(endpoint);
  if (!smoke || showRequested) show();
}
function rememberBounds() {
  if (!changingLayout && window && !window.isDestroyed() && !window.isMinimized()) {
    if (settings.compact) {
      if (!window.isMaximized()) settings.compactBounds = window.getBounds();
    } else {
      settings.bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
      settings.fullMaximized = window.isMaximized();
    }
    persist();
  }
}
async function stopBackend() {
  await completionNotifier?.close();
  for (const notification of activeNotifications) notification.close();
  activeNotifications.clear();
  await notificationRegistration?.close();
  await phoneTunnel?.close();
  if (stopping) return stopping;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const ownedChild = child;
  stopping = new Promise(resolve => {
    const deadline = setTimeout(() => { ownedChild.kill(); resolve(); }, 10_000);
    ownedChild.once('exit', () => { clearTimeout(deadline); resolve(); });
    if (!ownedChild.stdin.destroyed) ownedChild.stdin.end('quit\n');
  });
  // The helper removes only its own discovery record. Never delete another run's file.
  return stopping;
}
function trayImage() {
  return appIcon().resize({ width: 16, height: 16 });
}
if (owned) {
  app.on('second-instance', openFullApp);
  app.on('activate', show);
  app.on('window-all-closed', () => { if (!settings.closeToTray) app.quit(); });
  app.on('before-quit', event => {
    quitting = true;
    if (stopped) return;
    event.preventDefault();
    stopBackend().finally(() => { stopped = true; tray?.destroy(); app.quit(); });
  });
  app.whenReady().then(async () => {
    fs.mkdirSync(userData, { recursive: true });
    loadPreferences();
    await startBackend();
    if (quitting) return;
    registerIPC(); await openWindow();
    if (quitting) return;
    await startCompletionNotifications();
    tray = new Tray(trayImage()); tray.setToolTip('CodeWatch'); tray.on('double-click', show); updateTray();
    if (smoke) {
      await require('./smoke.cjs')({ app, window, child, endpoint, token, discovery, completionNotifier, notificationState, notificationRegistration });
      app.quit();
    }
  }).catch(error => {
    log(error.stack || error.message);
    if (smoke) {
      const result = process.env.CODEWATCH_SMOKE_RESULT;
      if (result) fs.writeFileSync(result, JSON.stringify({ ok: false, error: error.message }));
    } else if (!quitting) dialog.showErrorBox('CodeWatch could not start', `${error.message}\n\nDetails: ${logFile}`);
    app.quit();
  });
}
