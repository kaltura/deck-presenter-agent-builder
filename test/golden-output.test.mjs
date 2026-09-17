import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadContent } from '../engine/lib/load-content.mjs';

// A golden-output check on demo/'s ingestion and prompt-drafting output.
// content.mjs (ARCHITECTURE.md 5) is a pure function of
// project.json + prompts/*.md + data/slides/*.json, so its exports are the
// right golden surface: any unintended drift in derivation logic, or in the
// demo/fixture source data, shows up as a diff here instead of only at
// deploy time. The section 6.4 semantic lint (bin/lint-prompts.mjs) checks
// meaning; this checks that the exact rendered shapes haven't moved.
//
// PROMPTS[0] is the SDK's own PAGE_CONTEXT_PROMPT constant, not derived from
// this repo's content, so it is checked for presence but left out of the
// snapshot — an SDK version bump shouldn't fail a content golden test.
//
// To intentionally update a golden file after a real content change, run:
//   UPDATE_GOLDEN=1 node --test test/golden-output.test.mjs

const ROOT = resolve(import.meta.dirname, '..');

const PROJECTS = [
  { name: 'demo', path: resolve(ROOT, 'demo') },
  { name: 'smoke-project', path: resolve(ROOT, 'fixtures/smoke-project') },
];

async function snapshotOf(projectPath) {
  const content = await loadContent(projectPath);
  assert.ok(content.PROMPTS[0]?.key === 'pageContext' || content.PROMPTS[0]?.type, 'PROMPTS[0] should be the SDK page-context block');
  return {
    TOTAL_SLIDES: content.TOTAL_SLIDES,
    NAV_RULES: content.NAV_RULES,
    AGENT_DISPLAY_NAME: content.AGENT_DISPLAY_NAME,
    KB_NAME: content.KB_NAME,
    MAX_CONVERSATION_LENGTH: content.MAX_CONVERSATION_LENGTH,
    BASE_DIRECTIVE: content.BASE_DIRECTIVE,
    OPENING_PHRASE: content.OPENING_PHRASE,
    GLOSSARY: content.GLOSSARY,
    PROMPTS: content.PROMPTS.slice(1),
    CAPABILITIES: content.CAPABILITIES,
    NAV_TOOL: content.NAV_TOOL,
    CONTACT_TOOL: content.CONTACT_TOOL,
    END_SESSION_TOOL: content.END_SESSION_TOOL,
    FOLLOWUP_EMAIL_ADMIN_TAG: content.FOLLOWUP_EMAIL_ADMIN_TAG,
    FOLLOWUP_SUMMARY_PROMPT: content.FOLLOWUP_SUMMARY_PROMPT,
    FOLLOWUP_EMAIL_TEMPLATE: content.FOLLOWUP_EMAIL_TEMPLATE,
    FOLLOWUP_INSIGHT_SETTINGS: content.FOLLOWUP_INSIGHT_SETTINGS,
    FOLLOWUP_LIFECYCLE_RULE_A_SAMPLE: content.followupLifecycleRuleA(['golden-test-topic-id', 'golden-test-feedback-id', 'golden-test-contact-id']),
    FOLLOWUP_LIFECYCLE_RULE_B_SAMPLE: content.followupLifecycleRuleB('golden-test-template-id'),
  };
}

for (const { name, path } of PROJECTS) {
  test(`content.mjs golden output: ${name}`, async () => {
    const goldenPath = resolve(import.meta.dirname, `golden/${name}.json`);
    const actual = await snapshotOf(path);

    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(goldenPath, JSON.stringify(actual, null, 2) + '\n');
      return;
    }

    const expected = JSON.parse(readFileSync(goldenPath, 'utf8'));
    assert.deepEqual(
      actual,
      expected,
      `${name}'s content.mjs output no longer matches test/golden/${name}.json. If this is an intended content change, regenerate with: UPDATE_GOLDEN=1 node --test test/golden-output.test.mjs`,
    );
  });
}
