#!/usr/bin/env node
/**
 * Provisions the optional post-session follow-up email: the agent's
 * summaryOverridePrompt, reusable InsightSettings entities, a branded email
 * template (mgmt.emailTemplates), and the two session-lifecycle rules that
 * connect them (mgmt.lifecycle). Only runs when project.json's
 * features.followUpEmail is on. This is the one feature that captures and
 * emails contact data, so it is off by default and never provisioned
 * implicitly by provision.mjs (ARCHITECTURE.md 10).
 *
 * Idempotent: an email template already tagged for this project is updated
 * in place, unless its appGuid is stale (the agent was re-provisioned since),
 * in which case the stale template is left alone and a fresh one is created.
 * InsightSettings entities and lifecycle rules are looked up by key/systemName
 * and reused rather than duplicated. Both rules are dry-run verified with
 * lifecycle.match() before this command reports success. A rule that exists
 * but does not match is the normal failure mode here, not an edge case.
 *
 * Usage: node engine/update-followup.mjs --project <path> [--dry-run] [--yes] [--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, recordStep, assertPartnerMatch } from './lib/state.mjs';
import { loadContent } from './lib/load-content.mjs';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const REQUIRED_KEYS = ['SUMMARY', 'TOPIC', 'FEEDBACK', 'CONTACT'];
const flattenMatchedRuleIds = (matchedRules) => matchedRules.flatMap((entry) => (entry.rules ? entry.rules.map((r) => r.id) : [entry.id]));

async function findRuleBySystemName(mgmt, ks, systemName) {
  for await (const rule of mgmt.lifecycle.list(ks)) {
    if (rule.systemName === systemName) return rule;
  }
  return null;
}

async function findTemplateByAdminTags(mgmt, ks, adminTags) {
  for await (const template of mgmt.emailTemplates.list(ks)) {
    if (template.adminTags === adminTags) return template;
  }
  return null;
}

/** Create/update each InsightSettings entity to match `defs`, keyed by `key`. */
async function planInsightSettings(mgmt, ks, defs) {
  const existing = [];
  for await (const s of mgmt.insightSettings.list(ks)) existing.push(s);
  return defs.map((def) => {
    const found = existing.find((s) => s.key === def.key);
    if (!found) return { def, action: 'create' };
    const unchanged = found.title === def.title && found.prompt === def.prompt && found.valueType === def.valueType && found.status === 'active';
    return { def, action: unchanged ? 'unchanged' : 'update', id: found.id };
  });
}

