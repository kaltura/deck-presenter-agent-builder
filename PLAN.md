# Deck Presenter Agent Builder Plan

## 1. What this is

A generic, public-facing toolkit that turns "a deck + speaker notes + support docs" into a live Kaltura AI presenter agent (avatar + voice + navigable deck + knowledge base). Point Claude Code at a new deck, answer a short round of questions, and it builds, tests, and deploys the whole thing to a Kaltura account.

Anyone, any company, any topic, any deck, should be able to clone this, drop in their own deck, and get an accurate, engaging, agent-led presentation without knowing anything about the Kaltura API.

## 2. Non-negotiables

- **Assumes an existing Kaltura account.** The target user already has a Kaltura partner account (`partnerId`/`adminSecret`). "No knowledge of the Kaltura API required" means no API knowledge, not account acquisition. Signup and onboarding for people with no Kaltura relationship is out of scope.
- **Public repo, zero internal or customer data, ever.** No deck content, speaker notes, company names, logos, transcripts, account ids, or example content drawn from any real engagement may enter this repo's tracked git history, not even temporarily, not even as a design reference. Every example in this repo and its docs uses a clearly fictional product. This shapes the architecture (section 3), not just a gitignore rule.
- **Generic by construction.** No product name, persona name, or topic baked into code. Everything deck-specific is data or generated content, never a code edit.
- **Easy for a stranger to pick up.** Clone, run one setup command, drop in a deck, answer a few questions, get a live agent.
- **Safe by default.** Provisioning and deployment are real, billable, externally visible actions against a real account. The tool shows a plan and asks before anything irreversible, and can never collide with another project's resources on the same account.
- **The deployed agent tells the audience it is an AI.** The disclosure is on by default, is real text in the page, and cannot be emptied by editing a branding file (section 9).
- **The deployed agent stores nothing about the audience by default.** No audio, no video, no persisted transcript. Turning any capture on is an explicit, documented choice recorded in `project.json` (section 10).
- **Safe defaults, not compliance.** The tool ships defaults that keep the common case out of trouble and documents what the user still owns. It never claims to make anyone compliant, and it gives no legal advice.

## 3. Architecture: template repo, not shared workspace

The core design choice that satisfies "never share internal or customer data": **this repo is a template, not a workspace.**

- `deck-presenter-agent-builder` (this repo, public) ships the *engine* (Kaltura API scripts), the *generic client app*, prompt *templates* (placeholders, no real content), and the *Claude Code skill* that orchestrates the build. Starting in Phase 1, it also contains one committed demo project using an obviously fictional product, for docs and for smoke-testing the tool itself.
- Each real deck is built by running `create-project.mjs`, which scaffolds a **new, separate git repo** (private, owned by whoever runs it) from this template. That new repo, not this one, holds the actual deck, speaker notes, generated prompts, KB docs, and `.env` credentials for that Kaltura account. `create-project.mjs` also copies `skills/build-deck-agent/` into the new repo's own `.claude/skills/`, so Claude Code running inside the new project can discover and invoke the skill immediately. That copy is what makes step 3 of section 4 work.
- **Why not GitHub's own "template repository" button.** A repo generated that way starts from a single fresh commit with no shared history, so it can never merge or rebase from the template later. Since the engine will ship real bug fixes that existing projects need, the copy-in path plus an explicit staleness check (section 12) is the only version of this that stays maintainable.
- Deck and account data structurally cannot reach the public repo, because it never exists inside this repo's working directory in the first place. This is enforced, not just a discipline norm:
  - The repo root ships a `.gitignore` blocking `input/`, `.env*`, `*.pdf`, `*.pptx`, and any `data/slides|kb` path outside `demo/`.
  - CI runs a **named secret scanner** (gitleaks or equivalent) with an added custom rule for the `adminSecret` shape, and the same job fails on the blocked paths above. A hand-rolled regex on its own is not enough: it has no entropy detection and cannot scan history.
  - GitHub **secret scanning and push protection** are enabled on the repo, including a custom push-protection pattern for the `adminSecret` shape, so a bad push is blocked before it lands.
  - The same scanner runs as a local pre-commit hook, so the first line of defense is on the contributor's machine.
  - This gate also catches anyone hand-running `engine/` scripts inside this repo during development.
- **If a secret reaches git history anyway, rotate first.** Rotate or revoke the credential at the Kaltura account immediately and treat it as compromised from the moment it was pushed. History rewrite and force-push are cleanup, not the fix.
- `CLAUDE.md` at the repo root is the enforcement point for Claude Code itself when someone works *on* this repo: it restates the non-negotiables (never commit real deck or account data, generic by construction, no product or persona names in code) so an agent contributing to `engine/`, `client/`, or `templates/` doesn't need to re-derive them from this plan file. `templates/project/CLAUDE.md` is a separate, generic file scaffolded into every new project: ambient context for Claude Code working *inside* a project repo (data contracts, pipeline stage names, where things live), available without invoking the skill just to look something up. Keep each `CLAUDE.md` under roughly 200 lines; adherence drops as these files grow, and anything longer belongs in a referenced doc. The skill (`skills/build-deck-agent/SKILL.md`) drives the pipeline as a checklist with stage arguments (`ingest`, `prompts`, ...) rather than fragmenting into one skill per stage; a second skill would duplicate most of the same context for no real benefit.

```
deck-presenter-agent-builder/          (public, generic, this repo)
├── CLAUDE.md                          contributor-facing: restates the non-negotiables above
├── LICENSE                            Apache-2.0
├── SECURITY.md                        points at GitHub private vulnerability reporting
├── .gitignore                         blocks input/, .env*, *.pdf, *.pptx, data/slides|kb outside demo/
├── .claude-plugin/plugin.json         minimal manifest so the skill auto-loads as a plugin
├── engine/                            Kaltura API scripts: provision, deploy, bundle, verify, update-*
├── client/                            generic presenter web app (viewer UI, avatar, PDF, nav)
├── templates/
│   ├── prompts/*.md                   prompt skeletons with {{PLACEHOLDERS}}, no real wording
│   └── project/                       full new-repo skeleton (.env.example, CLAUDE.md, consent/, data/, docs/)
├── skills/build-deck-agent/
│   ├── SKILL.md                       the pipeline checklist, stage-dispatched
│   └── reference-*.md                 per-stage procedural detail, loaded on demand
├── bin/
│   ├── create-project.mjs             scaffolds a new private project repo from templates/project
│   ├── check-template-update.mjs      read-only staleness diff against the template (section 12)
│   └── doctor.mjs                     re-runnable environment + credential preflight
├── demo/                              one fictional product, fake deck, fake speaker notes; Phase 1, docs only
└── docs/
    ├── implementation-appendix.md     the concrete Kaltura calls for 6.6 and 6.7
    └── transparency-and-consent.md    what the defaults cover, what the user still owns (section 10)
```

