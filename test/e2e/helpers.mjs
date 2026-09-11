/** Shared across *.e2e.mjs files. Not matched by playwright.config.mjs's testMatch itself. */
export async function startSession(page) {
  await page.goto('/dist.html');
  await page.click('#btn-continue');
  await page.click('#btn-start');
}
