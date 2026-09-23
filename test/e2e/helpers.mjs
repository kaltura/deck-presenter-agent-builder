// Shared across *.e2e.mjs files. Not matched by playwright.config.mjs's testMatch itself.
import { test as base, expect } from '@playwright/test';

export { expect };

// Masks anything id-like before it reaches a CI log: long digit runs, emails,
// and long tokens such as session keys.
function mask(text) {
  return String(text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, '<email>')
    .replace(/[A-Za-z0-9_\-=+/]{32,}/g, '<token>')
    .replace(/\d{6,}/g, '<n>');
}

/**
 * Same as Playwright's test, plus one auto fixture: when a test fails, it
 * prints the client's window.__debugTimeline (see addDebugEntry in
 * client/app.js), masked, so a CI failure shows what the session did.
 */
export const test = base.extend({
  debugTimeline: [async ({ page }, use, testInfo) => {
    await use();
    if (testInfo.status === testInfo.expectedStatus) return;
    const timeline = await page.evaluate(() => window.__debugTimeline || []).catch(() => []);
    const lines = timeline.map(({ tMs, text }) => `  ${String(Math.round(tMs)).padStart(6)}ms ${mask(text)}`);
    console.log(`debug timeline for "${testInfo.title}" (${testInfo.project.name}):\n${lines.join('\n') || '  (empty)'}`);
  }, { auto: true }],

  // The avatar server sends only H264 video. Playwright's Linux Firefox gets
  // H264 from the OpenH264 plugin, which it downloads after launch (the prefs
  // in playwright.config.mjs turn this on). Without it the session connects
  // and speaks, but no video frame ever arrives. Waits once per worker.
  firefoxH264: [async ({ browser, browserName }, use) => {
    if (browserName === 'firefox') {
      const page = await browser.newPage();
      await page.waitForFunction(
        () => RTCRtpReceiver.getCapabilities('video').codecs.some((c) => /h264/i.test(c.mimeType)),
        null,
        { timeout: 120_000, polling: 2_000 },
      );
      await page.close();
    }
    await use();
  }, { scope: 'worker', auto: true, timeout: 150_000 }],
});

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
