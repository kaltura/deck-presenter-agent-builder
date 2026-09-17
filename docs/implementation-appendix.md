# Implementation appendix: the Kaltura calls

Concrete API contract for `PLAN.md` sections 6.6 (provisioning) and 6.7 (bundle and deploy). Written from a working, already-deployed presenter agent, so the sequence, the required fields, and the gotchas are observed behavior, not guesses.

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

Every management call takes `admin.ks` as its last argument. Resources used below: `mgmt.sessions`, `mgmt.tools`, `mgmt.knowledge`, `mgmt.intellects`, `mgmt.avatars`, `mgmt.agents`, `mgmt.application`, `mgmt.catalog` (custom voice and visual), `mgmt.lifecycle` (post-session rules), plus the top-level `mgmt.converseOnce`.

Named helpers exported alongside `Management`, all used below: `tools.client`, `tools.clientToolReadiness`, `stripServerManaged`, `lintPersonaIdentity`, `mergeCapabilityWrite`.

**Credential rule (6.6).** `adminSecret` is read from the project's `.env` once, exchanged for a session key at run start, and never logged. `createAdminToken()` is that exchange. Pass `admin.ks` onward; never re-read the secret per call.

**The SDK also ships `provision()`**, a one-call factory (`generateProfile` → `intellect.add` → `intellect.update` → preset voice/visual → `avatar.create` → `agent.create` → `resolveWidgetId`). Do not use it for this engine. It picks a preset voice and visual from a plain-English brief and gives no per-step resume point, and 6.6 needs explicit control over the KB, the nav tool, and the consent-gated avatar, plus a recorded id after every step. Read it as a reference for call shapes only.

## Vocabulary

| Term | What it is |
|---|---|
| **intellect** / `configId` | The agent's brain: prompts, base directive, glossary, capabilities, linked tool ids, linked knowledge ids. Numeric id. |
| **avatar** / `avatarId` | Face and voice only. A `{ voice, visual, openingPhrase }` triple. Hex string id. |
| **agent** / `agentId` | Binds one intellect to one or more avatars, carries the display name and tags. UUID. |
| **tool** | A callable the intellect can invoke. The presenter needs one client-side navigation tool. UUID. |
| **knowledge record** / `knowledgeId` | A RAG corpus definition pointing at a category of uploaded entries. Numeric id. |
| **widget id** | The public embed handle the client needs. Kaltura entry-id shape (`N_xxxxxxxx`). |

## One content module, imported everywhere

No command in `engine/` contains prompt text, a tool description, a slide count, or a persona name. One module reads the project's files and exports every payload constant (PLAN.md 5). Shape:

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

Each step's id goes into `.provisioning-state.json` **the moment it returns**, not at stage end (PLAN.md 8).

### 0. Pre-flight, read-only

Runs before anything is created. All of it must pass.

```js
const k = mgmt.knowledge;
for (const m of ['findOrCreateCategory', 'uploadMarkdown', 'addRecord', 'corpusStatus']) {
  if (typeof k[m] !== 'function') fail(`SDK too old: knowledge.${m} missing.`);
}
```

Also check, in this order, and fail with a specific message per case:

1. At least one `*.md` file exists in the project's `data/kb/`.
2. `capabilities.use_knowledge_base === 'on'` in the config about to be written. **Partner config is cached for roughly 24 hours**, so this has to be right at creation time; flipping it later does not take effect promptly.
3. If cloning a voice or visual: read the source avatar and confirm it has both.

```js
const source = await mgmt.avatars.get(sourceAvatarId, admin.ks);   // READ only
if (!source.voice?.id || !source.visual?.id) fail('Source avatar has no voice or visual.');
```

The clone path is additionally gated on a consent record existing in the project repo (PLAN.md 6.6, 10). Check the file before this API call, so a missing consent record costs nothing.

### 1. Navigation tool

