import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTyped, typedTextsMatch } from '../client/echo-match.js';
import { isWithinCooldown } from '../client/nav-cooldown.js';
import { levelAt, statsSummary } from '../client/mic-stats.js';

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

test('levelAt returns the dBFS bucket holding a single concentrated spike', () => {
  const hist = new Uint32Array(101);
  hist[20] = 100;
  assert.equal(levelAt(hist, 100, 0.5), -20);
});

test('levelAt walks from loudest to quietest as q rises', () => {
  const hist = new Uint32Array(101);
  hist[10] = 50;
  hist[30] = 50;
  assert.equal(levelAt(hist, 100, 0.1), -10);
  assert.equal(levelAt(hist, 100, 0.9), -30);
});

test('statsSummary is null before any tick has been recorded', () => {
  assert.equal(statsSummary({ ticks: 0, hist: new Uint32Array(101) }, 100, -50), null);
});

test('statsSummary formats levels, gate-open share, and voice-turn counts', () => {
  const hist = new Uint32Array(101);
  hist[10] = 60;
  hist[50] = 540;
  const stats = { ticks: 600, hist, openTicks: 300, openings: 4, turns: 5, shortTurns: 2, bargeIns: 1 };
  assert.deepEqual(statsSummary(stats, 100, -50), {
    'gate threshold': '-50 dBFS',
    sampled: '1m00s (mic on, not muted)',
    'raw level: floor / median / speech': '-50 / -50 / -10 dBFS',
    'gate open': '50% of the time, 4 openings',
    'voice turns': '5 (2 under 3 words, 1 while the avatar spoke)',
  });
});
