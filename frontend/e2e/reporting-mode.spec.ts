import { expect, test } from '@playwright/test';

test('reporting mode defaults to Light and keeps configuration and instructions in sync', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Connect your AI/ }).click();
  const mode = page.getByLabel('Reporting mode', { exact: true });
  const format = page.getByLabel('Configuration format');
  const snippet = page.locator('.integration-code pre');
  await expect(mode).toHaveValue('light');
  await expect(snippet).toContainText('"CODEWATCH_REPORTING_MODE": "light"');
  await format.selectOption('instructions');
  await expect(snippet).toContainText('Always call codewatch_complete');
  await mode.selectOption('detailed');
  await expect(snippet).toContainText('Report each command as running');
  await format.selectOption('codex');
  await expect(snippet).toContainText('CODEWATCH_REPORTING_MODE = "detailed"');
  await page.reload();
  await page.getByRole('button', { name: /Connect your AI/ }).click();
  await expect(mode).toHaveValue('detailed');
  await expect(snippet).toContainText('"CODEWATCH_REPORTING_MODE": "detailed"');
  await mode.selectOption('light');
  await expect(snippet).toContainText('"CODEWATCH_REPORTING_MODE": "light"');
});
