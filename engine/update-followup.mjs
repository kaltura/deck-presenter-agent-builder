#!/usr/bin/env node
/**
 * Provisions the optional post-session follow-up email: the agent's
 * summaryOverridePrompt, a branded email template (classic Messaging API),
 * and the two session-lifecycle rules that connect them (agentic Management
 * API). Only runs when project.json's features.followUpEmail is on — this
 * is the one feature that captures and emails contact data, so it is off by
 * default and never provisioned implicitly by provision.mjs (PLAN.md 10).
 *
 * Idempotent: an email template already tagged for this project is updated
 * in place, unless its appGuid is stale (the agent was re-provisioned since),
 * in which case the stale template is left alone and a fresh one is created.
 * Lifecycle rules are looked up by systemName and reused rather than
 * duplicated. Both rules are dry-run verified with lifecycle.match() before
 * this command reports success — a rule that exists but does not match is
 * the normal failure mode here, not an edge case.
 *
 * Usage: node engine/update-followup.mjs --project <path> [--dry-run] [--yes] [--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadCredentials } from './lib/env.mjs';
import { messagingBaseUrl, mintClassicKs, messagingApi } from './lib/messaging.mjs';
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
  if (!followUp.emailProviderId) {
    fail(flags, EXIT.VALIDATION, 'features.followUpEmail is on but project.json.followUpEmail.emailProviderId is empty. Find it in KMC > Settings, or ask your Kaltura account contact.');
  }

  const { mgmt, partnerId } = connect(projectRoot, flags);
  const creds = loadCredentials(projectRoot);
  if (!creds.messagingUrl) {
    fail(flags, EXIT.CREDENTIAL, 'features.followUpEmail is on but KALTURA_MESSAGING_URL is not set in .env. Ask your Kaltura account contact for this account\'s Messaging API base URL.');
  }
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

  const baseUrl = messagingBaseUrl(creds);
  const classicKs = await mintClassicKs(creds.partnerId, creds.adminSecret, creds.serviceUrl);
  const templateList = await messagingApi(baseUrl, 'email-template/list', { pageIndex: 0, pageSize: 50 }, classicKs);
  const existingTemplate = (templateList?.objects || []).find((t) => t.adminTags === content.FOLLOWUP_EMAIL_ADMIN_TAG);

  let templateAction;
  if (existingTemplate && existingTemplate.appGuid !== appGuid) {
    templateAction = 'create-fresh-stale-appguid';
  } else if (existingTemplate) {
    const desired = content.FOLLOWUP_EMAIL_TEMPLATE;
    const unchanged =
      existingTemplate.subject === desired.subject &&
      existingTemplate.fromName === desired.fromName &&
      existingTemplate.body === desired.body &&
      existingTemplate.emailProviderId === desired.emailProviderId;
    templateAction = unchanged ? 'unchanged' : 'update';
  } else {
    templateAction = 'create';
  }

  const ruleA = await findRuleBySystemName(mgmt, ks, content.FOLLOWUP_LIFECYCLE_RULE_A.systemName);
  const ruleANeedsWrite = !ruleA || !eq(ruleA.action, content.FOLLOWUP_LIFECYCLE_RULE_A.action);

  const ruleBSystemName = content.followupLifecycleRuleB('placeholder').systemName;
  const ruleB = await findRuleBySystemName(mgmt, ks, ruleBSystemName);
  // ruleB's desired body depends on the template's final id, not known until
  // the template step runs, so it is always re-checked after that step
  // instead of here.

  const planLines = [`Sync follow-up email for project "${state.slug}" (agentId ${agentId}):`];
  planLines.push(summaryNeedsUpdate ? '  summaryOverridePrompt: update' : '  summaryOverridePrompt: unchanged');
  planLines.push(`  email template: ${templateAction}`);
  planLines.push(`  lifecycle rule A (${content.FOLLOWUP_LIFECYCLE_RULE_A.systemName}): ${ruleA ? (ruleANeedsWrite ? 'update' : 'unchanged') : 'create'}`);
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
    const updated = await messagingApi(baseUrl, 'email-template/update', { id: existingTemplate.id, appGuid, ...content.FOLLOWUP_EMAIL_TEMPLATE }, classicKs);
    if (!updated?.id) fail(flags, EXIT.UNEXPECTED, `email-template/update returned no id: ${JSON.stringify(updated).slice(0, 500)}`);
    templateId = updated.id;
  } else {
    if (templateAction === 'create-fresh-stale-appguid') {
      progress(flags, `[email template] existing template ${existingTemplate.id} has a stale appGuid (agent was re-provisioned); leaving it and creating a fresh one.`);
    }
    progress(flags, '[email template] creating...');
    const created = await messagingApi(baseUrl, 'email-template/add', { appGuid, ...content.FOLLOWUP_EMAIL_TEMPLATE }, classicKs);
    if (!created?.id) fail(flags, EXIT.UNEXPECTED, `email-template/add returned no id: ${JSON.stringify(created).slice(0, 500)}`);
    templateId = created.id;
  }
  recordStep(projectRoot, state, 'followUpEmailTemplateId', { value: templateId, origin: 'created' });

  let ruleAId = ruleA?.id;
  if (!ruleA) {
    progress(flags, '[lifecycle rule A] creating...');
    const created = await mgmt.lifecycle.create(content.FOLLOWUP_LIFECYCLE_RULE_A, ks);
    ruleAId = created.id;
  } else if (ruleANeedsWrite) {
    progress(flags, `[lifecycle rule A] updating ${ruleA.id}...`);
    await mgmt.lifecycle.update(ruleA.id, { action: content.FOLLOWUP_LIFECYCLE_RULE_A.action }, ks);
  } else {
    progress(flags, `[lifecycle rule A] unchanged (${ruleAId})`);
  }
  recordStep(projectRoot, state, 'followUpLifecycleRuleAId', { value: ruleAId, origin: 'created' });

  const desiredRuleB = content.followupLifecycleRuleB(templateId);
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

  progress(flags, 'Verified: summary prompt, email template, and both lifecycle rules are wired and dry-run matching.');
  result(flags, { ok: true, agentId, templateId, ruleAId, ruleBId });
}

runMain(main);
