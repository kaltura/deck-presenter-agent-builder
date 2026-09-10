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

Every management call takes `admin.ks` as its last argument. Resources used below: `mgmt.sessions`, `mgmt.tools`, `mgmt.knowledge`, `mgmt.intellects`, `mgmt.avatars`, `mgmt.agents`, `mgmt.application`.

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

### 8. Agent

```js
const ag = await mgmt.agents.create({
  displayName,
  intellect: { intellectType: 'genie', id: intel.configId },
  avatarIds: [av.id],
  adminTags: [...tags],            // tags go HERE, not on the avatar
  maxConversationLength: 900,      // seconds
}, admin.ks);
// -> ag.agentId   (UUID)
```

`intellectType: 'genie'` is the value for an internal intellect.

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

Other update calls with the same read-merge-write contract: `mgmt.intellects.setCapabilities(configId, dict, ks)`, `mgmt.intellects.setClientVariablesEnabled(configId, bool, ks)`, `mgmt.intellects.setPrompts`. For point edits there are also `snapshot(configId, ks)` / `restore(snapshot, ks)` / `diffSnapshots(a, b)`, which are the right primitive behind a `--dry-run` diff.

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

## Verification plan for the port

Phase 0 is proven, per PLAN.md 13, by hand-running against a throwaway `project.json`, a sandbox `.env`, and a few stub slide files. Concretely:

1. `doctor` passes against the sandbox account.
2. `provision --dry-run` prints all nine planned operations and makes no network write.
3. `provision` succeeds; `.provisioning-state.json` holds nine ids.
4. Kill `provision` mid-run, then `--resume`: it reuses the recorded ids and creates nothing twice.
5. `verify compare` reports every field matching the local content.
6. `bundle` then `deploy` produces a reachable share URL with a content hash in it.
7. Re-run `update-directive` with no local change: it reports "already up to date" and makes no call.
8. Point a second project with a different slug at the same account: its provision succeeds, and a mutating call against the first project's id is refused (PLAN.md 8).
