import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, scanText, compileLiterals } from '../bin/scan-leaks.mjs';

const hits = (text, literals = []) => scanText('sample.js', text, literals);
const rules = (text) => new Set(hits(text).map((f) => f.rule));

/** One line that must trip a rule, one that must not, per rule id. */
const CASES = {
  'kaltura-entry-id': {
    bad: 'const entry = "1_ab3d9xk2";',
    good: 'const entry = process.env.ENTRY_ID;',
  },
  'kaltura-object-id': {
    bad: 'const avatarId = "0123456789abcdef01234567";',
    good: 'const avatarId = state.avatarId;',
  },
  uuid: {
    bad: 'const tool = "11111111-2222-3333-4444-555555555555";',
    good: 'const tool = "00000000-0000-0000-0000-000000000000";',
  },
  'partner-id': {
    bad: 'const PARTNER_ID = 1234567;',
    good: 'const PARTNER_ID = Number(process.env.KALTURA_PARTNER_ID);',
  },
  'admin-secret': {
    bad: 'const adminSecret = "abc123def456ghi789";',
    good: 'const adminSecret = process.env.KALTURA_ADMIN_SECRET;',
  },
  'kaltura-session': {
    bad: 'const ks = "djJ8NjUxNjc0MnyAbCdEfGhIjKlMnOp";',
    good: 'const ks = await mgmt.startSession();',
  },
  'local-path': {
    bad: "const ref = '/Users/someone/projects/thing/file.mjs';",
    good: "const ref = resolve(import.meta.dirname, 'file.mjs');",
  },
  'internal-host': {
    bad: 'const host = "messaging.nvp1.ovp.example.com";',
    good: 'const host = "www.kaltura.com";',
  },
  email: {
    bad: 'const to = "someone@acme.co";',
    good: 'const to = "you@example.com";',
  },
};

test('every rule has a test case', () => {
  assert.deepEqual(
    RULES.map((r) => r.id).sort(),
    Object.keys(CASES).sort(),
    'add a case to CASES for each new rule',
  );
});

for (const [id, { bad, good }] of Object.entries(CASES)) {
  test(`${id} fires on a leak`, () => {
    assert.ok(rules(bad).has(id), `expected ${id} to fire on: ${bad}`);
  });

  test(`${id} stays quiet on correct code`, () => {
    assert.ok(!rules(good).has(id), `expected ${id} not to fire on: ${good}`);
  });
}

test('clean file produces no findings', () => {
  const clean = [
    'import { Management } from "@kaltura/intelligent-agents/management";',
    'const mgmt = new Management({',
    '  partnerId: Number(process.env.KALTURA_PARTNER_ID),',
    '  adminSecret: process.env.KALTURA_ADMIN_SECRET,',
    '});',
    'export const TOTAL_SLIDES = readdirSync(SLIDE_DIR).length;',
  ].join('\n');
  assert.deepEqual(hits(clean), []);
});

test('binary content is skipped', () => {
  assert.deepEqual(hits('PARTNER_ID = 1234567\0\0binary'), []);
});

test('findings report the right line number', () => {
  const found = hits('line one\nline two\nconst PARTNER_ID = 1234567;\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
});

test('literals match on word boundaries, not substrings', () => {
  const literals = compileLiterals('LOG\nCLI\nFoobar\n');

  // "dialog" contains "log" and "client" contains "cli". Neither is a leak.
  assert.deepEqual(hits('open the dialog from the client directory', literals), []);

  const found = hits('LOG the Foobar result', literals);
  assert.deepEqual(
    found.map((f) => f.hit).sort(),
    ['Foobar', 'LOG'],
  );
});

test('literal matching ignores case', () => {
  const literals = compileLiterals('FooBar\n');
  assert.equal(hits('we used foobar for this', literals).length, 1);
});

test('regex metacharacters in a literal are escaped', () => {
  const literals = compileLiterals('a.b-c\n');
  assert.deepEqual(hits('axbxc', literals), [], 'the dot must be literal');
  assert.equal(hits('a.b-c', literals).length, 1);
});

test('comment lines in the literal list are ignored', () => {
  assert.deepEqual(compileLiterals('# a comment\n\nRealThing\n').map((l) => l.literal), [
    'RealThing',
  ]);
});
