#!/usr/bin/env node
/**
 * A chunk-level retrieval eval over a project's KB files (synthetic Q&A,
 * recall and precision) so a retrieval miss is distinguishable from a
 * generation miss.
 *
 * The live agent's actual retrieval runs server-side inside Kaltura's own
 * use_knowledge_base capability, which this repo never re-implements and
 * this script never calls. What this checks instead: given the KB files as
 * authored, does a straightforward chunk-and-score retrieval find the
 * passage a synthetic question is actually about? That is a proxy for KB
 * authoring quality (is the right answer in a single self-contained chunk,
 * phrased so its own words overlap with how someone would ask about it),
 * not a guarantee about Kaltura's own retrieval engine. It runs no LLM, so
 * a low score here means "the KB needs rewriting," never "the model
 * hallucinated" — that second failure mode is out of scope for this check.
 *
 * Chunking: split each KB file's body (after frontmatter) on "## " headers.
 * Scoring: token-overlap (Jaccard) between the question and each chunk's
 * heading + text, case-insensitive, stopword-free.
 *
 * Usage: node bin/eval-retrieval.mjs --project <path> [--json] [--top-k 3]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFlags, projectRootFrom, result, fail, EXIT, runMain } from '../engine/lib/cli.mjs';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'did', 'can', 'could', 'what', 'when', 'where', 'why', 'how',
  'to', 'of', 'in', 'on', 'for', 'and', 'or', 'if', 'it', 'this', 'that', 'with', 'about', 'than', 'more',
  'i', 'we', 'our', 'their', 'has', 'have', 'be', 'get', 'gets', 'there', 'not', 'no', 'any', 'so',
]);

function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function chunksOf(kbDir) {
  const chunks = [];
  for (const file of readdirSync(kbDir).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(resolve(kbDir, file), 'utf8');
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
    const parts = body.split(/^## /m);
    // parts[0] is the "# Title" preamble before any "## " heading, skip it.
    for (const part of parts.slice(1)) {
      const newlineIdx = part.indexOf('\n');
      const heading = (newlineIdx === -1 ? part : part.slice(0, newlineIdx)).trim();
      const rest = newlineIdx === -1 ? '' : part.slice(newlineIdx + 1);
      chunks.push({ file, heading, tokens: tokenize(`${heading} ${rest}`) });
    }
  }
  return chunks;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const topK = Number(flags['top-k'] || 3);

  const kbDir = resolve(projectRoot, 'data/kb');
  const qaPath = resolve(projectRoot, 'data/kb-eval.json');
  if (!existsSync(kbDir)) fail(flags, EXIT.USAGE, `No data/kb/ at ${kbDir}`);
  if (!existsSync(qaPath)) fail(flags, EXIT.USAGE, `No synthetic Q&A fixture at ${qaPath}`);

  const chunks = chunksOf(kbDir);
  const qaSet = JSON.parse(readFileSync(qaPath, 'utf8'));

  let hits = 0;
  let top1Hits = 0;
  const misses = [];

  for (const qa of qaSet) {
    const qTokens = tokenize(qa.question);
    const ranked = chunks
      .map((c) => ({ ...c, score: jaccard(qTokens, c.tokens) }))
      .sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, topK);
    const found = top.some((c) => c.file === qa.file && c.heading === qa.heading);
    const top1 = ranked[0];
    if (found) hits += 1;
    if (top1 && top1.file === qa.file && top1.heading === qa.heading) top1Hits += 1;
    if (!found) {
      misses.push({
        question: qa.question,
        expected: `${qa.file} :: ${qa.heading}`,
        gotTop1: top1 ? `${top1.file} :: ${top1.heading} (score ${top1.score.toFixed(2)})` : 'no chunks',
      });
    }
  }

  const recall = qaSet.length ? hits / qaSet.length : 1;
  const precisionAt1 = qaSet.length ? top1Hits / qaSet.length : 1;
  const ok = recall === 1;

  if (!flags.json) {
    for (const m of misses) {
      console.error(`MISS  Q: "${m.question}"\n      expected: ${m.expected}\n      got top-1: ${m.gotTop1}`);
    }
    console.error(
      `\neval-retrieval: recall@${topK} ${(recall * 100).toFixed(0)}% (${hits}/${qaSet.length}), precision@1 ${(precisionAt1 * 100).toFixed(0)}% (${top1Hits}/${qaSet.length}).`,
    );
  }
  result(flags, { ok, recall, precisionAt1, total: qaSet.length, hits, top1Hits, misses });
  if (!ok) process.exitCode = EXIT.VALIDATION;
}

runMain(main);
