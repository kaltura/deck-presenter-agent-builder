#!/usr/bin/env node
/**
 * Scaffolds a brand-new, private, per-deck project repo from templates/project/.
 * Never writes into this toolkit's own repo: a project is always a separate git
 * repository, so real deck content structurally cannot reach here.
 *
 * Usage:
 *   npx deck-presenter-agent-builder create <dir> [--slug <slug>] [--yes] [--json] [--dry-run]
 *   node bin/create-project.mjs <dir> [--slug <slug>] [--yes] [--json] [--dry-run]
 */
import { existsSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseFlags, confirmPlan, progress, result, fail, EXIT, runMain } from '../engine/lib/cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLKIT_ROOT = resolve(__dirname, '..');

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'deck-project'
  );
}

function templateVersion() {
  try {
    return execFileSync('git', ['-C', TOOLKIT_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const targetArg = flags._.find((a) => a !== 'create');
  if (!targetArg) {
    fail(flags, EXIT.USAGE, 'Usage: create-project.mjs <dir> [--slug <slug>] [--yes] [--json] [--dry-run]');
  }

  const targetDir = resolve(String(targetArg));
  if (targetDir === TOOLKIT_ROOT || (targetDir + sep).startsWith(TOOLKIT_ROOT + sep)) {
    fail(
      flags,
      EXIT.USAGE,
      `Refusing to scaffold inside this toolkit's own repo (${TOOLKIT_ROOT}). A project is always a separate repo, outside this one.`,
    );
  }
  if (existsSync(resolve(targetDir, 'project.json'))) {
    fail(flags, EXIT.USAGE, `${targetDir} already has a project.json. Refusing to overwrite an existing project.`);
  }

  const slug = slugify(flags.slug || basename(targetDir));

  const planLines = [
    `Scaffold a new project at ${targetDir} (slug "${slug}"):`,
    '  copy templates/project/* as the project skeleton',
    '  copy templates/prompts/* into prompts/',
    '  copy client/ (the presenter app) into client/',
    '  copy engine/ into scripts/, plus doctor.mjs at the project root',
    '  copy skills/build-deck-agent/ (plus docs/implementation-appendix.md) into .claude/skills/build-deck-agent/ (if built)',
    '  write project.json, package.json, .template-version',
    '  git init (if not already a repo)',
  ];
  await confirmPlan(flags, planLines);

  mkdirSync(targetDir, { recursive: true });

  // ── Project skeleton (CLAUDE.md, .env.example, .gitignore, consent/, data/, docs/, client/prompt-format.js, content.mjs, project.json) ──
  cpSync(resolve(TOOLKIT_ROOT, 'templates/project'), targetDir, { recursive: true });

  // ── Prompt skeletons: {{PLACEHOLDER}} starting point for the skill's drafting stage ──
  cpSync(resolve(TOOLKIT_ROOT, 'templates/prompts'), resolve(targetDir, 'prompts'), { recursive: true });

  // ── The generic presenter app. templates/project/client/prompt-format.js is a vendored
  // duplicate for content.mjs to import at scaffold time; this copy replaces it with the
  // full app (app.js, index.html, styles.css, assets/), so prompt-format.js must stay
  // byte-identical between the two sources or this copy silently forks it. ──
  cpSync(resolve(TOOLKIT_ROOT, 'client'), resolve(targetDir, 'client'), { recursive: true });

  // ── The engine, parameterized entirely by this project's own project.json + .env ──
  cpSync(resolve(TOOLKIT_ROOT, 'engine'), resolve(targetDir, 'scripts'), { recursive: true });

  // ── The environment/credential preflight, rewritten to import from ./scripts/lib
  // instead of ../engine/lib since it now lives at the project root, not in bin/. ──
  const doctorSrc = readFileSync(resolve(TOOLKIT_ROOT, 'bin/doctor.mjs'), 'utf8');
  writeFileSync(resolve(targetDir, 'doctor.mjs'), doctorSrc.replaceAll('../engine/lib/', './scripts/lib/'));

  // ── The pipeline skill, discoverable the moment Claude Code opens this folder ──
  const skillSrc = resolve(TOOLKIT_ROOT, 'skills/build-deck-agent');
  if (existsSync(skillSrc)) {
    mkdirSync(resolve(targetDir, '.claude/skills'), { recursive: true });
    cpSync(skillSrc, resolve(targetDir, '.claude/skills/build-deck-agent'), { recursive: true });
    // The concrete Kaltura call contract the skill's reference-provisioning.md points
    // at. Copied alongside the skill so a scaffolded project is self-contained and
    // never needs a live checkout of the toolkit repo to troubleshoot provisioning.
    const appendixSrc = resolve(TOOLKIT_ROOT, 'docs/implementation-appendix.md');
    if (existsSync(appendixSrc)) {
      cpSync(appendixSrc, resolve(targetDir, '.claude/skills/build-deck-agent/reference-implementation-appendix.md'));
    }
  } else {
    progress(flags, 'skills/build-deck-agent does not exist yet in this toolkit checkout; skipped.');
  }

  // ── project.json: stamp the slug into the template skeleton ──
  const projectJsonPath = resolve(targetDir, 'project.json');
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
  project.slug = slug;
  writeFileSync(projectJsonPath, JSON.stringify(project, null, 2) + '\n');

  // ── package.json: the SDK version pin is read from this toolkit's own package.json,
  // never duplicated by hand, so the two can never drift. ──
  const toolkitPkg = JSON.parse(readFileSync(resolve(TOOLKIT_ROOT, 'package.json'), 'utf8'));
  const projectPkg = {
    name: slug,
    version: '0.0.0',
    private: true,
    type: 'module',
    engines: { node: '>=22' },
    dependencies: { '@kaltura/intelligent-agents': toolkitPkg.dependencies['@kaltura/intelligent-agents'] },
    devDependencies: { esbuild: toolkitPkg.devDependencies.esbuild },
  };
  writeFileSync(resolve(targetDir, 'package.json'), JSON.stringify(projectPkg, null, 2) + '\n');

  // ── What this project was scaffolded from, for check-template-update.mjs (ARCHITECTURE.md 12) ──
  writeFileSync(resolve(targetDir, '.template-version'), templateVersion() + '\n');

  // ── This project is its own repo from the start ──
  if (!existsSync(resolve(targetDir, '.git'))) {
    execFileSync('git', ['init', '-q'], { cwd: targetDir });
  }

  progress(flags, `Scaffolded ${targetDir}.`);
  progress(flags, 'Next: copy your deck and speaker notes into input/, fill in .env and project.json, then open this folder in Claude Code and run /build-deck-agent.');
  result(flags, { ok: true, targetDir, slug, templateVersion: templateVersion() });
}

runMain(main);
