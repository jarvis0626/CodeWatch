'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

function runRegistry(args) {
  const binary = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  return new Promise((resolve, reject) => {
    execFile(binary, args, { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

// Electron 44 registers a shortcut named after the EXE's ProductName and a COM
// server pointing at the running EXE. A portable launcher extracts that EXE to
// a temporary directory. Repair those owned records after Electron initializes.
function createWindowsNotificationRegistration({ app, shell, userData, executable, icon,
  applicationId, toastActivatorClsid, smoke = false, log = () => {} }, dependencies = {}) {
  const disk = dependencies.fs || fs;
  const registry = dependencies.runRegistry || runRegistry;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const platform = dependencies.platform || process.platform;
  const state = { registered: false, repaired: false };
  const validClsid = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' &&
    a.replaceAll('/', '\\').toLowerCase() === b.replaceAll('/', '\\').toLowerCase();
  const identityMatches = () => same(app.toastActivatorCLSID, toastActivatorClsid);
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const smokeId = crypto.createHash('sha256').update(userData).digest('hex').slice(0, 16);
  // The automatic filename comes from the PE ProductName, not app.setName().
  const automaticPath = path.join(programs, 'CodeWatch.lnk');
  const shortcutPath = smoke ? path.join(programs, `CodeWatch smoke ${smokeId}.lnk`) : automaticPath;
  const stableIcon = path.join(userData, 'codewatch.ico');
  const innerExecutable = dependencies.innerExecutable || app.getPath('exe');
  const registryKey = `HKCU\\Software\\Classes\\CLSID\\${toastActivatorClsid}`;
  const serverKey = registryKey + '\\LocalServer32';
  let originalAutomatic, replacedAutomatic = false, closed = false, pending, closing;

  function details() {
    return { target: executable, cwd: path.dirname(executable), description: 'CodeWatch desktop companion',
      icon: stableIcon, iconIndex: 0, appUserModelId: applicationId, toastActivatorClsid };
  }
  function ownedShortcut(file) {
    try {
      const value = shell.readShortcutLink(file);
      return value.appUserModelId === applicationId && same(value.toastActivatorClsid, toastActivatorClsid) &&
        (same(value.target, executable) || same(value.target, innerExecutable));
    } catch { return false; }
  }
  function writeShortcut(file) {
    if (!shell.writeShortcutLink(file, 'create', details())) throw new Error('Could not register the shortcut');
  }
  async function readServer() {
    try {
      const text = await registry(['query', serverKey, '/ve']);
      // The default value label is localized; REG_SZ is not.
      return /\sREG_SZ\s+([^\r\n]*)/i.exec(text)?.[1].trim() || null;
    } catch { return null; }
  }
  function serverTarget(value) {
    if (!value) return null;
    if (value.startsWith('"')) return /^"([^"\r\n]+)"/.exec(value)?.[1] || null;
    // Electron's own registration is an unquoted absolute EXE path with no arguments.
    return /^(.*?\.exe)(?:\s|$)/i.exec(value)?.[1] || null;
  }
  function valid() {
    return platform === 'win32' && app.isPackaged && validClsid.test(toastActivatorClsid) &&
      typeof applicationId === 'string' && applicationId.length > 0 && applicationId.length <= 128 &&
      [userData, executable, icon, innerExecutable].every(value => typeof value === 'string' && path.isAbsolute(value)) &&
      (!smoke || (applicationId.startsWith('local.codewatch.desktop.smoke.') &&
        !same(toastActivatorClsid, '{56F538D7-F88A-4507-B0B3-A251D6F85149}')));
  }
  function register() {
    if (closed || state.registered || !valid()) return state.registered;
    try {
      if (!disk.existsSync(executable) || !disk.existsSync(icon)) throw new Error('The launcher or icon is unavailable');
      disk.mkdirSync(programs, { recursive: true });
      disk.mkdirSync(userData, { recursive: true });
      disk.writeFileSync(stableIcon, disk.readFileSync(icon));
      if (smoke) {
        // Prevent Electron from adopting a production shortcut's CLSID during the
        // smoke run. Restore its exact bytes later if this smoke identity still owns it.
        if (replacedAutomatic && !ownedShortcut(automaticPath)) throw new Error('Smoke shortcut ownership changed');
        if (!replacedAutomatic && disk.existsSync(automaticPath)) originalAutomatic = disk.readFileSync(automaticPath);
        writeShortcut(automaticPath);
        replacedAutomatic = true;
      }
      writeShortcut(shortcutPath);
      state.registered = true;
    } catch { log('Windows completion notifications could not be registered. Reports remain visible in the app.'); }
    return state.registered;
  }
  async function repairOnce() {
    if (closed || !state.registered) return;
    // Wait briefly for Electron's asynchronous COM registration before replacing
    // its temporary path; otherwise its worker could overwrite our repair afterward.
    let server;
    for (let attempt = 0; attempt < 21; attempt++) {
      if (closed || !identityMatches()) return;
      server = await readServer();
      if (same(serverTarget(server), innerExecutable) || state.repaired) break;
      if (attempt < 20) await sleep(100);
    }
    if (closed || !identityMatches()) return;
    if (!ownedShortcut(shortcutPath) || (smoke && !ownedShortcut(automaticPath))) return;
    writeShortcut(shortcutPath);
    if (smoke) writeShortcut(automaticPath);
    // Preserve an activation flag if a future Electron release writes one.
    const activation = /(?:^|\s)(--notification-launch-id(?:=[^\r\n]*)?)$/i.exec(server || '')?.[1];
    const command = `"${executable}"${activation ? ` ${activation}` : ''}`;
    await registry(['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', 'CodeWatch Notification Activator', '/f']);
    if (closed || !identityMatches()) return;
    await registry(['add', registryKey, '/v', 'CustomActivator', '/t', 'REG_DWORD', '/d', '1', '/f']);
    if (closed || !identityMatches()) return;
    await registry(['add', serverKey, '/ve', '/t', 'REG_SZ', '/d', command, '/f']);
    state.repaired = true;
  }
  function repair() {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = repairOnce().catch(() => log('Windows notification activation will be repaired on the next completion report.'))
      .finally(() => { pending = undefined; });
    return pending;
  }
  function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await pending;
      if (!smoke || !valid()) return;
      if (ownedShortcut(shortcutPath)) {
        try { disk.unlinkSync(shortcutPath); } catch { /* Disposable identity may already be gone. */ }
      }
      if (replacedAutomatic && ownedShortcut(automaticPath)) {
        try {
          if (originalAutomatic) disk.writeFileSync(automaticPath, originalAutomatic);
          else disk.unlinkSync(automaticPath);
        } catch { log('A disposable notification shortcut could not be cleaned up.'); }
      }
      // Never remove a production or another process's registry registration.
      const server = await readServer();
      if (identityMatches() && (same(serverTarget(server), executable) || same(serverTarget(server), innerExecutable))) {
        try { await registry(['delete', registryKey, '/f']); }
        catch { log('A disposable notification activation record could not be cleaned up.'); }
      }
    })();
    return closing;
  }
  return { register, repair, close, shortcutPath, state };
}

module.exports = { createWindowsNotificationRegistration };
