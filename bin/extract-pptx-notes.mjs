#!/usr/bin/env node
/**
 * Native PPTX speaker-notes extraction. Reads a
 * .pptx directly (it's a zip of OOXML) and writes the same "## Slide N"
 * markdown shape reference-ingestion.md already expects from a
 * hand-prepared notes.md, so a PPTX deck feeds the same ingest stage a
 * PDF + notes.md pair does.
 *
 * This extracts speaker notes only. It does not render slide visuals; the
 * ingest stage's vision pass still needs the deck exported as PDF or
 * images separately.
 *
 * Usage: node bin/extract-pptx-notes.mjs <deck.pptx> <out-notes.md> [--json]
 */
import { writeFileSync } from 'node:fs';
import { extractPptxNotes, renderNotesMarkdown } from '../engine/lib/pptx-notes.mjs';
import { parseFlags, progress, result, fail, EXIT, runMain } from '../engine/lib/cli.mjs';

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const [src, dest] = flags._;
  if (!src || !dest) fail(flags, EXIT.USAGE, 'Usage: node bin/extract-pptx-notes.mjs <deck.pptx> <out-notes.md> [--json]');

  const notesBySlide = extractPptxNotes(src);
  const withNotes = notesBySlide.filter((s) => s.notes).length;
  writeFileSync(dest, renderNotesMarkdown(notesBySlide));

  progress(flags, `${notesBySlide.length} slides, ${withNotes} with notes -> ${dest}`);
  result(flags, { ok: true, slides: notesBySlide.length, withNotes, out: dest });
}

runMain(main);
