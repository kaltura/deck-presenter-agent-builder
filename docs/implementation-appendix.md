# Implementation appendix: the Kaltura calls

Concrete API contract for `ARCHITECTURE.md` sections 6.6 (provisioning) and 6.7 (bundle and deploy). Written from a working, already-deployed presenter agent, so the sequence, the required fields, and the gotchas are observed behavior, not guesses.

Everything here is generic. No account ids, no partner ids, no deck content.

## Dependency

The engine talks to Kaltura through the `@kaltura/intelligent-agents` SDK, not raw HTTP. It is a zero-dependency ESM package, `engines.node >= 18`, with two entry points:

| Import | Use |
|---|---|
| `@kaltura/intelligent-agents/management` | Provision, configure, inspect. Everything in 6.6. |
| `@kaltura/intelligent-agents/experience` | Browser-side live runtime. What `client/` uses. |

The management surface is a single `Management` instance with one resource object per area:

```js
import { Management, tools } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });
const admin = await mgmt.sessions.createAdminToken();   // -> { ks, ... }
```

Every management call takes `admin.ks` as its last argument. Resources used below: `mgmt.sessions`, `mgmt.tools`, `mgmt.knowledge`, `mgmt.intellects`, `mgmt.intellectConfig` (opening phrase, tool ids, knowledge ids), `mgmt.avatars`, `mgmt.agents`, `mgmt.application`, `mgmt.catalog` (custom voice and visual), `mgmt.lifecycle` (post-session rules), `mgmt.insightSettings` and `mgmt.emailTemplates` (follow-up email and feedback), plus the top-level `mgmt.converseOnce`.

Named helpers exported alongside `Management`, all used below: `tools.client`, `lintPersonaIdentity`, `mergeCapabilityWrite`.

**Credential rule (6.6).** `adminSecret` is read from the project's `.env` once, exchanged for a session key at run start, and never logged. `createAdminToken()` is that exchange. Pass `admin.ks` onward; never re-read the secret per call.

**The SDK also ships `provision()`**, a one-call factory (`generateProfile` → `intellect.add` → `intellect.update` → preset voice/visual → `avatar.create` → `agent.create` → `resolveWidgetId`). Do not use it for this engine. It picks a preset voice and visual from a plain-English brief and gives no per-step resume point, and 6.6 needs explicit control over the KB, the nav tool, and the consent-gated avatar, plus a recorded id after every step. Read it as a reference for call shapes only.

## Vocabulary

| Term | What it is |
|---|---|
| **intellect** / `configId` | The agent's brain: prompts, base directive, glossary, capabilities, linked tool ids, linked knowledge ids. Numeric id. |
| **avatar** / `avatarId` | Face and voice only. A `{ voice, visual }` pair. Hex string id. Its legacy `openingPhrase` field stays null: the opening lives on the intellect. |
| **agent** / `agentId` | Binds one intellect to one or more avatars, carries the display name and tags. UUID. |
| **tool** | A callable the intellect can invoke. The presenter needs one client-side navigation tool. UUID. |
| **knowledge record** / `knowledgeId` | A RAG corpus definition pointing at a category of uploaded entries. Numeric id. |
| **widget id** | The public embed handle the client needs. Kaltura entry-id shape (`N_xxxxxxxx`). |

## One content module, imported everywhere

No command in `engine/` contains prompt text, a tool description, a slide count, or a persona name. One module reads the project's files and exports every payload constant (ARCHITECTURE.md 5). Shape:

```js
const readPrompt = (name) => readFileSync(resolve(PROMPTS_DIR, name), 'utf8').trim();
const TOTAL_SLIDES = readdirSync(SLIDES_DIR).filter((f) => f.endsWith('.json')).length;

export const BASE_DIRECTIVE = readPrompt('base-directive.md')
  .replaceAll('{{TOTAL_SLIDES}}', String(TOTAL_SLIDES));
export const PROMPTS = [ /* prompt blocks, below */ ];
export const GLOSSARY = readPrompt('glossary.md');
export const CAPABILITIES = { /* all 15 keys, below */ };
export const NAV_TOOL = { name, description, args };
export const OPENING_PHRASE = readPrompt('opening-phrase.md');
```

A prompt block is `{ key, label, headerTemplate, type: 'custom', value }`. `headerTemplate` is the line the platform wraps the value in when it assembles the system prompt, so it belongs to the block, not to the file body.

Derive counts, never hardcode them. `TOTAL_SLIDES` from `readdirSync` cannot drift from the files on disk; a literal can.

## Provisioning: nine steps in order

Each step's id goes into `.provisioning-state.json` **the moment it returns**, not at stage end (ARCHITECTURE.md 8).

### 0. Pre-flight, read-only

Runs before any resource is created, only for what `features.knowledgeBase` needs:

1. At least one `*.md` file exists in the project's `data/kb/`.
2. `capabilities.use_knowledge_base === 'on'` in the config about to be written. **Partner config is cached for roughly 24 hours**, so this has to be right at creation time; flipping it later does not take effect promptly.

