import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('connected steps retain their changes, selection, and reported target in the pinned companion', async ({ page, request }) => {
  await mkdir(resolve('..', '.local'), { recursive: true });
  const project = await mkdtemp(resolve('..', '.local', 'codewatch-flow-e2e-'));
  let runId: string | undefined;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await mkdir(resolve(project, 'src'));
    await writeFile(resolve(project, 'src/data.ts'), 'export const value = 1;\n');
    await writeFile(resolve(project, 'src/app.ts'), "import { value } from './data';\nexport const app = value;\n");
    await page.addInitScript(() => {
      let preferences = { alwaysOnTop: false, closeToTray: false, compact: false, tutorialCompleted: true };
      const listeners = new Set<(value: typeof preferences) => void>();
      window.codewatchDesktop = {
        chooseFolder: async () => null,
        getPreferences: async () => ({ ...preferences }),
        setPreferences: async (patch) => {
          const compact = patch.compact ?? (patch.alwaysOnTop !== undefined && patch.alwaysOnTop !== preferences.alwaysOnTop ? patch.alwaysOnTop : preferences.compact);
          preferences = { ...preferences, ...patch, compact };
          listeners.forEach((listener) => listener({ ...preferences }));
          return { ...preferences };
        },
        onPreferencesChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        getPhoneStatus: async () => ({ state: 'idle' }),
        startPhoneShare: async () => ({ state: 'idle' }),
        stopPhoneShare: async () => ({ state: 'idle' }),
        onPhoneStatusChanged: () => () => {},
      };
    });
    await page.goto('/');
    await page.getByLabel('Project folder', { exact: true }).fill(project);
    await page.getByRole('button', { name: 'Watch project', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop watching', exact: true })).toBeVisible();
    runId = (await (await request.get('/api/session')).json()).session.runId;
    const report = async (stage: string, message: string, paths = ['src/app.ts']) => {
      expect((await request.post('/api/agent/progress', { data: { runId, agentName: 'Flow test agent', stage, message, paths } })).ok()).toBe(true);
    };
    await report('PLANNING', 'Plan the data connection');
    await expect(page.locator('.flow-step')).toHaveCount(1);
    await writeFile(resolve(project, 'src/app.ts'), "import { value } from './data';\nexport const app = value + 1;\n");
    await expect(page.getByTestId('flow-current-file')).toContainText('src/app.ts');
    await expect(page.locator('.file-row').filter({ hasText: 'app.ts' })).toBeVisible();
    await report('IMPLEMENTING', 'Connect the app to its data');
    await writeFile(resolve(project, 'src/data.ts'), 'export const value = 2;\n');
    await expect(page.locator('.file-row').filter({ hasText: 'data.ts' })).toBeVisible();
    await expect(page.getByTestId('flow-current-file')).toContainText('src/app.ts');
    await expect(page.getByTestId('flow-current-report')).toContainText('Connect the app to its data');
    const planning = page.locator('.flow-step').filter({ hasText: 'Plan the data connection' });
    await planning.click();
    await expect(page.getByTestId('flow-step-details')).toContainText('src/app.ts');
    await expect(page.getByTestId('flow-step-details')).toContainText('modified');
    await expect(page.getByTestId('flow-step-details')).toContainText('File connections');
    await expect(page.getByTestId('flow-step-details')).toContainText('src/data.ts');
    await writeFile(resolve(project, 'src/new.ts'), 'export const later = true;\n');
    await expect(page.locator('.file-row').filter({ hasText: 'new.ts' })).toBeVisible();
    await expect(page.getByTestId('flow-step-details')).toContainText('Plan the data connection');
    await expect(page.getByTestId('flow-step-details')).not.toContainText('src/new.ts');
    expect((await request.post('/api/agent/test', { data: { runId, name: 'test_data_connection', status: 'passed', path: 'src/app.ts' } })).ok()).toBe(true);
    expect((await request.post('/api/agent/command', { data: { runId, commandId: 'check-1', command: 'verify data', status: 'running' } })).ok()).toBe(true);
    expect((await request.post('/api/agent/command', { data: { runId, commandId: 'check-1', command: 'verify data', status: 'completed', exitCode: 0, output: 'Verified fixture data' } })).ok()).toBe(true);
    await page.locator('.flow-step').filter({ hasText: 'Connect the app to its data' }).click();
    await expect(page.getByTestId('flow-step-details')).toContainText('test_data_connection');
    await expect(page.getByTestId('flow-step-details')).toContainText('Exit code 0');
    await page.getByRole('button', { name: 'Always on top', exact: true }).click();
    await page.setViewportSize({ width: 540, height: 720 });
    await expect(page.getByTestId('app-view')).toHaveAttribute('data-view', 'companion');
    await expect(page.getByTestId('flow-step-details')).toContainText('Connect the app to its data');
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await expect(page.locator('#architecture')).toHaveCount(0);
    await expect(page.locator('.stats-grid')).toHaveCount(0);
    await expect(page.getByTestId('flow-connector')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.screenshot({ path: '../docs/codewatch-companion.png' });
    await page.getByRole('button', { name: 'Open full app', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await expect(page.getByTestId('app-view')).toHaveAttribute('data-view', 'full');
    await expect(page.getByRole('button', { name: 'Always on top', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#architecture')).toBeVisible();
    expect((await request.post('/api/agent/complete', { data: { runId, message: 'Data connection work is done' } })).ok()).toBe(true);
    await expect(page.locator('.flow-step')).toHaveCount(3);
    await expect(page.locator('.flow-step-completed')).toHaveCount(3);
    await expect(page.getByTestId('flow-connector')).toHaveCount(2);
    await page.locator('.flow-step').filter({ hasText: 'Connect the app to its data' }).click();
    await expect(page.getByTestId('flow-step-details')).toContainText('src/new.ts');
    await expect(page.getByTestId('flow-step-details')).toContainText('test_data_connection');
    await page.setViewportSize({ width: 1440, height: 1500 });
    await page.getByTestId('activity-flow').screenshot({ path: '../docs/codewatch-work-flow.png' });
    await page.reload();
    await expect(page.locator('.flow-step')).toHaveCount(3);
    await page.locator('.flow-step').filter({ hasText: 'Plan the data connection' }).click();
    await expect(page.getByTestId('flow-step-details')).toContainText('modified');
    await page.getByRole('button', { name: 'Always on top', exact: true }).click();
    await page.setViewportSize({ width: 440, height: 500 });
    await expect(page.getByTestId('app-view')).toHaveAttribute('data-view', 'companion');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Unpin', exact: true }).click();
    await expect(page.getByTestId('app-view')).toHaveAttribute('data-view', 'full');
    expect(errors).toEqual([]);
  } finally {
    if (runId) await request.post('/api/watch/stop', { data: { runId } });
    if (!project.startsWith(resolve('..', '.local') + '\\') && !project.startsWith(resolve('..', '.local') + '/')) throw new Error('Unexpected temporary project path');
    await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
