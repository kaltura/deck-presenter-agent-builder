import { test, expect } from '@playwright/test';
import { startSession, waitForLiveSession, sendChat } from './helpers.mjs';

test.describe('keyboard shortcuts', () => {
  test('Home, End, T, and Escape control the deck', async ({ page }) => {
    await startSession(page);
    await waitForLiveSession(page);

    await page.keyboard.press('End');
    await expect(page.locator('#slide-jump-input')).toHaveValue('10');

    await page.keyboard.press('Home');
    await expect(page.locator('#slide-jump-input')).toHaveValue('1');

    await page.keyboard.press('t');
    await expect(page.locator('#transcript-panel')).not.toHaveClass(/hidden/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#transcript-panel')).toHaveClass(/hidden/);
  });

  test('Escape blurs the chat input instead of typing into it', async ({ page }) => {
    await startSession(page);
    await waitForLiveSession(page);
    await page.click('#chat-input');
    await expect(page.locator('#chat-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#chat-input')).not.toBeFocused();
  });
});

test('a typed question renders exactly one chat bubble for it, not a duplicate', async ({ page }) => {
  await startSession(page);
  await waitForLiveSession(page);
  await sendChat(page, 'What does this cost?');
  await expect(page.locator('.chat-msg-user')).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(4000);
  await expect(page.locator('.chat-msg-user')).toHaveCount(1);
});

test('typing goodbye pauses autoplay until a real slide navigation happens', async ({ page }) => {
  await startSession(page);
  await waitForLiveSession(page);
  await sendChat(page, 'goodbye');
  await page.waitForTimeout(2000);
  await expect(page.locator('#autoplay-digits')).toHaveText('');

  await page.click('#btn-next');
  await expect(page.locator('#slide-jump-input')).toHaveValue('2');
  await expect(page.locator('#autoplay-digits')).not.toHaveText('', { timeout: 20_000 });
});

test('asking for a follow-up opens the contact form and stops the avatar mid-speech', async ({ page }) => {
  await startSession(page);
  await waitForLiveSession(page);
  await sendChat(page, "Yes, I'd like someone from your team to follow up with a demo.");
  await expect(page.locator('#contact-modal')).not.toHaveClass(/hidden/, { timeout: 30_000 });
  await expect(page.locator('#avatar-pip')).not.toHaveClass(/thinking/, { timeout: 5_000 });
});

test('closing the contact form blocks navigation briefly, then allows it', async ({ page }) => {
  await startSession(page);
  await waitForLiveSession(page);
  await sendChat(page, "Yes, I'd like someone from your team to follow up with a demo.");
  await expect(page.locator('#contact-modal')).not.toHaveClass(/hidden/, { timeout: 30_000 });

  await page.click('#btn-contact-skip');
  await expect(page.locator('#contact-modal')).toHaveClass(/hidden/);

  // The agent can navigate the deck (e.g. to a closing slide) while answering
  // the follow-up request, so the slide at this point is whatever it left it
  // at, not necessarily slide 1. Step away from the deck edge already
  // reached, so both the blocked click and the later click have headroom.
  const startSlide = Number(await page.locator('#slide-jump-input').inputValue());
  const atEnd = startSlide >= 10;
  const navButton = atEnd ? '#btn-prev' : '#btn-next';
  const expectedAfterCooldown = String(atEnd ? startSlide - 1 : startSlide + 1);

  await page.click(navButton);
  await page.waitForTimeout(500);
  await expect(page.locator('#slide-jump-input')).toHaveValue(String(startSlide));

  await page.waitForTimeout(2500);
  await page.click(navButton);
  await expect(page.locator('#slide-jump-input')).toHaveValue(expectedAfterCooldown);
});
