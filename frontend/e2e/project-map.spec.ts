import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('large projects start with readable folders; file connections, recent saves and manual viewport remain useful', async ({ page, request }) => {
  await mkdir(resolve('..', '.local'), { recursive: true });
  const project = await mkdtemp(resolve('..', '.local', 'codewatch-map-e2e-'));
  let runId: string | undefined;
  try {
    await mkdir(resolve(project, 'frontend'));
    await mkdir(resolve(project, 'backend'));
    await Promise.all(Array.from({ length: 90 }, (_, index) => writeFile(resolve(project, `${index < 60 ? 'frontend' : 'backend'}/file-${index}.ts`), `export const value = ${index};\n`)));
    await writeFile(resolve(project, 'frontend/entry.ts'), "import { value } from './file-0';\nexport const entry = value;\n");
    await page.goto('/');
    await page.getByLabel('Project folder').fill(project);
    await page.getByRole('button', { name: 'Watch project', exact: true }).click();
    await expect(page.locator('.project-area')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Open frontend folder', exact: true })).toContainText('61 files');
    await expect(page.getByRole('button', { name: 'Open backend folder', exact: true })).toContainText('30 files');
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    expect(await page.locator('.project-area h3').first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(15);
    runId = (await (await request.get('/api/session')).json()).session.runId;
    await page.getByLabel('Search architecture').fill('entry.ts');
    await expect(page.locator('.map-file-list > button')).toHaveCount(1);
    await page.getByRole('button', { name: 'Open connections for frontend/entry.ts', exact: true }).click();
    await expect(page.locator('.map-connection-column').filter({ hasText: 'Uses code from' })).toContainText('file-0.ts');
    await expect(page.locator('.map-connection-column').filter({ hasText: 'Used by' })).toContainText('No direct local imports detected');
    await page.getByRole('button', { name: 'Show connection diagram', exact: true }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    const diagram = page.getByTestId('file-connections-diagram');
    await diagram.scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      const transform = await page.locator('.react-flow__viewport').getAttribute('style');
      return Number(transform?.match(/scale\(([\d.]+)\)/)?.[1] ?? 0);
    }).toBeGreaterThanOrEqual(0.65);
    const box = (await diagram.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 30);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 65, box.y + 75, { steps: 8 }); await page.mouse.up();
    const viewport = await page.locator('.react-flow__viewport').getAttribute('style');
    const positions = await page.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).style.transform));
    await writeFile(resolve(project, 'frontend/new-unrelated.ts'), 'export const unrelated = true;\n');
    await expect(page.locator('.map-recent')).toContainText('new-unrelated.ts');
    await page.waitForTimeout(300); // Allow node measurements and effects to expose an unwanted fit.
    expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(viewport);
    expect(await page.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).style.transform))).toEqual(positions);
    await page.getByRole('button', { name: 'Hide map', exact: true }).click();
    await expect(page.locator('#project-map-content')).toBeHidden();
    await page.getByRole('button', { name: 'Show map', exact: true }).click();
    await expect(page.getByTestId('map-file-details')).toContainText('entry.ts');
    expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(viewport);
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await page.getByLabel('Search architecture').fill('');
    await page.screenshot({ path: '../.local/project-map-overview.png', fullPage: true });
    await page.locator('.file-row').filter({ hasText: 'new-unrelated.ts' }).getByRole('button', { name: 'new-unrelated.ts', exact: true }).click();
    await expect(page.getByTestId('map-file-details')).toContainText('new-unrelated.ts');
    await expect(page.getByTestId('map-file-details')).toContainText('Changed this session');
    await page.screenshot({ path: '../.local/project-map-connections.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('map-file-details')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(page.locator('.project-area')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    if (runId) await request.post('/api/watch/stop', { data: { runId } });
    if (!project.startsWith(resolve('..') + '\\') && !project.startsWith(resolve('..') + '/')) throw new Error('Temporary project must stay inside the workspace');
    await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