The clone-avatar check runs later, inline at the avatar step (step 7), right before the clone call: read the source avatar and confirm it has both a voice and a visual, and confirm the consent record exists in the project repo (ARCHITECTURE.md 6.6, 10).

```js
const source = await mgmt.avatars.get(sourceAvatarId, admin.ks);   // READ only
if (!source.voice?.id || !source.visual?.id) fail('Source avatar has no voice or visual.');
```

By this point the nav tool, the optional contact/end-session tools, the knowledge base, and the intellect already exist. A missing consent record still fails the run before the clone call itself, so nothing mutating happens on the avatar's side, but the earlier steps are not undone.

### 1. Navigation tool, plus optional contact and end-session tools

```js
const cfg = tools.client(navToolDefinition);      // typed builder, validates the shape
const tool = await mgmt.tools.add(cfg, admin.ks);
// -> tool.id   (UUID)
```

`tools.client(...)` is the builder for a client-executed tool (the browser handles the call). `tools.api`, `tools.csv`, and `tools.code` exist for other kinds. `navToolDefinition` is rendered from `data/nav-rules.json`, never hand-written (ARCHITECTURE.md 5).

When `project.json`'s `features.contactForm` / `features.endSessionTool` are on, the same builder and `mgmt.tools.add` call create a contact-form tool and an end-session tool right here, before the intellect exists in step 6. All three tool ids feed `tool_ids` on the intellect. Each is checked against existing tool names first (`assertNamedResourceFree`), so a name collision fails before any call, not after.

### 2. Knowledge base category

```js
const cat = await k.findOrCreateCategory({ name: kbCategoryName }, admin.ks);
// -> cat.id   (numeric)
```

**Idempotent on name.** This is the one step safe to re-run blind. `kbCategoryName` is namespaced by `project.json.slug` (ARCHITECTURE.md 8), so two projects on one account do not land in the same category.

### 3. Upload each KB file

One call per markdown file. Loop, and record each result.

```js
const up = await k.uploadMarkdown({ markdown, name: fileName, categoryId: cat.id }, admin.ks);
// -> { entryId, markdownAssetId }
```

Not idempotent. A re-run without state creates duplicate entries in the category, which silently degrades retrieval. The state file must list uploaded filenames, not just a count.

**Open question (ARCHITECTURE.md 6.3, 12):** whether Kaltura re-chunks an uploaded markdown file or indexes it as one unit. Resolve it here by uploading one deliberately long file and inspecting what retrieval returns. The answer decides whether file sizing is the engine's problem.

### 4. Knowledge record

```js
// REQUIRED. A record created without `indexers` fails with HTTP 422.
const indexers = [
  { index_position: 0, type: 1, strategy: 'EmbedCaptionV1' },
  { index_position: 0, type: 2, strategy: 'EmbedOcrV1' },
  { index_position: 0, type: 3, strategy: 'EmbedDocumentV1' },
];

const rec = await k.addRecord({
  name: kbName,
  description: kbDescription,
  config: {
    sources: [{
      type: 'internal',
      language: 'English',
      categoryIds: [String(cat.id)],    // strings here, even though cat.id is numeric
      indexers,
    }],
  },
}, admin.ks);
// -> rec.id   (must be an integer; assert Number.isInteger(Number(rec.id)))
```

Markdown uploads are picked up by the document indexer, `type: 3`. Send all three anyway; the caption and OCR indexers are inert for markdown and cost nothing.

**Then wait, and check the corpus below, before creating the intellect in step 6.** There is no reliable completion signal for indexing at this point. The reference implementation waits a fixed 60 seconds, overridable by flag. Creating the intellect too early links a corpus that is not yet queryable.

### 5. Corpus readiness poll

```js
const corpus = await k.corpusStatus({ categoryId: cat.id }, admin.ks);
// -> { entryCount, populated, categoryIds, perCategory }
```

Poll every 10 seconds against a 5-minute deadline. **Non-fatal on timeout:** warn and continue.

**Known limitation:** this counts entries present in the category. It cannot confirm that embedding finished. Treat a healthy count as necessary, not sufficient. `mgmt.knowledge.isIndexed(knowledgeId, ks)` and `mgmt.knowledge.getLinkage(configId, ks)` give further read-only signal and belong in the verify command (6.8), not in the provisioning gate.

### 6. Intellect, everything in one write

```js
const intel = await mgmt.intellects.create({
  type: 'internal',
  status: 2,                       // active
  allow_client_variables: true,    // see below
  prompts,                         // array of prompt blocks
  base_directive: baseDirective,
  glossary,
  capabilities,                    // includes use_knowledge_base: 'on'
  opening_phrase: openingPhrase,   // Jinja template, rendered from request_vars
  tool_ids: [tool.id],
  knowledge_ids: [Number(rec.id)],
  }, admin.ks);
// -> intel.configId, intel.warnings[]
```

Log `intel.warnings` if non-empty. They are advisory, not failures.

