import { expect, test } from '@playwright/test';
import type { AgentEvent } from '../src/types/events';

const runId = 'watch_phone_notifications';
const session = { runId, projectPath: '', projectName: 'Phone alerts project', agentName: 'Test agent', watching: true, connectedAt: '2026-10-05T12:00:00Z', lastActivityAt: '2026-10-05T12:00:00Z', eventCount: 1, trackedFiles: 1, warnings: [] };
const planning: AgentEvent = { schemaVersion: 1, runId, eventId: 'plan-1', timestamp: '2026-10-05T12:00:00Z', sequence: 1, source: 'agent', agentName: 'Test agent', status: 'running', type: 'agent_stage', data: { stage: 'PLANNING', message: 'Plan a small task' } };
const snapshot = { kind: 'snapshot', session, events: [planning], graph: { nodes: [], edges: [] } };

test('phone alerts request permission from a tap and persist a private push subscription', async ({ page }) => {
  const calls: string[] = [];
  let enabled = false;
  await page.route('**/api/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/push/status', route => route.fulfill({ json: { enabled, publicKey: 'AQIDBA' } }));
  await page.route('**/api/push/subscribe', async route => {
    calls.push('subscribe');
    expect(route.request().postDataJSON()).toEqual({ endpoint: 'https://push.test.example/private', keys: { auth: 'private-auth', p256dh: 'private-key' } });
    enabled = true;
    await route.fulfill({ json: { enabled: true } });
  });
  await page.route('**/api/push/unsubscribe', async route => { calls.push('unsubscribe'); enabled = false; await route.fulfill({ json: { enabled: false } }); });
  await page.addInitScript(() => {
    const operations: string[] = [];
    const subscription = { toJSON: () => ({ endpoint: 'https://push.test.example/private', keys: { auth: 'private-auth', p256dh: 'private-key' } }), unsubscribe: async () => { operations.push('browser-unsubscribe'); return true; } };
    const worker = { pushManager: { getSubscription: async () => null, subscribe: async () => { operations.push('browser-subscribe'); return subscription; } } };
    Object.defineProperty(window, 'Notification', { configurable: true, value: { requestPermission: async () => { operations.push('permission'); return 'granted'; } } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: async (path: string, options: { scope: string }) => { operations.push(`register:${path}:${options.scope}`); return worker; }, ready: Promise.resolve(worker), getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) } });
    Object.assign(window, { phoneAlertOperations: () => [...operations] });
  });
  await page.goto('/phone');
  const alerts = page.getByTestId('phone-notifications');
  await expect(alerts.getByRole('button', { name: 'Enable completion alerts', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { phoneAlertOperations: () => string[] }).phoneAlertOperations())).toEqual([]);
  await alerts.getByRole('button', { name: 'Enable completion alerts', exact: true }).click();
  await expect(alerts).toContainText('Alerts enabled on this phone');
  expect(await page.evaluate(() => (window as unknown as { phoneAlertOperations: () => string[] }).phoneAlertOperations())).toEqual(['permission', 'register:/phone-sw.js:/phone', 'browser-subscribe']);
  await page.reload();
  await expect(alerts).toContainText('Alerts enabled on this phone');
  await alerts.getByRole('button', { name: 'Turn off alerts', exact: true }).click();
  await expect(alerts.getByRole('button', { name: 'Enable completion alerts', exact: true })).toBeEnabled();
  expect(calls).toEqual(['subscribe', 'unsubscribe']);
  await expect(page.locator('body')).not.toContainText('private-auth');
  await expect(page.locator('body')).not.toContainText('private-key');
});

test('a separately installed phone view can pair from its current private link without storing the secret', async ({ page }) => {
  const tokens: string[] = [];
  let paired = false;
  await page.route('**/api/snapshot', route => paired ? route.fulfill({ json: snapshot }) : route.fulfill({ status: 403, json: { detail: 'not paired' } }));
  await page.route('**/api/pair', async route => { tokens.push(route.request().postDataJSON().token); paired = true; await route.fulfill({ json: { paired: true } }); });
  await page.route('**/api/push/status', route => route.fulfill({ json: { enabled: false, publicKey: 'AQIDBA' } }));
  await page.goto('/phone');
  await expect(page.getByRole('button', { name: 'Pair this phone', exact: true })).toBeVisible();
  await page.getByLabel('Private phone link', { exact: true }).fill('https://other.example/phone#token=do-not-send');
  await page.getByRole('button', { name: 'Pair this phone', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Paste the private phone link' })).toBeVisible();
  expect(tokens).toEqual([]);
  const origin = new URL(page.url()).origin;
  await page.getByLabel('Private phone link', { exact: true }).fill(`${origin}/phone#token=phone-pairing-secret`);
  await page.getByRole('button', { name: 'Pair this phone', exact: true }).click();
  await expect(page.getByTestId('flow-current-report')).toContainText('Plan a small task');
  expect(tokens).toEqual(['phone-pairing-secret']);
  expect(new URL(page.url()).hash).toBe('');
  const stored = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), text: document.body.innerText }));
  for (const value of Object.values(stored)) expect(value).not.toContain('phone-pairing-secret');
  await expect(page.getByLabel('Private phone link', { exact: true })).toHaveCount(0);
});