```
<your-project>/                        (new repo, created per deck, private, lives outside this repo)
├── CLAUDE.md                           copy of templates/project/CLAUDE.md: data contracts, conventions
├── .env                                gitignored; this project's Kaltura partnerId/adminSecret
├── .env.example
├── .template-version                   template tag this project was scaffolded from (section 12)
├── .claude/skills/build-deck-agent/    copy of this repo's skill, installed by create-project.mjs
├── .provisioning-state.json            gitignored; ids created so far, for resume + idempotency (section 8)
├── consent/                            voice/visual consent records, required before cloning (section 10)
├── input/                              raw deck file(s), speaker notes, support docs, working files, gitignored
├── data/
│   ├── slides/*.json                   generated per-slide structured content
│   ├── nav-rules.json                  generated navigation source of truth (section 5)
│   ├── routes.json                     rendered from nav-rules.json, never drafted directly
│   ├── kb/*.md                         generated knowledge-base docs
│   └── eval/held-out.json              human-authored eval questions (section 6.5)
├── prompts/*.md                        generated prompt files (base-directive, glossary, pronunciation, tools/*)
├── client/                             copy of the generic app from the template
├── scripts/                            copy of engine/, parameterized by project.json + .env
├── project.json                        persona, topic, audience, tone, disclosure, privacy, feature flags
└── docs/
    ├── build-log.md                    what was generated, what was asked, what was decided
    └── eval-runs/<timestamp>.json      per-run eval results, diffable across rebuilds
```

## 4. End-to-end user experience

Prerequisites: **Node 22+** and Claude Code installed. Node 18 and Node 20 are both past end-of-life, so 22 (Jod) is the floor and 24 (Krypton) is fine. Re-check the Node LTS schedule at each release rather than treating 22 as permanent. `create-project.mjs` checks for these (and whatever system dependency the chosen PDF-rendering approach needs) and prints install instructions per OS on failure. The same check is exposed as a re-runnable `doctor` command.

1. Create a new project: `npx deck-presenter-agent-builder create my-deck`. This clones the template into a new local folder and a new private git repo, with an `input/` folder waiting and the skill already installed under `.claude/skills/`.
2. Drop in `input/deck.pdf` (or `.pptx`), `input/speaker-notes.*` if separate, and any support docs (product sheets, FAQs, prior transcripts) into `input/support/`.
3. Open Claude Code **inside the new project folder** and say: "build the presenter agent from this deck."
4. Claude Code runs the `build-deck-agent` skill (section 7), which:
   - Validates the Kaltura account and `.env` first with one cheap authenticated call, and fails fast with a clear, actionable error if credentials are missing or invalid, before spending any effort on the deck.
   - Parses the deck and notes into structured slide data, then asks one batched, capped round of clarifying questions (persona name, tone, target audience, any restricted topics, plus up to the 10 highest-risk content gaps flagged during ingestion, harvesting, and drafting). Anything beyond the cap, or left unanswered, gets a best-guess default plus a TODO entry in `docs/build-log.md`, never an open-ended back-and-forth.
   - Drafts all prompt files and the knowledge base from the deck content.
   - Shows a summary and a dry-run diff (generated content, plus the concrete sequence of Kaltura operations it is about to run: resource type, create vs. update, existing id if reusing one) before touching any live account.
   - On confirmation: provisions the Kaltura resources, bundles and deploys the client, runs smoke tests and a per-chapter Q&A eval.
   - Reports a share link and a short build log.
5. Later edits ("make it more casual", "add a glossary entry for X", "the deck changed, re-import slide 12") are incremental re-runs of one pipeline stage, not a full rebuild. Any such stage that reaches a mutating call still shows a diff and asks for confirmation first, exactly like a full run.

### CLI contract

The CLI follows standard command-line conventions, because the plan's own CI suite (section 13) cannot sit at an interactive prompt:

| Requirement | Behavior |
|---|---|
| `--no-input` / `--yes` | Run with no prompts. Every question either has a resolved value or the command exits non-zero naming what was missing. |
| `--json` | Machine-readable result on stdout; human progress goes to stderr. |
| `--dry-run` | Already required by section 6.5. No network mutation, prints the planned operation sequence. |
| `NO_COLOR` | Honored, along with non-TTY detection. |
| Exit codes | `0` success · `1` unexpected error · `2` bad usage or arguments · `3` credential or preflight failure · `4` lint or validation failure · `5` provisioning failure, partial state written and ids printed. |

## 5. Data contracts

These are the interfaces between pipeline stages.

### `project.json`

```json
{
  "slug": "my-deck",
  "personaName": "Nova",
  "productOrTopic": "One-line description of the deck's subject",
  "audience": "Who this is presented to",
  "tone": "confident, concise, no filler",
  "restrictedTopics": ["topics the agent should never discuss"],
  "totalSlides": 42,
  "chapters": [{ "title": "Introduction", "range": [1, 5] }],
  "features": { "contactForm": true, "endSessionTool": true, "knowledgeBase": true, "followUpEmail": false },
  "sessionMaxSeconds": 900,
  "capabilities": { "avatar": "on", "use_knowledge_base": "on", "use_content_search": "on" },
  "avatar": { "source": "fresh" },
  "disclosure": { "text": "", "locale": "en" },
  "privacy": {
    "controllerName": "",
    "controllerContact": "",
    "transcriptRetention": "none",
    "retentionDays": 0,
    "reuseForEval": false
  }
}
```

Drives placeholder substitution into every generated prompt file, the tool names (derived from `slug`, never hardcoded), resource naming for collision avoidance (section 8), and generic client branding.

- `avatar.source` is `"cloned"` or `"fresh"`, written by section 6.6. It drives the synthetic-content label in the client (section 9) so labelling is data-driven, not a judgment call at render time.
- `capabilities` is a **partial override** on top of the engine's presenter default map. The engine expands it to the full 15-key set before every write, because Kaltura replaces the whole capability sub-dict on update rather than merging it. The appendix lists the keys, the defaults, and why a partial write silently drops siblings.
- `sessionMaxSeconds` must agree with the duration the welcome-screen copy promises. The server accepts 1 to 3600. The bundle step compares the two and fails on a mismatch, because a session that ends before the promised time reads as a crash to the audience.
- `features.followUpEmail` is off by default. Turning it on makes the agent collect contact details and email a session summary, which is a new purpose under section 10 and needs its own privacy-panel copy.
- `disclosure.text` may be reworded or translated. When blank, the engine substitutes its built-in default string, so the disclosure cannot be removed by emptying the field.
- `privacy.controllerName` and `privacy.controllerContact` must be non-empty before section 6.7 will produce a bundle.
- Naming the persona after a real person pulls in the same consent requirement as cloning their voice (section 10), even when no cloning happens.

### `data/slides/NN.json`

`{slide, title, category, talking_points[], content: {key_metrics, text, footnotes[]}, narrator_guidance}`, one file per slide, generated by the deck-ingestion stage (section 6.1). Generated under a **JSON Schema enforced at generation time** (Anthropic Structured Outputs with `strict: true`), so shape validity is guaranteed by constrained decoding rather than checked by a lint afterwards.

### `data/nav-rules.json`

The single structured source of truth for navigation, generated in section 6.4 and written to disk before anything is rendered from it: per-chapter slide range, per-topic entry slide id, forward-reference guard trigger and target, proof-point slide ids. Also schema-enforced at generation.

### `data/kb/*.md`

Topic-scoped markdown, uploaded to the Kaltura knowledge base. Retrieval belongs to Kaltura, so the **text itself is the only lever the plan controls**. Authoring rules, all checkable:

