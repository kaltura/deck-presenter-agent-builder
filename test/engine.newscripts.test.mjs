import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, cpSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { median, computeIntervals, checkBudgets } from '../engine/verify-startup-timing.mjs';

// Same pattern as test/engine.scripts.test.mjs's tempProject(): the copy must
// live inside this repo (the "*.tmp-*" gitignore rule), not the system tmpdir,
// because content.mjs resolves the @kaltura/intelligent-agents bare specifier
// by walking up from the project directory to this repo's own node_modules.
// A system-tmpdir copy has no such node_modules to find.
const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = resolve(ROOT, 'fixtures/smoke-project');
const FIXTURE_PARTNER_ID = ['1', '2', '3', '4', '5', '6'].join('');

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.KALTURA_PARTNER_ID;
  delete env.KALTURA_ADMIN_SECRET;
  return Object.assign(env, extra);
}

function run(script, args, extraEnv) {
  const r = spawnSync('node', [resolve(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv(extraEnv),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withKnowledgeBaseProject() {
  const dir = mkdtempSync(resolve(ROOT, 'kb-test.tmp-'));
  cpSync(FIXTURE, dir, { recursive: true });
  // Strip any gitignored .env or state file a local run left in the fixture,
  // so this copy starts from a clean, known state.
  for (const f of ['.env', '.provisioning-state.json']) rmSync(resolve(dir, f), { force: true });
  const project = JSON.parse(readFileSync(resolve(dir, 'project.json'), 'utf8'));
  project.features.knowledgeBase = true;
  writeFileSync(resolve(dir, 'project.json'), JSON.stringify(project));
  writeFileSync(resolve(dir, '.env'), `KALTURA_PARTNER_ID=${FIXTURE_PARTNER_ID}\nKALTURA_ADMIN_SECRET=fake-secret-for-dry-run-only\n`);
  mkdirSync(resolve(dir, 'data/kb'), { recursive: true });
  return dir;
}

test('attach-knowledge-base skips with no network call when features.knowledgeBase is off', () => {
  const { code, stderr, stdout } = run('engine/attach-knowledge-base.mjs', ['--project', FIXTURE, '--json']);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /knowledgeBase is off/);
  assert.match(stdout, /"skipped": true/);
});

test('attach-knowledge-base refuses to prompt on a non-interactive stream without --yes', () => {
  const dir = withKnowledgeBaseProject();
  writeFileSync(resolve(dir, 'data/kb/topic-lumen-basics.md'), '# Northwind Lumen basics\n\nLumen keeps a field readable for Iris to describe.\n');
  writeFileSync(
    resolve(dir, '.provisioning-state.json'),
    JSON.stringify({ partnerId: FIXTURE_PARTNER_ID, slug: 'smoke-project', steps: { configId: { value: 4242, origin: 'created' } } }),
  );

  const { code, stderr } = run('engine/attach-knowledge-base.mjs', ['--project', dir]);
  assert.equal(code, 2, stderr);
  assert.match(stderr, /Refusing to prompt on a non-interactive stream/);
  // The plan itself is built and printed entirely from local state; nothing
  // in it should ever require a live intellect read to reach this refusal.
  assert.match(stderr, /category "smoke-project-knowledge-base"/);
  rmSync(dir, { recursive: true, force: true });
});

test('update-kb exits 4 when a local data/kb file has no recorded entry', () => {
  const dir = withKnowledgeBaseProject();
  writeFileSync(resolve(dir, 'data/kb/topic-unrecorded.md'), '# Not yet attached\n\nIris has not attached this note yet.\n');
  writeFileSync(
    resolve(dir, '.provisioning-state.json'),
    JSON.stringify({
      partnerId: FIXTURE_PARTNER_ID,
      slug: 'smoke-project',
      steps: {
        configId: { value: 4242, origin: 'created' },
        knowledgeId: { value: 555, origin: 'created' },
        kbEntries: { value: [{ file: 'topic-lumen-basics.md', entryId: 1, markdownAssetId: 2, contentHash: 'deadbeef' }], origin: 'created' },
      },
    }),
  );

  const { code, stderr } = run('engine/update-kb.mjs', ['--project', dir]);
  assert.equal(code, 4, stderr);
  assert.match(stderr, /topic-unrecorded\.md/);
  assert.match(stderr, /attach-knowledge-base/);
  rmSync(dir, { recursive: true, force: true });
});

test('update-kb refuses to prompt on a non-interactive stream without --yes when local content changed', () => {
  const dir = withKnowledgeBaseProject();
  writeFileSync(resolve(dir, 'data/kb/topic-lumen-basics.md'), '# Northwind Lumen basics, revised\n\nIris now describes the revised field.\n');
  writeFileSync(
    resolve(dir, '.provisioning-state.json'),
    JSON.stringify({
      partnerId: FIXTURE_PARTNER_ID,
      slug: 'smoke-project',
      steps: {
        configId: { value: 4242, origin: 'created' },
        knowledgeId: { value: 555, origin: 'created' },
        // Deliberately wrong hash so the local file reads as changed, with
        // no live fetch needed to know it.
        kbEntries: { value: [{ file: 'topic-lumen-basics.md', entryId: 1, markdownAssetId: 2, contentHash: 'not-the-real-hash' }], origin: 'created' },
      },
    }),
  );

  const { code, stderr } = run('engine/update-kb.mjs', ['--project', dir]);
  assert.equal(code, 2, stderr);
  assert.match(stderr, /Refusing to prompt on a non-interactive stream/);
  assert.match(stderr, /topic-lumen-basics\.md: content changed/);
  rmSync(dir, { recursive: true, force: true });
});

test('update-kb reports up to date with no network call when no local file changed', () => {
  const dir = withKnowledgeBaseProject();
  const content = '# Northwind Lumen basics\n\nIris describes the field as it is today.\n';
  writeFileSync(resolve(dir, 'data/kb/topic-lumen-basics.md'), content);
  const realHash = createHash('sha256').update(content).digest('hex');
  writeFileSync(
    resolve(dir, '.provisioning-state.json'),
    JSON.stringify({
      partnerId: FIXTURE_PARTNER_ID,
      slug: 'smoke-project',
      steps: {
        configId: { value: 4242, origin: 'created' },
        knowledgeId: { value: 555, origin: 'created' },
        kbEntries: { value: [{ file: 'topic-lumen-basics.md', entryId: 1, markdownAssetId: 2, contentHash: realHash }], origin: 'created' },
      },
    }),
  );

  const { code, stderr, stdout } = run('engine/update-kb.mjs', ['--project', dir, '--json']);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /Already up to date/);
  assert.match(stdout, /"upToDate": true/);
  rmSync(dir, { recursive: true, force: true });
});

test('teardown picks up a knowledge base created by attach-knowledge-base', () => {
  const dir = withKnowledgeBaseProject();
  writeFileSync(
    resolve(dir, '.provisioning-state.json'),
    JSON.stringify({
      partnerId: FIXTURE_PARTNER_ID,
      slug: 'smoke-project',
      steps: {
        knowledgeId: { value: 555, origin: 'created' },
        kbEntries: { value: [{ file: 'topic-lumen-basics.md', entryId: 1, markdownAssetId: 2, contentHash: 'deadbeef' }], origin: 'created' },
        kbCategoryId: { value: 777, origin: 'created' },
      },
    }),
  );

  const { code, stderr } = run('engine/teardown.mjs', ['--project', dir, '--dry-run']);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /delete knowledgeId = 555/);
  assert.match(stderr, /delete kbEntries = /);
  assert.match(stderr, /delete kbCategoryId = 777/);
  rmSync(dir, { recursive: true, force: true });
});

test('verify-startup-timing: median is the middle value, or the average of the two middle values', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5]), 5);
});

