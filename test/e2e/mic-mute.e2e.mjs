import { test, expect, startSession, waitForLiveSession } from './helpers.mjs';

test('clicking the mic-mute button mutes and unmutes the viewer mic', async ({ page }) => {
  await startSession(page);
  await waitForLiveSession(page);

  await expect(page.locator('#btn-mic-mute')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#icon-mic-on')).toBeVisible();
  await expect(page.locator('#icon-mic-off')).toBeHidden();

  await page.click('#btn-mic-mute');
  await expect(page.locator('#btn-mic-mute')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#icon-mic-on')).toBeHidden();
  await expect(page.locator('#icon-mic-off')).toBeVisible();

  await page.click('#btn-mic-mute');
  await expect(page.locator('#btn-mic-mute')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#icon-mic-on')).toBeVisible();
});

test('the mic-mute button is independent of the avatar-audio mute button', async ({ page }) => {
  await startSession(page);
  await waitForLiveSession(page);

  await page.click('#btn-mic-mute');
  await expect(page.locator('#btn-mic-mute')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#btn-mute')).toHaveAttribute('aria-pressed', 'false');

  await page.click('#btn-mute');
  await expect(page.locator('#btn-mute')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#btn-mic-mute')).toHaveAttribute('aria-pressed', 'true');
});