- Per-file frontmatter: `chapter`, `sourceSlides`, `restrictedTopic` flag. Lets the section 6.4 lint cross-check KB content against real slide ranges.
- The file opens with an explicit one-line context statement naming the product or topic and where this content sits in the deck. Chunks that carry their own context retrieve measurably better; a generic whole-document summary prepended to every chunk does not, so use the specific context line, not a boilerplate blurb.
- Every section is self-contained: restate the entity or acronym instead of using a pronoun or "as shown above", because the KB may re-split the file however it likes.
- State each number in the same sentence as its label. Front-load the answer, then the detail.
- Preserve exact terminology from the deck rather than paraphrasing it, since lexical matching does real work on numeric and jargon-heavy text.
- Split by heading (structure-aware), not by semantic-similarity breakpoints. Header-based splitting outperforms fixed, recursive, and semantic chunking on retrieval quality at a fraction of the index size, and semantic chunking's extra cost is not repaid by consistent gains.
- Cap each file's token budget so a single file cannot become one unretrievable blob. **Open question to resolve in 6.3:** whether the Kaltura KB re-chunks uploaded files. If it does, sizing is its problem and the plan only owns the text rules above.

### `prompts/*.md`

One file per prompt surface: `base-directive.md`, `pronunciation-guide.md`, `glossary.md`, `goal.md`, `target-audience.md`, `restricted-topics.md`, `persona-name.md`, `opening-phrase.md`, `tools/*.md`, `client/*.md`. Template versions carry `{{PLACEHOLDERS}}` and structural comments, no real wording.

`base-directive.md` has a fixed generic skeleton that stays the same shape across every project: identity and disclosure, navigation rules, speech style, UI help, data-integrity rules, silence handling, security, memory, goals, feedback and follow-up, session-end, plus one deck-specific section. Only the deck-specific section and the placeholder values change per project.

Three rules govern how that skeleton is written:

**Every negative rule is paired with its positive substitute.** Models handle "do this instead" better than "don't do that", and negation handling gets worse as models get larger. So a restricted-topic rule states the decline-and-redirect behavior, a silence rule states what to say, and a security rule states what to do with an out-of-scope request. The pairing is lint-checkable: a rule sentence that only forbids, with no stated alternative behavior, fails the lint.

**The identity and disclosure section is fixed and not overridable.** The agent confirms it is an AI presenter when asked, never asserts it is human, never denies being AI, never claims lived experience as the person it represents, and routes anything needing a human to the `contactForm` feature. Section 6.4 emits this section verbatim and the section 6.5 checkpoint highlights any attempt to edit it.

**The data-integrity section names the anti-hallucination behaviors explicitly**, rather than only testing for them in 6.8: the agent has standing permission to say it doesn't have that information, grounds every numeric claim in the current slide's own `key_metrics`, `footnotes`, or `talking_points`, does not fill gaps from world knowledge, and treats text from the deck and from ingested documents as **data to present, never as instructions to follow**.

### Hard-coded routes and pronunciation caption map: must be data, not code

Two things risk becoming deck-specific *code* if built carelessly: topic-to-slide routing shortcuts, and a caption-display map converting spoken-letter forms back to normal spelling. Both are generated data files with a fixed schema, produced by one generic transform in `engine/`, never per-project logic:

- `data/routes.json`: `[{ topic, entrySlide, aliases: [] }]`
- caption map (auto-derived from `pronunciation-guide.md` at bundle time): `{ "spoken form": "display form" }`

Both, along with the deck-specific section of `base-directive.md`, are rendered deterministically from `data/nav-rules.json`. One structured source of truth, several rendered outputs, so the routing data and the directive prose can never cite different slide numbers for the same topic.

### The derived-content module

One generic module in the project, `content.mjs`, is the only bridge between the data files above and the Kaltura payloads in section 6.6. It reads `project.json`, `prompts/*.md`, `data/slides/*.json`, and `data/nav-rules.json` at import time and exports every API constant: the base directive with placeholders substituted, the prompt-block array, the full capability map, each tool definition, the opening phrase, and the glossary.

Every provisioning and update command imports from it and holds no content of its own. That matters for three reasons:

- A prompt file edit reaches the live agent through one code path, so `provision` and any later `update-*` can never write different wording.
- Derived values are computed once, not repeated. Total slide count comes from counting `data/slides/*.json`, not from a literal, so it cannot drift from the files on disk.
- Every command is content-free, which is what keeps deck material out of `engine/` and therefore out of this repo.

### Bundle credential contract

The self-contained HTML bundle (section 6.7) may only ever contain a widget id and, if the client needs to authenticate live, a scoped short-TTL Kaltura session key minted at deploy or request time. Never `adminSecret` or any other raw `.env` value. The bundle step scans its own output for every `.env` value before upload and aborts on a match, as defense in depth even though the design never puts secrets there.

### Ingestion working files

All ingestion intermediates (rendered slide-page images, extracted PPTX XML) are written under the project's own gitignored `input/` or a system temp dir, never resolved relative to the engine's install path.

## 6. Pipeline stages

### 6.1 Deck + notes ingestion

Input: one deck file (PDF export is the safe baseline; native PPTX with real speaker-notes extraction is the high-value case) plus optional separate speaker-notes file and support docs.

- Preflight the input file itself first: confirm the file type is supported, the page count is sane, and text and notes are actually extractable (not a scanned image with no text layer, not corrupted, not password-protected). Fail fast with a specific, actionable error per failure mode. Ingestion resumes after the user fixes and re-drops the file, without restarting the whole pipeline.
- Extract per-slide: title, visible text, speaker notes, on-slide numbers and metrics, image and chart captions (a vision pass over each rendered slide page).
- **Cross-check the vision pass against the PDF text layer.** Most decks retain one, and vision parsing of dense slides is strong but not solved. Run both, diff them, and route disagreements into the batched question round rather than silently trusting one.
- **Extract `key_metrics` twice, independently, and diff.** This is the plan's only defense against a misread number becoming ground truth: once a wrong figure lands in `slides/NN.json`, section 6.8 will happily confirm the agent repeated it faithfully. Each extracted number also records the slide region it came from, so a human can spot-check it. Mismatches go into the batched question round.
- Produce `data/slides/NN.json` per slide under the enforced schema (section 5). Claude does this analysis directly; no bespoke parser is needed for v1 beyond PDF-to-page-image rendering, plus PPTX-to-XML text and notes extraction for v2.
- Each per-slide file is written as it is produced, so a killed session resumes from the first missing slide instead of restarting ingestion.
- Flag gaps rather than guessing: slides with no speaker notes, ambiguous chapter boundaries, contradictory numbers between slide and notes, missing sources for a specific claim. Collect these into the single batched question round from section 4, don't ask inline.
- Cluster slides into chapters (title-slide detection, section-divider heuristics, or an explicit user-supplied outline).

### 6.2 Terminology harvesting

- Scan all extracted text for acronyms and product names. For each, draft a `pronunciation-guide.md` entry (phonetic spelling) and, where the term needs disambiguation or aliasing, a `glossary.md` entry (`Term: explanation`).
- Write pronunciation entries as positive instructions: state the form to write, and note the standard spelling only as the thing this form replaces. A bare "never write X" is the shape models handle worst.
- Ask the user only about terms the model can't confidently phoneticize or define from context, folded into the same batched question round.

