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
  name: `${project.slug}_navigate_to_slide`,
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
        name: `${project.slug}_request_contact`,
        description: sub(p['description'], VARS),
        args: { reason: { prompt: p['arg: reason'], type: 'str', required: false } },
        waitForResponse: false,
      };
    })()
  : null;

export const END_SESSION_TOOL = project.features?.endSessionTool
  ? {
      name: `${project.slug}_end_session`,
      description: sub(readPromptSections('tools/end-session.md')['description'], VARS),
      waitForResponse: false,
    }
  : null;