test('denied permission leaves phone alerts off without creating a subscription', async ({ page }) => {
  let subscribed = false;
  await page.route('**/api/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/push/status', route => route.fulfill({ json: { enabled: false, publicKey: 'AQIDBA' } }));
  await page.route('**/api/push/subscribe', async route => { subscribed = true; await route.fulfill({ json: { enabled: true } }); });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Notification', { configurable: true, value: { requestPermission: async () => 'denied' } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: () => { throw new Error('Registration must not occur before permission'); } } });
  });
  await page.goto('/phone');
  const alerts = page.getByTestId('phone-notifications');
  await expect(alerts.getByRole('button', { name: 'Enable completion alerts', exact: true })).toBeEnabled();
  await alerts.getByRole('button', { name: 'Enable completion alerts', exact: true }).click();
  await expect(alerts.getByRole('alert')).toContainText('Notifications are blocked');
  await expect(alerts.getByRole('button', { name: 'Enable completion alerts', exact: true })).toBeEnabled();
  await expect(alerts).not.toContainText('Alerts enabled on this phone');
  expect(subscribed).toBe(false);
});

test('iPhone browsers explain Home Screen installation before offering background alerts', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 Version/17.6 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.route('**/api/snapshot', route => route.fulfill({ json: snapshot }));
    await page.route('**/api/pair', route => route.fulfill({ json: { paired: true } }));
    await page.route('**/api/push/status', route => route.fulfill({ json: { enabled: false, publicKey: 'AQIDBA' } }));
    await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { Object.assign(window, { copiedPhoneLink: value }); } } }); });
    await page.goto('http://127.0.0.1:5173/phone#token=private-install-link');
    const alerts = page.getByTestId('phone-notifications');
    await expect(alerts).toContainText('Add to Home Screen');
    await expect(alerts).toContainText('paste the private phone link');
    await expect(alerts.getByRole('button', { name: 'Enable completion alerts', exact: true })).toHaveCount(0);
    await alerts.getByRole('button', { name: 'Copy pairing link', exact: true }).click();
    await expect(alerts).toContainText('Copied. Paste this link into CodeWatch');
    expect(await page.evaluate(() => (window as unknown as { copiedPhoneLink: string }).copiedPhoneLink)).toBe('http://127.0.0.1:5173/phone#token=private-install-link');
    await expect(page.locator('body')).not.toContainText('private-install-link');
    expect(new URL(page.url()).hash).toBe('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); }
});

test('the real service worker displays a background push after the phone view leaves the page', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  await page.route('**/api/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/push/status', route => route.fulfill({ json: { enabled: false, publicKey: 'AQIDBA' } }));
  const protocol = await context.newCDPSession(page);
  let registrationId: string | undefined;
  protocol.on('ServiceWorker.workerRegistrationUpdated', value => {
    const registration = value.registrations.find(item => item.scopeURL === 'http://127.0.0.1:5173/phone');
    if (registration) registrationId = registration.registrationId;
  });
  await protocol.send('ServiceWorker.enable');
  await page.goto('/phone');
  await page.evaluate(async () => { await navigator.serviceWorker.register('/phone-sw.js', { scope: '/phone' }); await navigator.serviceWorker.ready; });
  await expect.poll(() => registrationId).toBeTruthy();
  await page.goto('about:blank');
  await protocol.send('ServiceWorker.deliverPushMessage', { origin: 'http://127.0.0.1:5173', registrationId: registrationId!, data: JSON.stringify({ eventId: 'background-complete', runId, title: 'Work reported complete', body: 'Phone alerts project', tag: 'codewatch-background', url: 'https://untrusted.example/' }) });
  await page.goto('/phone');
  await expect.poll(async () => page.evaluate(async () => {
    const worker = await navigator.serviceWorker.getRegistration('/phone');
    const notifications = await worker?.getNotifications();
    return notifications?.map(item => ({ title: item.title, body: item.body, data: item.data }));
  })).toEqual([{ title: 'Work reported complete', body: 'Phone alerts project', data: { runId, eventId: 'background-complete' } }]);
  await page.evaluate(async () => { const worker = await navigator.serviceWorker.getRegistration('/phone'); for (const notification of await worker?.getNotifications() ?? []) notification.close(); await worker?.unregister(); });
  await protocol.detach();
});

test('enabling alerts replaces a surviving subscription from an older share key', async ({ page }) => {
  let postedEndpoint: string | undefined;
  await page.route('**/api/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/push/status', route => route.fulfill({ json: { enabled: false, publicKey: 'AQIDBA' } }));
  await page.route('**/api/push/subscribe', async route => { postedEndpoint = route.request().postDataJSON().endpoint; await route.fulfill({ json: { enabled: true } }); });
  await page.addInitScript(() => {
    const operations: string[] = [];
    const previous = { unsubscribe: async () => { operations.push('old-subscription-removed'); return true; } };
    const worker = { pushManager: { getSubscription: async () => previous, subscribe: async () => { operations.push('new-subscription-created'); return { toJSON: () => ({ endpoint: 'https://push.test.example/new-key', keys: { auth: 'new-auth', p256dh: 'new-key' } }) }; } } };
    Object.defineProperty(window, 'Notification', { configurable: true, value: { requestPermission: async () => 'granted' } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: async () => worker, ready: Promise.resolve(worker) } });
    Object.assign(window, { phoneAlertOperations: () => [...operations] });
  });
  await page.goto('/phone');
  const alerts = page.getByTestId('phone-notifications');
  await expect(alerts.getByRole('button', { name: 'Enable completion alerts', exact: true })).toBeEnabled();
  await alerts.getByRole('button', { name: 'Enable completion alerts', exact: true }).click();
  await expect(alerts).toContainText('Alerts enabled on this phone');
  expect(postedEndpoint).toBe('https://push.test.example/new-key');
  expect(await page.evaluate(() => (window as unknown as { phoneAlertOperations: () => string[] }).phoneAlertOperations())).toEqual(['old-subscription-removed', 'new-subscription-created']);
});