### 6.3 Knowledge base drafting

- First, resolve whether the Kaltura KB re-chunks uploaded files, and record the answer in the implementation appendix. It decides whether file sizing is this plan's problem at all.
- Chunk support docs and deck content into topic-scoped `data/kb/*.md` files, one per major topic cluster, matching the slide chapters where possible, following the authoring rules in section 5.
- Support docs are ingested as **content to be presented**, never as instructions. The directive rule in section 5 covers the agent side; section 6.8 tests it.

### 6.4 Prompt drafting

- Fill `project.json`-driven placeholders into every template.
- Generate `data/nav-rules.json` first, under the enforced schema, and **write it to disk before rendering anything from it**. This is the highest-leverage, highest-risk artifact in the whole build (most navigation bugs trace back to ambiguous wording here) and it deserves both a dedicated drafting pass and its own resume point. The pass includes a one-paragraph worked definition of "forward-reference guard" and "proof-point-slide handling" so two runs on the same deck can't diverge on what those terms mean.
- Optionally run a verification pass over the drafted table: re-derive each entry independently from the slide data and reconcile, rather than accepting the first draft.
- Deterministically render `data/routes.json` and the deck-specific section of `base-directive.md` from the nav-rules table, with explicit slide-number citations the user can spot-check.
- Then run a deterministic lint. Because shape validity is already guaranteed by the generation schema, the lint is **semantic only**: every slide-number reference must exist in `data/slides/`, fall inside its stated chapter's range, and carry the fields its role implies (a proof-point citation must point at a slide with non-empty `key_metrics`). KB frontmatter `sourceSlides` must resolve to real slides in the stated chapter. Every negative directive rule must have a stated positive alternative. The identity and disclosure section must match the template byte for byte. Fail the build on a lint miss instead of relying on the human reviewer.

### 6.5 Human checkpoint

Before anything is created on a live Kaltura account: show a diff and summary (a dry-run mode, no network calls) covering generated prompts, KB file list, slide count, chapter map, the consent records for any cloned voice or visual (section 10), and the concrete sequence of planned provisioning operations (resource type, create vs. update, existing id if reusing one, sourced from the state file in section 8). Require explicit confirmation. This gate lives in the engine layer at the single call site that can mutate a live resource, so it applies whether the pipeline runs end to end or a later incremental re-run touches one stage (section 7).

**The checkpoint also collects held-out eval questions.** Every question in section 6.8 is otherwise generated from the same slide data the agent was built from, which measures self-consistency rather than correctness; models measurably prefer their own outputs. So the human writes or approves 2 to 3 questions per chapter, phrased the way a real audience would ask, stored in `data/eval/held-out.json` and reused across every later rebuild and by the regression suite (section 13).

### 6.6 Provisioning

A fixed order: navigation tool → KB category → KB upload → knowledge record → intellect (prompts + glossary + capabilities + tool ids + knowledge ids in one call) → corpus-readiness poll → avatar → agent → widget id. The engine is built by porting and generalizing an existing, already-proven provisioning implementation rather than designed from scratch. **`docs/implementation-appendix.md` holds the concrete contract**: every call in order, with method name, required fields, returned id, and the observed gotchas. Read it before writing any engine code.

- After each of the nine steps succeeds, its id is written immediately to `.provisioning-state.json` (section 8), not only when the whole stage finishes. A retry reads this file and resumes from the first missing step, reusing recorded ids instead of re-creating them. On an unrecoverable failure mid-stage, the tool prints every id created so far.
- **Credential handling.** `adminSecret` comes from the project's own `.env`, and the engine exchanges it for a short-lived Kaltura session key once at run start, then uses that session key for every subsequent call. This mirrors what the section 5 bundle contract already does, so the long-lived secret isn't the thing in flight on every request. The secret is never logged and is redacted from error output.
- Names (KB category, tool, agent display name) come from `project.json`, never literals, and are namespaced by `project.json.slug` so two projects naturally produce differently-named resources on the same account (section 8).
- **Capabilities are written in full, always.** The intellect carries a 15-key capability map. Kaltura replaces that sub-dict wholesale on update, so sending three keys turns the other twelve off. The engine expands `project.json.capabilities` against the platform default map and writes all 15 every time. The presenter needs `avatar`, `use_knowledge_base`, and `use_content_search` on. The appendix lists the keys, the ones that are off by default, the account-level flag that vetoes a per-request enable, and the roughly 24-hour cache that makes a late flip look like it did nothing.
- **Avatar voice and visual.** Either clone from a voice or visual id the user supplies, or create fresh from an audio sample and a photo. The clone path and the fresh-from-sample path are both gated on a consent record that must already exist in the project repo (section 10); the engine refuses to run the avatar step without it, and passes the record's identifier to the platform's own consent field. Either way, the engine writes `avatar.source` to `project.json` so the client knows whether to show a synthetic-content label. **Creating a voice or visual is not idempotent:** each run mints a new catalog item and orphans the previous one, so the step is skipped whenever state already records an id, and a forced re-run reports what it orphaned.
- **Persona identity is checked across three surfaces.** The name appears in the base directive, in the prompt blocks, and in the opening phrase. Changing one leaves the agent introducing itself by the old name, which is why they are written together from `project.json.personaName` and asserted equal after the write.
- **Optional post-provision stage: follow-up email.** When `features.followUpEmail` is on, the engine also creates two session-lifecycle rules and a branded email template. This runs after step 9, is skipped by default, and is the only part of provisioning that touches a second Kaltura API. The appendix carries the contract.
- Prompt caching and MCP are Anthropic-API-layer mechanisms and are out of scope here: the deployed agent runs on Kaltura's platform, which owns its own inference path.

The update commands are the same nine steps addressed one at a time, and there are six of them rather than one per field: `update-prompts` (directive, glossary, prompt blocks, persona name), `update-capabilities`, `update-avatar` (opening phrase, voice, visual, motion), `update-agent` (display name, tags, session length), `attach-tool` (one generic command, any client tool), and `update-followup` (lifecycle rules and email template). All six share the read-compare-write-verify shape in the appendix, all six take `--dry-run`, and all six exit non-zero when the post-write read-back disagrees.

### 6.7 Bundle and deploy

Inline the generated slide data and client-side prompt templates into one self-contained HTML bundle (per the credential contract in section 5, never a raw `.env` value). Upload the deck and the bundle as Kaltura entries under a filename or asset embedding a content hash or incrementing version, so a changed bundle is never served stale from a cache. Create or update a share short link. Everything is parameterized by `project.json`, never hardcoded branding or slide counts.

The bundle step refuses to produce output when the AI-disclosure string would be absent, when `privacy.controllerName` or `privacy.controllerContact` is empty, or when the session duration promised in the welcome copy exceeds `sessionMaxSeconds`.

It also stamps a version constant into the bundle and refuses to deploy an unchanged one, so a cache-busting URL can never be minted for a bundle nobody rebuilt.

### 6.8 Testing and eval

