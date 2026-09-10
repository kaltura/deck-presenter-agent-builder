import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { extractPptxNotes, renderNotesMarkdown } from '../engine/lib/pptx-notes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = resolve(ROOT, 'test/fixtures/sample-deck.pptx');

test('extractPptxNotes reads notes in presentation order, decodes entities, skips notesless slides', () => {
  const notes = extractPptxNotes(FIXTURE);
  assert.deepEqual(notes, [
    { slide: 1, notes: 'Welcome the visitor and introduce & frame Canopy.\nMention the fictional demo disclaimer.' },
    { slide: 2, notes: '' },
  ]);
});

test('extractPptxNotes rejects a file that is not a zip', () => {
  assert.throws(() => extractPptxNotes(resolve(ROOT, 'package.json')), /Not a valid zip file/);
});

test('renderNotesMarkdown renders the "## Slide N" shape reference-ingestion.md expects', () => {
  const md = renderNotesMarkdown(extractPptxNotes(FIXTURE));
  assert.equal(
    md,
    '# Speaker notes\n\n' +
      '## Slide 1\n\nWelcome the visitor and introduce & frame Canopy.\nMention the fictional demo disclaimer.\n\n' +
      '## Slide 2\n\n_No speaker notes._\n',
  );
});

test('bin/extract-pptx-notes.mjs writes the rendered markdown and reports slide counts', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'pptx-notes-test-'));
  const dest = resolve(dir, 'notes.md');
  try {
    const out = execFileSync(
      process.execPath,
      [resolve(ROOT, 'bin/extract-pptx-notes.mjs'), FIXTURE, dest, '--json'],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(out.trim());
    assert.equal(result.ok, true);
    assert.equal(result.slides, 2);
    assert.equal(result.withNotes, 1);
    assert.equal(readFileSync(dest, 'utf8'), renderNotesMarkdown(extractPptxNotes(FIXTURE)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
