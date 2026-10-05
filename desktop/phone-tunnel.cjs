'use strict';
const { spawn: spawnProcess } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CANCELLED = Symbol('phone-sharing-cancelled');
const CONNECTION_ERROR = 'Could not connect the phone link. Check your internet connection and try again.';

function publicOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(url.hostname) &&
      url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}
function localEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port &&
      !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}
function unref(timer) { timer?.unref?.(); return timer; }

/** Owns one opt-in tunnel to the backend's separate, read-only phone service. */
function createPhoneTunnel(options) {
  const { request, executable, onChange = () => {}, log = () => {} } = options;
  if (typeof request !== 'function' || typeof executable !== 'function') throw new TypeError('Phone sharing requires a backend and tunnel executable');
  const spawn = options.spawn ?? spawnProcess;
  const publicFetch = options.fetch ?? globalThis.fetch;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  const probeRetryMs = options.probeRetryMs ?? 1_000;
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 3_000;
  const now = options.now ?? Date.now;
  let status = { state: 'idle' }, current, startFlight, stopFlight, closed = false;

  const getStatus = () => ({ ...status });
  function publish(value) {
    status = value;
    try { onChange(getStatus()); } catch { /* Renderer listeners do not own tunnel lifecycle. */ }
  }
  function diagnostic(message) { try { log(message); } catch { /* Best-effort, never raw child output or credentials. */ } }
  function bounded(promise, milliseconds, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = unref(setTimeout(() => reject(new Error(message)), milliseconds));
    })]).finally(() => clearTimeout(timer));
  }
  function backend(route, data) {
    return bounded(Promise.resolve().then(() => request(route, data)), requestTimeoutMs,
      'The phone sharing service did not respond. Restart CodeWatch and try again.');
  }
  function cancel(operation, message) {
    if (operation.cancelled) return;
    operation.cancelled = true;
    operation.failure = message;
    operation.abort.abort();
    operation.cancelResolve(CANCELLED);
    clearTimeout(operation.deadline); clearTimeout(operation.expiry); clearInterval(operation.poll);
    for (const timer of operation.delays) clearTimeout(timer);
    operation.delays.clear();
  }
  async function cancellable(promise, operation) {
    const value = await Promise.race([promise, operation.cancelPromise]);
    if (value === CANCELLED || operation.cancelled) throw CANCELLED;
    return value;
  }
  function delay(operation) {
    return cancellable(new Promise(resolve => {
      const timer = unref(setTimeout(() => { operation.delays.delete(timer); resolve(); }, probeRetryMs));
      operation.delays.add(timer);
    }), operation);
  }
  async function terminate(operation) {
    const child = operation.child;
    if (!child || operation.exited || child.exitCode !== null && child.exitCode !== undefined) return;
    await new Promise(resolve => {
      let finished = false, timer;
      const done = () => {
        if (finished) return;
        finished = true; clearTimeout(timer); child.removeListener('exit', done); resolve();
      };
      child.once('exit', done);
      timer = unref(setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* It may have exited after the deadline. */ }
        done();
      }, shutdownTimeoutMs));
      try { if (!child.kill()) done(); } catch { done(); }
    });
  }
  function cleanup(operation) {
    if (operation.cleanup) return operation.cleanup;
    cancel(operation, operation.failure);
    operation.cleanup = (async () => {
      // A cancelled start may still be creating a local listener. Wait for its
      // bounded response before revoking, so a late start cannot undo a stop.
      if (operation.creation) {
        try { const value = await operation.creation; operation.share ??= { ...value }; } catch { /* No public tunnel exists yet. */ }
      }
      if (typeof operation.share?.shareId === 'string') {
        try { await backend('/api/phone/stop', { shareId: operation.share.shareId }); }
        catch { diagnostic('Phone sharing revocation could not be confirmed; stopping its owned tunnel.'); }
      }
      await terminate(operation);
      if (operation.share) operation.share.pairToken = '';
      if (operation.temporary) {
        const directory = path.resolve(operation.temporary);
        if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('codewatch-phone-')) {
          try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* Owned temporary configuration only. */ }
        }
      }
    })();
    return operation.cleanup;
  }
  function fail(operation, message) {
    if (current !== operation || operation.cancelled) return;
    cancel(operation, message);
    publish({ state: 'error', error: message });
    void cleanup(operation).then(() => { if (current === operation) current = undefined; });
  }
  function configFile(operation) {
    let file = typeof options.configPath === 'function' ? options.configPath() : options.configPath;
    if (!file) {
      operation.temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codewatch-phone-'));
      file = path.join(operation.temporary, 'empty.yml');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // An explicit empty config avoids inheriting a user's named-tunnel routing.
    fs.writeFileSync(file, '{}\n', { mode: 0o600 });
    return file;
  }
  function observeOutput(operation, stream) {
    let buffer = '';
    const line = value => {
      for (const match of value.matchAll(/https:\/\/[^\s"'<>|]+/g)) {
        const origin = publicOrigin(match[0].replace(/[),;]+$/, ''));
        if (origin && !operation.origin) operation.origin = origin;
      }
      if (value.includes('Registered tunnel connection')) operation.registered = true;
      if (operation.origin && operation.registered) operation.readyResolve(operation.origin);
    };
    stream?.on('data', bytes => {
      buffer += bytes.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop().slice(-16_384);
      for (const value of lines) line(value);
    });
    stream?.on('end', () => { if (buffer) line(buffer); buffer = ''; });
  }
  async function publicReady(operation, origin) {
    while (!operation.cancelled) {
      try {
        const response = await cancellable(publicFetch(origin + '/phone/health', {
          method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.any([operation.abort.signal, AbortSignal.timeout(probeTimeoutMs)]),
        }), operation);
        if (response.ok && response.headers.get('content-type')?.includes('application/json') &&
            Number(response.headers.get('content-length') || 0) <= 4096) {
          const health = await cancellable(response.json(), operation);
          if (health?.active === true && health.shareId === operation.share.shareId) return;
        }
      } catch { if (operation.cancelled) throw CANCELLED; }
      await delay(operation);
    }
    throw CANCELLED;
  }
  async function check(operation) {
    if (current !== operation || operation.cancelled || operation.checking) return;
    operation.checking = true;
    try {
      const value = await backend('/api/phone/status');
      if (current !== operation || operation.cancelled) return;
      if (!value?.active || value.shareId !== operation.share.shareId || value.runId !== operation.share.runId) {
        fail(operation, 'Phone sharing ended. Start a new link for your current project.');
      } else if (Number.isInteger(value.pairedDevices) && value.pairedDevices >= 0 && value.pairedDevices !== status.pairedDevices) {
        publish({ ...status, pairedDevices: value.pairedDevices });
      }
    } catch { fail(operation, 'Phone sharing lost connection to CodeWatch. Start a new link.'); }
    finally { operation.checking = false; }
  }
  async function runStart(operation) {
    try {
      const binary = await cancellable(Promise.resolve().then(executable), operation);
      if (typeof binary !== 'string' || !binary) throw new Error('Missing tunnel executable');
      const creation = Promise.resolve().then(() => request('/api/phone/start', {}));
      operation.creationSettled = false;
      // If a timed-out backend responds later, revoke only that generation.
      void creation.then(value => {
        operation.creationSettled = true;
        if (operation.creationTimedOut && typeof value?.shareId === 'string') {
          void backend('/api/phone/stop', { shareId: value.shareId }).catch(() => {});
        }
      }, () => { operation.creationSettled = true; });
      operation.creation = bounded(creation, requestTimeoutMs, 'The phone sharing service did not respond. Restart CodeWatch and try again.')
        .catch(error => { operation.creationTimedOut = !operation.creationSettled; throw error; });
      const value = await operation.creation;
      const endpoint = localEndpoint(value?.endpoint);
      const desktop = typeof options.desktopEndpoint === 'function' ? options.desktopEndpoint() : options.desktopEndpoint;
      if (!endpoint || endpoint === desktop || typeof value.shareId !== 'string' || !value.shareId || typeof value.runId !== 'string' || !value.runId ||
          typeof value.pairToken !== 'string' || !/^[a-zA-Z0-9_-]{24,512}$/.test(value.pairToken) ||
          !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now()) throw new Error('Invalid phone sharing response');
      operation.share = { ...value, endpoint };
      if (operation.cancelled) throw CANCELLED;
      const config = configFile(operation);
      const env = { ...process.env };
      for (const name of Object.keys(env)) if (/^TUNNEL_/i.test(name)) delete env[name];
      operation.child = spawn(binary, ['tunnel', '--config', config, '--no-autoupdate', '--protocol', 'http2', '--url', endpoint], {
        windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env,
      });
      operation.child.on('error', () => fail(operation, CONNECTION_ERROR));
      operation.child.on('exit', () => {
        operation.exited = true;
        if (!operation.cancelled) fail(operation, 'The phone connection closed. Start a new link.');
      });
      observeOutput(operation, operation.child.stdout); observeOutput(operation, operation.child.stderr);
      const origin = await cancellable(operation.ready, operation);
      await cancellable(backend('/api/phone/activate', { shareId: value.shareId, publicUrl: origin }), operation);
      await publicReady(operation, origin);
      if (operation.cancelled) throw CANCELLED;
      const remaining = Date.parse(value.expiresAt) - now();
      if (remaining <= 0) throw new Error('Expired phone link');
      clearTimeout(operation.deadline);
      publish({ state: 'active', url: `${origin}/phone#token=${encodeURIComponent(value.pairToken)}`,
        expiresAt: value.expiresAt, pairedDevices: 0 });
      operation.expiry = unref(setTimeout(() => fail(operation, 'This phone link expired. Start a new link.'), Math.min(remaining, 2_147_483_647)));
      operation.poll = unref(setInterval(() => { void check(operation); }, pollIntervalMs));
      diagnostic('Phone sharing connected to its read-only service.');
      return getStatus();
    } catch (error) {
      if (!operation.cancelled) {
        cancel(operation, error instanceof Error && error.message.startsWith('The phone sharing service') ? error.message : CONNECTION_ERROR);
        if (current === operation) publish({ state: 'error', error: operation.failure });
      }
      await cleanup(operation);
      if (current === operation) current = undefined;
      return getStatus();
    }
  }
  function start() {
    if (closed) return Promise.resolve({ state: 'error', error: 'CodeWatch is closing. Open the app to start phone sharing.' });
    if (stopFlight) return stopFlight.then(start);
    if (startFlight) return startFlight;
    if (status.state === 'active') return Promise.resolve(getStatus());
    // Do not create a replacement until an expired or failed generation is gone.
    if (current?.cleanup) return current.cleanup.then(start);
    const operation = { cancelled: false, exited: false, abort: new AbortController(), delays: new Set() };
    operation.cancelPromise = new Promise(resolve => { operation.cancelResolve = resolve; });
    operation.ready = new Promise(resolve => { operation.readyResolve = resolve; });
    current = operation;
    publish({ state: 'starting' });
    operation.deadline = unref(setTimeout(() => fail(operation, CONNECTION_ERROR), connectionTimeoutMs));
    startFlight = runStart(operation);
    const flight = startFlight;
    void flight.finally(() => { if (startFlight === flight) startFlight = undefined; });
    return flight;
  }
  function stop() {
    if (stopFlight) return stopFlight;
    const operation = current;
    if (operation) cancel(operation);
    publish({ state: 'idle' });
    const flight = startFlight;
    stopFlight = (async () => {
      if (operation) await cleanup(operation);
      if (flight) await flight;
      if (current === operation) current = undefined;
      return getStatus();
    })();
    const stopping = stopFlight;
    void stopping.finally(() => { if (stopFlight === stopping) stopFlight = undefined; });
    return stopping;
  }
  async function close() { closed = true; await stop(); }
  return Object.freeze({ start, stop, getStatus, close });
}

module.exports = { createPhoneTunnel };