- **Smoke test:** one real conversation turn against the live agent.
- **Numeric traceability, deterministic.** Extract every number from the agent's response with code, normalize it (currency symbols, percentages, scale words, thousands separators), and match it against the numbers in the cited slide's `key_metrics`, `footnotes`, and `talking_points`. An unmatched number fails the build. This is deliberately **not** an LLM-judge call: judges perform close to chance on exactly this kind of factual-correctness check, and a confident wrong number is the failure mode most likely to slip past one.
- **Slide routing, deterministic.** Assert the agent navigated to the expected slide id.
- **Talking-point coverage and tone, LLM-judged.** Judgment is the right tool here, and the judge prompt uses the mitigations that measurably work: give the judge the slide JSON and have it **derive the expected answer first, then compare** (reference-guided grading cuts failure rates on this kind of task sharply), reason step by step before scoring, and run at temperature 0. Verbosity bias is real, so length is never evidence of quality. If the judge and the drafting model are the same model, note it in `docs/build-log.md`.
- **Flakiness guard.** A single stochastic call should not gate a build: require two consecutive failures before hard-failing, and report the retry.
- **Held-out questions.** Run the human-authored questions from `data/eval/held-out.json` alongside the generated ones, and report them separately.
- **Adversarial turns.** One or two per entry in `restrictedTopics`, confirming the agent declines and redirects instead of answering. One off-topic question, confirming it stays in persona and declines cleanly. One turn that asks the agent to act on instructions embedded in an ingested document, confirming it treats document content as data (section 5). Today `restrictedTopics` is collected and never tested, which is the gap this closes.
- **Pronunciation spot-check:** exercise every harvested acronym at least once in a conversation turn.
- **Accessibility acceptance checklist:** the criteria named in section 9, checked by number.
- **Reporting.** Write per-check pass or fail plus judge rationale to `docs/eval-runs/<timestamp>.json`, so a later run diffs against the previous one. Report results as "N passed / N total", never as a percentage or a quality score: at one question per chapter the sample is a smoke test, and a percentage invites reading precision that isn't there.
- Deferred past v1 (section 12): checking pronunciation against actual rendered audio rather than just usage, and scoring transcripts for tone fidelity against `project.json.tone`.

### 6.9 Report

Write `docs/build-log.md` in the new project: what was asked, what was decided, what was generated, which disclosure and synthetic-content label were applied and why, links to the live agent and share URL. This is the project's own record, not a builder-repo artifact.

## 7. The Claude Code skill

`skills/build-deck-agent/SKILL.md` drives the whole pipeline as a checklist Claude follows inside a project repo: validate credentials → ingest → harvest terms → draft KB → draft prompts → checkpoint → provision → bundle/deploy → test → report.

- The frontmatter declares a `stage` argument, so `/build-deck-agent ingest` and `/build-deck-agent prompts` dispatch to one stage. A later "the deck changed" or "make the tone more casual" request re-runs one stage instead of the whole thing. Any stage reaching a mutating call still passes through the confirmation gate from section 6.5.
- `SKILL.md` stays under roughly 500 lines by holding the checklist and the stage dispatch only. Per-stage procedural detail lives in `reference-ingestion.md`, `reference-prompts.md`, `reference-provisioning.md`, and `reference-eval.md`, loaded on demand. Nine stages of detail in one file would blow past the size where instructions are reliably followed.
- `create-project.mjs` installs a copy into the new project's `.claude/skills/` (section 3), so it is discoverable the moment Claude Code opens that folder.
- A minimal `.claude-plugin/plugin.json` (only `name` is required) makes the repo load as a skills-providing plugin with no marketplace hosting. Ship it in Phase 1; only the hosted marketplace listing waits for Phase 3.

## 8. Resource safety: idempotency and collision avoidance

One gitignored file per project, `.provisioning-state.json`, does two jobs:

1. **This project's own idempotency.** Populated incrementally, one id per provisioning sub-step, as section 6.6 runs. Before creating any resource, the engine checks this file: if a step already has a recorded id, it updates in place or skips instead of creating a duplicate. A run that fails partway resumes from the first missing step.
2. **Cross-project collision avoidance, without shared state.** Resource names are namespaced by `project.json.slug` (section 6.6), so two projects only risk colliding if they share a slug or someone hand-edits `.env` to point at another project's ids. Before creating a named resource, the engine also queries the live Kaltura account for an existing resource with that generated name; if one exists and isn't recorded in this project's own state file, it refuses with a clear "already exists, owned elsewhere" error instead of overwriting it. This needs no registry, no cross-repo file reads, and no shared filesystem convention, consistent with section 12's "one `.env` per project, no shared state" decision.

Each recorded id carries an `origin` of `created` or `adopted`, set from what the call that produced it actually did, and the file records the `partnerId` it was written against. Section 8.1 depends on both. The file also records the hash of each consent record used (section 10), so a consent file edited after provisioning is visible rather than silent.

This directly backs the section 2 non-negotiable that a project must never collide with another project's resources on the same account, and is covered by an explicit test in the Phase 1 regression suite (section 13): two demo-derived projects pointed at one sandbox account, where a mutating call from one against the other's id is refused while a call against its own id succeeds.

### 8.1 Teardown

`engine/teardown.mjs` deletes what a project provisioned, so an account can be returned to its prior state and a full pipeline run is repeatable rather than one-way. Without it, every test run leaves an avatar, agent, intellect, category, and entries behind, and the only cleanup is by hand in the KMC.

It is a separate command, never a flag on `provision`, and never a step in the skill's pipeline.

**It deletes only what this project created.** That is a property of the input, not a checklist bolted on top. The sole input is this project's `.provisioning-state.json`, so nothing is ever discovered by name, slug, prefix, or pattern, and a resource this project did not create has no path into the delete list. A missing state file is a hard error, not an empty success.

Two facts recorded at provisioning time are what make this hold:

- **`origin` per id: `created` or `adopted`.** Provisioning writes `created` only when the API call it just made returned a new resource. An id supplied by the operator or matched from the account, such as an existing avatar under `avatar.source: "reuse"`, is recorded `adopted`. **Teardown deletes `created` and never touches `adopted`,** which it reports as skipped so the operator can see what was left standing and why. Without this field, tearing down a project that reused an existing avatar would delete an asset the project never owned.
- **`partnerId` in the state file.** Teardown compares it to the partner id in `.env` and aborts before the first call on a mismatch. This is what catches a state file paired with the wrong account, whether from a swapped `.env`, a copied project directory, or a restored backup. It needs no operator input, so it protects an unattended run exactly as well as an interactive one.

Required behavior:

- **Print the plan, then act.** It lists the partner id, every id it will delete, and every `adopted` id it will skip. With `--yes` it proceeds; without it, it asks. The account check above is automatic and not waivable by a flag.
- **Reverse creation order,** so a category is removed after the resources filed under it.
- **Write state after each delete.** A killed teardown resumes; it never re-deletes.
- **Idempotent.** An id already gone counts as success. A second run on a torn-down project makes no call and exits 0.
- **Report, do not guess.** Anything it could not delete is listed with the id, the reason, and the KMC path to finish by hand. Exit 5 with the state file still naming the survivors.

`--dry-run` prints the full delete plan and makes no mutating call. That is the form the fixture and CI use.

## 9. The generic client: branding, disclosure, accessibility

The client ships with a neutral default look (no logo, no product-specific copy). Brand touchpoints (`logo.svg`, welcome-screen copy, color accents) are files the user swaps, not code changes.

