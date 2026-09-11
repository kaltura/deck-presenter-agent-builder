// Shared across *.e2e.mjs files. Not matched by playwright.config.mjs's testMatch itself.
import { expect } from '@playwright/test';

export async function startSession(page, query = '') {
  await page.goto(`/dist.html${query}`);
  await page.click('#btn-continue');
  await page.click('#btn-start');
}

/** Types into the chat box and submits, same path a real viewer uses. */
export async function sendChat(page, text) {
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
}

/**
 * The PDF canvas renders from a local file and can appear before the avatar
 * session (and the `presenter` object it wires up) finishes connecting.
 * Anything that calls goToSlide/presenter.goTo must wait for this first, or
 * it silently no-ops against a still-null `presenter`.
 */
export async function waitForLiveSession(page) {
  await expect(page.locator('#presentation-container canvas')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#avatar-loading')).toBeHidden({ timeout: 30_000 });
}
