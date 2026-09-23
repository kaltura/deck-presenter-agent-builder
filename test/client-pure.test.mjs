import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTyped, typedTextsMatch } from '../client/echo-match.js';
import { isWithinCooldown } from '../client/nav-cooldown.js';
import { navAckPayload } from '../client/nav-ack.js';
import { levelAt, statsSummary } from '../client/mic-stats.js';
import { peekResumeSlide, PRESENTER_MEMORY_KEY } from '../client/presenter-memory.js';
import { autoPlayBlocked, autoPlayBlockers, STAY_HERE_PHRASE_RE } from '../client/autoplay-state.js';

function fakeStorage(record) {
  const raw = record === undefined ? null : JSON.stringify(record);
  return { getItem: (key) => (key === PRESENTER_MEMORY_KEY ? raw : null) };
}

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

test('navAckPayload carries the landed slide minus its visual', () => {
  const slides = [
    { title: 'One', talking_points: ['a'], content: { text: 'hello', key_metrics: ['3x'], visual: { layout: 'x' } } },
    { title: 'Two', talking_points: [], content: {} },
  ];
  assert.deepEqual(navAckPayload(slides, 1), {
    ok: true, slide_num: 1, title: 'One', talking_points: ['a'], content: { text: 'hello', key_metrics: ['3x'] },
  });
  assert.equal(slides[0].content.visual.layout, 'x', 'source slide is not mutated');
  assert.equal(navAckPayload(slides, '2').slide_num, 2);
  assert.deepEqual(navAckPayload(slides, 3), { ok: false, slide_num: 3 });
  assert.deepEqual(navAckPayload(slides, undefined), { ok: false, slide_num: null });
  assert.deepEqual(navAckPayload(slides, 1.5), { ok: false, slide_num: 1.5 });
});

test('peekResumeSlide returns 0 with no storage or no stored record', () => {
  assert.equal(peekResumeSlide(null), 0);
  assert.equal(peekResumeSlide(fakeStorage(undefined)), 0);
});

test('peekResumeSlide prefers lastSequential over lastSlide', () => {
  const now = () => 1_000_000;
  const storage = fakeStorage({ timestamp: now(), lastSlide: 2, lastSequential: 5 });
  assert.equal(peekResumeSlide(storage, now, 10), 5);
});

test('peekResumeSlide falls back to lastSlide when lastSequential is absent', () => {
  const now = () => 1_000_000;
  const storage = fakeStorage({ timestamp: now(), lastSlide: 4 });
  assert.equal(peekResumeSlide(storage, now, 10), 4);
});

test('peekResumeSlide is 0 for slide 1 or below (nothing to resume into)', () => {
  const now = () => 1_000_000;
  assert.equal(peekResumeSlide(fakeStorage({ timestamp: now(), lastSlide: 1 }), now, 10), 0);
});

test('peekResumeSlide is 0 when the stored slide is at or past the total', () => {
  const now = () => 1_000_000;
  assert.equal(peekResumeSlide(fakeStorage({ timestamp: now(), lastSlide: 10 }), now, 10), 0);
});

test('peekResumeSlide is 0 once the record is older than the max age', () => {
  const now = () => 40 * 24 * 3600 * 1000;
  const storage = fakeStorage({ timestamp: 0, lastSlide: 3 });
  assert.equal(peekResumeSlide(storage, now, 10), 0);
});

test('peekResumeSlide is 0 for a corrupt record or a storage read that throws', () => {
  assert.equal(peekResumeSlide({ getItem: () => 'not json' }), 0);
  assert.equal(peekResumeSlide({ getItem: () => { throw new Error('blocked'); } }), 0);
});

test('autoPlayBlocked is false only when every gate is clear', () => {
  const clear = {
    sessionRevealed: true, openingDone: true, deckPresenting: true, autoPlayEnabled: true,
  };
  assert.equal(autoPlayBlocked(clear), false);
});

test('autoPlayBlocked is true with no state at all', () => {
  assert.equal(autoPlayBlocked(), true);
  assert.equal(autoPlayBlocked(undefined), true);
});

test('autoPlayBlocked is true when any single hold flag is set', () => {
  const base = { sessionRevealed: true, openingDone: true, deckPresenting: true, autoPlayEnabled: true };
  for (const flag of ['heldAfterBack', 'isPaused', 'sessionEnded', 'deckPausedAfterGoodbye', 'visitorSpeaking', 'replyPending', 'typing', 'avatarSpeaking', 'sessionSpeaking', 'responsePending']) {
    assert.equal(autoPlayBlocked({ ...base, [flag]: true }), true, `expected blocked when ${flag} is true`);
  }
});

test('autoPlayBlockers names each gate that blocks', () => {
  const base = { sessionRevealed: true, openingDone: true, deckPresenting: true, autoPlayEnabled: true };
  assert.deepEqual(autoPlayBlockers(base), []);
  assert.deepEqual(autoPlayBlockers({ ...base, openingDone: false, visitorSpeaking: true }), ['!openingDone', 'visitorSpeaking']);
});

test('STAY_HERE_PHRASE_RE matches common generic stay-here phrasing', () => {
  for (const text of ['can we stay here for a bit', "don't move on yet", 'please wait before the next slide', 'hold on this slide please']) {
    assert.equal(STAY_HERE_PHRASE_RE.test(text), true, `expected a match for: ${text}`);
  }
});

test('STAY_HERE_PHRASE_RE does not match unrelated text', () => {
  assert.equal(STAY_HERE_PHRASE_RE.test('what does this cost'), false);
});
