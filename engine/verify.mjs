#!/usr/bin/env node
/**
 * Read-only checks against one project's live Kaltura resources. No call in
 * this file can mutate anything.
 *
 * Usage:
 *   node engine/verify.mjs --project <path> snapshot <label>
 *   node engine/verify.mjs --project <path> compare
 *   node engine/verify.mjs --project <path> smoke ["question"] [--dry-run]
 *
 * snapshot writes the current live avatar + intellect to
 * .verify-snapshots/<label>.json (gitignored, project-local).
 * compare diffs live state against a prior "before" snapshot (if one exists,
 * to catch unintended side effects) and always diffs the live avatar/intellect
 * against what this project's own content.mjs says they should be.
 * smoke sends one text turn to the intellect; it creates a conversation and
 * changes no config. With --dry-run it prints the turn instead of sending it.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFlags, projectRootFrom, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, assertPartnerMatch } from './lib/state.mjs';
import { loadContent } from './lib/load-content.mjs';

const stable = (o) => JSON.stringify(o, Object.keys(o || {}).sort(), 2);
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const strip = (o) => { const c = JSON.parse(JSON.stringify(o || {})); delete c.readAt; return c; };
// intellects.get() echoes prompts back as an object keyed by index, with each
// entry carrying server-added fields (e.g. "mode") that content.mjs never sets.
// content.PROMPTS is a plain array. Normalize the container and compare only
// the fields we actually push, or every prompt would show as a MISMATCH even
// when the wording is unchanged.
const promptsArray = (v) => (Array.isArray(v) ? v : Object.keys(v || {}).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]));
const pickExpectedFields = (liveEntry, expectedEntry) => {
  if (!expectedEntry || typeof liveEntry !== 'object' || Array.isArray(liveEntry)) return liveEntry;
  return Object.fromEntries(Object.keys(expectedEntry).map((f) => [f, liveEntry[f]]));
};
const promptsMatch = (live, expected) => {
  const liveArr = promptsArray(live);
  const expArr = promptsArray(expected);
  return liveArr.length === expArr.length && liveArr.every((entry, i) => eq(pickExpectedFields(entry, expArr[i]), expArr[i]));
};

function snapshotsDir(projectRoot) {
  return resolve(projectRoot, '.verify-snapshots');
}

async function readLive(mgmt, ks, state) {
  const avatarId = state.steps.avatarId?.value;
  const configId = state.steps.configId?.value;
  if (!avatarId || !configId) throw new Error('No avatarId/configId in .provisioning-state.json yet. Run engine/provision.mjs first.');
  const avatar = await mgmt.avatars.get(avatarId, ks);
  const intellect = await mgmt.intellects.get(configId, ks);
  return { avatar, intellect, readAt: new Date().toISOString() };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const cmd = flags._[0];
  if (!['snapshot', 'compare', 'smoke'].includes(cmd)) {
    fail(flags, EXIT.USAGE, 'Usage: verify.mjs --project <path> <snapshot <label>|compare|smoke ["question"]>');
  }

  const { mgmt, partnerId } = connect(projectRoot, flags);
  const state = loadState(projectRoot);
  if (!state) fail(flags, EXIT.UNEXPECTED, 'No .provisioning-state.json. Run engine/provision.mjs first.');
  assertPartnerMatch(state, partnerId);
  const ks = await adminKs(mgmt);

  if (cmd === 'snapshot') {
    const label = flags._[1] || 'before';
    const dir = snapshotsDir(projectRoot);
    mkdirSync(dir, { recursive: true });
    const snap = await readLive(mgmt, ks, state);
    const out = resolve(dir, `${label}.json`);
    writeFileSync(out, JSON.stringify(snap, null, 2));
    progress(flags, `wrote ${out}`);
    result(flags, { wrote: out, avatarId: snap.avatar?.id, configId: snap.intellect?.id });
    return;
  }

  if (cmd === 'compare') {
    const after = await readLive(mgmt, ks, state);
    const dir = snapshotsDir(projectRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'after.json'), JSON.stringify(after, null, 2));

    const report = { fields: {}, sideEffects: null };
    let ok = true;

    const beforePath = resolve(dir, 'before.json');
    if (existsSync(beforePath)) {
      const before = JSON.parse(readFileSync(beforePath, 'utf8'));
      const avatarSame = stable(strip(before.avatar)) === stable(strip(after.avatar));
      const intellectSame = stable(strip(before.intellect)) === stable(strip(after.intellect));
      report.sideEffects = { avatarUnchanged: avatarSame, intellectUnchanged: intellectSame };
      progress(flags, `avatar unchanged since before-snapshot: ${avatarSame}`);
      progress(flags, `intellect unchanged since before-snapshot: ${intellectSame}`);
    }

    const content = await loadContent(projectRoot);
    const vi = after.intellect;
    const va = after.avatar;

    const checks = {
      base_directive: vi.base_directive === content.BASE_DIRECTIVE,
      prompts: promptsMatch(vi.prompts, content.PROMPTS),
      glossary: eq(vi.glossary, content.GLOSSARY),
      allow_client_variables: vi.allow_client_variables === true,
      opening_phrase: vi.opening_phrase === content.OPENING_PHRASE,
      legacy_avatar_opening_phrase_cleared: va.openingPhrase == null,
    };
    const capDiff = Object.entries(content.CAPABILITIES).filter(([k, v]) => vi.capabilities?.[k] !== v);
    checks.capabilities = capDiff.length === 0;

    const expectedToolIds = [
      state.steps.navToolId?.value,
      state.steps.contactToolId?.value,
      state.steps.endSessionToolId?.value,
    ].filter((id) => id != null).map(String);
    checks.tool_ids = eq((vi.tool_ids || []).map(String), expectedToolIds);

    const expectedKnowledgeIds = state.steps.knowledgeId?.value != null ? [state.steps.knowledgeId.value] : [];
    checks.knowledge_ids = eq(vi.knowledge_ids || [], expectedKnowledgeIds);

    for (const [field, pass] of Object.entries(checks)) {
      report.fields[field] = pass;
      progress(flags, `${field}: ${pass ? 'match' : 'MISMATCH'}`);
      if (!pass) ok = false;
    }
    if (capDiff.length) progress(flags, `  capabilities differ: ${JSON.stringify(capDiff)}`);
    if (!checks.tool_ids) progress(flags, `  tool_ids: live=${JSON.stringify(vi.tool_ids)} expected=${JSON.stringify(expectedToolIds)}`);
    if (!checks.knowledge_ids) progress(flags, `  knowledge_ids: live=${JSON.stringify(vi.knowledge_ids)} expected=${JSON.stringify(expectedKnowledgeIds)}`);

    result(flags, { ok, ...report });
    if (!ok) process.exitCode = EXIT.VALIDATION;
    return;
  }

  if (cmd === 'smoke') {
    const configId = state.steps.configId?.value;
    if (!configId) fail(flags, EXIT.UNEXPECTED, 'No configId in .provisioning-state.json. Run engine/provision.mjs first.');
    const question = flags._[1] || 'Hello! In one sentence, what is this presentation about?';
    if (flags['dry-run']) {
      progress(flags, `[dry-run] would send one conversational turn to configId ${configId}: "${question}"`);
      result(flags, { dryRun: true, question, configId });
      return;
    }
    const r = await mgmt.converseOnce(configId, question, { recoverFromSpiral: true });
    result(flags, { question, text: r?.text, status: r?.status, error: r?.error });
    return;
  }
}

runMain(main);
