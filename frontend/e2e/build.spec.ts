import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('real streamed build fails, debugs, passes, exports, and runs again', async ({ page }) => {
  const errors: string[] = [];
  const runIds = new Set<string>();
  const arrivals: number[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws/build')) return;
    ws.on('framereceived', ({ payload }) => {
      const event = JSON.parse(payload.toString()) as { runId: string };
      runIds.add(event.runId);
      arrivals.push(Date.now());
    });
  });
  await page.goto('/');
  await mkdir('../docs', { recursive: true });
  await page.screenshot({ path: '../docs/codewatch-idle.png', fullPage: true });
  await expect(page.getByTestId('node-agent')).toHaveAttribute('data-state', 'planned');
  await page.getByRole('button', { name: 'Start Build' }).click();
  await expect(page.getByTestId('current-stage')).toHaveText('PLANNING');
  await expect(page.getByRole('button', { name: 'Building…' })).toBeDisabled();
  await expect(page.getByTestId('node-frontend')).toBeVisible();
  await expect(page.getByTestId('node-tests')).toHaveAttribute('data-state', 'failed', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('test-test_create_todo')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('current-stage')).toHaveText('DEBUGGING', { timeout: 10_000 });
  await expect(page.getByTestId('node-service')).toHaveAttribute('data-state', 'active');
  await page.screenshot({ path: '../docs/codewatch-debugging.png', fullPage: true });
  await expect(page.getByRole('status')).toContainText('Build complete.', { timeout: 20_000 });
  await expect(page.getByTestId('tests-passing')).toHaveText('3 / 3');
  await expect(page.getByTestId('files-touched')).toHaveText('8');
  await expect(page.getByTestId('architecture-nodes')).toHaveText('07');
  await expect(page.locator('.react-flow__edge')).toHaveCount(6);
  await expect(page.locator('[data-state="completed"]')).toHaveCount(7);
  await expect(page.locator('.file-row')).toHaveCount(9);
  await expect(page.locator('.timeline .visited')).toHaveCount(8);
  await expect(async () => {
    const canvas = await page.locator('.graph-canvas').boundingBox();
    const database = await page.getByTestId('node-database').boundingBox();
    expect(canvas).not.toBeNull();
    expect(database).not.toBeNull();
    expect(database!.y + database!.height).toBeLessThan(canvas!.y + canvas!.height - 5);
  }).toPass();
  await page.getByRole('button', { name: 'Fit graph to view', exact: true }).click();
  const scrolledToEnd = await page
    .locator('.event-feed')
    .evaluate((feed) => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 3);
  expect(scrolledToEnd).toBe(true);
  expect(arrivals[1] - arrivals[0]).toBeGreaterThan(300);
  await page.screenshot({ path: '../docs/codewatch-complete.png', fullPage: true });
  await page.getByTestId('node-service').click();
  await expect(page.locator('.node-inspector')).toContainText('TodoService');
  await page.getByRole('button', { name: 'Close node details' }).click();
  await page.getByRole('tab', { name: /Commands/ }).click();
  await expect(page.locator('.command-entry')).toHaveCount(4);
  await expect(page.getByRole('tabpanel')).toContainText('1 failed, 2 passed');
  await expect(page.getByRole('tabpanel')).toContainText('3 passed');
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download event log' }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toMatch(/^run_.*-events\.ndjson$/);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByTestId('current-stage')).toHaveText('IDLE');
  await expect(page.getByTestId('events-received')).toHaveText('00');
  await expect(page.getByTestId('tests-passing')).toHaveText('0 / 0');
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start Build' }).click();
  await expect(page.getByRole('status')).toContainText('Build complete.', { timeout: 45_000 });
  expect(runIds.size).toBe(2);
  expect(errors).toEqual([]);
});

test('reset cancels an active stream and a fresh run can start', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Build' }).click();
  await expect(page.getByTestId('node-frontend')).toBeVisible();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForTimeout(1100); // Deliberately cross two event intervals to detect late deliveries.
  await expect(page.getByTestId('events-received')).toHaveText('00');
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(page.getByTestId('files-touched')).toHaveText('0');
  await page.getByRole('button', { name: 'Start Build' }).click();
  await expect(page.getByTestId('current-stage')).toHaveText('PLANNING');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
});

test('malformed events produce a recoverable error', async ({ page }) => {
  await page.routeWebSocket('**/ws/build', (ws) =>
    ws.onMessage(() => ws.send('{"type":"file_created","data":{}}')),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Build' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid event');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('mobile layout fits the viewport and build controls work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
  await page.screenshot({ path: '../docs/codewatch-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Start Build' }).click();
  await expect(page.getByTestId('current-stage')).toHaveText('PLANNING');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
});
