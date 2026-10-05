'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createPhoneTunnel } = require('./phone-tunnel.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(condition) {
  for (let index = 0; index < 100; index++) { if (condition()) return; await pause(2); }
  assert.fail('The expected lifecycle event did not happen');
}
function fixture(t, overrides = {}) {
  // Production lifecycle timers are unref'd; this fake child has no OS handles.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const calls = [], children = [], statuses = [], probes = [], logs = [];
  const share = { endpoint: 'http://127.0.0.1:49001', pairToken: 'test-pairing-secret-with-at-least-32-characters',
    shareId: 'test-share-one', runId: 'watch-test-project', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  let backendStatus = { active: true, pairedDevices: 0, shareId: share.shareId, runId: share.runId };
  const request = async (route, payload) => {
    calls.push({ route, payload });
    if (route === '/api/phone/start') return overrides.creation ? overrides.creation.promise : { ...share };
    if (route === '/api/phone/status') return backendStatus;
    if (route === '/api/phone/activate') return { ...backendStatus };
    if (route === '/api/phone/stop') { if (overrides.revoke) await overrides.revoke.promise; return { active: false }; }
    assert.fail(`Unexpected backend route ${route}`);
  };
  const controller = createPhoneTunnel({
    request, executable: () => 'C:/CodeWatch/cloudflared.exe',
    fetch: async (url, options) => {
      probes.push({ url, options });
      return { ok: true, headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ active: true, shareId: share.shareId }) };
    },
    spawn: (binary, args, options) => {
      const child = new EventEmitter();
      Object.assign(child, { binary, args, options, stdout: new PassThrough(), stderr: new PassThrough(),
        exitCode: null, killCount: 0, kill: function () {
          this.killCount++; calls.push({ route: 'kill-owned-child' }); this.exitCode = 0; this.emit('exit', 0); return true;
        } });
      children.push(child);
      return child;
    },
    onChange: value => statuses.push(value), log: message => logs.push(message),
    connectionTimeoutMs: 500, probeRetryMs: 1, pollIntervalMs: 10_000, shutdownTimeoutMs: 30,
    ...overrides.options,
  });
  t.after(() => controller.close());
  async function ready(promise = controller.start()) {
    await until(() => children.length > 0);
    const child = children.at(-1);
    child.stderr.write('https://valid-phone.trycloudflare.com\n');
    child.stdout.write('INF Registered tunnel connection connIndex=0 protocol=http2\n');
    return promise;
  }
  return { controller, ready, share, calls, children, statuses, probes, logs,
    setBackendStatus: value => { backendStatus = value; } };
}

test('QR readiness requires a valid URL, registered connection and matching public health', { timeout: 2000 }, async t => {
  const f = fixture(t);
  const started = f.controller.start();
  await until(() => f.children.length > 0);
  const child = f.children[0];
  child.stderr.write('https://valid-phone.trycloudflare.com\n');
  await pause(5);
  assert.equal(f.controller.getStatus().state, 'starting');
  assert.equal(f.probes.length, 0);
  child.stdout.write('INF Registered tunnel connection connIndex=0 protocol=http2\n');
  const status = await started;
  assert.equal(status.state, 'active');
  assert.equal(status.url, 'https://valid-phone.trycloudflare.com/phone#token=' + f.share.pairToken);
  assert.equal(child.options.windowsHide, true);
  assert.equal(child.options.shell, false);
  assert.ok(child.args.includes('--no-autoupdate'));
  assert.equal(child.args[child.args.indexOf('--protocol') + 1], 'http2');
  assert.equal(child.args[child.args.indexOf('--url') + 1], f.share.endpoint);
  const config = child.args[child.args.indexOf('--config') + 1];
  assert.equal(fs.readFileSync(config, 'utf8'), '{}\n');
  assert.equal(f.probes[0].url, 'https://valid-phone.trycloudflare.com/phone/health');
  assert.equal(f.probes[0].options.redirect, 'error');
  assert.equal(f.probes[0].options.credentials, 'omit');
  assert.equal(f.probes[0].options.headers.Authorization, undefined);
  assert.ok(f.calls.find(call => call.route === '/api/phone/activate').payload.publicUrl === 'https://valid-phone.trycloudflare.com');
  assert.ok(!JSON.stringify([...f.calls, child.args, f.probes, f.logs]).includes(f.share.pairToken));
  await f.controller.stop();
  assert.equal(fs.existsSync(config), false);
});