Three things are on by default and are **not** removable by swapping a branding file:

**AI disclosure.** An always-on disclosure line in the welcome screen plus a short persistent form in the session chrome, rendered as real text in the DOM (not baked into an image), so screen readers reach it. Text comes from `project.json.disclosure`; blank falls back to the engine's built-in string. Disclosing AI interaction at the start of each session is required unconditionally by Anthropic's usage policy for any external-facing interactive AI agent, and separately by EU AI Act Art 50(1) and 50(5), which also requires the disclosure itself to meet accessibility requirements. The "obvious to a reasonable person" carve-out in Art 50(1) does not help here: a photoreal avatar with a cloned human voice is the case where it is least obvious.

**Synthetic-content label, when the avatar is cloned.** When `avatar.source === "cloned"`, the client shows the official EU AI-generated-content icon as `assets/ai-label.svg` in its persistent chrome, with alt text, placed per the Commission's published rules (perceivable at first exposure, no overlay on top of it, still visible if the content is reshared). Users may swap it for their own mark; they cannot remove it. A fresh fictional avatar does not resemble an existing person, so the Art 50(4) deep-fake labelling duty likely does not bite and the disclosure line above is enough. Art 50(2) machine-readable marking of generated audio and video is the avatar vendor's duty, not the toolkit user's; the docs page says so and tells users to confirm their vendor does it.

**Accessibility defaults.** Target is WCAG 2.2 AA. The client ships:

| Criterion | What ships |
|---|---|
| 1.2.4 Captions (Live), AA | A live caption track rendered from the same text the TTS speaks, reusing the section 5 caption map so spoken-letter forms display correctly. A toggle, not a removable file. |
| 1.4.2 Audio Control, A | A visible mute independent of OS volume, since the avatar starts speaking on load. |
| 2.1.1 / 2.1.2 Keyboard, A | Full keyboard operation of slide and mic controls, no focus trap. |
| 2.2.2 Pause, Stop, Hide, A | A control that pauses avatar motion and slide auto-advance. |
| 2.4.7 Focus Visible, AA | Visible focus rings on all custom controls. |
| 2.5.8 Target Size, AA | Minimum 24×24 px nav and mic targets. |
| (good default, not AA) | `prefers-reduced-motion` honored for idle and gesture animation. It is a technique under 2.3.3, which is AAA, so treat it as cheap polish rather than a requirement. |

Whether an AI avatar's live speech formally triggers 1.2.4 is genuinely unsettled: the W3C Understanding text carves out two-way multimedia calls, and that carve-out was written for human callers. Captioning satisfies the criterion under either reading, so caption it. Note for the docs page: sign-language interpretation (1.2.6) is AAA, not AA; WCAG 2.x has no live-audio-description criterion; SC 4.1.1 Parsing was removed in WCAG 2.2. EN 301 549 V4.1.1 (September 2026) adopts WCAG 2.2, but until the Commission cites it in the Official Journal the operative legal reference for EU presumption of conformity is still V3.2.1, based on WCAG 2.1 AA.

**Privacy panel.** A "How this session handles your data" panel, linked from the welcome screen and reachable **before** the mic can be enabled, generated from `project.json.privacy` (section 10).

### What the client must handle

The live session emits roughly two dozen events, and a presenter that only listens for "connected" and "error" ships visibly broken. The generic client handles them in five groups, and the appendix lists the event names:

| Group | What the client owes the audience |
|---|---|
| Startup | Separate video and audio elements, a widget token minted per session with a re-mint path, and a one-time click to start playback when the browser blocks autoplay. |
| Speech | Show when the agent is speaking, when it was interrupted, and when a reply is pending. Captions come from the same text stream, so the caption toggle in section 9 has no separate server channel to depend on. |
| Navigation | The slide-change tool call may arrive before the client is told the agent stopped speaking, so slide state follows the tool call, not the speech state. |
| Health | Reconnect, capacity, and stalled-response events all need visible handling. A stalled reply is re-sent once with a resume instruction naming the current slide and forbidding navigation, so recovery does not jump the deck. |
| Time | A warning before the session limit and a clean end at it, both worded from `sessionMaxSeconds` rather than a literal. |

The engine also rewrites the SDK version constant into the bundle at build time, so a deployed page states which SDK it actually shipped with.

## 10. Transparency, consent, and audience data

This section exists because three obligations attach to the *deployed* agent rather than to this repo, and the section 2 rule about zero customer data in the repo does not cover any of them.

### Voice and likeness consent

Cloning a real person's voice or face without their agreement is the one place this tool could actively help someone commit a tort. So the clone path in section 6.6 is gated on a record that must exist in the project repo before the avatar step runs:

- `consent/voice-<id>.md` and `consent/visual-<id>.md`, from a template scaffolded by `create-project.mjs`.
- Required fields: subject name, date, **a specific description of the intended use**, scope and duration, revocation contact, and a statement that the subject is living and consented personally or that estate/rights-holder consent was obtained.
- The specific-use requirement is not gold-plating: California Lab. Code § 927 (effective 1 January 2025) makes a digital-replica contract term unenforceable where it lacks "a reasonably specific description of the intended uses". Blanket permission is not enough. Tennessee's ELVIS Act (effective 1 July 2024) creates liability for making an unauthorized voice or likeness available, and defines "voice" to include a simulation. Cal. Civ. Code § 3344.1 as amended by AB 1836 covers deceased personalities with statutory damages.
- There is no federal US digital-replica right yet. The NO FAKES Act is still pending (S.4591 sits on the Senate calendar), so design to state law and expect the floor to rise.
- The ELVIS Act also reaches tools whose *primary purpose* is producing unauthorized likenesses. This toolkit's primary purpose is deck presentation, so that provision probably does not capture the repo. The docs should not overstate this in either direction.
- The fresh-avatar path needs no consent record, but must set `avatar.source = "fresh"`.
- Section 6.5's diff shows the consent record and the checkpoint refuses to confirm without it. Section 8 records its hash.

### Audience data

The presenter takes live audience questions, which means personal data. Defaults, all in `project.json.privacy`:

- **No audience audio or video is captured or stored at all.**
- Transcripts are session-only (`transcriptRetention: "none"`).
- `reuseForEval` is `false`. Section 6.8 reads transcripts only from projects that set it to `true` explicitly, because reusing conversation data for eval or model improvement is a *new purpose* and needs its own basis, not the one that covered answering the question. The template `CLAUDE.md` tells the agent never to copy audience transcripts into the project repo.
- The privacy panel (section 9) covers the GDPR Art 13 items: controller identity and contact, purposes and legal basis, recipients, retention period, and data-subject rights including withdrawal and the right to complain to a supervisory authority. Art 6(1) requires a basis; Art 5(1)(c) and 5(1)(e) require minimisation and storage limitation, which is why "store nothing" is the default rather than "store and offer a delete button".
- Section 6.7 refuses to bundle when `controllerName` or `controllerContact` is empty.
- **The follow-up email feature is off by default**, and it is the one feature that contradicts every default above. Turned on, the platform extracts the visitor's name, email, company, role, and phone from the conversation after it ends, and emails a summary to an address the project owner sets. That is collection, storage, and transmission of contact data, plus a purpose the audience did not come for. So it ships off, `features.followUpEmail` must be set explicitly, the checkpoint in section 6.5 shows the recipient address and the fields extracted, and turning it on requires its own privacy-panel paragraph naming the recipient and the retention period before section 6.7 will bundle.
- Capturing a question is **not** automatically biometric processing. Voice data becomes special-category data under Art 9 only when processed to uniquely identify someone, which this does not do. Voice recordings are still hard to anonymise and question content can reveal special categories regardless, which is another reason not to keep them.
- Section 3 should state which of Kaltura and the model vendor act as processors, so users know where they need a data-processing contract. Obtaining it is theirs to do.