test('verify-startup-timing: computeIntervals derives greeting and first-reply latency from ordered milestones', () => {
  const milestones = [
    { name: 'pageLoad', tMs: 0 },
    { name: 'disclaimerAck', tMs: 100 },
    { name: 'sessionStart', tMs: 200 },
    { name: 'greeting', tMs: 3200 },
    { name: 'typedContinue', tMs: 3300 },
    { name: 'firstReply', tMs: 5300 },
  ];
  assert.deepEqual(computeIntervals(milestones), { greetingMs: 3000, firstReplyMs: 2000 });
});

test('verify-startup-timing: computeIntervals throws when a required milestone is missing', () => {
  assert.throws(() => computeIntervals([{ name: 'sessionStart', tMs: 0 }]), /Missing milestone/);
});

test('verify-startup-timing: checkBudgets fails only the interval(s) whose median exceeds budget plus slack', () => {
  const runs = [
    { greetingMs: 9000, firstReplyMs: 2000 },
    { greetingMs: 9100, firstReplyMs: 2100 },
    { greetingMs: 8900, firstReplyMs: 1900 },
  ];
  const { ok, failures, medians } = checkBudgets(runs, { greetingMs: 8000, firstReplyMs: 6000 }, 500);
  assert.equal(ok, false);
  assert.equal(medians.greetingMs, 9000);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, 'greetingMs');
});

test('verify-startup-timing: checkBudgets passes when every median is within budget plus slack', () => {
  const runs = [{ greetingMs: 7000, firstReplyMs: 5000 }];
  const { ok, failures } = checkBudgets(runs, { greetingMs: 8000, firstReplyMs: 6000 }, 0);
  assert.equal(ok, true);
  assert.equal(failures.length, 0);
});

test('update-kb markdownForm builds the FormData body ctx.ovpUpload expects', async () => {
  const { markdownForm } = await import('../engine/update-kb.mjs');
  const fd = markdownForm('# Canopy pricing\n', 'pricing.md');
  assert.ok(fd instanceof FormData);
  const file = fd.get('fileData');
  assert.equal(file.name, 'pricing.md');
  assert.equal(file.type, 'text/markdown');
  assert.equal(await file.text(), '# Canopy pricing\n');
});

test('engine entry guards still run main from a path with a space', () => {
  const dir = resolve(ROOT, 'engine.tmp-space test');
  rmSync(dir, { recursive: true, force: true });
  cpSync(resolve(ROOT, 'engine'), dir, { recursive: true });
  try {
    for (const script of ['bundle.mjs', 'update-kb.mjs', 'attach-tool.mjs']) {
      const r = spawnSync('node', [resolve(dir, script)], { cwd: ROOT, encoding: 'utf8', env: cleanEnv() });
      // No --project: main runs and fails with bad usage. A skipped main exits 0 silently.
      assert.equal(r.status, 2, `${script}: ${r.stderr}`);
      assert.match(r.stderr, /--project/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
