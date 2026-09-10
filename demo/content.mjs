/**
 * Reads project.json, prompts/*.md, and data/slides/*.json, and exports the
 * exact shapes the engine scripts push to Kaltura. Every engine command
 * imports deck-specific values only from here — never hold content in
 * engine/ or client/ directly.
 *
 * Edit wording in prompts/*.md. Edit this file only to change which prompt
 * blocks or tools exist, not their wording.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_CONTEXT_PROMPT } from '@kaltura/intelligent-agents/management';
import { parseSections } from './client/prompt-format.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SLIDES_DIR = resolve(ROOT, 'data/slides');
const PROMPTS_DIR = resolve(ROOT, 'prompts');

const readPrompt = (name) => readFileSync(resolve(PROMPTS_DIR, name), 'utf8').trim();
const readPromptSections = (name) => parseSections(readFileSync(resolve(PROMPTS_DIR, name), 'utf8'));
const sub = (s, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), s);

const project = JSON.parse(readFileSync(resolve(ROOT, 'project.json'), 'utf8'));
if (!project.slug) throw new Error('project.json is missing "slug".');

// Tool names must be valid identifiers for the Kaltura API
// (^[A-Za-z_][A-Za-z0-9_]*$); project.slug is free to contain hyphens
// everywhere else (tags, short-link names), so derive a separate identifier
// here instead of constraining slug itself.
const TOOL_NAME_PREFIX = project.slug.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=[0-9])/, '_');

export const TOTAL_SLIDES = readdirSync(SLIDES_DIR).filter((f) => f.endsWith('.json')).length;
export const NAV_RULES = existsSync(resolve(ROOT, 'data/nav-rules.json'))
  ? JSON.parse(readFileSync(resolve(ROOT, 'data/nav-rules.json'), 'utf8'))
  : { rules: [] };

const VARS = {
  TOTAL_SLIDES,
  PERSONA_NAME: project.personaName,
  PRODUCT_NAME: project.productName,
  PRODUCT_OR_TOPIC: project.productOrTopic || project.productName,
  COMPANY_NAME: project.companyName,
};

export const AGENT_DISPLAY_NAME = `${project.personaName} — ${project.productName || project.productOrTopic} presenter`;
export const KB_NAME = `${project.slug}-knowledge-base`;
export const MAX_CONVERSATION_LENGTH = project.sessionMaxSeconds || 900;

export const BASE_DIRECTIVE = sub(readPrompt('base-directive.md'), VARS);
export const OPENING_PHRASE = sub(readPrompt('opening-phrase.md'), VARS);
export const GLOSSARY = sub(readPrompt('glossary.md'), VARS);

const promptBlock = (key, headerTemplate, value) => ({ key, label: key, headerTemplate, type: 'custom', value });

export const PROMPTS = [
  PAGE_CONTEXT_PROMPT,
  promptBlock('goal', 'Your core goal:', sub(readPrompt('goal.md'), VARS)),
  promptBlock('targetAudience', 'Your audience:', sub(readPrompt('target-audience.md'), VARS)),
  promptBlock('restrictedTopics', 'Never discuss:', sub(readPrompt('restricted-topics.md'), VARS)),
  promptBlock('name', 'You are:', sub(readPrompt('persona-name.md'), VARS)),
  promptBlock('pronunciation', 'Pronunciation guide (TTS formatting):', readPrompt('pronunciation-guide.md')),
];

// kaltura_genie_experiences must stay 'off' whenever tool_ids is set, or its
// built-in "call get_experience_instructions" rule out-competes navigation.
// avatar_filler stays 'off': its phrasing is generated server-side and does
// not respond to BASE_DIRECTIVE steering.
const DEFAULT_CAPABILITIES = {
  kaltura_genie_experiences: 'off',
  avatar: 'on',
  avatar_filler: 'off',
  avatar_show_content: 'off',
  use_knowledge_base: project.features?.knowledgeBase ? 'on' : 'off',
  use_content_search: 'on',
  use_get_entry_content: 'off',
  use_related_files: 'off',
  include_sources: 'off',
  generate_followup_questions: 'off',
  video_gallery: 'off',
  external_video: 'off',
  show_link: 'off',
  use_web_search: 'off',
  screen_share_analysis: 'off',
};

const overrides = project.capabilities || {};
for (const key of Object.keys(overrides)) {
  if (!(key in DEFAULT_CAPABILITIES)) throw new Error(`project.json capabilities has unknown key "${key}".`);
}
export const CAPABILITIES = { ...DEFAULT_CAPABILITIES, ...overrides };

const NAV_TOOL_PROMPTS = readPromptSections('tools/navigate-to-slide.md');
export const NAV_TOOL = {
  name: `${TOOL_NAME_PREFIX}_navigate_to_slide`,
  description: sub(NAV_TOOL_PROMPTS['description'], VARS),
  args: {
    slide_num: { prompt: sub(NAV_TOOL_PROMPTS['arg: slide_num'], VARS), type: 'int', required: true },
    reason: { prompt: NAV_TOOL_PROMPTS['arg: reason'], type: 'str', required: false },
  },
  // Must ACK: an unacknowledged wait_for_response call still narrates a
  // confident "success" off the timeout, and the brain has no way to tell a
  // call landed, so it can re-fire the same navigation unbounded.
  waitForResponse: true,
};

export const CONTACT_TOOL = project.features?.contactForm
  ? (() => {
      const p = readPromptSections('tools/request-contact.md');
      return {
        name: `${TOOL_NAME_PREFIX}_request_contact`,
        description: sub(p['description'], VARS),
        args: { reason: { prompt: p['arg: reason'], type: 'str', required: false } },
        waitForResponse: false,
      };
    })()
  : null;

export const END_SESSION_TOOL = project.features?.endSessionTool
  ? {
      name: `${TOOL_NAME_PREFIX}_end_session`,
      description: sub(readPromptSections('tools/end-session.md')['description'], VARS),
      waitForResponse: false,
    }
  : null;

// ── Follow-up email (PLAN.md 10, docs/implementation-appendix.md "follow-up email").
// Only consulted by update-followup.mjs, and only when features.followUpEmail is on. ──
const followUp = project.followUpEmail || {};

export const FOLLOWUP_EMAIL_ADMIN_TAG = `${project.slug}-followup-email`;

export const FOLLOWUP_SUMMARY_PROMPT = followUp.summaryPrompt
  ? sub(followUp.summaryPrompt, VARS)
  : `Summarize this ${VARS.PRODUCT_OR_TOPIC} presentation conversation in 1-2 sentences, written for ${VARS.PERSONA_NAME}'s team to read after the fact.`;

const EMAIL_ACCENT = project.branding?.primaryColor || '#3b82f6';
const EMAIL_SECTION = 'background-color:#ffffff;padding:32px 40px;margin-bottom:12px;border-radius:8px;';
const EMAIL_H2 = 'font-size:18px;font-weight:700;margin-bottom:12px;color:#111111;';
const EMAIL_TEXT = 'font-size:15px;line-height:1.7;color:#333333;margin-bottom:4px;white-space:pre-wrap;';

// Placeholders are {TOKEN}, the classic Messaging API's own template syntax
// (never {{TOKEN}}, this engine's own placeholder syntax). Inline CSS only:
// the template engine treats any "{...}" as a token candidate, so a <style>
// block's own braces 400 the call.
const FOLLOWUP_EMAIL_BODY_HTML = `<!DOCTYPE html>
<html lang="${project.language || 'en'}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${VARS.PRODUCT_OR_TOPIC} conversation summary</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f0f0;font-family:Arial,sans-serif;font-size:16px;color:#222222;">
  <div style="max-width:620px;margin:0 auto;background-color:#f0f0f0;">
    <div style="height:5px;background-color:${EMAIL_ACCENT};"></div>

    <div style="${EMAIL_SECTION}">
      <div style="font-size:15px;font-weight:700;letter-spacing:0.5px;color:${EMAIL_ACCENT};text-transform:uppercase;margin-bottom:4px;">${VARS.PRODUCT_OR_TOPIC}</div>
      <div style="font-size:13px;color:#777777;margin-bottom:20px;">Conversation with {AGENTNAME}</div>
      <h2 style="${EMAIL_H2}">Topic: {TOPIC}</h2>
      <p style="${EMAIL_TEXT}">{SUMMARY}</p>
    </div>

    <div style="${EMAIL_SECTION}">
      <h2 style="${EMAIL_H2}">Visitor feedback</h2>
      <p style="${EMAIL_TEXT}">{FEEDBACK}</p>
    </div>

    <div style="${EMAIL_SECTION}">
      <h2 style="${EMAIL_H2}">Contact details shared</h2>
      <p style="${EMAIL_TEXT}">{CONTACT}</p>
    </div>

    <div style="${EMAIL_SECTION}">
      <div style="font-size:15px;color:#333333;margin-top:0;line-height:1.8;">&mdash; {AGENTNAME}</div>
      <br/>
      <p style="font-size:13px;line-height:1.6;color:#888888;">${VARS.PRODUCT_OR_TOPIC}</p>
    </div>
  </div>
</body>
</html>
`;

export const FOLLOWUP_EMAIL_TEMPLATE = {
  name: `${AGENT_DISPLAY_NAME} — Conversation Insight`,
  adminTags: FOLLOWUP_EMAIL_ADMIN_TAG,
  subject: `New ${VARS.PRODUCT_OR_TOPIC} conversation with ${VARS.PERSONA_NAME}`,
  fromName: `${VARS.PERSONA_NAME}, ${VARS.PRODUCT_OR_TOPIC}`,
  toAttributePath: '{USER.email}',
  body: FOLLOWUP_EMAIL_BODY_HTML,
  msgParamsMap: {
    AGENTNAME: { type: 'String' },
    USER: { type: 'User' },
    SUMMARY: { type: 'String' },
    TOPIC: { type: 'String' },
    FEEDBACK: { type: 'String' },
    CONTACT: { type: 'String' },
  },
  emailProviderId: followUp.emailProviderId || '',
  unsubscribeGroups: [],
};

const FOLLOWUP_REQUIRED_KEYS = ['SUMMARY', 'TOPIC', 'FEEDBACK', 'CONTACT'];

export const FOLLOWUP_LIFECYCLE_RULE_A = {
  name: `${AGENT_DISPLAY_NAME} — extract insights on session end`,
  systemName: `${project.slug}_session_insights`,
  eventType: 'session_ended',
  objectType: 'thread',
  action: {
    actionType: 'triggerInsight',
    insights: [
      {
        insightKey: 'TOPIC',
        valueType: 'string',
        prompt: `In one short sentence, what was the visitor mainly trying to learn about ${VARS.PRODUCT_OR_TOPIC}, and did ${VARS.PERSONA_NAME} help them get there?`,
      },
      {
        insightKey: 'FEEDBACK',
        valueType: 'string',
        prompt: 'Any explicit feedback, praise, criticism, or suggestions the visitor gave about the presentation, the avatar, or the experience. If none was given, answer exactly "No feedback was provided."',
      },
      {
        insightKey: 'CONTACT',
        valueType: 'string',
        prompt: 'Any contact details or company/role info the visitor provided (name, email, company, role, phone), as given via the contact form or in conversation. Format as a short plain-text list. If none was given, answer exactly "No contact details were submitted."',
      },
    ],
  },
};

/** Built after the email template step, once its final id is known. */
export const followupLifecycleRuleB = (templateId) => ({
  name: `${AGENT_DISPLAY_NAME} — email on analysis update`,
  systemName: `${project.slug}_send_summary_email`,
  eventType: 'analysis_updated',
  objectType: 'thread',
  eventConditions: [{ field: 'changed_keys', operator: 'has_all', value: FOLLOWUP_REQUIRED_KEYS }],
  action: { actionType: 'sendInsightEmail', recipients: followUp.recipients || [], templateId },
});
