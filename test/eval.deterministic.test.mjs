import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractNumbers,
  numberInPool,
  numericTraceabilityCheck,
  routedToSlide,
  applyCaptionMap,
  accessibilityChecklist,
  parseVerdict,
} from '../engine/eval.mjs';

test('extractNumbers normalizes currency, percent, scale words, and thousands separators', () => {
  const nums = extractNumbers('Revenue grew 25% to $1.2 million, up from 800,000 last year.');
  const values = nums.map((n) => n.value);
  assert.ok(values.includes(25));
  assert.ok(values.includes(1_200_000));
  assert.ok(values.includes(800_000));
});

test('numberInPool matches within rounding tolerance, not exact float equality', () => {
  const pool = extractNumbers('about 1.2 million users');
  assert.ok(numberInPool(1_200_000, pool));
  assert.ok(!numberInPool(2_000_000, pool));
});

test('numericTraceabilityCheck passes when every response number is in the slide data', () => {
  const slide = { talking_points: ['We monitor 4 blocks for one season.'], content: {} };
  const r = numericTraceabilityCheck('This story covers 4 blocks over one season.', slide);
  assert.equal(r.pass, true);
});

test('numericTraceabilityCheck fails on a number the slide never states', () => {
  const slide = { talking_points: ['We monitor 4 blocks.'], content: {} };
  const r = numericTraceabilityCheck('We monitor 40 blocks.', slide);
  assert.equal(r.pass, false);
  assert.equal(r.unmatched.length, 1);
});

test('numericTraceabilityCheck allows the slide referring to its own number', () => {
  const slide = { slide: 19, talking_points: ['We monitor 4 blocks.'], content: {} };
  const r = numericTraceabilityCheck('You can see right here on slide 19 the block count.', slide);
  assert.equal(r.pass, true);
});

test('applyCaptionMap swaps a spoken form back to its display term at a word boundary', () => {
  const map = { 'V-and-C': 'V&C', 'Genie plus plus': 'Genie++' };
  const out = applyCaptionMap('Ask about V-and-C and Genie plus plus today.', map);
  assert.equal(out, 'Ask about V&C and Genie++ today.');
});

test('applyCaptionMap does not touch a substring that is not a whole spoken term', () => {
  const map = { AEP: 'AEP (Adobe Experience Platform)' };
  const out = applyCaptionMap('AEPeople is not a real word.', map);
  assert.equal(out, 'AEPeople is not a real word.');
});

test('routedToSlide checks the tool name and slide_num argument', () => {
  const toolCalls = [{ name: 'demo_navigate_to_slide', args: { slide_num: 8 } }];
  assert.equal(routedToSlide(toolCalls, 'demo_navigate_to_slide', 8), true);
  assert.equal(routedToSlide(toolCalls, 'demo_navigate_to_slide', 3), false);
  assert.equal(routedToSlide([], 'demo_navigate_to_slide', 8), false);
});

test('accessibilityChecklist reports every criterion by number', () => {
  const html = '<a class="skip-link" href="#presentation-container">Skip</a><span aria-live="polite"></span><span aria-pressed="false"></span><div role="dialog"></div>';
  const css = ':focus-visible { outline: 2px solid; } .btn { min-height: 24px; min-width: 24px; } @media (prefers-reduced-motion: reduce) { * { animation: none; } }';
  const js = "if (ev.key === 'c') {} if (ev.key === 'ArrowRight') {} togglePause();";
  const checks = accessibilityChecklist(html, css, js);
  assert.equal(checks.length, 6);
  assert.ok(checks.every((c) => c.pass));
  assert.deepEqual(checks.map((c) => c.n), [1, 2, 3, 4, 5, 6]);
});

test('accessibilityChecklist fails a missing criterion without failing the others', () => {
  const checks = accessibilityChecklist('<html></html>', '', '');
  assert.ok(checks.some((c) => c.pass === false));
});

test('parseVerdict extracts the trailing JSON verdict line and ignores reasoning text before it', () => {
  const reply = 'Step 1: ...\nStep 2: ...\nVERDICT: {"coverage":"pass","tone":"fail","rationale":"too curt"}';
  assert.deepEqual(parseVerdict(reply), { coverage: 'pass', tone: 'fail', rationale: 'too curt' });
});

test('parseVerdict returns null when no VERDICT line is present', () => {
  assert.equal(parseVerdict('I refuse to answer in the required format.'), null);
});