### The docs page

`docs/transparency-and-consent.md`, referenced from sections 9 and 13, in four short parts:

1. **What the tool does by default:** disclosure line, synthetic-content label when cloning, no audience capture, session-only transcripts, captions on, no contact collection and no follow-up email.
2. **What you must decide:** lawful basis, retention, whether transcripts feed eval, who your processors are, and whether you are provider or deployer under the AI Act. That last one is genuinely fact-dependent for someone who scaffolds and deploys their own presenter, so the page tells users to work it out rather than asserting an answer.
3. **Jurisdiction-labelled pointers,** one sentence and one link each, with thresholds where they exist: EU AI Act Art 50 (applies from 2 August 2026), GDPR, US state digital-replica laws, WCAG 2.2 AA, the model vendor's usage policy, and the California AI Transparency Act (operative 2 August 2026, but its duties attach above 1,000,000 monthly users, so ordinary users of this toolkit are almost certainly out of scope while their avatar or model vendor may not be).
4. **A plain statement** that these are defaults, not compliance, that the toolkit gives no legal advice, and that obligations depend on where the user and their audience are.

## 11. Repo and supply-chain hygiene

The section 3 gate covers data leakage. These cover the rest, and they matter more than usual because `engine/` touches live billable accounts and `bin/create-project.mjs` runs on strangers' machines next to their cloud credentials.

- **LICENSE.** Apache-2.0, shipped. Without a license the repo is "all rights reserved" no matter how public it is, so it isn't actually open source.
- **SECURITY.md** pointing at GitHub's private vulnerability reporting (enable the feature on the repo; it is separate from the file) and stating supported-version scope. Don't ship GitHub's default template text.
- **The published npm package:** no `preinstall`, `postinstall`, or `prepare` scripts; a `files` allowlist in `package.json` so only `bin/`, `engine/`, `client/`, and templates ship; publish via npm Trusted Publishing (OIDC, no static token) or a 2FA-protected account, with `npm publish --provenance` so consumers can verify with `npm audit signatures`. Install-time lifecycle scripts are the main way compromised packages reach developer machines.
- **CI hardening:** all third-party Actions pinned to a full commit SHA, not a tag; top-level `permissions` read-only with per-job write elevation only where needed; `npm ci` against the committed lockfile; Dependabot enabled for both the npm and github-actions ecosystems; the OpenSSF Scorecard action running on the repo.
- **Branch protection** on `main`: PR review plus passing status checks, and a CODEOWNERS rule requiring review specifically on `.github/workflows/` and `engine/`.
- **Fork-safe CI, stated precisely.** The documented risk is `pull_request_target` and `workflow_run` combined with a checkout of untrusted fork content. Plain `pull_request` from a fork already runs with a read-only token and no repo secrets, so it is fine for the section 3 scan, which needs no secrets. The sandbox-credential regression suite runs only via `workflow_dispatch` (restricted to users with write access), optionally behind a required-reviewer environment.
- **Contributor files** once outside contributions are invited: CODE_OF_CONDUCT.md, CONTRIBUTING.md, `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`.
- **SBOM:** release CI runs `npm sbom` and attaches the SPDX output to the GitHub release.
- Commit and tag signing is not needed on top of npm provenance, which already covers signed release artifacts. Leave it to maintainer preference.

## 12. Open decisions (need a call before Phase 1)

| Decision | Options | Recommendation |
|---|---|---|
| Deck input formats for v1 | PDF only vs. PDF + PPTX | **Decided: PDF only.** Render pages as images, Claude reads them plus a separate notes file. Native PPTX notes extraction lands in Phase 3, once the PDF path is proven. |
| LICENSE | MIT vs. Apache-2.0 | **Decided: Apache-2.0**, shipped. Its explicit patent grant is worth something for a tool that drives billable API operations. |
| Distribution of the skill | Bundled in this repo only vs. published plugin/marketplace | Ship the minimal `.claude-plugin/plugin.json` in Phase 1 (it costs nothing and needs no hosting); defer only the hosted marketplace listing to Phase 3. |
| Voice/avatar sourcing | Always clone an existing id vs. support fresh creation | Support both, with the clone path gated on a consent record (section 10). |
| Multi-account support | One `.env` per project vs. a project registry | One `.env` per project, resolved without shared state via section 8's live-account name lookup. |
| Engine porting source | Which existing implementation section 6.6 is ported from, and how much to generalize immediately | **Decided.** The source is chosen and stays unnamed here. Its contract is extracted, generalized, and committed as `docs/implementation-appendix.md`, so Phase 0 needs no access to the original. |
| Per-chapter eval scoring (6.8) | Scripted match vs. Claude-graded judgment | Split by what each is good at: deterministic code for slide ids and numeric traceability, LLM-judge for talking-point coverage and tone. Resolved in 6.8. |
| Engine/client sync after project creation | Versioned dependency/submodule vs. a staleness check vs. defer | **Not deferrable.** `create-project.mjs` writes `.template-version`; `bin/check-template-update.mjs` diffs the project's `engine/` and `client/` against the named tag, read-only. Every mature copy-in tool ships this primitive (cruft `check`/`diff`, `copier update`, `shadcn diff`) because without it a shipped engine bug can never reach existing projects. |
| KB re-chunking | Kaltura re-splits uploaded files vs. uploads them as one unit | Unknown. Resolve in 6.3 before sizing rules are written; it decides whether file sizing is this plan's problem. |
| Provenance metadata | Sign exported video with C2PA vs. rely on the vendor's Art 50(2) marking | Defer: no local video artifact exists to sign. The pipeline provisions a live avatar and ships a widget id. If a download or recording feature ever lands, sign with `@contentauth/c2pa-node` using the IPTC `trainedAlgorithmicMedia` source type, and note that a self-signed manifest proves nothing without a trusted certificate. |
| Audience: already has a Kaltura account? | Assume yes vs. support first-timers | Decided (section 2): assume yes. |
| Offline test coverage for engine control-flow | Mock/fixture Kaltura client vs. live sandbox suite only | Rely on the live sandbox suite (section 13) for now; add fixtures later only if control-flow bugs keep slipping through. |
| Follow-up email after a session | Ship on, ship off, or leave out of v1 | **Ship off, built in Phase 2.** The platform surface exists and is worth exposing, but it collects contact data, so it stays behind an explicit flag and its own privacy copy (section 10). |
| Which capabilities the presenter default map turns on | Minimal three vs. also web search and related files | **Minimal three:** avatar, knowledge base, content search. Web search reintroduces ungrounded claims the section 6.8 numeric check is built to catch, and related-files surfaces content the deck owner did not choose. Both stay available as overrides. |