```js
const cfg = tools.client(navToolDefinition);      // typed builder, validates the shape
const tool = await mgmt.tools.add(cfg, admin.ks);
// -> tool.id   (UUID)
```

`tools.client(...)` is the builder for a client-executed tool (the browser handles the call). `tools.api`, `tools.csv`, and `tools.code` exist for other kinds. `navToolDefinition` is rendered from `data/nav-rules.json`, never hand-written (PLAN.md 5).

### 2. Knowledge base category

```js
const cat = await k.findOrCreateCategory({ name: kbCategoryName }, admin.ks);
// -> cat.id   (numeric)
```

**Idempotent on name.** This is the one step safe to re-run blind. `kbCategoryName` is namespaced by `project.json.slug` (PLAN.md 8), so two projects on one account do not land in the same category.

### 3. Upload each KB file

One call per markdown file. Loop, and record each result.

```js
const up = await k.uploadMarkdown({ markdown, name: fileName, categoryId: cat.id }, admin.ks);
// -> { entryId, markdownAssetId }
```

Not idempotent. A re-run without state creates duplicate entries in the category, which silently degrades retrieval. The state file must list uploaded filenames, not just a count.

**Open question (PLAN.md 6.3, 12):** whether Kaltura re-chunks an uploaded markdown file or indexes it as one unit. Resolve it here by uploading one deliberately long file and inspecting what retrieval returns. The answer decides whether file sizing is the engine's problem.

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

**Then wait before step 5.** There is no reliable completion signal for indexing at this point. The reference implementation waits a fixed 60 seconds, overridable by flag. Creating the intellect too early links a corpus that is not yet queryable.

### 5. Intellect, everything in one write

```js
const intel = await mgmt.intellects.create({
  type: 'internal',
  status: 2,                       // active
  allow_client_variables: true,    // see below
  prompts,                         // array of prompt blocks
  base_directive: baseDirective,
  glossary,
  capabilities,                    // includes use_knowledge_base: 'on'
  tool_ids: [tool.id],
  knowledge_ids: [Number(rec.id)],
  }, admin.ks);
// -> intel.configId, intel.warnings[]
```

Log `intel.warnings` if non-empty. They are advisory, not failures.

**`allow_client_variables: true` is not optional for a presenter agent.** It gates `request_vars`, which is how the client passes the current slide as page context on every turn. With it off, turns that depend on page context come back empty with no error, which is a hard bug to find later. Set it at creation.

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

### 6. Corpus readiness poll

```js
const corpus = await k.corpusStatus({ categoryId: cat.id }, admin.ks);
// -> { entryCount, populated, categoryIds, perCategory }
```

Poll every 10 seconds against a 5-minute deadline. **Non-fatal on timeout:** warn and continue.

**Known limitation:** this counts entries present in the category. It cannot confirm that embedding finished. Treat a healthy count as necessary, not sufficient. `mgmt.knowledge.isIndexed(knowledgeId, ks)` and `mgmt.knowledge.getLinkage(configId, ks)` give further read-only signal and belong in the verify command (6.8), not in the provisioning gate.

### 7. Avatar

```js
const voice = { id: source.voice.id };
if (source.voice.speed != null) voice.speed = source.voice.speed;
const visual = { ...source.visual };   // id, motionControl, crop, and any other fields

const av = await mgmt.avatars.create({ voice, visual, openingPhrase }, admin.ks);
// -> av.id   (hex string)
```

Copy `visual` wholesale. It carries `motionControl` and framing fields beyond `id`, and dropping them changes how the avatar is composited.

**The avatar carries no `tags` field.** Passing one is silently ignored. Tags belong on the agent, step 8.

Write `avatar.source` (`"cloned"` or `"fresh"`) back to `project.json` here, so the client knows whether to render the synthetic-content label (PLAN.md 9).

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

- **`consentRef` is a real field, so write the consent record's identifier into it.** That is the platform-side half of the PLAN.md 10 gate: the record lives in the project repo and its reference travels with the catalog item. Include who provided it, when, and what use it covers.
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

