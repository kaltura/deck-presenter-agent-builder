import { test, expect, startSession, waitForLiveSession } from './helpers.mjs';

test('print media hides chrome and the PDF badge glows once on load', async ({ page }) => {
  await startSession(page);
  await waitForLiveSession(page);

  const badge = page.locator('#btn-download-pdf');
  await expect(badge).toHaveCSS('animation-name', 'pdfGlow');
  await expect(badge).toHaveCSS('animation-iteration-count', '3');

  await page.emulateMedia({ media: 'print' });
  for (const selector of ['.app-header', '.controls-bar', '#avatar-pip', '.status-toast']) {
    await expect(page.locator(selector)).toHaveCSS('display', 'none');
  }
  await expect(page.locator('.presentation-container')).toHaveCSS('box-shadow', 'none');
});