async function executeInsightSettings(mgmt, ks, flags, plan) {
  const ids = {};
  for (const { def, action, id } of plan) {
    if (action === 'create') {
      progress(flags, `[insight setting ${def.key}] creating...`);
      const created = await mgmt.insightSettings.create(def, ks);
      ids[def.key] = created.id;
    } else if (action === 'update') {
      progress(flags, `[insight setting ${def.key}] updating ${id}...`);
      await mgmt.insightSettings.update(id, { title: def.title, prompt: def.prompt, valueType: def.valueType, status: 'active' }, ks);
      ids[def.key] = id;
    } else {
      progress(flags, `[insight setting ${def.key}] unchanged (${id})`);
      ids[def.key] = id;
    }
  }
  return ids;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const projectJsonPath = resolve(projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) fail(flags, EXIT.USAGE, `No project.json at ${projectJsonPath}`);
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));

  if (!project.features?.followUpEmail) {
    progress(flags, 'features.followUpEmail is off in project.json. Nothing to do.');
    result(flags, { skipped: true, reason: 'followUpEmail feature is off' });
    return;
  }

  const followUp = project.followUpEmail || {};
  if (!Array.isArray(followUp.recipients) || followUp.recipients.length === 0) {
    fail(flags, EXIT.VALIDATION, 'features.followUpEmail is on but project.json.followUpEmail.recipients is empty. Set at least one Kaltura user id (often the account login email).');
  }
  const { mgmt, partnerId } = connect(projectRoot, flags);
  const content = await loadContent(projectRoot);
  const state = loadState(projectRoot);
  if (!state) fail(flags, EXIT.UNEXPECTED, 'No .provisioning-state.json. Run engine/provision.mjs first.');
  assertPartnerMatch(state, partnerId);
  const agentId = state.steps.agentId?.value;
  if (!agentId) fail(flags, EXIT.UNEXPECTED, 'No agentId in .provisioning-state.json. Run engine/provision.mjs first.');

  const ks = await adminKs(mgmt);

  // ── Plan (read-only) ──
  const agentBefore = await mgmt.agents.get(agentId, ks);
  const summaryNeedsUpdate = agentBefore.summaryOverridePrompt !== content.FOLLOWUP_SUMMARY_PROMPT;

  const appGuid = agentBefore.appGuid;
  if (!appGuid) fail(flags, EXIT.UNEXPECTED, `agents.get(${agentId}) returned no appGuid; cannot scope the email template.`);

  const existingTemplate = await findTemplateByAdminTags(mgmt, ks, content.FOLLOWUP_EMAIL_ADMIN_TAG);

  let templateAction;
  if (existingTemplate && existingTemplate.appGuid !== appGuid) {
    templateAction = 'create-fresh-stale-appguid';
  } else if (existingTemplate) {
    const desired = content.FOLLOWUP_EMAIL_TEMPLATE;
    const unchanged =
      existingTemplate.subject === desired.subject &&
      existingTemplate.fromName === desired.fromName &&
      existingTemplate.body === desired.body &&
      existingTemplate.toAttributePath === desired.toAttributePath &&
      eq(existingTemplate.msgParamsMap, desired.msgParamsMap) &&
      // An empty desired.emailProviderId means "no preference"; Kaltura
      // assigns the account's default provider id on create and that
      // assigned value would otherwise never match an empty desired string.
      (!desired.emailProviderId || existingTemplate.emailProviderId === desired.emailProviderId);
    templateAction = unchanged ? 'unchanged' : 'update';
  } else {
    templateAction = 'create';
  }

  const insightSettingsPlan = await planInsightSettings(mgmt, ks, content.FOLLOWUP_INSIGHT_SETTINGS);

  const ruleASystemName = content.followupLifecycleRuleA([]).systemName;
  const ruleA = await findRuleBySystemName(mgmt, ks, ruleASystemName);
  // ruleA's desired action depends on the InsightSettings ids resolved
  // above, not known until that step runs, so it is always re-checked after
  // that step instead of here (same reasoning as ruleB below).

  const ruleBSystemName = content.followupLifecycleRuleB('placeholder').systemName;
  const ruleB = await findRuleBySystemName(mgmt, ks, ruleBSystemName);
  // ruleB's desired body depends on the template's final id, not known until
  // the template step runs, so it is always re-checked after that step
  // instead of here.

  const planLines = [`Sync follow-up email for project "${state.slug}" (agentId ${agentId}):`];
  planLines.push(summaryNeedsUpdate ? '  summaryOverridePrompt: update' : '  summaryOverridePrompt: unchanged');
  planLines.push(`  email template: ${templateAction}`);
  for (const { def, action, id } of insightSettingsPlan) {
    planLines.push(`  insight setting ${def.key}: ${action}${id ? ` (${id})` : ''}`);
  }
  planLines.push(`  lifecycle rule A (${ruleASystemName}): ${ruleA ? 're-sync after insight settings step' : 'create'}`);
  planLines.push(`  lifecycle rule B (${ruleBSystemName}): ${ruleB ? 're-sync after template step' : 'create'}`);
  await confirmPlan(flags, planLines);

  // ── Execute ──
  if (summaryNeedsUpdate) {
    progress(flags, '[summaryOverridePrompt] updating...');
    await mgmt.agents.update({ agentId, summaryOverridePrompt: content.FOLLOWUP_SUMMARY_PROMPT }, ks);
  }

  let templateId;
  if (templateAction === 'unchanged') {
    templateId = existingTemplate.id;
    progress(flags, `[email template] unchanged (${templateId})`);
  } else if (templateAction === 'update') {
    progress(flags, `[email template] updating ${existingTemplate.id}...`);
    const updated = await mgmt.emailTemplates.update(existingTemplate.id, content.FOLLOWUP_EMAIL_TEMPLATE, ks);
    templateId = updated.id;
  } else {
    if (templateAction === 'create-fresh-stale-appguid') {
      progress(flags, `[email template] existing template ${existingTemplate.id} has a stale appGuid (agent was re-provisioned); leaving it and creating a fresh one.`);
    }
    progress(flags, '[email template] creating...');
    const created = await mgmt.emailTemplates.create({ appGuid, ...content.FOLLOWUP_EMAIL_TEMPLATE }, ks);
    templateId = created.id;
  }
  recordStep(projectRoot, state, 'followUpEmailTemplateId', { value: templateId, origin: 'created' });

  const insightSettingIds = await executeInsightSettings(mgmt, ks, flags, insightSettingsPlan);
  recordStep(projectRoot, state, 'followUpInsightSettingIds', { value: insightSettingIds, origin: 'created' });

  const desiredRuleA = content.followupLifecycleRuleA(Object.values(insightSettingIds));
  let ruleAId = ruleA?.id;
  if (!ruleA) {
    progress(flags, '[lifecycle rule A] creating...');
    const created = await mgmt.lifecycle.create(desiredRuleA, ks);
    ruleAId = created.id;
  } else if (!eq(ruleA.action, desiredRuleA.action)) {
    progress(flags, `[lifecycle rule A] updating ${ruleA.id}...`);
    await mgmt.lifecycle.update(ruleA.id, { action: desiredRuleA.action }, ks);
  } else {
    progress(flags, `[lifecycle rule A] unchanged (${ruleAId})`);
  }
  recordStep(projectRoot, state, 'followUpLifecycleRuleAId', { value: ruleAId, origin: 'created' });

  const desiredRuleB = content.followupLifecycleRuleB(templateId);
  const recipientsOverride = (process.env.EMAIL_RECIPIENTS_OVERRIDE || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (recipientsOverride.length) {
    desiredRuleB.action.recipients = recipientsOverride;
    progress(flags, `[lifecycle rule B] recipients overridden by EMAIL_RECIPIENTS_OVERRIDE: ${recipientsOverride.join(', ')}`);
  }
  let ruleBId = ruleB?.id;
  if (!ruleB) {
    progress(flags, '[lifecycle rule B] creating...');
    const created = await mgmt.lifecycle.create(desiredRuleB, ks);
    ruleBId = created.id;
  } else if (!eq(ruleB.action, desiredRuleB.action) || !eq(ruleB.eventConditions || [], desiredRuleB.eventConditions || [])) {
    progress(flags, `[lifecycle rule B] updating ${ruleB.id} (templateId ${templateId})...`);
    await mgmt.lifecycle.update(ruleB.id, { action: desiredRuleB.action, eventConditions: desiredRuleB.eventConditions }, ks);
  } else {
    progress(flags, `[lifecycle rule B] unchanged (${ruleBId})`);
  }
  recordStep(projectRoot, state, 'followUpLifecycleRuleBId', { value: ruleBId, origin: 'created' });

  // ── Verify: read the agent back, and dry-run match both rules ──
  const errors = [];
  const agentAfter = await mgmt.agents.get(agentId, ks);
  if (agentAfter.summaryOverridePrompt !== content.FOLLOWUP_SUMMARY_PROMPT) errors.push('summaryOverridePrompt did not apply');

  const syntheticObject = { agent_id: agentId, thread_id: 'verify-thread', user_id: 'verify-user' };
  const sessionEndedMatch = await mgmt.lifecycle.match('thread', 'session_ended', { object: syntheticObject }, ks);
  if (!flattenMatchedRuleIds(sessionEndedMatch.matchedRules).includes(ruleAId)) errors.push(`Rule A (${ruleAId}) did not match a dry-run session_ended event`);

  const analysisUpdatedMatch = await mgmt.lifecycle.match('thread', 'analysis_updated', { object: syntheticObject, changed_keys: REQUIRED_KEYS }, ks);
  if (!flattenMatchedRuleIds(analysisUpdatedMatch.matchedRules).includes(ruleBId)) errors.push(`Rule B (${ruleBId}) did not match a dry-run analysis_updated event with all required keys`);

  if (errors.length) {
    progress(flags, `Verification FAILED: ${errors.join('; ')}`);
    result(flags, { ok: false, errors });
    process.exitCode = EXIT.VALIDATION;
    return;
  }

  progress(flags, 'Verified: summary prompt, email template, insight settings, and both lifecycle rules are wired and dry-run matching.');
  result(flags, { ok: true, agentId, templateId, insightSettingIds, ruleAId, ruleBId });
}

runMain(main);
