import { test, expect } from '@playwright/test';
import { startSession } from './helpers.mjs';

/**
 * Harness proof, not a feature test: loads the real demo/dist.html, starts a
 * session against the live, already-provisioned demo widget, and confirms
 * the deck actually presents. Every other *.e2e.mjs file assumes this flow
 * works and jumps straight to the behavior it's testing.
 */
test('loads the deck, starts a live avatar session, and renders the first slide', async ({ page }) => {
  await startSession(page);
  await expect(page.locator('#presentation-container canvas')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#slide-counter')).toContainText('/');
  // mediaReady only fires once the real RTC avatar stream negotiates against
  // the live widget; this is what actually proves a live session, not just
  // that the deck's own PDF.js rendering worked.
  await expect(page.locator('#avatar-loading')).toBeHidden({ timeout: 30_000 });
});

test('slide navigation advances the counter', async ({ page }) => {
  await startSession(page);
  await expect(page.locator('#presentation-container canvas')).toBeVisible({ timeout: 30_000 });
  const before = await page.locator('#slide-counter').textContent();
  await page.click('#btn-next');
  await expect(page.locator('#slide-counter')).not.toHaveText(before);
});