**`allow_client_variables: true` is not optional for a presenter agent.** It gates `request_vars`, which is how the client passes the current slide as page context on every turn, and the `resume_*` / `rejoin_*` values the opening phrase template branches on. With it off, turns that depend on page context come back empty with no error, which is a hard bug to find later. Set it at creation.

One write, not a create-then-patch, because 6.6 records one id per step and a half-configured active intellect is reachable.

#### The capability map, in full

The SDK exports the canonical frozen list. There are 15 keys, each `'on'`, `'off'`, or `'disabled'`:

| Key | Default | What it is |
|---|---|---|
| `use_knowledge_base` | on | RAG over the linked knowledge records. **Required.** |
| `use_content_search` | on | Search across account content. |
| `use_get_entry_content` | on | Read a specific entry's content. |
| `generate_followup_questions` | on | Suggested next questions. |
| `include_sources` | on | Citations in the answer. |
| `use_related_files` | on | Surfaces sibling files. |
| `kaltura_genie_experiences` | on | Platform experience integrations. |
| `avatar` | off | **Required for a presenter.** Switches the model to the avatar path. |
| `avatar_filler` | off | Spoken filler while the model thinks. |
| `avatar_show_content` | off | Lets the avatar surface content panels. |
| `video_gallery` | off | Gallery responses. |
| `external_video` | off | External video responses. |
| `show_link` | off | Link responses. |
| `use_web_search` | off | Web search. |
| `screen_share_analysis` | off | Screen-share vision. |

Five rules, each learned the hard way:

1. **`capabilities` is a full-replace sub-dict.** The intellect `update` call is otherwise a patch that preserves omitted top-level fields, but a partial `capabilities` dict **drops every key you did not send**. Always write all 15. `mergeCapabilityWrite` does the read-merge-write if you only have a delta.
2. **`disabled` is an account-level veto.** It overrides a per-request `on`. The SDK refuses to write over a stored `disabled` unless you pass `force: true`. That guard is a convenience, not a permission boundary.
3. **`think_process` is not a capability.** It appears in older notes. Sending it makes intellect creation return 500.
4. **The resolved value is cached at the account-config layer for up to roughly 24 hours.** Get it right at creation. A later flip may not reach a live session promptly, which is why pre-flight checks `use_knowledge_base === 'on'` before anything is created.
5. **`avatar_filler` phrasing is server-generated and cannot be steered from the base directive.** If the filler does not fit the persona, the only lever is turning it off.

No endpoint enumerates the capabilities or the account's per-key settings, so the list above is the contract. Fail pre-flight on an unknown key rather than sending it.

### 7. Avatar

```js
const voice = { id: source.voice.id };
if (source.voice.speed != null) voice.speed = source.voice.speed;
const visual = { ...source.visual };   // id, motionControl, crop, and any other fields

const av = await mgmt.avatars.create({ voice, visual }, admin.ks);
// -> av.id   (hex string)
```

Copy `visual` wholesale. It carries `motionControl` and framing fields beyond `id`, and dropping them changes how the avatar is composited.

**The avatar carries no `tags` field.** Passing one is silently ignored. Tags belong on the agent, step 8.

Write `avatar.source` (`"cloned"` or `"fresh"`) back to `project.json` here, so the client knows whether to render the synthetic-content label (ARCHITECTURE.md 9).

#### Creating a voice or visual from a sample

Instead of copying an existing avatar's ids, mint new catalog items. Both calls take a web `File`:

```js
const file = new File([buf], 'sample.jpg', { type: 'image/jpeg' });
const visual = await mgmt.catalog.createVisual(file, {
  name,
  genderPresentation, hairColor,          // descriptive metadata
  consentRef,                             // see below
}, admin.ks);
// -> visual.itemId

await mgmt.avatars.update({
  id: avatarId,
  visual: { id: visual.itemId, motionControl: { speaking: 0.6, nonSpeaking: 0.2 } },
}, admin.ks);
```

`mgmt.catalog.createVoice` is the same shape for an audio sample.

Four things to get right:

- **`consentRef` is a real field, so write the consent record's identifier into it.** That is the platform-side half of the ARCHITECTURE.md 10 gate: the record lives in the project repo and its reference travels with the catalog item. Include who provided it, when, and what use it covers.
- **Neither call is idempotent.** Every run creates a new catalog item and orphans the previous one. Skip the step when state already has an id; on `--force`, print the id being orphaned.
- **The live avatar stream is square, 512 by 512.** A portrait photo gets letterboxed.
- **Padding a portrait to square with a flat colour shows as visible bars in the stream.** Extend the backdrop and the subject's shoulders past the original photo edges instead, so the square crop has real image in every corner. This is an image-preparation step before the API call, not an API setting.

`motionControl` values (`speaking`, `nonSpeaking`) are motion amplitude. They live on the `visual` object, so an `avatars.update` that sends `visual` without them resets them.

### 8. Agent

```js
const ag = await mgmt.agents.create({
  displayName,
  intellect: { intellectType: 'genie', id: intel.configId },
  avatarIds: [av.id],
  adminTags: [...tags],            // tags go HERE, not on the avatar
  maxConversationLength: sessionMaxSeconds,
}, admin.ks);
// -> ag.agentId   (UUID)
```

