import { test, expect, startSession, waitForLiveSession, sendChat } from './helpers.mjs';

test('opening the transcript shows mic stats and logs a turn, download and close both work', async ({ page }) => {
  await startSession(page);
  await waitForLiveSession(page);

  await page.keyboard.press('t');
  await expect(page.locator('#transcript-panel')).not.toHaveClass(/hidden/);

  await sendChat(page, 'What does this cost?');
  await expect(page.locator('#transcript-body .transcript-entry').filter({ hasText: 'user:' })).toHaveCount(1, { timeout: 15_000 });

  // Mic stats render every 50 ticks (100ms each) once the mic is live, so
  // this needs real wall-clock time, not just a session-connected wait.
  await expect(page.locator('#mic-stats')).not.toHaveClass(/hidden/, { timeout: 10_000 });
  await expect(page.locator('#mic-stats')).toContainText('mic ·');

  const downloadPromise = page.waitForEvent('download');
  await page.click('#btn-download-transcript');
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import('node:fs/promises');
  const content = await fs.readFile(path, 'utf8');
  expect(content).toContain('user:');
  expect(content).toContain('mic stats');

  await page.click('#btn-close-transcript');
  await expect(page.locator('#transcript-panel')).toHaveClass(/hidden/);
});
