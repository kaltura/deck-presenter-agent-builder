#!/usr/bin/env node
/**
 * Deletes everything this project's own .provisioning-state.json says it
 * created. Never touches an id recorded as "adopted". Aborts before any
 * delete if the state file's partnerId does not match .env.
 *
 * Usage: node engine/teardown.mjs --project <path> [--dry-run] [--yes] [--json]
 */
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, writeState, statePath } from './lib/state.mjs';
import { deleteEntry, deleteShortLink } from './lib/ovp.mjs';
import { pathToFileURL } from 'node:url';

/** Reverse of creation order: deploy.mjs runs after provision.mjs, so its ids die first. */
const DELETE_ORDER = [
  'shortLinkId',
  'htmlEntryId',
  'pdfEntryId',
  'widgetId', // no delete call exists for a widget id; it is dropped by deleting the agent.
  'followUpLifecycleRuleBId',
  'followUpLifecycleRuleAId',
  'followUpInsightSettingIds',
  'followUpEmailTemplateId',
  'feedbackLifecycleRuleBId',
  'feedbackLifecycleRuleAId',
  'feedbackInsightSettingIds',
  'feedbackTemplateId',
  'agentId',
  'avatarId',
  'configId',
  'knowledgeId',
  'kbEntries',
  'kbCategoryId',
  'endSessionToolId',
  'contactToolId',
  'navToolId',
];

// Every SDK delete call has its own built-in confirmation gate ({confirmPermanent: true}),
// on top of this engine's own confirmPlan(). Both must agree before anything is deleted.
const CONFIRM = { confirmPermanent: true, force: true };
const DELETERS = {
  shortLinkId: (mgmt, id, ks) => deleteShortLink(ks, id),
  htmlEntryId: (mgmt, id, ks) => deleteEntry(ks, id),
  pdfEntryId: (mgmt, id, ks) => deleteEntry(ks, id),
  followUpLifecycleRuleAId: (mgmt, id, ks) => mgmt.lifecycle.delete(id, ks, CONFIRM),
  followUpLifecycleRuleBId: (mgmt, id, ks) => mgmt.lifecycle.delete(id, ks, CONFIRM),
  followUpEmailTemplateId: (mgmt, id, ks) => mgmt.emailTemplates.delete(id, ks, CONFIRM),
  feedbackLifecycleRuleAId: (mgmt, id, ks) => mgmt.lifecycle.delete(id, ks, CONFIRM),
  feedbackLifecycleRuleBId: (mgmt, id, ks) => mgmt.lifecycle.delete(id, ks, CONFIRM),
  feedbackTemplateId: (mgmt, id, ks) => mgmt.emailTemplates.delete(id, ks, CONFIRM),
  agentId: (mgmt, id, ks) => mgmt.agents.delete(id, ks, CONFIRM),
  avatarId: (mgmt, id, ks) => mgmt.avatars.delete(id, ks, CONFIRM),
  configId: (mgmt, id, ks) => mgmt.intellects.delete(id, ks, CONFIRM),
  knowledgeId: (mgmt, id, ks) => mgmt.knowledge.deleteRecord(id, ks, CONFIRM),
  kbCategoryId: () => { throw new Error('no delete call for a knowledge category; remove it by hand in the KMC.'); },
  endSessionToolId: (mgmt, id, ks) => mgmt.tools.delete(id, ks, CONFIRM),
  contactToolId: (mgmt, id, ks) => mgmt.tools.delete(id, ks, CONFIRM),
  navToolId: (mgmt, id, ks) => mgmt.tools.delete(id, ks, CONFIRM),
};

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const { mgmt, partnerId } = connect(projectRoot, flags);

  const state = loadState(projectRoot);
  if (!state) fail(flags, EXIT.UNEXPECTED, `No .provisioning-state.json at ${statePath(projectRoot)}. Teardown needs it; a missing state file is a hard error, not an empty success.`);

  if (String(state.partnerId) !== String(partnerId)) {
    fail(
      flags,
      EXIT.UNEXPECTED,
      `.provisioning-state.json was written for partner ${state.partnerId}, but .env now points at partner ${partnerId}. Refusing to delete anything.`,
    );
  }

  const created = DELETE_ORDER.filter((k) => state.steps[k]?.origin === 'created' && state.steps[k].value != null);
  const adopted = Object.entries(state.steps).filter(([, v]) => v?.origin === 'adopted');

  const planLines = [`Teardown plan for project "${state.slug}" (partner ${partnerId}):`];
  for (const key of created) planLines.push(`  delete ${key} = ${JSON.stringify(state.steps[key].value)}`);
  for (const [key, v] of adopted) planLines.push(`  skip ${key} = ${JSON.stringify(v.value)} (origin: adopted, not this project's to delete)`);
  if (!created.length) planLines.push('  nothing to delete: no id in this state file is recorded as created.');

  await confirmPlan(flags, planLines);

  if (!created.length) {
    result(flags, { deleted: [], skipped: adopted.map(([k]) => k), survivors: [] });
    return;
  }

  const ks = await adminKs(mgmt);
  const deleted = [];
  const survivors = [];

  for (const key of created) {
    const step = state.steps[key];
    if (key === 'kbEntries') {
      // Each entry is a document entry this project uploaded, so it is deleted by its own id.
      // The category has no delete call, so it never takes the entries with it.
      progress(flags, `[${key}] deleting ${step.value.length} knowledge entry(ies)...`);
      const r = await deleteKbEntries(
        step,
        (id) => deleteEntry(ks, id),
        () => writeState(projectRoot, state),
        (msg) => progress(flags, `[${key}] ${msg}`),
      );
      deleted.push(...r.deleted);
      survivors.push(...r.survivors);
      if (!step.value.length) {
        delete state.steps[key];
        writeState(projectRoot, state);
      }
      continue;
    }
    if (key === 'widgetId') {
      // No delete call exists for a widget id; it is dropped when the agent is deleted.
      progress(flags, `[${key}] no delete call for a widget id; it is dropped with the agent.`);
      deleted.push({ key, id: step.value, droppedWithAgent: true });
      delete state.steps[key];
      writeState(projectRoot, state);
      continue;
    }
    if (key === 'followUpInsightSettingIds' || key === 'feedbackInsightSettingIds') {
      progress(flags, `[${key}] deleting ${Object.keys(step.value).length} insight setting(s)...`);
      for (const [insightKey, id] of Object.entries(step.value)) {
        try {
          await mgmt.insightSettings.delete(id, ks, CONFIRM);
        } catch (err) {
          if (!isAlreadyGone(err)) throw err;
        }
        progress(flags, `[${key}] deleted ${insightKey} (${id})`);
      }
      deleted.push({ key, id: step.value });
      delete state.steps[key];
      writeState(projectRoot, state);
      continue;
    }
    const del = DELETERS[key];
    try {
      progress(flags, `[${key}] deleting ${step.value}...`);
      await del(mgmt, step.value, ks);
      deleted.push({ key, id: step.value });
      delete state.steps[key];
      writeState(projectRoot, state);
      progress(flags, `[${key}] deleted`);
    } catch (err) {
      if (isAlreadyGone(err)) {
        progress(flags, `[${key}] already gone, treating as success`);
        deleted.push({ key, id: step.value, alreadyGone: true });
        delete state.steps[key];
        writeState(projectRoot, state);
        continue;
      }
      progress(flags, `[${key}] FAILED: ${err?.detail || err?.message || err}`);
      survivors.push({ key, id: step.value, reason: String(err?.detail || err?.message || err) });
    }
  }

  result(flags, { deleted, skipped: adopted.map(([k]) => k), survivors });

  if (survivors.length) {
    progress(flags, `\n${survivors.length} resource(s) could not be deleted. Remove by hand in the KMC, then re-run teardown to clear the state file.`);
    process.exitCode = EXIT.PROVISIONING;
  }
}