`intellectType: 'genie'` is the value for an internal intellect.

**`maxConversationLength` is seconds, server range 1 to 3600.** Take it from `project.json.sessionMaxSeconds` and cross-check it against the duration the client's welcome copy promises. A default that undershoots the promise ends the session early and reads as a crash.

`mgmt.agents.get(agentId, ks)` reads back `.intellect.configId`, `.intellect.id`, `.avatarIds[]`, and `.appGuid`. That is the way to recover ids from an agent when state is missing.

### 9. Widget id

```js
const wr = await mgmt.application.resolveWidgetId(ag.agentId, admin.ks);
// -> wr.widgetId   (N_xxxxxxxx)
```

This is the only id the browser client needs. It is what gets baked into the bundle (6.7).

Provisioning itself sends no conversational turn. The one text-turn smoke test, `mgmt.converseOnce(configId, 'Hello! What can you help me with?')`, is `verify.mjs`'s `smoke` subcommand (6.8), run separately, after provisioning, never as part of it.

## Syncing client tools after provisioning

`engine/attach-tool.mjs` is the one generic command for every client tool `content.mjs` declares: navigation always, plus contact and end-session when their `project.json` feature flag is on. A tool with no recorded id is created; one that already has an id is compared and only sent through `tools.update` on a real diff. It never calls `tools.add` for a tool this project has already recorded.

```js
const desired = tools.client(TOOL_DEF);
const current = await mgmt.tools.get(existingId, admin.ks);

// The server adds its own defaults (variables_mapping, response_mapping,
// display_name, add_to_history, log_request/response, timeout, a
// `default: null` on every arg, ...) and may reorder `args` keys. Strip and
// stable-stringify both sides before comparing, or every run reports a
// false diff on a config that already matches.
if (!eqToolConfig(current.config, desired)) {
  await mgmt.tools.update(existingId, { name: desired.name, config: desired }, admin.ks);
}
```

Then reconcile `tool_ids` on the intellect in one call, once every tool body is in its final state:

```js
await mgmt.intellectConfig.setToolIds(configId, finalToolIds, admin.ks);
```

After the write, assert that `base_directive`, `prompts`, `glossary`, `knowledge_ids`, and `capabilities` are unchanged, and exit non-zero if not. Attaching a tool must not silently rewrite the persona.

## Optional stage: follow-up email after a session

Off by default (ARCHITECTURE.md 10). One InsightSettings entity per insight, two lifecycle rules, one email template. SDK v1.22.0 folded the email template API into the management SDK, so this whole stage now runs on a single `ks`, with no second Kaltura API and no separate session key.

**Step 1, create/reuse each insight as a standalone entity:**

```js
const created = await mgmt.insightSettings.create(
  { key: 'TOPIC', title: 'Topic', valueType: 'string', prompt: '...' },
  admin.ks,
);
// created.id -> pass into rule A below
```

`triggerInsight` with an inline `insights: [...]` array no longer exists; the SDK rejects that shape client-side before any network call. Each insight is its own entity now, looked up by `key` via `mgmt.insightSettings.list(admin.ks)` and reused rather than duplicated.

**Rule A, extract insights when the session ends:**

```js
await mgmt.lifecycle.create({
  name, systemName,
  eventType: 'session_ended', objectType: 'thread',
  action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: [topicId, feedbackId, contactId] },
}, admin.ks);
```

**Rule B, email once all of them have landed:**

```js
await mgmt.lifecycle.create({
  name, systemName,
  eventType: 'analysis_updated', objectType: 'thread',
  eventConditions: [{
    field: 'changed_keys', operator: 'has_all',
    value: ['SUMMARY', 'TOPIC', 'FEEDBACK', 'CONTACT'],
  }],
  action: { actionType: 'sendInsightEmail', recipients, templateId },
}, admin.ks);
```

`sendInsightEmail`'s shape is unchanged from v1.19.0.

Five design points:

- **Do not request a `SUMMARY` insight.** Every account gets one from an always-on system preset that merges into the same batch. Requesting it duplicates work. Rule B still waits on it, which is why it is in `changed_keys`.
- **Do not condition rules on `object.agent_id`.** The client mints widget tokens, so real production threads arrive with `agent_id: "default"` and an agent-id condition never matches. This is the single easiest way to ship rules that silently never fire.
- **Idempotency is by `key` (InsightSettings) and `systemName` (lifecycle rules).** `for await (const rule of mgmt.lifecycle.list(admin.ks))` and match before creating; same pattern for `mgmt.insightSettings.list(admin.ks)`.
- **Dry-run both rules before declaring success:** `mgmt.lifecycle.match(objectType, eventType, { object: syntheticObject }, admin.ks)`. A rule that exists but does not match is the normal failure, not an exception.
- **Flatten match results defensively.** Every entry nests its rules under `.rules[]` regardless of grouping, so `mr.flatMap((e) => e.rules ? e.rules.map((r) => r.id) : [e.id])`.

