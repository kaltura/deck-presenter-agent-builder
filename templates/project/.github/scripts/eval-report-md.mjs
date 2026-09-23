#!/usr/bin/env node
// Renders one docs/eval-runs/*.json report as Markdown on stdout. Read-only.
// Usage: node .github/scripts/eval-report-md.mjs <report.json> [run-url]
import { readFileSync } from 'node:fs';

const [path, runUrl] = process.argv.slice(2);
if (!path) {
  process.stderr.write('Usage: node .github/scripts/eval-report-md.mjs <report.json> [run-url]\n');
  process.exit(2);
}
const r = JSON.parse(readFileSync(path, 'utf8'));

// An item with its own boolean `pass` is judged by that alone, since its other
// false fields can be diagnostics of a pass. Otherwise every field that is false
// or holds { pass: false } is a failed sub-check.
const failedFields = (item) => {
  if (typeof item.pass === 'boolean') return item.pass ? [] : ['pass'];
  return Object.entries(item).filter(([, v]) => v === false || v?.pass === false).map(([k]) => k);
};
const labelOf = (item) => item.q ?? item.term ?? item.topic ?? item.label ?? item.kind ?? JSON.stringify(item).slice(0, 80);

const ok = r.checks.every((c) => c.pass);
const lines = [
  `**Nightly eval: ${ok ? 'PASS' : 'FAIL'}, ${r.summary}** (${r.timestamp})`,
  '',
  '| # | Check | Result | Items failed |',
  '|---|---|---|---|',
];
const failures = [];
for (const c of r.checks) {
  const items = Array.isArray(c.detail) ? c.detail.filter((it) => it && typeof it === 'object') : [];
  const bad = items.map((it) => ({ it, why: failedFields(it) })).filter((x) => x.why.length);
  lines.push(`| ${c.n} | ${c.name} | ${c.pass ? 'pass' : 'FAIL'} | ${items.length ? `${bad.length} / ${items.length}` : ''} |`);
  for (const { it, why } of bad) failures.push(`- **${c.name}**: ${labelOf(it)}${why[0] === 'pass' ? '' : ` (failed: ${why.join(', ')})`}`);
}
if (failures.length) lines.push('', '**Failed items**', '', ...failures);
if (runUrl) lines.push('', `Full JSON report: run artifact at ${runUrl}`);
process.stdout.write(`${lines.join('\n')}\n`);