### 10. Smoke test, non-fatal

```js
const smoke = await mgmt.converseOnce(intel.configId, 'Hello! What can you help me with?');
// -> { text, status, error }
```

One text turn. Creates a conversation, changes no config. A failure here warns; the provisioned stack is still valid and 6.8 will exercise it properly.

## Optional stage: extra client tools

The presenter needs one navigation tool (step 1). A contact form and an end-session button are two more client tools with the identical shape, which is why the engine ships **one** generic `attach-tool` command rather than one per tool.

```js
const wanted = tools.client(TOOL_DEF);   // marks it client-executed

// The server adds its own defaults (display_name, add_to_history, per-arg
// defaults), so compare only the keys you set, recursively.
const subset = (want, have) =>
  (want && typeof want === 'object' && !Array.isArray(want))
    ? Object.keys(want).every((k) => subset(want[k], have?.[k]))
    : JSON.stringify(want) === JSON.stringify(have);

const created = await mgmt.tools.add(wanted, admin.ks);            // create once
await mgmt.tools.update(created.id, { name: wanted.name, config: wanted }, admin.ks);
```

Then attach it, read-merge-write:

```js
const before = await mgmt.intellects.get(configId, admin.ks);
const body = stripServerManaged(before, configId);      // drops read-only fields
body.tool_ids = [...(before.tool_ids || []), created.id];

const readiness = tools.clientToolReadiness(body);      // -> { warnings[] }
await mgmt.intellects.update(body, admin.ks);
```

`stripServerManaged` exists because a plain round-trip of a `get` result fails validation: the response carries fields the update endpoint rejects. Never hand-maintain that list.

`clientToolReadiness` warns when the intellect is configured in a way that stops a client tool from ever firing. Print its warnings; they are the difference between a tool that exists and a tool that works.

After the write, assert that `base_directive`, `prompts`, `knowledge_ids`, `capabilities`, and `status` are unchanged, and exit non-zero if not. Attaching a tool must not silently rewrite the persona.

## Optional stage: follow-up email after a session

Off by default (PLAN.md 10). One InsightSettings entity per insight, two lifecycle rules, one email template. SDK v1.22.0 folded the email template API into the management SDK, so this whole stage now runs on a single `ks`, with no second Kaltura API and no separate session key.

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

On any step throwing, write the partial state and exit non-zero (`5`, per the PLAN.md 4 exit-code contract):

```js
function fail(step, err) {
  const detail = err?.detail || err?.message || String(err);
  console.error(`Provision failed at step "${step}": ${detail}`);
  console.error('Created so far:', JSON.stringify(created, null, 2));
  writeState({ failedStep: step, createdSoFar: created, error: detail });
  process.exit(5);
}
```

`err.detail` first: `KalturaError` carries the server's message there, and `err.message` alone is often just the HTTP status.

A `--resume` run reads `createdSoFar`, skips every step with a recorded id, and refuses if any recorded id is on the protected list below.

**Flags the reference implementation exposes, worth keeping:** `--dry-run`, `--force`, `--resume`, and `--kb-wait-ms=<n>` for the step-4 wait.

### Protected-id guard

The reference implementation keeps a module of ids that no mutating call may touch, with `isForbidden(id)` and `assertNotForbidden(id, label)` helpers, and calls the assert before every write and on every id read back from config. It exists because a second agent built on the same account can otherwise overwrite a live one.

Generalize this to: **the deny list is the set of ids in the account that this project's own `.provisioning-state.json` does not claim.** That is exactly the collision check in PLAN.md 8, so the engine gets the guard from state rather than from a hardcoded list. Read-only calls against a resource this project does not own stay allowed; cloning a voice from a live avatar needs that.

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

### The six update commands and their calls

Every field the pipeline writes is reachable from one of these. Do not grow this into one command per field.