The agent's own summary wording is a separate field: `mgmt.agents.update({ agentId, summaryOverridePrompt }, admin.ks)`.

### The email template

`mgmt.emailTemplates.*`, mounted on the same management SDK, authenticated with the same admin `ks` as everything else above. No separate classic-Messaging session key. `for await (const t of mgmt.emailTemplates.list(admin.ks))` filtered by admin tags, then `.update(id, patch, admin.ks)` in place or `.create({ appGuid, ... }, admin.ks)`.

- **Look `appGuid` up live from `mgmt.agents.get(agentId).appGuid`. Never hardcode it.** It regenerates whenever the agent is re-provisioned, and a stale one makes `sendInsightEmail` fail silently: the rule fires, the template resolves, no mail arrives. If the value changed, leave the old template alone and create a fresh one.
- **`appGuid` and `toAttributePath` are create-only.** `emailTemplates.update()`'s field list does not include them; a template created with the wrong value needs a fresh template, not an update.
- `emailProviderId` is optional. It's an account-level setting (a custom sending domain configured via `email-provider/add`), and Kaltura falls back to a shared provider when it's empty. Read it from config, but don't require it.
- Placeholders in the body are `{TOKEN}`. Use **inline CSS only**, so the body contains no other braces for the template engine to choke on.

## Failure, resume, and state

Each id is written to `.provisioning-state.json` the moment its call returns (`recordStep` in `engine/lib/state.mjs`, an atomic temp-file-then-rename write), so the state on disk is always the partial state. On any step throwing, report and exit `5` (the ARCHITECTURE.md 4 exit-code contract):

```js
} catch (err) {
  progress(flags, `\nProvision failed: ${err.detail || err.message || err}`);
  progress(flags, `Partial state written to .provisioning-state.json. Re-run to resume.`);
  process.exitCode = EXIT.PROVISIONING;
}
```

`err.detail` first: `KalturaError` carries the server's message there, and `err.message` alone is often just the HTTP status.

There is no resume flag. A plain re-run reads the state file and skips every step that already has a recorded id.

**Flags `provision.mjs` exposes:** `--dry-run`, `--yes`/`--no-input`, `--json`, `--force` (re-provision when a `widgetId` is already recorded), and `--kb-wait-ms=<n>` for the wait after the step-4 knowledge record.

### Protected-id guard

The reference implementation keeps a module of ids that no mutating call may touch, with `isForbidden(id)` and `assertNotForbidden(id, label)` helpers, and calls the assert before every write and on every id read back from config. It exists because a second agent built on the same account can otherwise overwrite a live one.

Generalize this to: **the deny list is the set of ids in the account that this project's own `.provisioning-state.json` does not claim.** That is exactly the collision check in ARCHITECTURE.md 8, so the engine gets the guard from state rather than from a hardcoded list. Read-only calls against a resource this project does not own stay allowed; cloning a voice from a live avatar needs that.

## Configuration updates after provisioning

Every `update-*` command follows one shape. The prompt update is the reference case:

```js
const before = await mgmt.intellects.get(configId, admin.ks);

// The server adds `mode: null` to prompt blocks that were never sent with one.
// Strip it before comparing, or every run reports a false diff.
const normalize = (arr) => (arr || []).map(({ mode, ...rest }) =>
  (mode == null ? rest : { ...rest, mode }));

if (nothingDiffers) { console.log('Already up to date.'); process.exit(0); }
if (dryRun) process.exit(0);

const { lint } = await mgmt.intellects.setPrompts(configId, prompts, admin.ks, {
  baseDirective, glossary,
});

const after = await mgmt.intellects.get(configId, admin.ks);
// Assert BOTH: the new content applied, AND tool_ids / knowledge_ids /
// capabilities / status came through untouched. Exit non-zero if not.
```

Three things this pattern gets right and a naive `update` does not:

1. **`setPrompts` is read-merge-write.** It preserves `tool_ids`, `knowledge_ids`, `capabilities`, and `status`. A plain `mgmt.intellects.update` with a partial body can drop them.
2. **Compare before writing.** No diff means no call, so the command is idempotent and cheap to re-run.
3. **Verify after writing.** Re-read and assert byte equality on what changed plus no change on what should not have. Exit non-zero on mismatch, do not just log.

`setPrompts` returns `lint.findings[]`. Print the `severity: 'warning'` ones.

For point edits there are also `snapshot(configId, ks)` / `restore(snapshot, ks)` / `diffSnapshots(a, b)`, which are the right primitive behind a `--dry-run` diff.

### The update commands and their calls

Every field the pipeline writes is reachable from one of these. Do not grow this into one command per field.

