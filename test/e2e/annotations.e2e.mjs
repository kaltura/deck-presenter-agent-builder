import { test, expect, startSession, waitForLiveSession } from './helpers.mjs';
import { buildAnnotationsPdf } from './fixtures/annotations-pdf.mjs';

const FIXTURE_PATH = '/test-annotations.pdf';

test('clicking a PDF link annotation opens an external URL or navigates to the internal destination', async ({ page }) => {
  const pdfBytes = buildAnnotationsPdf();
  await page.route(
    (url) => url.pathname === FIXTURE_PATH,
    (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: pdfBytes })
  );

  await startSession(page, `?debug&pdf=${FIXTURE_PATH}`);
  await waitForLiveSession(page);

  const externalLink = page.locator(`a[href="https://example.com/"]`);
  await expect(externalLink).toHaveCount(1);
  await expect(externalLink).toHaveAttribute('target', '_blank');
  await expect(externalLink).toHaveAttribute('rel', 'noopener');

  const internalLink = page.locator('#annotation-layer a[href="#"]');
  await expect(internalLink).toHaveCount(1);
  await internalLink.click();
  await expect(page.locator('#slide-jump-input')).toHaveValue('2', { timeout: 10_000 });
});
