#!/usr/bin/env node
/**
 * The semantic lint from ARCHITECTURE.md 6.4 / skills/build-deck-agent/reference-prompts.md,
 * as a mechanical check a CI job can run without a live account. Shape validity is
 * already guaranteed by schema-enforced generation, so this checks meaning:
 *
 *   1. Every "slide N" reference in the deck-specific section of base-directive.md
 *      is a real slide in data/slides/.
 *   2. Every such reference, and every KB sourceSlides entry, falls inside at least
 *      one of project.json's declared chapter ranges.
 *   3. Every KB file's frontmatter chapter is a real chapter and its sourceSlides
 *      resolve to real slides inside that chapter's range.
 *   4. The identity-and-disclosure skeleton (everything in base-directive.md before
 *      "# DECK-SPECIFIC PRESENTING RULES") matches templates/prompts/base-directive.md
 *      byte for byte. That section is copied, never drafted per project.
 *   5. Every goToSlide in data/nav-rules.json is cited in the deck-specific section,
 *      so the routing data and the directive prose cannot drift apart.
 *
 * Two rules from reference-prompts.md are reported as heuristic warnings, not hard
 * failures: proof-point citations pointing at a slide with real key_metrics, and
 * negative directives paired with a stated positive alternative. Both need a
 * discourse-level read a regex can't reliably deliver without false failures; they
 * stay a drafting-time judgment call per reference-prompts.md, this script just
 * surfaces candidates for that reviewer.
 *
 * Usage: node bin/lint-prompts.mjs --project <path> [--json]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFlags, projectRootFrom, result, fail, EXIT, runMain } from '../engine/lib/cli.mjs';

const TOOLKIT_ROOT = resolve(import.meta.dirname, '..');

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { frontmatter: null, body: text };
  const frontmatter = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      frontmatter[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n));
    } else if (raw === 'true' || raw === 'false') {
      frontmatter[key] = raw === 'true';
    } else {
      frontmatter[key] = raw;
    }
  }
  return { frontmatter, body: text.slice(m[0].length) };
}

function skeletonOf(text) {
  const idx = text.indexOf('# DECK-SPECIFIC PRESENTING RULES');
  return idx === -1 ? text : text.slice(0, idx);
}

function inAnyChapterRange(slideNum, chapters) {
  return chapters.some((c) => Array.isArray(c.range) && slideNum >= c.range[0] && slideNum <= c.range[1]);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const projectJsonPath = resolve(projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) fail(flags, EXIT.USAGE, `No project.json at ${projectJsonPath}`);
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
  const chapters = project.chapters || [];

  const slidesDir = resolve(projectRoot, 'data/slides');
  const validSlides = new Set(
    existsSync(slidesDir)
      ? readdirSync(slidesDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => Number(f.replace('.json', '')))
      : [],
  );

  const errors = [];
  const warnings = [];

  // ── Rules 1 & 2: deck-specific slide references ──
  const directivePath = resolve(projectRoot, 'prompts/base-directive.md');
  if (existsSync(directivePath)) {
    const directiveText = readFileSync(directivePath, 'utf8');
    const deckSpecificIdx = directiveText.indexOf('# DECK-SPECIFIC PRESENTING RULES');
    const deckSpecific = deckSpecificIdx === -1 ? '' : directiveText.slice(deckSpecificIdx);
    const cited = new Set();
    for (const match of deckSpecific.matchAll(/\bslide (\d+)\b/gi)) {
      const n = Number(match[1]);
      cited.add(n);
      if (!validSlides.has(n)) errors.push(`base-directive.md deck-specific section cites slide ${n}, which does not exist in data/slides/.`);
      else if (chapters.length && !inAnyChapterRange(n, chapters)) errors.push(`base-directive.md deck-specific section cites slide ${n}, which falls outside every chapter range in project.json.`);
    }

    // ── Rule 5: every nav rule's slide is rendered into the deck-specific section ──
    const navRulesPath = resolve(projectRoot, 'data/nav-rules.json');
    if (existsSync(navRulesPath)) {
      for (const rule of JSON.parse(readFileSync(navRulesPath, 'utf8')).rules || []) {
        if (!cited.has(rule.goToSlide)) errors.push(`data/nav-rules.json sends "${rule.when}" to slide ${rule.goToSlide}, but base-directive.md's deck-specific section never cites slide ${rule.goToSlide}. Re-render the section from data/nav-rules.json.`);
      }
    }

    // ── Rule 4: fixed skeleton must match the template byte for byte ──
    const templatePath = resolve(TOOLKIT_ROOT, 'templates/prompts/base-directive.md');
    if (existsSync(templatePath)) {
      const templateSkeleton = skeletonOf(readFileSync(templatePath, 'utf8'));
      const projectSkeleton = skeletonOf(directiveText);
      if (templateSkeleton !== projectSkeleton) errors.push('base-directive.md\'s identity-and-disclosure skeleton no longer matches templates/prompts/base-directive.md byte for byte.');
    }

    // ── Heuristic: negative directive without a stated positive alternative ──
    for (const sentence of deckSpecific.split(/(?<=[.!?])\s+/)) {
      const isNegative = /\b(never|do not|don't|avoid)\b/i.test(sentence);
      const hasPositive = /\b(instead|rather than|say|offer|use|go to|navigate|answer)\b/i.test(sentence);
      if (isNegative && !hasPositive) warnings.push(`Possible bare negative with no stated alternative: "${sentence.trim()}"`);
    }
  }

  // ── Rule 3: KB frontmatter ──
  const kbDir = resolve(projectRoot, 'data/kb');
  if (existsSync(kbDir)) {
    for (const file of readdirSync(kbDir).filter((f) => f.endsWith('.md'))) {
      const text = readFileSync(resolve(kbDir, file), 'utf8');
      const { frontmatter } = parseFrontmatter(text);
      if (!frontmatter) {
        errors.push(`data/kb/${file} has no frontmatter (chapter, sourceSlides, restrictedTopic required).`);
        continue;
      }
      const chapter = chapters.find((c) => c.title === frontmatter.chapter);
      if (!chapter) {
        errors.push(`data/kb/${file} frontmatter names chapter "${frontmatter.chapter}", which is not in project.json.chapters.`);
        continue;
      }
      for (const n of frontmatter.sourceSlides || []) {
        if (!validSlides.has(n)) errors.push(`data/kb/${file} frontmatter sourceSlides cites slide ${n}, which does not exist in data/slides/.`);
        else if (n < chapter.range[0] || n > chapter.range[1]) errors.push(`data/kb/${file} frontmatter sourceSlides cites slide ${n}, outside its stated chapter "${chapter.title}" (${chapter.range[0]}-${chapter.range[1]}).`);
      }
    }
  }

  // ── Heuristic: proof-point citations should point at a slide with real metrics ──
  const slideMetrics = new Map();
  if (existsSync(slidesDir)) {
    for (const n of validSlides) {
      const slide = JSON.parse(readFileSync(resolve(slidesDir, `${String(n).padStart(2, '0')}.json`), 'utf8'));
      const metrics = slide.content?.key_metrics;
      slideMetrics.set(n, !!metrics && typeof metrics === 'object' && Object.keys(metrics).length > 0);
    }
  }
  const proofWords = /\b(proof|result|case study|metric|data point|example)\b/i;
  if (existsSync(directivePath)) {
    const text = readFileSync(directivePath, 'utf8');
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if (!proofWords.test(sentence)) continue;
      for (const match of sentence.matchAll(/\bslide (\d+)\b/gi)) {
        const n = Number(match[1]);
        if (validSlides.has(n) && slideMetrics.get(n) === false) warnings.push(`Possible proof-point citation to slide ${n}, which has no key_metrics: "${sentence.trim()}"`);
      }
    }
  }

  const ok = errors.length === 0;
  if (!flags.json) {
    for (const w of warnings) console.error(`WARN  ${w}`);
    for (const e of errors) console.error(`FAIL  ${e}`);
    console.error(ok ? `\nlint-prompts: clean (${warnings.length} heuristic warning(s), 0 error(s)).` : `\nlint-prompts: ${errors.length} error(s).`);
  }
  result(flags, { ok, errors, warnings });
  if (!ok) process.exitCode = EXIT.VALIDATION;
}

runMain(main);