| Command | Calls |
|---|---|
| `update-prompts` | `mgmt.intellects.setPrompts(configId, PROMPTS, ks, { baseDirective, glossary })` → `{ result, lint }`. Also `mgmt.intellectConfig.setOpeningPhrase(configId, OPENING_PHRASE, ks)` on a diff. It rejects `""`; pass `null` to clear. |
| `update-capabilities` | `mgmt.intellects.setCapabilities(configId, CAPABILITIES, ks)` → `{ capabilities, result }`. Also `setClientVariablesEnabled(configId, bool, ks)`. |
| `update-avatar` | `mgmt.avatars.update({ id, voice, visual })`, plus `openingPhrase: null` to clear the legacy field. An idempotent patch: omitted fields are left alone. |
| `update-agent` | `mgmt.agents.update({ agentId, displayName, adminTags, maxConversationLength, summaryOverridePrompt })` |
| `attach-tool` | `mgmt.tools.add` / `mgmt.tools.update` for nav, plus contact/end-session when their feature flag is on, then `mgmt.intellectConfig.setToolIds(configId, toolIds, ks)` to reconcile. Config-only sync never calls `add`. |
| `attach-knowledge-base` | `mgmt.knowledge.findOrCreateCategory` / `uploadMarkdown` / `addRecord`, then `mgmt.intellectConfig.setKnowledgeIds` and `mgmt.knowledge.setEnabled(configId, true, ks)`. Creates and attaches the knowledge base on a project's first run with `features.knowledgeBase` on, and uploads any new local `data/kb/*.md` file to an already-attached KB. Editing an existing file's content is `update-kb`'s job. |
| `update-kb` | Diffs each local `data/kb/*.md` file's hash against the hash recorded when it was last uploaded. For a changed file: two `uploadtoken.add` + upload pairs (one for the document entry, one for the markdown asset) followed by `baseentry.updateContent` and `attachment_attachmentasset.setContent`, then polls `mgmt.knowledge.entryStatus` until re-indexed. Same entry ids throughout; refuses a local file with no recorded entry rather than creating one. |
| `update-followup` | `mgmt.lifecycle.list` / `create` / `match`, plus `mgmt.emailTemplates`. Requests a `FEEDBACK` insight. |
| `update-feedback` | Same shape as `update-followup`, independent feature flag (`features.feedback`), own insight key `SESSIONFEEDBACK` so both can run without a race on the same `session_ended` event. A template whose `appGuid` has gone stale (agent re-provisioned) is left alone; a fresh one is created instead of updated. |

**`mgmt.agents.update` is a partial patch and rejects `intellect` outright.** The body is `{ agentId, ...fieldsYouAreChanging }`. Including `intellect` returns 400 even when the value is correct. To move an agent to a different intellect, that is not this call.

### Persona identity spans three fields

The persona name lives in `BASE_DIRECTIVE`, in the `name` prompt block, and in the intellect's `opening_phrase`. All three are on the intellect, so `update-prompts` writes them together and refuses to write a set that disagrees.

`lintPersonaIdentity` is the SDK's check for exactly this. `setPrompts` returns its findings in `lint.findings[]`; run it in `--dry-run` too, so the mismatch surfaces before the write.

## Bundle and deploy (6.7)

The deploy path is plain Kaltura OVP HTTP, not the management SDK. Base: `https://www.kaltura.com/api_v3/service`, all calls `POST` with `format=1` for JSON.

Session for these calls:

```
session/action/start   partnerId, secret, type=2, privileges=disableentitlement
```

Returns a bare quoted string. Strip the quotes and sanity-check it: length over 50, does not start with `<` or `{`. A failure here returns an error document with HTTP 200.

### Upload, two calls per file

```
uploadToken/action/add       ks, uploadToken[fileName]        -> { id }
uploadToken/action/upload    ks, uploadTokenId, fileData      -> { status, uploadedFileSize }
```

The second is `multipart/form-data`. Require `status === 2`; anything else is a failure.

### Entry create or update

```
document_documents/action/updateContent
  ks, entryId, resource[objectType]=KalturaUploadedFileTokenResource, resource[token]

document_documents/action/addFromUploadedFile
  ks, documentEntry[name], documentEntry[documentType], uploadTokenId

baseEntry/action/update
  ks, entryId, baseEntry[objectType]=KalturaDocumentEntry, baseEntry[name]
```

Try `updateContent` when the state file has an entry id; fall through to `addFromUploadedFile` only on code `ENTRY_ID_NOT_FOUND`. Any other error is a real failure, not a reason to create a second entry.

`updateContent` replaces the file's bytes but never its stored name. A caller that passes a name carrying a version number (deploy.mjs's `<slug> - App vN`) needs a rename right after a successful content update, or the entry keeps showing a stale name. Call `baseEntry/action/update` right after `updateContent` returns the matching entry id, and check the rename response's `id` too: a rename that lands on the wrong entry must be a thrown error, not a quiet mismatch.

`documentType`: `11` for PDF, `12` for HTML.

### Serving URL

```
https://cdnapi-ev.kaltura.com/p/<pid>/sp/<pid>00/raw/entry_id/<entryId>/direct_serve/1/forceproxy/true/<filename>?h=<hash>
```

**The content hash is mandatory, not a nicety.** The CDN caches by full URL including query string, observed `max-age` around 100 days. Without a hash that changes with the bytes, an updated deck or bundle keeps serving the old one from an edge indefinitely. Use `sha256` of the file, first 10 hex chars. A manually bumped version string is not a substitute: it does not change on every edit.