| Command | Calls |
|---|---|
| `update-prompts` | `mgmt.intellects.setPrompts(configId, PROMPTS, ks, { baseDirective, glossary })` → `{ result, lint }` |
| `update-capabilities` | `mgmt.intellects.setCapabilities(configId, CAPABILITIES, ks)` → `{ capabilities, result }`. Also `setClientVariablesEnabled(configId, bool, ks)`. |
| `update-avatar` | `mgmt.avatars.update({ id, openingPhrase })`, or with `voice` / `visual` / `visual.motionControl`. An idempotent patch: omitted fields are left alone. |
| `update-agent` | `mgmt.agents.update({ agentId, displayName, adminTags, maxConversationLength, summaryOverridePrompt })` |
| `attach-tool` | `mgmt.tools.add` / `mgmt.tools.update`, then the read-merge-write attach above. Config-only sync never calls `add`. |
| `update-followup` | `mgmt.lifecycle.list` / `create` / `match`, plus the Messaging API template calls. |

**`mgmt.agents.update` is a partial patch and rejects `intellect` outright.** The body is `{ agentId, ...fieldsYouAreChanging }`. Including `intellect` returns 400 even when the value is correct. To move an agent to a different intellect, that is not this call.

### Persona identity spans three fields

The persona name lives in `BASE_DIRECTIVE`, in the `name` prompt block, and in the avatar's `openingPhrase`. Two of them are on the intellect, one is on the avatar, so a rename touches two resources.

