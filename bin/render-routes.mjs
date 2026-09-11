#!/usr/bin/env node
/**
 * Deterministically render data/routes.json from data/nav-rules.json, per
 * skills/build-deck-agent/reference-prompts.md: "data/routes.json: never
 * hand-edit it. If it's wrong, the source of truth (data/nav-rules.json) is
 * wrong; fix it there and re-render."
 *
 * Takes every nav-rules.json rule that carries a "topic" field (rules with no
 * topic are conversational triggers only, out of scope here) and writes
 * data/routes.json as [{ topic, entrySlide, aliases }].
 *
 * Usage: node bin/render-routes.mjs --project <path> [--json]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFlags, projectRootFrom, progress, result, fail, EXIT, runMain } from '../engine/lib/cli.mjs';

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);

  const navRulesPath = resolve(projectRoot, 'data/nav-rules.json');
  if (!existsSync(navRulesPath)) fail(flags, EXIT.USAGE, `No data/nav-rules.json at ${navRulesPath}`);
  const navRules = JSON.parse(readFileSync(navRulesPath, 'utf8'));

  const slidesDir = resolve(projectRoot, 'data/slides');
  const validSlides = new Set(
    existsSync(slidesDir)
      ? readdirSync(slidesDir).filter((f) => f.endsWith('.json')).map((f) => Number(f.replace('.json', '')))
      : [],
  );

  const errors = [];
  const seenTopics = new Set();
  const routes = [];

  for (const rule of navRules.rules || []) {
    if (!rule.topic) continue;
    if (seenTopics.has(rule.topic)) errors.push(`Duplicate topic "${rule.topic}" in data/nav-rules.json.`);
    seenTopics.add(rule.topic);
    if (typeof rule.goToSlide !== 'number' || !validSlides.has(rule.goToSlide)) {
      errors.push(`Topic "${rule.topic}" has goToSlide ${JSON.stringify(rule.goToSlide)}, which is not a real slide in data/slides/.`);
      continue;
    }
    routes.push({ topic: rule.topic, entrySlide: rule.goToSlide, aliases: rule.aliases || [] });
  }

  if (errors.length) {
    for (const e of errors) console.error(`FAIL  ${e}`);
    result(flags, { ok: false, errors });
    process.exitCode = EXIT.VALIDATION;
    return;
  }

  const routesPath = resolve(projectRoot, 'data/routes.json');
  const rendered = `${JSON.stringify(routes, null, 2)}\n`;
  const current = existsSync(routesPath) ? readFileSync(routesPath, 'utf8') : null;
  const changed = rendered !== current;
  if (changed) writeFileSync(routesPath, rendered);

  progress(flags, changed ? `Wrote ${routesPath} (${routes.length} topic(s))` : `${routesPath} already up to date (${routes.length} topic(s))`);
  result(flags, { ok: true, changed, routesPath, count: routes.length });
}

runMain(main);