test('duplicate start is single flight, and stopping revokes before killing only its child', { timeout: 2000 }, async t => {
  const revoke = deferred();
  const f = fixture(t, { revoke });
  const first = f.controller.start();
  assert.equal(f.controller.start(), first);
  await f.ready(first);
  assert.equal(f.children.length, 1);
  const stopped = f.controller.stop();
  assert.equal(f.controller.stop(), stopped);
  assert.deepEqual(f.controller.getStatus(), { state: 'idle' });
  await until(() => f.calls.some(call => call.route === '/api/phone/stop'));
  assert.equal(f.children[0].killCount, 0);
  revoke.resolve();
  await stopped;
  assert.equal(f.children[0].killCount, 1);
  const routes = f.calls.map(call => call.route);
  assert.ok(routes.indexOf('/api/phone/stop') < routes.indexOf('kill-owned-child'));
  assert.deepEqual(f.calls.find(call => call.route === '/api/phone/stop').payload, { shareId: f.share.shareId });
});

test('stop during backend creation waits for and revokes the late generation without spawning', { timeout: 2000 }, async t => {
  const creation = deferred();
  const f = fixture(t, { creation });
  const started = f.controller.start();
  await until(() => f.calls.some(call => call.route === '/api/phone/start'));
  const stopped = f.controller.stop();
  assert.equal(f.controller.getStatus().url, undefined);
  creation.resolve({ ...f.share });
  await Promise.all([started, stopped]);
  assert.equal(f.children.length, 0);
  assert.equal(f.calls.filter(call => call.route === '/api/phone/stop').length, 1);
  assert.equal(f.controller.getStatus().state, 'idle');
});

test('connection timeout rejects hostile URLs, drops QR and revokes its service', { timeout: 2000 }, async t => {
  const f = fixture(t, { options: { connectionTimeoutMs: 35 } });
  const started = f.controller.start();
  await until(() => f.children.length > 0);
  f.children[0].stderr.write('https://good.trycloudflare.com.attacker.example\nhttps://good.trycloudflare.com@attacker.example\nhttps://good.trycloudflare.com/extra\nhttps://nested.good.trycloudflare.com\nhttp://good.trycloudflare.com\n');
  f.children[0].stdout.write('INF Registered tunnel connection\n');
  const result = await started;
  assert.equal(result.state, 'error');
  assert.match(result.error, /internet connection/);
  assert.equal(result.url, undefined);
  assert.equal(f.probes.length, 0);
  assert.equal(f.children[0].killCount, 1);
  assert.ok(f.calls.some(call => call.route === '/api/phone/stop'));
  assert.ok(f.statuses.every(status => status.state !== 'active'));
});

test('a registered tunnel cannot activate a QR when public health belongs to another share', { timeout: 2000 }, async t => {
  const f = fixture(t, { options: { connectionTimeoutMs: 35,
    fetch: async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ active: true, shareId: 'some-other-share' }) }) } });
  const result = await f.ready();
  assert.equal(result.state, 'error');
  assert.equal(result.url, undefined);
  assert.equal(f.children[0].killCount, 1);
});

test('public health retries transient failures before publishing the pairing fragment', { timeout: 2000 }, async t => {
  let probes = 0;
  const f = fixture(t, { options: { fetch: async () => {
    probes++;
    if (probes === 1) throw new TypeError('Redirect or connection failure');
    if (probes === 2) return { ok: false, headers: new Headers() };
    return { ok: true, headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ active: true, shareId: f.share.shareId }) };
  } } });
  const result = await f.ready();
  assert.equal(result.state, 'active');
  assert.equal(probes, 3);
  assert.equal(f.statuses.filter(value => value.state === 'active').length, 1);
});

test('stop while probing aborts the pending public request and never exposes a QR', { timeout: 2000 }, async t => {
  let signal;
  const f = fixture(t, { options: { fetch: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } } });
  const started = f.ready();
  await until(() => !!signal);
  await f.controller.stop();
  await started;
  assert.equal(signal.aborted, true);
  assert.equal(f.children[0].killCount, 1);
  assert.equal(f.statuses.filter(value => value.state === 'active').length, 0);
  assert.equal(f.controller.getStatus().state, 'idle');
});