Changing only `openingPhrase` leaves the model introducing itself by the old name, because the directive and the prompt block still carry it. `update-prompts` and `update-avatar` therefore both read the current value of all three and refuse to write a set that disagrees.

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
```

Try `updateContent` when the state file has an entry id; fall through to `addFromUploadedFile` only on code `ENTRY_ID_NOT_FOUND`. Any other error is a real failure, not a reason to create a second entry.

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

- **Values baked in by source rewrite, not by env at runtime:** `WIDGET_ID`, `PARTNER_ID`, `PDF_URL`, `SDK_VERSION`. Each rewrite is verified present afterward, and the build fails if a replacement did not take. Only the widget id and partner id go in, never `adminSecret` (PLAN.md 5).
- **The runtime `loadData()` fetch body is replaced with pre-loaded literals** so the deployed page makes no data fetches. Post-bundle validation asserts no `fetch(` for slide or prompt paths survives and that the inlined globals are present.
- **Use function replacers for the CSS and JS injection**, `html.replace(tag, () => code)`. A string replacer interprets `$&` and friends inside the injected code as replacement patterns, which corrupts any regex-escaping helper in the bundle.
- **Validate slide data before bundling:** every file parses, every file has a numeric `slide`, and the set is contiguous with no gaps and no duplicates. Report missing and duplicate numbers by name. The reference hardcodes the expected count; the generic engine reads it from `project.json`.
- **Write the output atomically:** temp file plus `renameSync`, so a killed build never leaves a half-written bundle that deploys.
- **Read `SDK_VERSION` from the SDK's own `package.json`** so the version shown in the UI cannot drift from what shipped.
- The bundle is self-contained except two CDN scripts (PDF rendering, websocket transport), which stay external. Validation asserts both are still referenced.

## Client runtime contract (PLAN.md 9)

The browser side uses the `experience` entry point. Startup:

```js
const token = await mgmt.sessions.createWidgetToken({ widgetId });   // re-mintable
const sess = new KalturaAvatarSession({ ...token, videoEl, audioEl, toolCallName });
```

**Video and audio are separate elements.** A single element does not work for this layout, and `audioEl` is what the mute control in PLAN.md 9 acts on.

`toolCallName` is the navigation tool's name from the content module, never a literal.

### Events to handle

| Group | Events |
|---|---|
| Connection | `stateChange`, `streamReady`, `mediaReady`, `error`, `warning` |
| Speech | `avatarStartTalking`, `avatarStopTalking`, `interrupted`, `transcript`, `brainSegment`, `responsePending`, `responseSettled` |
| Health | `reconnecting`, `reconnected`, `brainStalled`, `capacityChanged`, `toolSpiralDetected`, `toolSpiralRecovering`, `spiralRecovered` |
| Session | `disclosure`, `timeWarning`, `timeExpired`, `ended` |

Handling notes that cost real debugging time:

- **`streamReady` is not `mediaReady`.** The stream can exist before media is playable. Gate the UI on `mediaReady`.
- **Autoplay blocking is normal.** Keep a one-time click that calls `sess.startPlayback()`.
- **The navigation tool call can arrive before `avatarStopTalking`.** Drive slide state from the tool call. Waiting for the speech event makes the deck lag the narration.
- **On `brainStalled`, re-send once with a resume instruction** that names the current slide and says to continue presenting it and not to navigate. Without the no-navigate clause the recovery jumps the deck.
- **Captions have no separate server channel.** They are rendered from the same text stream, through `CaptionService(session, { replacements })` with `onCaption(({ text, clear }) => ...)`. `replacements` is the caption map from PLAN.md 5, which turns spoken-letter forms back into normal spelling. Default the toggle off and expose it on a button and a key.
- **`disclosure` carries the platform's own AI-disclosure text.** It does not replace the always-on line in PLAN.md 9.
- `timeWarning` and `timeExpired` fire against the agent's `maxConversationLength`, so the copy shown is derived from `sessionMaxSeconds`.

## Verify command (6.8)

The verify command must be read-only, with no mutating call reachable from it. Useful shape, three subcommands:

| Subcommand | Does |
|---|---|
| `snapshot <label>` | Write current live avatar and intellect state to a file. |
| `compare` | Diff a previous snapshot against now; diff live config against the local generated content; report per-field. |
| `smoke` | One `mgmt.converseOnce` turn. Creates a conversation, changes no config. |

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
| Agent still introduces itself by the old name | Only `openingPhrase` changed. The base directive and the `name` prompt block also carry it. |
| `agents.update` returns 400 | The body included `intellect`. It is a partial patch and rejects that field. |
| Duplicate voices or visuals piling up on the account | `catalog.createVoice` / `createVisual` are not idempotent. Skip when state has an id. |
| Avatar looks letterboxed with dark side bars | The visual was a portrait padded to square. The stream is 512 by 512; extend the backdrop instead. |
| Lifecycle rule exists but never fires | It was conditioned on `object.agent_id`. Widget-token threads carry `agent_id: "default"`. |
| `sendInsightEmail` sends nothing | Hardcoded `appGuid`. Read it from `agents.get(agentId).appGuid`; it regenerates on re-provision. |
| Intellect update rejects a body you just read | Round-tripped a `get` result. Pass it through `stripServerManaged` first. |
| Deck lags the narration by one slide | Slide state waited for `avatarStopTalking` instead of the tool call. |

## Verification plan for the port

Phase 0 is proven, per PLAN.md 13, by hand-running against a throwaway `project.json`, a sandbox `.env`, and a few stub slide files. Concretely:

1. `doctor` passes against the sandbox account.
2. `provision --dry-run` prints all nine planned operations and makes no network write.
3. `provision` succeeds; `.provisioning-state.json` holds nine ids.
4. Kill `provision` mid-run, then `--resume`: it reuses the recorded ids and creates nothing twice.
5. `verify compare` reports every field matching the local content.
6. `bundle` then `deploy` produces a reachable share URL with a content hash in it.
7. Re-run `update-prompts` with no local change: it reports "already up to date" and makes no call. Same for `update-capabilities` and `update-avatar`.
8. `attach-tool` twice with the same tool: the second run finds the existing tool, does not create a second one, and leaves the prompts and capabilities untouched.
9. Point a second project with a different slug at the same account: its provision succeeds, and a mutating call against the first project's id is refused (PLAN.md 8).
