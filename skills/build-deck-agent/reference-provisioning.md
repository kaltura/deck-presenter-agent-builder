# Reference: provisioning and updates (PLAN.md 6.6)

Loaded by the `provision` stage of `SKILL.md`. The concrete Kaltura call contract (method names, required fields, returned ids, gotchas) lives alongside this file, in `reference-implementation-appendix.md`, copied in at scaffold time from the deck-presenter-agent-builder toolkit's `docs/implementation-appendix.md`. Read it before troubleshooting a provisioning failure. Nothing below duplicates that contract; this file is about which command to run when.

## First run: `scripts/provision.mjs`

One command, nine steps, fixed order: navigation tool → optional contact/end-session tools → optional knowledge base (category, upload, record) → intellect (prompts + glossary + capabilities + tool ids + knowledge ids in one call) → corpus-readiness poll → avatar → agent → widget id.

- Resumable: after each step succeeds, its id is written immediately to `.provisioning-state.json`. A retry after a failure resumes from the first missing step, reusing recorded ids instead of re-creating them.
- Run once without `--yes` to see the plan (resource type, create vs. update, existing id if reusing one). Only re-run with `--yes` after confirming it.
- `--force` re-provisions even when a widget id is already recorded. Creating a voice or visual is **not idempotent** — a forced re-run mints a new catalog item and orphans the previous one, and reports what it orphaned. Don't pass `--force` casually.

## Later change: which update command owns which field

Once a project is provisioned, a narrower change goes through the matching update command instead of a full re-provision. All six share a read-compare-write-verify shape, all take `--dry-run`, and all exit non-zero if the post-write read-back disagrees with what was intended:

| Command | Owns |
|---|---|
| `scripts/update-prompts.mjs` | Base directive, glossary, prompt blocks, persona name |
| `scripts/update-capabilities.mjs` | The 15-key capability map, `allow_client_variables` |
| `scripts/update-avatar.mjs` | Opening phrase (voice/visual/motion have no `project.json` field yet — see the gap note below) |
| `scripts/update-agent.mjs` | Display name, admin tags, max conversation length |
| `scripts/attach-tool.mjs` | Any client tool (navigation, contact, end-session): creates one with no recorded id, updates config-only for one that already has an id |
| `scripts/update-followup.mjs` | Session-lifecycle rules and the follow-up email template, only relevant when `features.followUpEmail` is on |

**Gap to flag, not silently work around:** `update-avatar.mjs` only syncs the opening phrase today. `project.json` has no field yet for voice, visual, or motion-control overrides, so a request to change the avatar's voice or visual needs a manual call outside this pipeline, or a `project.json` schema extension plus an `update-avatar.mjs` change — note it in `docs/build-log.md` rather than inventing an ad hoc field.

## Capabilities are written in full, always

Kaltura replaces the intellect's whole capability sub-dict on update, so writing three keys silently turns the other twelve off. `content.mjs` expands `project.json.capabilities` (a partial override) against the platform default map before every write. Never call the SDK's capability-setting method with a hand-built partial object; always go through `content.mjs`'s `CAPABILITIES` export via the update or provision command.

## Avatar voice, visual, and consent

The clone path and the fresh-from-sample path are both gated on a consent record already existing in `consent/` (see `consent/README.md` in this project). `scripts/provision.mjs` refuses to run the avatar step without a matching, filled-in record when `project.json.avatar.source` implies cloning. `avatar.source: "fresh"` needs no record. Never bypass this gate by hand-crafting a call that skips the consent check; if a consent record is missing, stop and ask the human for it.

## Persona identity spans three fields

The persona's name appears in the base directive, the prompt blocks, and the opening phrase. `content.mjs` derives all three from `project.json.personaName` and the provisioning/update commands assert them equal after a write. If you ever see them drift, the fix is in `prompts/persona-name.md` or `project.json`, never a one-off patch to only one of the three live fields.

## Credential handling

`adminSecret` comes from this project's own `.env` and is exchanged once for a short-lived session key at the start of each command (`scripts/lib/kaltura.mjs`). Never log `adminSecret` or paste it into a report, a commit message, or `docs/build-log.md`. If a command's error output ever appears to include it, redact it before showing the human and flag it as a bug in the engine's error handling.

## Same-account collision

Every named resource (KB category, tool, agent display name) is namespaced by `project.json.slug`. Before creating one, the engine also checks the live account for an existing resource with that generated name; if one exists and this project's own state file doesn't already own it, provisioning refuses with an "already exists, owned elsewhere" error instead of overwriting it. If you hit this, it means either the slug collided with another project on the same Kaltura account, or `.env` points at the wrong account — don't rename around it without checking which.
