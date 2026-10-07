'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createWindowsNotificationRegistration } = require('./windows-notifications.cjs');

const productionClsid = '{56F538D7-F88A-4507-B0B3-A251D6F85149}';
const smokeClsid = '{ABCD1234-5678-4000-9000-0123456789AB}';
const executable = path.resolve('.local/portable app/CodeWatch.exe');
const inner = path.resolve('.local/extracted app/CodeWatch.exe');
const sourceIcon = path.resolve('desktop/assets/codewatch.ico');
function fixture(smoke = false, overrideClsid) {
  const files = new Map([[executable, Buffer.from('exe')], [sourceIcon, Buffer.from('icon')]]);
  const calls = [], registryWrites = [], logs = [];
  const values = new Map();
  let failWrite = false, failureAtCall, sleepCallback;
  const applicationId = smoke ? 'local.codewatch.desktop.smoke.1234567890' : 'local.codewatch.desktop';
  const clsid = overrideClsid || (smoke ? smokeClsid : productionClsid);
  const userData = path.resolve('.local/profile-notifications');
  const programs = path.join(path.resolve('.local/app-data'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const automatic = path.join(programs, 'CodeWatch.lnk');
  const app = { isPackaged: true, toastActivatorCLSID: clsid,
    getPath: name => name === 'exe' ? inner : path.resolve('.local/app-data') };
  const fs = { existsSync: file => files.has(file), mkdirSync() {},
    readFileSync(file) { if (!files.has(file)) throw new Error('ENOENT'); return Buffer.from(files.get(file)); },
    writeFileSync: (file, data) => files.set(file, Buffer.from(data)),
    unlinkSync: file => files.delete(file),
  };
  const shell = {
    writeShortcutLink(file, operation, details) {
      calls.push({ file, operation, details });
      if (failWrite || failureAtCall === calls.length) return false;
      files.set(file, Buffer.from(JSON.stringify(details)));
      return true;
    },
    readShortcutLink: file => JSON.parse(fs.readFileSync(file).toString()),
  };
  const runRegistry = async args => {
    const [operation, key] = args;
    if (operation === 'query') {
      if (!values.has(key)) throw new Error('No value');
      return `\r\n${key}\r\n    (localized default)    REG_SZ    ${values.get(key)}\r\n`;
    }
    registryWrites.push(args);
    if (operation === 'add' && key.endsWith('LocalServer32')) values.set(key, args[args.indexOf('/d') + 1]);
    if (operation === 'delete') values.delete(key + '\\LocalServer32');
    return '';
  };
  const registration = createWindowsNotificationRegistration({ app, shell, userData, executable,
    icon: sourceIcon, applicationId, toastActivatorClsid: clsid, smoke, log: message => logs.push(message) },
  { fs, runRegistry, platform: 'win32', sleep: async () => { await sleepCallback?.(); } });
  const serverKey = `HKCU\\Software\\Classes\\CLSID\\${clsid}\\LocalServer32`;
  return { registration, app, fs, files, calls, registryWrites, logs, values, shell, automatic, serverKey,
    setFailure: value => { failWrite = value; }, setFailureAt: value => { failureAtCall = value; },
    setSleep: callback => { sleepCallback = callback; } };
}

test('normal registration uses one Start Menu shortcut with stable portable target and icon', () => {
  const f = fixture();
  assert.equal(f.registration.register(), true);
  assert.equal(f.registration.shortcutPath, f.automatic);
  assert.equal(f.calls.length, 1);
  const link = f.shell.readShortcutLink(f.automatic);
  assert.equal(link.target, executable);
  assert.equal(link.cwd, path.dirname(executable));
  assert.equal(link.toastActivatorClsid, productionClsid);
  assert.ok(link.icon.endsWith('codewatch.ico'));
  assert.equal(f.files.get(link.icon).toString(), 'icon');
  assert.equal(f.registryWrites.length, 0);
});

test('smoke registration shields the automatic product-name shortcut from production CLSID adoption', () => {
  const f = fixture(true);
  f.files.set(f.automatic, Buffer.from(JSON.stringify({ target: '/old-production.exe', appUserModelId: 'local.codewatch.desktop',
    toastActivatorClsid: productionClsid }) + '\r\n'));
  assert.equal(f.registration.register(), true);
  assert.notEqual(f.registration.shortcutPath, f.automatic);
  assert.ok(f.registration.shortcutPath.includes('CodeWatch smoke '));
  assert.equal(f.shell.readShortcutLink(f.automatic).toastActivatorClsid, smokeClsid);
  assert.equal(f.shell.readShortcutLink(f.automatic).appUserModelId, 'local.codewatch.desktop.smoke.1234567890');
  assert.equal(f.shell.readShortcutLink(f.registration.shortcutPath).target, executable);
});

test('repair waits for Electron registration and replaces its temporary EXE with a quoted portable target', async () => {
  const f = fixture();
  f.registration.register();
  let sleeps = 0;
  f.setSleep(() => {
    sleeps++;
    f.values.set(f.serverKey, inner);
    const previous = f.shell.readShortcutLink(f.automatic);
    f.shell.writeShortcutLink(f.automatic, 'create', { ...previous, target: inner, icon: '' });
  });
  await f.registration.repair();
  assert.equal(sleeps, 1);
  assert.equal(f.shell.readShortcutLink(f.automatic).target, executable);
  assert.ok(f.shell.readShortcutLink(f.automatic).icon.endsWith('codewatch.ico'));
  assert.equal(f.values.get(f.serverKey), `"${executable}"`);
  assert.equal(f.registryWrites.length, 3);
  assert.ok(f.registryWrites.every(args => args[1].includes(productionClsid)));
  assert.equal(f.registration.state.repaired, true);
});

test('smoke cleanup restores exact original shortcut bytes and removes only its own registry registration', async () => {
  const f = fixture(true);
  const original = Buffer.from(JSON.stringify({ target: '/original.exe', appUserModelId: 'local.codewatch.desktop',
    toastActivatorClsid: productionClsid }) + '  \r\n');
  f.files.set(f.automatic, original);
  f.registration.register();
  f.values.set(f.serverKey, inner);
  await f.registration.repair();
  await f.registration.close();
  assert.deepEqual(f.files.get(f.automatic), original);
  assert.equal(f.files.has(f.registration.shortcutPath), false);
  assert.equal(f.values.has(f.serverKey), false);
  assert.ok(f.registryWrites.every(args => args[1].includes(smokeClsid)));
});

test('smoke cleanup leaves shortcuts and registry targets changed by another writer intact', async () => {
  const f = fixture(true);
  f.registration.register();
  const other = { target: '/another.exe', appUserModelId: 'another.app', toastActivatorClsid: productionClsid };
  f.shell.writeShortcutLink(f.automatic, 'create', other);
  f.shell.writeShortcutLink(f.registration.shortcutPath, 'create', other);
  const foreign = '"C:\\Other app\\Other.exe"';
  f.values.set(f.serverKey, foreign);
  await f.registration.close();
  assert.deepEqual(f.shell.readShortcutLink(f.automatic), other);
  assert.deepEqual(f.shell.readShortcutLink(f.registration.shortcutPath), other);
  assert.equal(f.values.get(f.serverKey), foreign);
  assert.equal(f.registryWrites.length, 0);
});

test('repair never writes the registry after Electron adopts a different activator identity', async () => {
  const f = fixture(true);
  f.registration.register();
  f.app.toastActivatorCLSID = productionClsid;
  f.values.set(f.serverKey, inner);
  await f.registration.repair();
  await f.registration.close();
  assert.equal(f.registryWrites.length, 0);
  assert.equal(f.values.get(f.serverKey), inner);
});

test('normal quit preserves its notification shortcut and activation registry', async () => {
  const f = fixture();
  f.registration.register();
  f.values.set(f.serverKey, inner);
  await f.registration.repair();
  const stable = f.values.get(f.serverKey);
  await f.registration.close();
  assert.equal(f.files.has(f.automatic), true);
  assert.equal(f.values.get(f.serverKey), stable);
  assert.equal(f.registryWrites.some(args => args[0] === 'delete'), false);
});

test('failed registration is handled and does not mutate an existing shortcut during cleanup', async () => {
  const f = fixture(true);
  const original = Buffer.from('original shortcut binary');
  f.files.set(f.automatic, original);
  f.setFailure(true);
  assert.equal(f.registration.register(), false);
  await f.registration.repair();
  await f.registration.close();
  assert.deepEqual(f.files.get(f.automatic), original);
  assert.equal(f.registryWrites.length, 0);
  assert.equal(f.logs.length, 1);
});

test('concurrent repairs share one operation and cannot continue writing after close', async () => {
  const f = fixture(true);
  f.registration.register();
  let release;
  f.setSleep(() => new Promise(resolve => { release = resolve; }));
  const first = f.registration.repair();
  const second = f.registration.repair();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  const closing = f.registration.close();
  release();
  await Promise.all([first, closing]);
  assert.equal(f.registryWrites.length, 0);
  assert.equal(f.files.has(f.automatic), false);
  assert.equal(f.files.has(f.registration.shortcutPath), false);
});

test('retrying a partial smoke registration preserves the original production shortcut backup', async () => {
  const f = fixture(true);
  const original = Buffer.from(JSON.stringify({ target: '/original.exe', appUserModelId: 'local.codewatch.desktop',
    toastActivatorClsid: productionClsid }) + '\r\n');
  f.files.set(f.automatic, original);
  f.setFailureAt(2);
  assert.equal(f.registration.register(), false);
  assert.equal(f.registration.register(), true);
  await f.registration.close();
  assert.deepEqual(f.files.get(f.automatic), original);
  assert.equal(f.files.has(f.registration.shortcutPath), false);
});

test('a smoke configuration cannot write or delete the fixed production CLSID', async () => {
  const f = fixture(true, productionClsid);
  f.values.set(f.serverKey, executable);
  assert.equal(f.registration.register(), false);
  await f.registration.repair();
  await f.registration.close();
  assert.equal(f.calls.length, 0);
  assert.equal(f.registryWrites.length, 0);
  assert.equal(f.values.get(f.serverKey), executable);
});


test('Windows short and long paths identify the same extracted EXE for repair and cleanup', async () => {
  const f = fixture(true);
  f.registration.register();
  const shortInner = inner.replace('extracted app', 'EXTRAC~1');
  const native = value => value === shortInner ? inner : value;
  f.fs.realpathSync = Object.assign(() => { throw new Error('Use native path resolution'); }, { native });
  const link = f.shell.readShortcutLink(f.automatic);
  f.shell.writeShortcutLink(f.automatic, 'create', { ...link, target: shortInner });
  f.values.set(f.serverKey, shortInner);
  let sleeps = 0;
  f.setSleep(() => { sleeps++; });
  await f.registration.repair();
  assert.equal(sleeps, 0);
  assert.equal(f.registration.state.repaired, true);
  assert.equal(f.values.get(f.serverKey), `"${executable}"`);
  assert.equal(f.shell.readShortcutLink(f.automatic).target, executable);
  // Cleanup must also recognize an equivalent path restored by Electron.
  f.values.set(f.serverKey, shortInner);
  await f.registration.close();
  assert.equal(f.files.has(f.automatic), false);
  assert.equal(f.values.has(f.serverKey), false);
});

test('path resolution never grants ownership to a different executable with matching identity', async () => {
  const f = fixture(true);
  f.registration.register();
  const other = path.resolve('.local/other/CodeWatch.exe');
  f.fs.realpathSync = value => value;
  const link = f.shell.readShortcutLink(f.automatic);
  f.shell.writeShortcutLink(f.automatic, 'create', { ...link, target: other });
  f.values.set(f.serverKey, other);
  await f.registration.repair();
  assert.equal(f.registration.state.repaired, false);
  assert.equal(f.registration.state.reason, 'Shortcut ownership check failed');
  await f.registration.close();
  assert.equal(f.shell.readShortcutLink(f.automatic).target, other);
  assert.equal(f.values.get(f.serverKey), other);
  assert.equal(f.registryWrites.length, 0);
});
