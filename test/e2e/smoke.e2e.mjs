import { test, expect } from '@playwright/test';
import { startSession, waitForLiveSession } from './helpers.mjs';

/**
 * Harness proof, not a feature test: loads the real demo/dist.html, starts a
 * session against the live, already-provisioned demo widget, and confirms
 * the deck actually presents. Every other *.e2e.mjs file assumes this flow
 * works and jumps straight to the behavior it's testing.
 */
test('loads the deck, starts a live avatar session, and renders the first slide', async ({ page }) => {
  await startSession(page);
  // mediaReady only fires once the real RTC avatar stream negotiates against
  // the live widget; this is what actually proves a live session, not just
  // that the deck's own PDF.js rendering worked.
  await waitForLiveSession(page);
  await expect(page.locator('#slide-jump-input')).toHaveValue('1');
});

test('slide navigation advances the current slide', async ({ page }) => {
  await startSession(page);
  await waitForLiveSession(page);
  await page.click('#btn-next');
  await expect(page.locator('#slide-jump-input')).toHaveValue('2');
});
