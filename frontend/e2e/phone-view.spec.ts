import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { DesktopPreferences, PhoneShareStatus } from '../src/types/desktop';

const localRoot = resolve('..', '.local');
async function projectFixture() {
  await mkdir(localRoot, { recursive: true });
  const project = await mkdtemp(resolve(localRoot, 'codewatch-phone-e2e-'));
  await mkdir(resolve(project, 'src'));
  await writeFile(resolve(project, 'src/data.ts'), 'export const data = 1;\n');
  await writeFile(resolve(project, 'src/app.ts'), "import { data } from './data';\nexport const app = data;\n");
  return project;
}
async function removeFixture(project: string) {
  if (!project.startsWith(localRoot + sep)) throw new Error('Temporary phone project must stay within .local');
  await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

test('a paired phone follows real reported work with a private cookie and a limited read-only projection', async ({ page, request }) => {
  const project = await projectFixture();
  let runId: string | undefined;
  let shareId: string | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    expect((await request.post('/api/watch', { data: { path: project, agentName: 'Phone test agent' } })).ok()).toBe(true);
    runId = (await (await request.get('/api/session')).json()).session.runId;
    expect((await request.post('/api/agent/progress', { data: { runId, stage: 'PLANNING', message: `Plan the app connection in ${project}`, paths: ['src/app.ts'] } })).ok()).toBe(true);
    const started = await request.post('/api/phone/start', { data: {} });
    expect(started.ok()).toBe(true);
    const share = await started.json() as { endpoint: string; pairToken: string; shareId: string };
    shareId = share.shareId;
    expect((await request.get(share.endpoint + '/api/snapshot')).status()).toBe(403);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${share.endpoint}/phone#token=${encodeURIComponent(share.pairToken)}`);
    await expect(page.getByTestId('phone-viewer')).toBeVisible();
    await expect(page.getByTestId('flow-current-report')).toContainText('Plan the app connection');
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    await expect(page.getByTestId('intro-tutorial')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Always on top', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Watch project', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Connect your AI/ })).toHaveCount(0);
    const cookie = (await page.context().cookies(share.endpoint)).find(item => item.name === 'codewatch_phone');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    expect(await page.evaluate(() => document.cookie)).not.toContain('codewatch_phone');
    expect((await page.request.get(share.endpoint + '/api/integrations')).status()).toBe(404);
    expect((await page.request.post(share.endpoint + '/api/watch', { data: { path: project } })).status()).toBe(404);

    await writeFile(resolve(project, 'src/app.ts'), "import { data } from './data';\nexport const app = data + 1;\n");
    await expect(page.locator('.file-row').filter({ hasText: 'app.ts' })).toContainText('Observed file change');
    await page.locator('.flow-step').filter({ hasText: 'Plan the app connection' }).click();
    await expect(page.getByTestId('flow-step-details')).toContainText('src/app.ts');
    await expect(page.getByTestId('flow-step-details')).toContainText('Observed file change');
    await expect(page.getByTestId('flow-step-details')).toContainText('modified');
    await expect(page.getByTestId('flow-step-details')).toContainText('src/data.ts');
    expect((await request.post('/api/agent/progress', { data: { runId, stage: 'IMPLEMENTING', message: 'Connect the app to its data', paths: ['src/app.ts'] } })).ok()).toBe(true);
    await writeFile(resolve(project, 'src/data.ts'), 'export const data = 2;\n');
    await expect(page.getByTestId('flow-current-report')).toContainText('Connect the app to its data');
    await expect(page.getByTestId('flow-current-file')).toContainText('app.ts');
    await expect(page.getByTestId('flow-current-file')).toContainText('Agent-reported');
    await expect(page.getByTestId('flow-current-file')).toContainText('data.ts');
    await expect(page.getByTestId('flow-step-details')).toContainText('Plan the app connection');
    await expect(page.getByTestId('flow-step-details')).not.toContainText('Connect the app to its data');

    expect((await request.post('/api/agent/test', { data: { runId, name: 'test_app_data', status: 'passed', capture: 'wrapper', path: 'src/app.ts', details: 'PRIVATE_TEST_DETAIL' } })).ok()).toBe(true);
    expect((await request.post('/api/agent/command', { data: { runId, commandId: 'phone-check', command: 'pytest PRIVATE_ARGUMENT_MARKER', status: 'running' } })).ok()).toBe(true);
    expect((await request.post('/api/agent/command', { data: { runId, commandId: 'phone-check', command: 'pytest PRIVATE_ARGUMENT_MARKER', status: 'completed', exitCode: 0, output: 'PRIVATE_OUTPUT_MARKER' } })).ok()).toBe(true);
    await page.locator('.flow-step').filter({ hasText: 'Connect the app to its data' }).click();
    await expect(page.getByTestId('flow-step-details')).toContainText('test_app_data');
    await expect(page.getByTestId('flow-step-details')).toContainText('Command wrapper');
    await expect(page.getByTestId('flow-step-details')).toContainText('pytest');
    await expect(page.getByTestId('flow-step-details')).toContainText('Exit code 0');
    const snapshot = await (await page.request.get(share.endpoint + '/api/snapshot')).text();
    expect(JSON.parse(snapshot).session.projectPath).toBe('');
    expect(snapshot).not.toContain(project);
    expect(snapshot).not.toContain(project.replaceAll('\\', '\\\\'));
    expect(snapshot).not.toContain(project.replaceAll('\\', '/'));
    expect(snapshot).not.toContain('export const');
    for (const marker of ['PRIVATE_TEST_DETAIL', 'PRIVATE_ARGUMENT_MARKER', 'PRIVATE_OUTPUT_MARKER']) {
      expect(snapshot).not.toContain(marker);
      await expect(page.locator('body')).not.toContainText(marker);
    }
    await expect(page.locator('body')).not.toContainText(project);
    await expect(page.locator('body')).not.toContainText(project.replaceAll('\\', '/'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    expect((await request.post('/api/agent/complete', { data: { runId, message: 'App data work is complete' } })).ok()).toBe(true);
    await expect(page.locator('.flow-step')).toHaveCount(3);
    await expect(page.locator('.flow-step-completed')).toHaveCount(3);
    await expect(page.getByTestId('flow-connector')).toHaveCount(2);
    await expect(page.getByTestId('test-test_app_data')).toHaveAttribute('data-status', 'passed');
    await page.reload();
    await expect(page.locator('.flow-step-completed')).toHaveCount(3);
    await expect(page.getByTestId('flow-current-report')).toContainText('App data work is complete');
    expect(new URL(page.url()).hash).toBe('');
    await page.setViewportSize({ width: 430, height: 932 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '../docs/codewatch-phone.png', fullPage: true });

    expect((await request.post('/api/phone/stop', { data: { shareId } })).ok()).toBe(true);
    shareId = undefined;
    await expect(page.getByRole('status').filter({ hasText: 'Connection paused' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    if (shareId) await request.post('/api/phone/stop', { data: { shareId } });
    if (runId) await request.post('/api/watch/stop', { data: { runId } });
    await removeFixture(project);
  }
});

test('the desktop QR panel supports startup cancellation, a rendered QR image, and stop sharing', async ({ page, request }) => {
  const project = await projectFixture();
  let runId: string | undefined;
  try {
    expect((await request.post('/api/watch', { data: { path: project } })).ok()).toBe(true);
    runId = (await (await request.get('/api/session')).json()).session.runId;
    await page.addInitScript(() => {
      let preferences: DesktopPreferences = { alwaysOnTop: false, closeToTray: false, compact: false, tutorialCompleted: true };
      let status: PhoneShareStatus = { state: 'idle' };
      let starts = 0, stops = 0;
      let pending: ((value: PhoneShareStatus) => void) | undefined;
      const preferencesListeners = new Set<(value: DesktopPreferences) => void>();
      const phoneListeners = new Set<(value: PhoneShareStatus) => void>();
      const publish = (value: PhoneShareStatus) => { status = value; phoneListeners.forEach(listener => listener({ ...value })); };
      window.codewatchDesktop = {
        chooseFolder: async () => null,
        getPreferences: async () => ({ ...preferences }),
        setPreferences: async patch => { preferences = { ...preferences, ...patch }; preferencesListeners.forEach(listener => listener({ ...preferences })); return { ...preferences }; },
        onPreferencesChanged: listener => { preferencesListeners.add(listener); return () => { preferencesListeners.delete(listener); }; },
        getPhoneStatus: async () => ({ ...status }),
        startPhoneShare: async () => {
          starts += 1;
          if (starts === 1) { publish({ state: 'starting' }); return new Promise<PhoneShareStatus>(resolvePending => { pending = resolvePending; }); }
          publish({ state: 'active', url: 'https://phone-e2e.trycloudflare.com/phone#token=browser-mock-qr', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
          return { ...status };
        },
        stopPhoneShare: async () => { stops += 1; publish({ state: 'idle' }); pending?.({ state: 'idle' }); pending = undefined; return { ...status }; },
        onPhoneStatusChanged: listener => { phoneListeners.add(listener); return () => { phoneListeners.delete(listener); }; },
      };
      Object.assign(window, { phoneTestCalls: () => ({ starts, stops }) });
    });
    await page.goto('/');
    const panel = page.getByTestId('phone-share-panel');
    await expect(panel.getByRole('button', { name: 'Enable phone view', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Enable phone view', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Enable phone view', exact: true })).toBeVisible();
    await expect(page.getByTestId('phone-qr')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Enable phone view', exact: true }).click();
    const image = page.getByTestId('phone-qr');
    await expect(image).toBeVisible();
    expect(await image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(256);
    await expect(panel.getByRole('button', { name: 'Copy phone link', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Stop sharing', exact: true }).click();
    await expect(image).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Enable phone view', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { phoneTestCalls: () => { starts: number; stops: number } }).phoneTestCalls())).toEqual({ starts: 2, stops: 2 });
  } finally {
    if (runId) await request.post('/api/watch/stop', { data: { runId } });
    await removeFixture(project);
  }
});
