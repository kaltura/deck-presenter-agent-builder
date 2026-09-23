#!/usr/bin/env node
/**
 * Replaces the content of already-attached knowledge base entries in place
 * (same entry ids, same category) when a local data/kb/*.md file changed.
 * Never adds or removes an entry - that is engine/attach-knowledge-base.mjs's
 * job. A local file with no recorded entry is refused, pointing at that
 * command instead of silently creating one here.
 *
 * Idempotent by local content hash: a file is only re-uploaded when its
 * sha256 no longer matches the hash recorded the last time this command (or
 * attach-knowledge-base.mjs) uploaded it. No changed file means no network
 * call at all.
 *
 * Usage: node engine/update-kb.mjs --project <path> [--dry-run] [--yes] [--index-wait-ms=600000] [--json]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, recordStep, assertPartnerMatch } from './lib/state.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (text) => createHash('sha256').update(text).digest('hex');

async function uploadToken(ctx, ks) {
  const tok = await ctx.ovp('uploadtoken', 'add', { uploadToken: {} }, ks);
  return tok.id;
}

// ctx.ovpUpload appends the ks to the body it is given, so it needs a real
// FormData, the same shape the SDK's own uploadMarkdown builds.
export function markdownForm(markdown, name) {
  const fd = new FormData();
  fd.append('fileData', new Blob([markdown], { type: 'text/markdown' }), name);
  return fd;
}

async function replaceEntryContent(ctx, entryId, markdownAssetId, markdown, name, ks) {
  // Two separate upload tokens: one feeds baseentry.updateContent (the doc
  // entry itself), the other feeds attachment_attachmentasset.setContent
  // (the markdown asset that makes the content RAG-searchable). Both must
  // carry the new text for a re-index to see the change.
  const entryTok = await uploadToken(ctx, ks);
  await ctx.ovpUpload(entryTok, markdownForm(markdown, name), ks);
  await ctx.ovp('baseentry', 'updateContent', {
    entryId,
    resource: { objectType: 'KalturaUploadedFileTokenResource', token: entryTok },
  }, ks);

  const assetTok = await uploadToken(ctx, ks);
  await ctx.ovpUpload(assetTok, markdownForm(markdown, name), ks);
  await ctx.ovp('attachment_attachmentasset', 'setContent', {
    id: markdownAssetId,
    contentResource: { objectType: 'KalturaUploadedFileTokenResource', token: assetTok },
  }, ks);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const projectJsonPath = resolve(projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) fail(flags, EXIT.USAGE, `No project.json at ${projectJsonPath}`);
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));

  if (!project.features?.knowledgeBase) {
    progress(flags, 'features.knowledgeBase is off in project.json. Nothing to do.');
    result(flags, { skipped: true, reason: 'knowledgeBase feature is off' });
    return;
  }

  const { mgmt, partnerId } = connect(projectRoot, flags);
  const state = loadState(projectRoot);
  if (!state) fail(flags, EXIT.UNEXPECTED, 'No .provisioning-state.json. Run engine/provision.mjs first.');
  assertPartnerMatch(state, partnerId);

  const knowledgeId = state.steps.knowledgeId?.value;
  const kbEntries = state.steps.kbEntries?.value ?? [];
  if (!knowledgeId || !kbEntries.length) {
    fail(flags, EXIT.UNEXPECTED, 'No knowledge base recorded in .provisioning-state.json. Run engine/attach-knowledge-base.mjs first.');
  }

  const kbDir = resolve(projectRoot, 'data/kb');
  const localFiles = existsSync(kbDir) ? readdirSync(kbDir).filter((f) => f.endsWith('.md')).sort() : [];
  const unrecorded = localFiles.filter((f) => !kbEntries.some((e) => e.file === f));
  if (unrecorded.length) {
    fail(flags, EXIT.VALIDATION, `${unrecorded.join(', ')} in ${kbDir} has no recorded knowledge base entry. Run engine/attach-knowledge-base.mjs to add new files.`);
  }

  // Pure local diff: compare each recorded entry's stored hash against the
  // current file's hash. No network call happens before confirmPlan, so a
  // non-interactive refusal never reaches Kaltura.
  const changed = [];
  for (const entry of kbEntries) {
    const filePath = resolve(kbDir, entry.file);
    if (!existsSync(filePath)) continue; // removed locally: update-kb never deletes, attach-knowledge-base owns additions only
    const markdown = readFileSync(filePath, 'utf8');
    const localHash = hash(markdown);
    if (localHash !== entry.contentHash) changed.push({ ...entry, markdown, localHash });
  }

  if (!changed.length) {
    progress(flags, 'Already up to date.');
    result(flags, { upToDate: true, knowledgeId });
    return;
  }

  const planLines = [`Update knowledge base content for project "${state.slug}" (knowledgeId ${knowledgeId}):`];
  for (const c of changed) {
    // State written before contentHash existed has no hash to compare, so the
    // first run re-uploads once and records one.
    const why = c.contentHash ? 'content changed' : 'no recorded content hash';
    planLines.push(`  ${c.file}: ${why}, re-upload in place (entryId ${c.entryId})`);
  }
  await confirmPlan(flags, planLines);

  const ks = await adminKs(mgmt);
  // SDK internal: the public Knowledge API can only create entries, not replace
  // their content in place. Recheck this field when bumping the SDK.
  const ctx = mgmt.knowledge._;

  for (const c of changed) {
    progress(flags, `[kbEntries] replacing content for ${c.file}...`);
    await replaceEntryContent(ctx, c.entryId, c.markdownAssetId, c.markdown, c.file, ks);
  }

  const indexWaitMs = flags['index-wait-ms'] ? Number(flags['index-wait-ms']) : 600000;
  const DONE = new Set(['SUCCEEDED', 'TOO_SHORT']);
  const FAILED = new Set(['NO_CHAPTERS', 'PARSE_ERROR']);
  const pendingIds = changed.map((c) => String(c.entryId));
  const deadline = Date.now() + indexWaitMs;
  let statuses = new Map();
  await sleep(3000);
  for (;;) {
    let entryStatusResult;
    try { entryStatusResult = await mgmt.knowledge.entryStatus(knowledgeId, pendingIds, ks); } catch { entryStatusResult = null; }
    statuses = new Map();
    for (const e of entryStatusResult?.entries ?? []) {
      const worst = (e.documents ?? []).map((d) => d.status).find((s) => FAILED.has(s)) ?? (e.documents ?? []).find((d) => DONE.has(d.status))?.status ?? null;
      statuses.set(e.entry_id, worst);
    }
    const remaining = pendingIds.filter((id) => !DONE.has(statuses.get(id)) && !FAILED.has(statuses.get(id)));
    if (!remaining.length || Date.now() > deadline) break;
    await sleep(15000);
  }

  const failedFiles = changed.filter((c) => FAILED.has(statuses.get(String(c.entryId)))).map((c) => c.file);
  const timedOutFiles = changed.filter((c) => !DONE.has(statuses.get(String(c.entryId))) && !FAILED.has(statuses.get(String(c.entryId)))).map((c) => c.file);

  if (failedFiles.length || timedOutFiles.length) {
    const errors = [];
    if (failedFiles.length) errors.push(`re-index failed for: ${failedFiles.join(', ')}`);
    if (timedOutFiles.length) errors.push(`re-index still pending after ${indexWaitMs}ms for: ${timedOutFiles.join(', ')}`);
    progress(flags, `Verification FAILED: ${errors.join('; ')}`);
    result(flags, { ok: false, knowledgeId, errors });
    process.exitCode = EXIT.VALIDATION;
    return;
  }

  const updatedEntries = kbEntries.map((e) => {
    const c = changed.find((x) => x.entryId === e.entryId);
    return c ? { ...e, contentHash: c.localHash } : e;
  });
  recordStep(projectRoot, state, 'kbEntries', { value: updatedEntries, origin: state.steps.kbEntries?.origin ?? 'created' });

  progress(flags, 'Verified: content replaced and re-indexed for every changed file.');
  result(flags, { ok: true, knowledgeId, updated: changed.map((c) => c.file) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(main);
