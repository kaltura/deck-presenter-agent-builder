import { test, expect, startSession, waitForLiveSession } from './helpers.mjs';

test('avatar pip shows a tooltip on hover, drags without breaking pause-toggle, and resizes at every breakpoint', async ({ page }) => {
  await startSession(page);
  await waitForLiveSession(page);

  const pip = page.locator('#avatar-pip');
  const tooltip = page.locator('.avatar-pip-tooltip');

  await expect(tooltip).toHaveCSS('opacity', '0');
  await pip.hover();
  await expect(tooltip).toHaveCSS('opacity', '1');

  const before = await pip.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 40, { steps: 10 });
  await expect(pip).toHaveClass(/dragging/);
  await page.mouse.up();
  await expect(pip).not.toHaveClass(/dragging/);

  const after = await pip.boundingBox();
  expect(after.x).not.toBeCloseTo(before.x, 0);

  // A plain click (no movement in between) still toggles pause after a drag.
  await pip.click();
  await expect(page.locator('#avatar-pause-overlay')).not.toHaveClass(/hidden/);
  await pip.click();
  await expect(page.locator('#avatar-pause-overlay')).toHaveClass(/hidden/);

  for (const [width, height, size] of [[1000, 900, 150], [700, 900, 130], [400, 900, 100]]) {
    await page.setViewportSize({ width, height });
    await expect(pip).toHaveCSS('width', `${size}px`);
    await expect(pip).toHaveCSS('height', `${size}px`);
  }
});
