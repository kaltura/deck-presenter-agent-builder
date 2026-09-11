import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTyped, typedTextsMatch } from '../client/echo-match.js';
import { isWithinCooldown } from '../client/nav-cooldown.js';

test('normalizeTyped trims, lowercases, and drops punctuation', () => {
  assert.equal(normalizeTyped('  What Does   this   COST?  '), 'what does this cost');
});

test('normalizeTyped treats missing text as empty', () => {
  assert.equal(normalizeTyped(undefined), '');
  assert.equal(normalizeTyped(''), '');
});

test('normalizeTyped makes differently-cased/spaced/punctuated echoes match', () => {
  assert.equal(normalizeTyped('Tell me more!'), normalizeTyped('  tell   me more  '));
});

test('typedTextsMatch is true for an exact normalized match', () => {
  assert.equal(typedTextsMatch(normalizeTyped('What does this cost?'), normalizeTyped('what does this cost')), true);
});

test('typedTextsMatch is true when the echo is a partial (merged or truncated) match', () => {
  const typed = normalizeTyped('What does this cost?');
  const echoed = normalizeTyped('What does this cost? [NAV HINT: slide 3]');
  assert.equal(typedTextsMatch(typed, echoed), true);
});

test('typedTextsMatch is false for unrelated text', () => {
  assert.equal(typedTextsMatch(normalizeTyped('What does this cost?'), normalizeTyped('Tell me more')), false);
});

test('typedTextsMatch is false when either side is empty', () => {
  assert.equal(typedTextsMatch('', 'anything'), false);
  assert.equal(typedTextsMatch('anything', ''), false);
});

test('isWithinCooldown is true right after the window starts', () => {
  assert.equal(isWithinCooldown(1000, 1500, 2500), true);
});

test('isWithinCooldown is false once the window has fully elapsed', () => {
  assert.equal(isWithinCooldown(1000, 4000, 2500), false);
});

test('isWithinCooldown is false when the window never started', () => {
  assert.equal(isWithinCooldown(0, 1500, 2500), false);
});