test('a new start waits for an old stop to finish revoking and terminating its tunnel', { timeout: 2000 }, async t => {
  const revoke = deferred();
  const f = fixture(t, { revoke });
  await f.ready();
  const stopped = f.controller.stop();
  const restarted = f.controller.start();
  await pause(5);
  assert.equal(f.children.length, 1);
  revoke.resolve();
  await stopped;
  await until(() => f.children.length === 2);
  f.children[1].stderr.write('https://replacement-phone.trycloudflare.com\nRegistered tunnel connection\n');
  const result = await restarted;
  assert.equal(result.state, 'active');
  assert.equal(f.children[0].killCount, 1);
  assert.equal(f.children[1].killCount, 0);
  assert.ok(result.url.startsWith('https://replacement-phone.trycloudflare.com/phone#token='));
});

test('unexpected process exit removes its link and revokes the old generation', { timeout: 2000 }, async t => {
  const f = fixture(t);
  await f.ready();
  f.children[0].exitCode = 1;
  f.children[0].emit('exit', 1);
  assert.equal(f.controller.getStatus().state, 'error');
  assert.equal(f.controller.getStatus().url, undefined);
  await until(() => f.calls.some(call => call.route === '/api/phone/stop'));
  assert.equal(f.children[0].killCount, 0);
});

test('project changes revoke phone access and device counts update without regenerating the URL', { timeout: 2000 }, async t => {
  const f = fixture(t, { options: { pollIntervalMs: 5 } });
  const active = await f.ready();
  f.setBackendStatus({ active: true, shareId: f.share.shareId, runId: f.share.runId, pairedDevices: 1 });
  await until(() => f.controller.getStatus().pairedDevices === 1);
  assert.equal(f.controller.getStatus().url, active.url);
  f.setBackendStatus({ active: true, shareId: 'new-share', runId: 'another-project', pairedDevices: 0 });
  await until(() => f.controller.getStatus().state === 'error');
  assert.equal(f.controller.getStatus().url, undefined);
  await until(() => f.children[0].killCount === 1);
  assert.deepEqual(f.calls.find(call => call.route === '/api/phone/stop').payload, { shareId: f.share.shareId });
});

test('expiry removes the link and close prevents sharing from restarting', { timeout: 2000 }, async t => {
  const f = fixture(t);
  f.share.expiresAt = new Date(Date.now() + 50).toISOString();
  await f.ready();
  await until(() => f.controller.getStatus().state === 'error');
  assert.match(f.controller.getStatus().error, /expired/);
  assert.equal(f.controller.getStatus().url, undefined);
  await f.controller.close();
  assert.deepEqual(f.controller.getStatus(), { state: 'idle' });
  const result = await f.controller.start();
  assert.equal(result.state, 'error');
  assert.match(result.error, /closing/);
  assert.equal(f.children.length, 1);
});

test('a timed-out backend creation gets conditional revocation if its response arrives later', { timeout: 2000 }, async t => {
  const creation = deferred();
  const f = fixture(t, { creation, options: { requestTimeoutMs: 15 } });
  const result = await f.controller.start();
  assert.equal(result.state, 'error');
  assert.equal(f.children.length, 0);
  creation.resolve({ ...f.share });
  await until(() => f.calls.some(call => call.route === '/api/phone/stop'));
  assert.deepEqual(f.calls.find(call => call.route === '/api/phone/stop').payload, { shareId: f.share.shareId });
});

test('local endpoint validation prevents a tunnel to another machine', { timeout: 2000 }, async t => {
  const f = fixture(t);
  f.share.endpoint = 'https://remote.example:49001';
  const result = await f.controller.start();
  assert.equal(result.state, 'error');
  assert.equal(f.children.length, 0);
  assert.equal(f.calls.filter(call => call.route === '/api/phone/stop').length, 1);
});

test('the main desktop endpoint cannot be used as the public phone origin', { timeout: 2000 }, async t => {
  const f = fixture(t, { options: { desktopEndpoint: () => 'http://127.0.0.1:49001' } });
  const result = await f.controller.start();
  assert.equal(result.state, 'error');
  assert.equal(f.children.length, 0);
  assert.equal(f.calls.filter(call => call.route === '/api/phone/stop').length, 1);
});
