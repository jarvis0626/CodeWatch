import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('watches actual files, connects agent progress, restores state, and stays live after completion', async ({ page, request }) => {
  const project = await mkdtemp(resolve('..', '.codewatch-e2e-'));
  const errors: string[] = [];
  let runId: string | undefined;
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await mkdir(resolve(project, 'src'));
    await writeFile(resolve(project, 'src/data.ts'), 'export const data = [1];\n');
    await writeFile(resolve(project, 'src/app.ts'), "import { data } from './data';\nexport const count = data.length;\n");
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Live project', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Start Build' })).toHaveCount(0);
    await page.getByLabel('Project folder').fill(project);
    await page.getByLabel('Session label').fill('My coding IDE');
    await page.getByRole('button', { name: 'Watch project', exact: true }).click();
    await expect(page.getByTestId('node-file:src/app.ts')).toBeVisible();
    await expect(page.getByTestId('architecture-nodes')).toHaveText('03');
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect(page.getByTestId('current-stage')).toHaveText('NOT REPORTED');
    await expect(page.getByTestId('files-touched')).toHaveText('0');
    runId = (await (await request.get('/api/session')).json()).session.runId;
    await page.getByRole('button', { name: /Connect your AI/ }).click();
    await expect(page.locator('.integration-code pre')).toContainText('mcpServers');
    await page.getByLabel('Configuration format').selectOption('instructions');
    await expect(page.locator('.integration-code pre')).toContainText('codewatch');
    await page.getByRole('button', { name: /Connect your AI/ }).click();

    const report = await request.post('/api/agent/progress', { data: { runId, agentName: 'Test assistant', stage: 'IMPLEMENTING', message: 'Connecting the app to its data module', paths: ['src/app.ts'] } });
    expect(report.ok()).toBe(true);
    await expect(page.getByTestId('current-stage')).toHaveText('IMPLEMENTING');
    await expect(page.getByTestId('current-action')).toHaveText('Connecting the app to its data module');
    await expect(page.locator('.current-panel .source-badge')).toHaveText('Agent-reported');
    await expect(page.getByTestId('node-file:src/app.ts')).toHaveAttribute('data-state', 'active');
    await writeFile(resolve(project, 'src/data.ts'), 'export const data = [1, 2, 3];\n');
    await expect(page.locator('.file-row').filter({ hasText: 'data.ts' })).toContainText('Observed file change');
    await expect(page.locator('.latest-report')).toContainText('Connecting the app to its data module');
    await expect(page.getByTestId('files-touched')).toHaveText('1');
    const testReport = await request.post('/api/agent/test', { data: { runId, agentName: 'Test assistant', name: 'test_count', status: 'passed', path: 'src/app.ts' } });
    expect(testReport.ok()).toBe(true);
    await expect(page.getByTestId('tests-passing')).toHaveText('1 / 1');
    await page.reload();
    await expect(page.getByTestId('current-stage')).toHaveText('IMPLEMENTING');
    await expect(page.getByTestId('tests-passing')).toHaveText('1 / 1');
    await expect(page.getByTestId('node-file:src/app.ts')).toBeVisible();
    await page.getByLabel('Search architecture').fill('app.ts');
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    await page.getByLabel('Search architecture').fill('');
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await page.getByTestId('node-file:src/app.ts').click();
    await page.getByRole('button', { name: 'Focus connections' }).click();
    await expect(page.locator('.node-inspector')).toContainText('Import');
    await page.getByRole('button', { name: 'Close node details' }).click();
    await page.screenshot({ path: '../docs/codewatch-live.png', fullPage: true });
    const complete = await request.post('/api/agent/complete', { data: { runId, agentName: 'Test assistant', message: 'App data flow is ready' } });
    expect(complete.ok()).toBe(true);
    await expect(page.getByTestId('current-stage')).toHaveText('COMPLETE');
    await expect(page.getByRole('button', { name: 'Stop watching', exact: true })).toBeVisible();
    await writeFile(resolve(project, 'src/extra.ts'), 'export const extra = true;\n');
    await expect(page.getByTestId('node-file:src/extra.ts')).toBeVisible();
    await rm(resolve(project, 'src/data.ts'));
    await expect(page.getByTestId('node-file:src/data.ts')).toHaveCount(0);
    await expect(page.locator('.file-row.deleted')).toContainText('data.ts');
    await page.waitForTimeout(11_000); // Cross a heartbeat interval; idle activity must stay connected.
    await expect(page.locator('.connection')).toContainText('Stream connected');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop watching', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop watching', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('tests-passing')).toHaveText('1 / 1');
    expect(errors).toEqual([]);
  } finally {
    if (runId) await request.post('/api/watch/stop', { data: { runId } });
    if (!project.startsWith(resolve('..') + '\\') && !project.startsWith(resolve('..') + '/')) throw new Error('Temporary project must stay inside the workspace');
    await rm(project, { recursive: true, force: true });
  }
});

test('live connection setup fits a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /Connect your AI/ }).click();
  await expect(page.locator('.integration-code pre')).toContainText('mcpServers');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../docs/codewatch-live-mobile.png', fullPage: true });
  await page.getByRole('tab', { name: /Any IDE/ }).click();
  await expect(page.locator('.watcher-guide')).toContainText('Needs an agent integration');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
