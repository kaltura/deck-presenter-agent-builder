// Shared by client/app.js (bundled into the browser) and test/*.test.mjs.
//
// True while `now` is still inside the cooldown window that started at
// `closedAt`. `closedAt <= 0` means the window never started.
export function isWithinCooldown(closedAt, now, windowMs) {
  return closedAt > 0 && now - closedAt < windowMs;
}