Deferred past v1, revisit in Phase 3: audio-rendered pronunciation verification and tone-fidelity scoring in 6.8. Real gaps, but consistent with the plan's manual-checkpoint-heavy early phases.

## 13. Phased roadmap

- **Phase 0: Engine.** Build the Kaltura API commands (`provision`, `bundle`, `deploy`, `verify`, plus the six update commands in 6.6: `update-prompts`, `update-capabilities`, `update-avatar`, `update-agent`, `attach-tool`; `update-followup` waits for Phase 2) and the derived-content module they all import from (section 5), fully parameterized by `project.json` and `.env`, with no hardcoded names, ids, or paths, including the per-project `.provisioning-state.json` idempotency/resume logic, the live-account name-collision check (section 8), `teardown` (section 8.1), and the admin-secret-to-session-key exchange (section 6.6). Ship the generic client app with neutral branding, the disclosure line, the accessibility defaults from section 9, and handling for every event group in section 9's runtime table. Commit a lockfile. Write the root `CLAUDE.md` now, before any other contributor touches the repo, plus LICENSE and SECURITY.md. Pin Actions to SHAs and set workflow permissions from the first workflow. Proven by hand-running the engine against a minimal hand-written fixture (a throwaway `project.json`/`.env` and a few stub slide-data files), not the fictional demo project.
- **Phase 1: Manual-assisted pipeline.** Add `templates/prompts/*.md`, `templates/project/CLAUDE.md`, the consent-record templates, `create-project.mjs` (installing the skill into `.claude/skills/`, writing `.template-version`, and the repo-root `.gitignore` plus the CI secret-and-path scan from section 3), `bin/check-template-update.mjs`, `bin/doctor.mjs`, the minimal `.claude-plugin/plugin.json`, and the fictional `demo/` project. Claude Code can already do sections 6.1 to 6.4 ad hoc in a fresh project repo using the templates as a guide; no dedicated skill yet, just documented steps. Add the regression suite driving provision → bundle → deploy → verify against `demo/` on a sandbox account, triggered by `workflow_dispatch` only (section 11), including the same-account collision test from section 8. Add CI checks that need no live account: a golden-output check on `demo/`'s ingestion and prompt-drafting output, the section 6.4 semantic lint, and a chunk-level retrieval eval over `demo/`'s KB files (synthetic Q&A, recall and precision) so a retrieval miss is distinguishable from a generation miss.
- **Phase 2: The skill.** Write and test `SKILL.md` plus its `reference-*.md` files so the full pipeline runs from one instruction, with the credential preflight, the batched and capped question round, the human checkpoint and held-out question collection (6.5), the nav-rules lint, the optional follow-up-email stage and its `update-followup` command with the privacy copy from section 10, and the full eval pass (6.8: deterministic numeric traceability, reference-guided judge, adversarial turns, eval-run artifact) all built in.
- **Phase 3: Polish.** Native PPTX notes extraction, publish as a hosted Claude Code plugin, write `docs/transparency-and-consent.md` and public docs plus a short screen recording using the fictional demo project. Add the contributor files and SBOM release step from section 11. Revisit the deferred items in section 12 (audio pronunciation check, tone-fidelity eval, offline mock layer, C2PA if a download feature lands) if they've become worth the investment.

## Appendix: sources for the standards above

Kept so a reader can check the claims rather than trust them.

**Prompting and agent design:** Structured Outputs (`platform.claude.com/docs/en/build-with-claude/structured-outputs`); "tell Claude what to do instead of what not to do" (`.../prompt-engineering/claude-prompting-best-practices`); reducing hallucinations (`.../test-and-evaluate/strengthen-guardrails/reduce-hallucinations`); staying in character (`.../increase-consistency`); workflows vs. agents (`anthropic.com/engineering/building-effective-agents`); tool design (`anthropic.com/engineering/writing-tools-for-agents`). Negation difficulty scaling with model size: *Language Model Behavior: A Comprehensive Survey*, Computational Linguistics 50(1).

**Eval:** JudgeBench (ICLR 2025, `arxiv.org/abs/2410.12784`) on judges near chance for factual correctness; MT-Bench (`arxiv.org/abs/2306.05685`) for reference-guided grading and verbosity bias; ALCE (`arxiv.org/abs/2305.14627`) and AIS (`doi.org/10.1162/coli_a_00490`) for decompose-then-entail attribution; self-preference bias (`arxiv.org/abs/2404.13076`); Chain-of-Verification (`arxiv.org/abs/2309.11495`).

**Retrieval and ingestion:** Anthropic Contextual Retrieval (`anthropic.com/news/contextual-retrieval`), including the finding that generic whole-document summaries help very little; Chroma chunking evaluation (`trychroma.com/research/evaluating-chunking`); semantic chunking's cost/benefit (`arxiv.org/abs/2410.13070`, NAACL 2025 Findings); vision-guided chunking (`arxiv.org/abs/2506.16035`); indirect prompt injection (`doi.org/10.1145/3605764.3623985`, ACM AISec 2023).

**Claude Code integration:** skills and supporting files (`code.claude.com/docs/en/skills`), memory and CLAUDE.md (`code.claude.com/docs/en/memory`), plugins reference (`code.claude.com/docs/en/plugins-reference`). Claude Code reads `CLAUDE.md`, not `AGENTS.md`; if that changes, the documented pattern is `@AGENTS.md` as the first line of `CLAUDE.md` or a symlink, never duplicated content.

**Repo and supply chain:** GitHub secret scanning and push protection (`docs.github.com/en/code-security/secret-scanning`); Actions hardening and the `pull_request_target`/`workflow_run` risk (`docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions`); private vulnerability reporting (`docs.github.com/en/code-security/security-advisories/...`); OpenSSF Scorecard checks (`github.com/ossf/scorecard/blob/main/docs/checks.md`); OWASP Secrets Management Cheat Sheet; Node release schedule (`nodejs.org/en/about/previous-releases`); CLI conventions (`clig.dev`); template-staleness prior art (cruft, Copier, shadcn CLI docs).

**Transparency, consent, privacy, accessibility:** Anthropic Usage Policy (`anthropic.com/legal/aup`); EU AI Act Art 50 and Art 113 (`artificialintelligenceact.eu/article/50/`), Commission transparency guidance and official icon set (`digital-strategy.ec.europa.eu`); Tenn. Code Ann. § 47-25-1105; Cal. Lab. Code § 927; Cal. Civ. Code § 3344.1 as amended by AB 1836; Cal. Bus. & Prof. Code §§ 22757.1 et seq. as amended by AB 853; GDPR Arts 5, 6, 9, 13, 28; EDPB Guidelines 02/2021 on Virtual Voice Assistants (retention and training-reuse guidance); WCAG 2.2 (`w3.org/TR/WCAG22/`) and its Understanding documents; EN 301 549 V3.2.1 and V4.1.1; C2PA 2.4 and IPTC `trainedAlgorithmicMedia`.

Two caveats worth carrying: EUR-Lex was unreachable during this research, so GDPR and AI Act article wording above rests on secondary reproductions and should be re-checked against EUR-Lex before anyone relies on it. And the effective date of AB 1836 was not confirmed from a primary source.