### Share link

```
shortlink_shortlink/action/list     ks, filter[systemNameEqual], filter[statusEqual]=2
shortlink_shortlink/action/update   ks, id, shortLink[objectType]=KalturaShortLink, shortLink[fullUrl]
shortlink_shortlink/action/add      ks, shortLink[objectType], shortLink[systemName],
                                    shortLink[fullUrl], shortLink[status]=2
```

Look up by `systemName` (namespaced by `project.json.slug`) before creating, so a re-deploy updates the existing link instead of minting a second one. Public URL: `https://www.kaltura.com/tiny/<shortLinkId>`.

### Bundler contract

The bundler inlines `client/` plus the vendored SDK plus generated data into one self-contained HTML file. What matters for the port:

- **Values baked in by source rewrite, not by env at runtime:** `WIDGET_ID`, `PARTNER_ID`, `PDF_URL`, `SDK_VERSION`. Each rewrite is verified present afterward, and the build fails if a replacement did not take. Only the widget id and partner id go in, never `adminSecret` (ARCHITECTURE.md 5).
- **The runtime `loadData()` fetch body is replaced with pre-loaded literals** so the deployed page makes no data fetches. Post-bundle validation asserts no `fetch(` for slide or prompt paths survives and that the inlined globals are present.
- **Use function replacers for the CSS and JS injection**, `html.replace(tag, () => code)`. A string replacer interprets `$&` and friends inside the injected code as replacement patterns, which corrupts any regex-escaping helper in the bundle.
- **Validate slide data before bundling:** every file parses, every file has a numeric `slide`, and the set is contiguous with no gaps and no duplicates. Report missing and duplicate numbers by name. The expected count is the number of `*.json` files in `data/slides/` on disk (`readdirSync`), never a hardcoded number or a `project.json` field.
- **Write the output atomically:** temp file plus `renameSync`, so a killed build never leaves a half-written bundle that deploys.
- **Read `SDK_VERSION` from the SDK's own `package.json`** so the version shown in the UI cannot drift from what shipped.
- The bundle is self-contained except two CDN scripts (PDF rendering, websocket transport), which stay external. Validation asserts both are still referenced.

## Client runtime contract (ARCHITECTURE.md 9)

The browser side uses the `experience` entry point. Startup:

```js
const token = await mgmt.sessions.createWidgetToken({ widgetId });   // re-mintable
const sess = new KalturaAvatarSession({ ...token, videoEl, audioEl, toolCallName });
```

**Video and audio are separate elements.** A single element does not work for this layout, and `audioEl` is what the mute control in ARCHITECTURE.md 9 acts on.

`toolCallName` is the navigation tool's name from the content module, never a literal.

### Events to handle

| Group | Events |
|---|---|
| Connection | `stateChange`, `streamReady`, `mediaReady`, `error`, `warning` |
| Speech | `avatarStartTalking`, `avatarStopTalking`, `interrupted`, `transcript`, `brainSegment`, `responsePending`, `responseSettled`, `turnEnd` |
| Health | `reconnecting`, `reconnected`, `brainStalled`, `capacityChanged`, `toolSpiralDetected`, `toolSpiralRecovering`, `spiralRecovered` |
| Session | `disclosure`, `timeWarning`, `timeExpired`, `ended` |

Handling notes that cost real debugging time:

- **`streamReady` is not `mediaReady`.** The stream can exist before media is playable. Gate the UI on `mediaReady`.
- **`mediaReady` can simply never arrive.** Negotiation can stall or the SDK can drop straight to `error` without it. Arm a bounded timeout (client's `AVATAR_CONNECT_TIMEOUT_MS`) on `connecting` and on `reconnecting`, clear it on `mediaReady`/`error`/`ended`/`timeExpired`, and swap the spinner for a visible failed state on expiry. Otherwise the loading cover spins forever with only a toast that fades after 4s.
- **Autoplay blocking is normal.** Keep a one-time click that calls `sess.startPlayback()`.
- **The navigation tool call can arrive before `avatarStopTalking`.** Drive slide state from the tool call. Waiting for the speech event makes the deck lag the narration.
- **Schedule autoplay from `turnEnd` and `avatarStopTalking`, not `responseSettled`.** `responseSettled` fires on the first output, and a navigation tool call counts, so it lands before the avatar has said anything. `interrupted` ends speech without an `avatarStopTalking`, so clear the speaking flag there too.
- **Reschedule autoplay when a client-side hold times out.** A mic noise or a barge-in can hold autoplay at the moment the avatar stops talking. If the hold's own release does not reschedule, no countdown starts until the next turn.
- **On `brainStalled`, re-send once with a resume instruction** that names the current slide and says to continue presenting it and not to navigate. Without the no-navigate clause the recovery jumps the deck.
- **Captions have no separate server channel.** They are rendered from the same text stream, through `CaptionService(session, { replacements })` with `onCaption(({ text, clear }) => ...)`. `replacements` is the caption map from ARCHITECTURE.md 5, which turns spoken-letter forms back into normal spelling. Default the toggle off and expose it on a button and a key.
- **`disclosure` carries the platform's own AI-disclosure text.** It does not replace the always-on line in ARCHITECTURE.md 9.
- `timeWarning` and `timeExpired` fire against the agent's `maxConversationLength`, so the copy shown is derived from `sessionMaxSeconds`.

## Verify command (6.8)

The verify command must be read-only, with no mutating call reachable from it. Useful shape, three subcommands:

| Subcommand | Does |
|---|---|
| `snapshot <label>` | Write current live avatar and intellect state to a file. |
| `compare` | Diff a previous snapshot against now; diff live config against the local generated content; report per-field. |
| `smoke` | One `mgmt.converseOnce` turn. Creates a conversation, changes no config. |

`verify-startup-timing.mjs` is a separate read-only script, not a subcommand of `verify.mjs`: it drives the deployed `dist.html` with `chromium` (via the toolkit's existing `@playwright/test` dependency) through welcome, disclaimer, greeting, and a first reply, and checks the median of `--runs` (default 3) against two budgets: time to the greeting and time to the first reply. Only the local HTTP server for `dist.html` is local; the avatar session it drives is the real, already-deployed widget. Exits `4` when a budget is missed, and writes every run's timings to `docs/timing-runs/<timestamp>.json` in the project.

`compare` is where the numeric checks in 6.8 hang. Assert, per field: `base_directive`, `prompts`, and `glossary` match the local generated files; `capabilities` matches; `tool_ids` and `knowledge_ids` are exactly the ids this project's state file claims; `allow_client_variables` is `true`. Sort object keys before stringifying so field order never shows as a diff.

## Gotchas, one list

| Symptom | Cause |
|---|---|
| `addRecord` returns HTTP 422 | `indexers` missing. It is required. |
| Turns come back empty with no error | `allow_client_variables` is not `true` on the intellect. |
| Knowledge base never retrieves | `capabilities.use_knowledge_base` was not `'on'` at creation. Partner config caches ~24h. |
| Avatar tags do not stick | Avatars have no `tags` field. Put them in the agent's `adminTags`. |
| Avatar composited wrong | `visual` was copied by `id` only, dropping `motionControl` and framing. |
| Deployed page serves old content | No content hash in the CDN URL. |
| Update command reports a diff every run | Server-added `mode: null` on prompt blocks was not normalized away. |
| Duplicate KB entries after a retry | Uploads are not idempotent and the state file did not record filenames. |
| Corpus poll passes but retrieval is empty | `corpusStatus` counts entries, it does not confirm embedding finished. |
| `err.message` is just a status code | Read `err.detail` on `KalturaError`. |
| Injected JS is corrupted in the bundle | String replacer expanded `$&` in the injected code. Use a function replacer. |
| Capabilities you did not touch turned off | `capabilities` is full-replace. Write all 15 keys every time. |
| Intellect creation returns 500 | `think_process` was sent. It is not a capability. |
| A capability flip has no effect | Resolved value is cached at the account-config layer for ~24h. |
| Agent still introduces itself by the old name | Only the opening phrase changed. The base directive and the `name` prompt block also carry it. Run `update-prompts`, which writes all three. |
| `agents.update` returns 400 | The body included `intellect`. It is a partial patch and rejects that field. |
| Duplicate voices or visuals piling up on the account | `catalog.createVoice` / `createVisual` are not idempotent. Skip when state has an id. |
| Avatar looks letterboxed with dark side bars | The visual was a portrait padded to square. The stream is 512 by 512; extend the backdrop instead. |
| Lifecycle rule exists but never fires | It was conditioned on `object.agent_id`. Widget-token threads carry `agent_id: "default"`. |
| `sendInsightEmail` sends nothing | Hardcoded `appGuid`. Read it from `agents.get(agentId).appGuid`; it regenerates on re-provision. |
| Deck lags the narration by one slide | Slide state waited for `avatarStopTalking` instead of the tool call. |

## Offline verification checklist

Prove the engine works by hand-running against a throwaway `project.json`, a sandbox `.env`, and a few stub slide files. Concretely:

1. `doctor` passes against the sandbox account.
2. `provision --dry-run` prints every planned operation for the features turned on in `project.json`, and makes no network write.
3. `provision` succeeds; `.provisioning-state.json` holds an id for every step it ran.
4. Kill `provision` mid-run, then run it again: it reuses the recorded ids and creates nothing twice.
5. `verify compare` reports every field matching the local content.
6. `bundle` then `deploy` produces a reachable share URL with a content hash in it.
7. Re-run `update-prompts` with no local change: it reports "already up to date" and makes no call. Same for `update-capabilities` and `update-avatar`.
8. `attach-tool` twice with the same tool: the second run finds the existing tool, does not create a second one, and leaves the prompts and capabilities untouched.
9. Point a second project with a different slug at the same account: its provision succeeds, and a mutating call against the first project's id is refused (ARCHITECTURE.md 8).