/** True when a delete failed because the resource no longer exists. The SDK sets `code` to
 * not_found or *_not_found on a 404, but some services answer with a generic code and put the
 * signal in `title` (AVATAR_NOT_FOUND) or in prose ("Tool not found"). Raw api_v3 errors carry
 * codes like ENTRY_ID_NOT_FOUND in the message. */
export function isAlreadyGone(err) {
  const text = [err?.code, err?.title, err?.detail, err?.message, typeof err === 'string' ? err : ''].join(' ');
  return /not[_ ]found|does not exist|no such/i.test(text);
}

/** Deletes each recorded knowledge entry by its own id. Each deleted or already-gone entry leaves
 * `step.value` and is saved at once, so a killed run resumes with only the entries still left. */
export async function deleteKbEntries(step, del, save, log) {
  const deleted = [];
  const survivors = [];
  for (const entry of [...step.value]) {
    try {
      await del(entry.entryId);
      deleted.push({ key: 'kbEntries', id: entry.entryId });
      log(`deleted ${entry.file} (${entry.entryId})`);
    } catch (err) {
      const reason = String(err?.detail || err?.message || err);
      if (!isAlreadyGone(err)) {
        log(`FAILED ${entry.file}: ${reason}`);
        survivors.push({ key: 'kbEntries', id: entry.entryId, reason });
        continue;
      }
      deleted.push({ key: 'kbEntries', id: entry.entryId, alreadyGone: true });
      log(`${entry.file} already gone, treating as success`);
    }
    step.value = step.value.filter((e) => e !== entry);
    save();
  }
  return { deleted, survivors };
}

// Guarded so tests can import deleteKbEntries without starting a real teardown.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(main);
