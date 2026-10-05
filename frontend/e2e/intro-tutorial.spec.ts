import { expect, test, type Page } from '@playwright/test';

// Browser storage stands in for native profile persistence in this preload mock.
// The application itself saves tutorialCompleted through its desktop preferences.
async function installTutorialDesktop(page: Page, failedSaves = 0) {
  await page.addInitScript(({ failedSaves }) => {
    const storageKey = 'codewatch-tutorial-e2e-completed';
    let preferences = {
      alwaysOnTop: false, closeToTray: false, compact: false,
      tutorialCompleted: localStorage.getItem(storageKey) === 'true',
    };
    let remainingFailures = failedSaves;
    const listeners = new Set<(value: typeof preferences) => void>();
    const desktop = {
      chooseFolder: async () => null,
      getPreferences: async () => ({ ...preferences }),
      setPreferences: async (patch: Partial<typeof preferences>) => {
        if (patch.tutorialCompleted && remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error('Simulated preference write failure');
        }
        preferences = { ...preferences, ...patch };
        if (preferences.tutorialCompleted) localStorage.setItem(storageKey, 'true');
        listeners.forEach(listener => listener({ ...preferences }));
        return { ...preferences };
      },
      onPreferencesChanged: (listener: (value: typeof preferences) => void) => {
        listeners.add(listener); return () => { listeners.delete(listener); };
      },
      getPhoneStatus: async () => ({ state: 'idle' as const }),
      startPhoneShare: async () => ({ state: 'idle' as const }),
      stopPhoneShare: async () => ({ state: 'idle' as const }),
      onPhoneStatusChanged: () => () => {},
    };
    Object.assign(window, { codewatchDesktop: desktop });
  }, { failedSaves });
}

async function expectCompletedAfterReload(page: Page) {
  await page.reload();
  await expect(page.getByRole('button', { name: 'Always on top', exact: true })).toBeEnabled();
  await expect(page.getByTestId('intro-tutorial')).toHaveCount(0);
}

test('the first-launch tutorial finishes once and stays dismissed after reload', async ({ page }) => {
  await installTutorialDesktop(page);
  await page.goto('/');
  const tutorial = page.getByTestId('intro-tutorial');
  await expect(tutorial).toBeVisible();
  await expect(page.getByTestId('tutorial-step')).toContainText('Choose your project');
  await page.getByTestId('tutorial-next').click();
  await expect(page.getByTestId('tutorial-step')).toContainText('Connect your coding agent');
  await expect(page.getByTestId('tutorial-step')).toContainText('Connecting alone does not capture every action');
  await page.getByTestId('tutorial-next').click();
  await expect(page.getByTestId('tutorial-step')).toContainText('Keep the work beside your editor');
  await page.getByTestId('tutorial-next').click();
  await expect(page.getByTestId('tutorial-step')).toContainText('different network');
  await expect(page.getByTestId('tutorial-step')).toContainText('Keep your computer online and CodeWatch running');
  await page.getByTestId('tutorial-finish').click();
  await expect(tutorial).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('codewatch-tutorial-e2e-completed'))).toBe('true');
  await expectCompletedAfterReload(page);
});

test('skipping the tutorial also persists completion', async ({ page }) => {
  await installTutorialDesktop(page);
  await page.goto('/');
  await expect(page.getByTestId('intro-tutorial')).toBeVisible();
  await page.getByTestId('tutorial-skip').click();
  await expect(page.getByTestId('intro-tutorial')).toHaveCount(0);
  await expectCompletedAfterReload(page);
});

test('a failed preference save keeps the tutorial open and can be retried', async ({ page }) => {
  await installTutorialDesktop(page, 1);
  await page.goto('/');
  const tutorial = page.getByTestId('intro-tutorial');
  await expect(tutorial).toBeVisible();
  await page.getByTestId('tutorial-skip').click();
  await expect(tutorial.getByRole('alert')).toContainText('Could not save your tutorial preference');
  await expect(tutorial).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('codewatch-tutorial-e2e-completed'))).toBeNull();
  await tutorial.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(tutorial).toHaveCount(0);
  await expectCompletedAfterReload(page);
});

test('keyboard navigation and Escape stay inside the dialog and persist dismissal on a narrow screen', async ({ page }) => {
  await installTutorialDesktop(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const tutorial = page.getByTestId('intro-tutorial');
  await expect(tutorial).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tutorial-step')).toContainText('Step 2 of 4');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('tutorial-step')).toContainText('Step 1 of 4');
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press('Tab');
    expect(await tutorial.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(tutorial).toHaveCount(0);
  await expectCompletedAfterReload(page);
});
