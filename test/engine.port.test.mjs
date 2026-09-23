import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { normalizeToolConfig, stableStringify, eqToolConfig } from '../engine/attach-tool.mjs';
import { inlineSvgAssets } from '../engine/bundle.mjs';
import { expandedNumberWordForm, buildCaptionMap } from '../engine/lib/caption-map.mjs';
import { normalizeServiceUrl } from '../engine/lib/env.mjs';
import {
  extractNumbers,
  hasUnspokenCurrencySuffix,
  buildDeckWideNumberPool,
  numericTraceabilityCheck,
} from '../engine/eval.mjs';

// ── attach-tool.mjs: normalizeToolConfig / stableStringify / eqToolConfig ──

test('stableStringify sorts object keys so key order never shows as a diff', () => {
  const a = stableStringify({ b: 1, a: 2 });
  const b = stableStringify({ a: 2, b: 1 });
  assert.equal(a, b);
});

test('normalizeToolConfig strips server-default fields and each arg\'s default:null', () => {
  const config = {
    name: 'canopy_navigate_to_slide',
    args: { slide_num: { type: 'integer', default: null } },
    add_to_history: true,
    log_request: true,
    log_response: true,
    timeout: 30,
  };
  const normalized = normalizeToolConfig(config);
  assert.equal(normalized.add_to_history, undefined);
  assert.equal(normalized.log_request, undefined);
  assert.deepEqual(normalized.args.slide_num, { type: 'integer' });
});

test('eqToolConfig treats a config as unchanged once server defaults are stripped from both sides', () => {
  const current = {
    name: 'canopy_navigate_to_slide',
    args: { slide_num: { type: 'integer', default: null } },
    add_to_history: true,
    log_request: false,
    timeout: 30,
  };
  const desired = {
    name: 'canopy_navigate_to_slide',
    args: { slide_num: { type: 'integer' } },
  };
  assert.equal(eqToolConfig(current, desired), true);
});

test('eqToolConfig still reports a real config change', () => {
  const current = { name: 'canopy_navigate_to_slide', args: { slide_num: { type: 'integer' } } };
  const desired = { name: 'canopy_navigate_to_slide', args: { slide_num: { type: 'string' } } };
  assert.equal(eqToolConfig(current, desired), false);
});

// ── engine/eval.mjs: hardened NUMBER_RE / extractNumbers ──

test('extractNumbers skips a bare 4-digit year with no currency and no unit', () => {
  const nums = extractNumbers('Canopy launched in 2021 with a small team.');
  assert.equal(nums.some((n) => n.value === 2021), false);
});

test('extractNumbers skips a bare single-digit integer with no currency, unit, or percent', () => {
  const nums = extractNumbers('See Q2 for the growth trend.');
  assert.equal(nums.some((n) => n.value === 2), false);
});

test('extractNumbers keeps a small number when it carries a currency symbol or unit', () => {
  const nums = extractNumbers('Wren grew from $2 million to $9 million in one year.');
  const values = nums.map((n) => n.value);
  assert.ok(values.includes(2_000_000));
  assert.ok(values.includes(9_000_000));
});

test('extractNumbers does not misread a unit-letter word boundary as a scale suffix', () => {
  const nums = extractNumbers('Wren improved retention by 300 basis points last quarter.');
  assert.ok(nums.some((n) => n.value === 300));
  assert.equal(nums.some((n) => n.value === 3e11), false);
});

// ── table scaling ("in thousands" / "in $mm") via buildDeckWideNumberPool + numericTraceabilityCheck ──

test('numericTraceabilityCheck scales a bare table figure labeled "in thousands"', () => {
  const slide = {
    slide: 4,
    talking_points: [],
    content: { note: 'Figures shown in thousands.', revenue_table: { fy1: '420' } },
  };
  const r = numericTraceabilityCheck('Wren posted $420 thousand in revenue that year.', slide);
  assert.equal(r.pass, true);
});

test('numericTraceabilityCheck scales a bare table figure labeled in $mm', () => {
  const slide = {
    slide: 5,
    talking_points: [],
    content: { note: 'All figures in $mm.', revenue_table: { fy1: '8.4' } },
  };
  const r = numericTraceabilityCheck('Wren posted $8.4 million in revenue that year.', slide);
  assert.equal(r.pass, true);
});

test('buildDeckWideNumberPool lets a presenter cite a figure that only lives on a different slide', () => {
  const slideById = {
    1: { slide: 1, talking_points: [], content: {} },
    2: { slide: 2, talking_points: ['Wren shipped to 12 pilot customers.'], content: {} },
  };
  const deckWidePool = buildDeckWideNumberPool(slideById);
  const r = numericTraceabilityCheck('We now have 12 pilot customers across the deck.', slideById[1], deckWidePool);
  assert.equal(r.pass, true);
});

