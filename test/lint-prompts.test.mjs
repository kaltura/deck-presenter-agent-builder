import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// bin/lint-prompts.mjs has no SDK import, so it's fully offline-testable end to
// end via the CLI, not just guard clauses. Uses os.tmpdir() (not a dir under
// ROOT): this script never imports the project's own content.mjs, so it has no
// bare-specifier resolution to worry about.
const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = resolve(ROOT, 'fixtures/smoke-project');
const SKELETON_MARKER = '# DECK-SPECIFIC PRESENTING RULES';

function run(args) {
  const r = spawnSync('node', [resolve(ROOT, 'bin/lint-prompts.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'lint-prompts-test-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function setDeckSpecific(dir, text) {
  const path = resolve(dir, 'prompts/base-directive.md');
  const current = readFileSync(path, 'utf8');
  const skeleton = current.slice(0, current.indexOf(SKELETON_MARKER));
  writeFileSync(path, `${skeleton}${SKELETON_MARKER}\n\n${text}\n`);
}

function setProjectField(dir, field, value) {
  const path = resolve(dir, 'project.json');
  const project = JSON.parse(readFileSync(path, 'utf8'));
  project[field] = value;
  writeFileSync(path, JSON.stringify(project));
}

test('lint-prompts reports clean on the unmodified fixture', () => {
  const { code, stdout } = run(['--project', FIXTURE, '--json']);
  const out = JSON.parse(stdout);
  assert.equal(code, 0);
  assert.deepEqual(out, { ok: true, errors: [], warnings: [] });
});

test('lint-prompts errors when the deck-specific section cites a slide that does not exist', () => {
  const dir = tempProject();
  try {
    setDeckSpecific(dir, 'Present slide 99 as the closer.');
    const { code, stdout } = run(['--project', dir, '--json']);
    const out = JSON.parse(stdout);
    assert.equal(code, 4);
    assert.equal(out.ok, false);
    assert.match(out.errors.join('\n'), /cites slide 99, which does not exist in data\/slides\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint-prompts errors when a cited slide falls outside every chapter range', () => {
  const dir = tempProject();
  try {
    setProjectField(dir, 'chapters', [{ title: 'Pricing', range: [2, 3] }]);
    setDeckSpecific(dir, 'Present slide 1 as the overview.');
    const { code, stdout } = run(['--project', dir, '--json']);
    const out = JSON.parse(stdout);
    assert.equal(code, 4);
    assert.match(out.errors.join('\n'), /cites slide 1, which falls outside every chapter range in project\.json\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint-prompts errors when the identity-and-disclosure skeleton no longer matches the template', () => {
  const dir = tempProject();
  try {
    const path = resolve(dir, 'prompts/base-directive.md');
    const current = readFileSync(path, 'utf8');
    writeFileSync(path, current.replace('# IDENTITY AND DISCLOSURE', '# IDENTITY AND DISCLOSURE (edited)'));
    const { code, stdout } = run(['--project', dir, '--json']);
    const out = JSON.parse(stdout);
    assert.equal(code, 4);
    assert.match(out.errors.join('\n'), /identity-and-disclosure skeleton no longer matches templates\/prompts\/base-directive\.md byte for byte\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint-prompts errors on a data/kb file with no frontmatter', () => {
  const dir = tempProject();
  try {
    mkdirSync(resolve(dir, 'data/kb'), { recursive: true });
    writeFileSync(resolve(dir, 'data/kb/loose.md'), 'Just some text, no frontmatter.\n');
    const { code, stdout } = run(['--project', dir, '--json']);
    const out = JSON.parse(stdout);
    assert.equal(code, 4);
    assert.match(out.errors.join('\n'), /data\/kb\/loose\.md has no frontmatter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint-prompts errors when a kb file names a chapter not in project.json.chapters', () => {
  const dir = tempProject();
  try {
    setProjectField(dir, 'chapters', [{ title: 'Intro', range: [1, 3] }]);
    mkdirSync(resolve(dir, 'data/kb'), { recursive: true });
    writeFileSync(resolve(dir, 'data/kb/ghost.md'), '---\nchapter: Ghost Chapter\nsourceSlides: [1]\n---\nBody.\n');
    const { code, stdout } = run(['--project', dir, '--json']);
    const out = JSON.parse(stdout);
    assert.equal(code, 4);
    assert.match(out.errors.join('\n'), /names chapter "Ghost Chapter", which is not in project\.json\.chapters\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint-prompts errors when a kb file sourceSlides falls outside its stated chapter', () => {
  const dir = tempProject();
  try {
    setProjectField(dir, 'chapters', [{ title: 'Intro', range: [1, 2] }]);
    mkdirSync(resolve(dir, 'data/kb'), { recursive: true });
    writeFileSync(resolve(dir, 'data/kb/mismatch.md'), '---\nchapter: Intro\nsourceSlides: [3]\n---\nBody.\n');
    const { code, stdout } = run(['--project', dir, '--json']);
    const out = JSON.parse(stdout);
    assert.equal(code, 4);
    assert.match(out.errors.join('\n'), /sourceSlides cites slide 3, outside its stated chapter "Intro" \(1-2\)\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint-prompts warns on a bare negative directive with no stated alternative', () => {
  const dir = tempProject();
  try {
    setDeckSpecific(dir, 'Never mention the discontinued model.');
    const { code, stdout } = run(['--project', dir, '--json']);
    const out = JSON.parse(stdout);
    assert.equal(code, 0);
    assert.equal(out.ok, true);
    assert.match(out.warnings.join('\n'), /Possible bare negative with no stated alternative/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint-prompts warns on a proof-point citation to a slide with no key_metrics', () => {
  const dir = tempProject();
  try {
    setDeckSpecific(dir, 'Cite the case study result on slide 1 when asked for proof.');
    const { code, stdout } = run(['--project', dir, '--json']);
    const out = JSON.parse(stdout);
    assert.equal(code, 0);
    assert.equal(out.ok, true);
    assert.match(out.warnings.join('\n'), /Possible proof-point citation to slide 1, which has no key_metrics/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
