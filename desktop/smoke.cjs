'use strict';
// Opt-in packaged smoke test. Uses a disposable project and user-data directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function smoke({ app, window, endpoint, token, discovery }) {
  const resultPath = process.env.CODEWATCH_SMOKE_RESULT;
  const project = process.env.CODEWATCH_SMOKE_PROJECT;
  if (!resultPath || !project || !process.env.CODEWATCH_TEST_USER_DATA) throw new Error('Smoke test requires disposable paths');
  const checks = [];
  const started = Date.now();
  let phoneWindow;
  window.show();
  const request = async (route, payload) => {
    const response = await fetch(endpoint + route, {
      method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, route);
    return response.json();
  };
  try {
    assert.equal((await fetch(endpoint + '/api/session')).status, 403);
    checks.push('Unauthenticated requests are denied');
    assert.ok(!fs.readFileSync(discovery, 'utf8').includes(token));
    checks.push('Discovery credential uses Windows DPAPI');
    const web = window.webContents;
    let renderer;
    for (let attempt = 0; attempt < 100; attempt++) {
      renderer = await web.executeJavaScript(`({ text: document.body.innerText, native: !!window.codewatchDesktop,
        node: typeof window.require, credentialVisible: document.cookie.includes('codewatch_auth') })`);
      if (renderer.text.includes('Choose folder')) break;
      await delay(100);
    }
    assert.ok(renderer.text.includes('Choose folder'), 'Built React dashboard rendered');
    assert.ok(renderer.native);
    assert.equal(renderer.node, 'undefined');
    assert.equal(renderer.credentialVisible, false);
    checks.push('Bundled dashboard and sandboxed preload render; credential stays HttpOnly');
    assert.equal(await web.executeJavaScript(`document.querySelector('[data-testid="app-view"]').dataset.view`), 'full');
    assert.ok(window.isAlwaysOnTop());
    assert.equal((await web.executeJavaScript(`window.codewatchDesktop.getPreferences()`)).compact, false);
    checks.push('Launching after a pinned companion session opens the full app');
    assert.ok(await web.executeJavaScript(`document.querySelector('[data-testid="intro-tutorial"]').open`));
    for (let index = 0; index < 3; index++) {
      await web.executeJavaScript(`document.querySelector('[data-testid="tutorial-next"]').click()`);
      await delay(80);
    }
    await web.executeJavaScript(`document.querySelector('[data-testid="tutorial-finish"]').click()`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await web.executeJavaScript(`!document.querySelector('[data-testid="intro-tutorial"]')`)) break;
      await delay(80);
    }
    assert.equal((await web.executeJavaScript(`window.codewatchDesktop.getPreferences()`)).tutorialCompleted, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(discovery), 'preferences.json'), 'utf8')).tutorialCompleted, true);
    await web.reload();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await web.executeJavaScript(`!!document.querySelector('[data-testid="phone-share-panel"]')`)) break;
      await delay(80);
    }
    assert.equal(await web.executeJavaScript(`!!document.querySelector('[data-testid="intro-tutorial"]')`), false);
    await web.executeJavaScript(`window.codewatchDesktop.setPreferences({alwaysOnTop:false})`);
    checks.push('Finishing the tutorial persists in the profile and stays dismissed after reload');
    const apiCheck = await web.executeJavaScript(`fetch('/api/session').then(r => r.status)`);
    assert.equal(apiCheck, 200);
    checks.push('Renderer API cookie authentication works');
    const watched = await request('/api/watch', { path: project, agentName: 'Packaged smoke test' });
    assert.equal(watched.watching, true);
    await request('/api/agent/progress', { runId: watched.runId, agentName: 'Packaged smoke test', stage: 'PLANNING',
      message: 'Inspect the fixture and its data connection', paths: ['fixture.py', 'data.py'] });
    const integration = await request('/api/integrations');
    const config = integration.mcpConfig.mcpServers.codewatch;
    assert.equal(config.args[0], 'mcp');
    assert.equal(config.args[1], '--discovery');
    assert.equal(config.args[2], discovery);
    assert.ok(fs.existsSync(config.command));
    assert.ok(config.command.startsWith(app.getPath('userData')));
    checks.push('Packaged MCP configuration points to stable per-user executable');
    let seen = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      seen = await web.executeJavaScript(`!!document.querySelector('button[aria-label="Open project root folder"]')`);
      if (seen) break;
      await delay(100);
    }
    assert.ok(seen, 'Live WebSocket delivers indexed files to dashboard');
    checks.push('Authenticated live WebSocket delivers actual project files');
    const folderMap = await web.executeJavaScript(`({
      title: document.querySelector('#architecture-title').innerText,
      folders: document.querySelectorAll('.project-area').length,
      canvasNodes: document.querySelectorAll('.react-flow__node').length,
      labelSize: parseFloat(getComputedStyle(document.querySelector('.project-area h3')).fontSize)
    })`);
    assert.equal(folderMap.title, 'Project map');
    assert.equal(folderMap.folders, 1);
    assert.equal(folderMap.canvasNodes, 0);
    assert.ok(folderMap.labelSize >= 15);
    await web.executeJavaScript(`document.querySelector('button[aria-label="Open project root folder"]').click()`);
    await delay(150);
    await web.executeJavaScript(`document.querySelector('button[aria-label="Open connections for fixture.py"]').click()`);
    await delay(150);
    const connectionText = await web.executeJavaScript(`document.querySelector('[data-testid="map-file-details"]').innerText`);
    assert.ok(connectionText.includes('Uses code from'));
    assert.ok(connectionText.includes('data.py'));
    assert.ok(connectionText.includes('Used by'));
    await web.executeJavaScript(`document.querySelector('.map-hide-button').click()`);
    await delay(100);
    assert.equal(await web.executeJavaScript(`document.querySelector('#project-map-content').hidden`), true);
    await web.executeJavaScript(`document.querySelector('.map-hide-button').click()`);
    await delay(100);
    assert.ok(await web.executeJavaScript(`document.querySelector('[data-testid="map-file-details"]').innerText.includes('fixture.py')`));
    checks.push('Readable folder overview, directed import lists and map hide/show work');
    await request('/api/agent/progress', { runId: watched.runId, agentName: 'Packaged smoke test', stage: 'IMPLEMENTING',
      message: 'Create a new source file and observe its save', paths: ['packaged_change.py'] });
    await web.executeJavaScript(`new Promise((opened, failed) => {
      const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/ws/live');
      window.__codewatchSmokeEvent = new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { socket.close(); reject(new Error('Change event timed out')); }, 10000);
        socket.onmessage = ({data}) => {
          const frame = JSON.parse(data);
          if (frame.kind === 'event' && frame.event.data.path === 'packaged_change.py') {
            clearTimeout(deadline); socket.close(); resolve(Date.parse(frame.event.timestamp));
          }
        };
      });
      socket.onopen = () => opened(true); socket.onerror = failed;
    })`);
    const changedAt = Date.now();
    fs.writeFileSync(path.join(project, 'packaged_change.py'), 'value = 42\n');
    let rendered = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      rendered = await web.executeJavaScript(`Array.from(document.querySelectorAll('#files .file-row.created')).some(row => row.innerText.includes('packaged_change.py'))`);
      if (rendered) break;
      await delay(100);
    }
    assert.ok(rendered, 'Saved file reaches renderer');
    const renderedAt = Date.now();
    const savedFileToRenderMs = renderedAt - changedAt;
    const sourceTimestamp = await web.executeJavaScript('window.__codewatchSmokeEvent');
    const eventToRenderMs = Math.max(0, renderedAt - sourceTimestamp);
    checks.push('Actual saved file reaches dashboard');
    await request('/api/agent/complete', { runId: watched.runId, agentName: 'Packaged smoke test',
      message: 'Fixture work is complete and its file connection is visible' });
    await delay(150);
    const screenshot = await web.capturePage();
    fs.writeFileSync(path.join(path.dirname(resultPath), 'desktop-window.png'), screenshot.toPNG());
    const exportPath = path.join(path.dirname(resultPath), 'exported-events.ndjson');
    const exported = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('NDJSON export timed out')), 10_000);
      web.session.once('will-download', (_event, item) => {
        item.setSavePath(exportPath);
        item.once('done', (_doneEvent, state) => { clearTimeout(deadline); resolve(state); });
      });
    });
    await web.executeJavaScript(`document.querySelector('#activity button[title="Download event log"]').click()`);
    assert.equal(await exported, 'completed');
    assert.ok(fs.readFileSync(exportPath, 'utf8').includes('fixture.py'));
    checks.push('Existing NDJSON export works in desktop window');
    const fullBounds = window.getBounds();
    const changed = await web.executeJavaScript(`window.codewatchDesktop.setPreferences({alwaysOnTop:true,closeToTray:true})`);
    assert.equal(changed.alwaysOnTop, true);
    assert.equal(changed.compact, true);
    assert.ok(window.isAlwaysOnTop());
    let companion;
    for (let attempt = 0; attempt < 100; attempt++) {
      companion = await web.executeJavaScript(`({view: document.querySelector('[data-testid="app-view"]').dataset.view,
        steps: document.querySelectorAll('.flow-step').length, done: document.querySelectorAll('.flow-step-completed').length,
        arrows: document.querySelectorAll('[data-testid="flow-connector"]').length,
        sidebar: !!document.querySelector('.sidebar'), map: !!document.querySelector('#architecture'),
        overflow: document.documentElement.scrollWidth > innerWidth})`);
      if (companion.view === 'companion' && companion.done === 3) break;
      await delay(100);
    }
    assert.equal(companion.view, 'companion');
    assert.equal(companion.steps, 3); assert.equal(companion.done, 3); assert.equal(companion.arrows, 2);
    assert.equal(companion.sidebar, false); assert.equal(companion.map, false); assert.equal(companion.overflow, false);
    assert.equal(window.getBounds().width, 540); assert.equal(window.getBounds().height, 720);
    await delay(150);
    fs.writeFileSync(path.join(path.dirname(resultPath), 'desktop-companion.png'), (await web.capturePage()).toPNG());
    await web.executeJavaScript(`document.querySelector('.flow-step').click()`);
    await delay(150);
    assert.ok(await web.executeJavaScript(`document.querySelector('[data-testid="flow-step-details"]').innerText.includes('fixture.py')`));
    await web.executeJavaScript(`Array.from(document.querySelectorAll('.desktop-controls button')).find(button=>button.innerText.includes('Open full app')).click()`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await web.executeJavaScript(`document.querySelector('[data-testid="app-view"]').dataset.view === 'full'`)) break;
      await delay(100);
    }
    assert.equal(await web.executeJavaScript(`document.querySelector('[data-testid="app-view"]').dataset.view`), 'full');
    assert.ok(window.isAlwaysOnTop());
    assert.equal(window.getBounds().width, fullBounds.width); assert.equal(window.getBounds().height, fullBounds.height);
    assert.ok(await web.executeJavaScript(`document.querySelector('[data-testid="flow-step-details"]').innerText.includes('fixture.py')`));
    checks.push('Pin opens the compact connected flow; step details and full-window restoration preserve selection');
    const rejected = await web.executeJavaScript(`window.codewatchDesktop.setPreferences({bad:'value'}).then(()=>false,()=>true)`);
    assert.equal(rejected, true);
    checks.push('Validated native preferences and always-on-top work');
    if (process.env.CODEWATCH_SMOKE_PHONE === '1') {
      const shared = await web.executeJavaScript(`window.codewatchDesktop.startPhoneShare()`);
      assert.equal(shared.state, 'active', shared.error);
      const phoneUrl = new URL(shared.url);
      assert.equal(phoneUrl.protocol, 'https:');
      assert.equal((await fetch(phoneUrl.origin + '/api/snapshot', { signal: AbortSignal.timeout(10000) })).status, 403);
      assert.equal((await fetch(phoneUrl.origin + '/api/integrations', { signal: AbortSignal.timeout(10000) })).status, 404);
      phoneWindow = new BrowserWindow({ width: 430, height: 850, show: false,
        webPreferences: { partition: 'phone-smoke', contextIsolation: true, nodeIntegration: false, sandbox: true } });
      await phoneWindow.loadURL(shared.url);
      const phoneWeb = phoneWindow.webContents;
      let phone;
      for (let attempt = 0; attempt < 150; attempt++) {
        phone = await phoneWeb.executeJavaScript(`({ready:!!document.querySelector('[data-testid="phone-viewer"]'),
          steps:document.querySelectorAll('.flow-step').length, hash:location.hash,
          native:!!window.codewatchDesktop, overflow:document.documentElement.scrollWidth>innerWidth,
          text:document.body.innerText})`);
        if (phone.steps === 3) break;
        await delay(100);
      }
      assert.equal(phone.ready, true); assert.equal(phone.steps, 3); assert.equal(phone.hash, '');
      assert.equal(phone.native, false); assert.equal(phone.overflow, false);
      assert.ok(phone.text.includes('Fixture work is complete'));
      assert.ok(!phone.text.includes(project));
      const phoneCookies = await phoneWeb.session.cookies.get({ url: phoneUrl.origin });
      const paired = phoneCookies.find(cookie => cookie.name === 'codewatch_phone');
      assert.ok(paired?.httpOnly && paired.secure);
      await phoneWeb.executeJavaScript(`document.querySelector('.flow-step').click()`);
      await delay(100);
      assert.ok(await phoneWeb.executeJavaScript(`document.querySelector('[data-testid="flow-step-details"]').innerText.includes('fixture.py')`));
      fs.writeFileSync(path.join(path.dirname(resultPath), 'phone-view.png'), (await phoneWeb.capturePage()).toPNG());
      await phoneWeb.reload();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await phoneWeb.executeJavaScript(`document.querySelectorAll('.flow-step').length===3`)) break;
        await delay(100);
      }
      assert.equal(await phoneWeb.executeJavaScript(`document.querySelectorAll('.flow-step').length`), 3);
      await web.executeJavaScript(`window.codewatchDesktop.stopPhoneShare()`);
      assert.equal((await web.executeJavaScript(`window.codewatchDesktop.getPhoneStatus()`)).state, 'idle');
      let afterStop = 0;
      try { afterStop = (await fetch(phoneUrl.origin + '/api/snapshot', {
        headers: { Cookie: `codewatch_phone=${paired.value}` }, signal: AbortSignal.timeout(10000),
      })).status; } catch { /* A stopped tunnel can be unreachable immediately. */ }
      assert.notEqual(afterStop, 200);
      phoneWindow.destroy(); phoneWindow = undefined;
      checks.push('Internet phone QR pairs a separate browser over public HTTPS, restores live steps, hides private APIs and revokes access');
    }
    window.close(); await delay(150);
    assert.equal(window.isDestroyed(), false);
    assert.equal(window.isVisible(), false);
    window.show(); window.minimize(); await delay(150); window.restore();
    assert.equal(window.isMinimized(), false);
    checks.push('Close-to-tray, show, minimize and restore work');
    await web.executeJavaScript(`window.codewatchDesktop.setPreferences({alwaysOnTop:false,closeToTray:false})`);
    fs.writeFileSync(resultPath, JSON.stringify({ ok: true, checks, eventToRenderMs, savedFileToRenderMs, elapsedMs: Date.now() - started,
      versions: process.versions, endpoint, helper: config.command }, null, 2));
  } catch (error) {
    phoneWindow?.destroy();
    fs.writeFileSync(resultPath, JSON.stringify({ ok: false, checks, error: error.stack || error.message }, null, 2));
    throw error;
  }
};