test('buildDeckWideNumberPool also pulls figures from knowledge-base text', () => {
  const slideById = { 1: { slide: 1, talking_points: [], content: {} } };
  const deckWidePool = buildDeckWideNumberPool(slideById, ['Wren\'s support team answers within 8 minutes on average.']);
  const r = numericTraceabilityCheck('Our support team answers within 8 minutes.', slideById[1], deckWidePool);
  assert.equal(r.pass, true);
});

// ── generic unspoken-currency-suffix check ──

test('hasUnspokenCurrencySuffix flags a dollar figure with a raw letter-scale suffix', () => {
  assert.equal(hasUnspokenCurrencySuffix('Wren raised $5M in its seed round.'), true);
});

test('hasUnspokenCurrencySuffix flags euro and pound figures the same way', () => {
  assert.equal(hasUnspokenCurrencySuffix('Wren\'s EU arm closed a €3B round.'), true);
  assert.equal(hasUnspokenCurrencySuffix('The UK office signed a £2M facility.'), true);
});

test('hasUnspokenCurrencySuffix passes a spoken-out word form', () => {
  assert.equal(hasUnspokenCurrencySuffix('Wren raised $5 million in its seed round.'), false);
});

test('hasUnspokenCurrencySuffix does not flag a unit-letter word boundary as a suffix', () => {
  assert.equal(hasUnspokenCurrencySuffix('Margin improved by $2 basis points... wait, that reads oddly.'), false);
});

// ── caption-map.mjs: expandedNumberWordForm alias for round hundreds ──

test('expandedNumberWordForm expands a round-hundred figure from 1,100 to 9,900', () => {
  assert.equal(expandedNumberWordForm('1,700'), 'one thousand seven hundred');
  assert.equal(expandedNumberWordForm('9,900'), 'nine thousand nine hundred');
  assert.equal(expandedNumberWordForm('1,100'), 'one thousand one hundred');
});

test('expandedNumberWordForm returns null outside the round-hundred 1,100-9,900 range', () => {
  assert.equal(expandedNumberWordForm('1,000'), null);
  assert.equal(expandedNumberWordForm('10,000'), null);
  assert.equal(expandedNumberWordForm('1,250'), null);
  assert.equal(expandedNumberWordForm('not-a-number'), null);
});

test('buildCaptionMap adds the expanded word form as an extra alias for a round-hundred term', () => {
  const guide = '1,700 -> "seventeen hundred"\n';
  const map = buildCaptionMap(guide);
  assert.equal(map['seventeen hundred'], '1,700');
  assert.equal(map['one thousand seven hundred'], '1,700');
});

// ── bundle.mjs: inlineSvgAssets ──

test('inlineSvgAssets inlines an svg tag the html actually references, as a base64 data URI', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'engine-port-test-'));
  try {
    writeFileSync(resolve(dir, 'logo.svg'), '<svg><circle r="1"/></svg>');
    const html = '<img src="./assets/logo.svg" alt="Canopy logo">';
    const out = inlineSvgAssets(html, dir);
    assert.match(out, /^<img src="data:image\/svg\+xml;base64,/);
    assert.doesNotMatch(out, /\.\/assets\/logo\.svg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inlineSvgAssets skips an svg file in assetsDir that the html never references', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'engine-port-test-'));
  try {
    writeFileSync(resolve(dir, 'unused.svg'), '<svg><rect width="1" height="1"/></svg>');
    const html = '<p>No image tags here.</p>';
    const out = inlineSvgAssets(html, dir);
    assert.equal(out, html);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inlineSvgAssets inlines every referenced svg, not only the first one found', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'engine-port-test-'));
  try {
    writeFileSync(resolve(dir, 'logo.svg'), '<svg id="logo"/>');
    writeFileSync(resolve(dir, 'badge.svg'), '<svg id="badge"/>');
    const html = '<img src="./assets/logo.svg"><img src="./assets/badge.svg">';
    const out = inlineSvgAssets(html, dir);
    assert.equal(out.match(/data:image\/svg\+xml;base64,/g)?.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inlineSvgAssets returns html unchanged when assetsDir does not exist', () => {
  const html = '<img src="./assets/logo.svg">';
  assert.equal(inlineSvgAssets(html, resolve(tmpdir(), 'engine-port-test-does-not-exist')), html);
});

test('normalizeServiceUrl adds /api_v3 to a bare host and keeps a URL that has a path', () => {
  assert.equal(normalizeServiceUrl('https://cdnapisec.kaltura.com'), 'https://cdnapisec.kaltura.com/api_v3');
  assert.equal(normalizeServiceUrl('https://cdnapisec.kaltura.com/'), 'https://cdnapisec.kaltura.com/api_v3');
  assert.equal(normalizeServiceUrl('https://cdnapisec.kaltura.com/api_v3/'), 'https://cdnapisec.kaltura.com/api_v3');
  assert.equal(normalizeServiceUrl('https://ovp.example.test/custom/api_v3'), 'https://ovp.example.test/custom/api_v3');
});
