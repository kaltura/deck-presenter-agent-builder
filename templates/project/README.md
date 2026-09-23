# Deck presenter agent

One deck's live AI presenter, scaffolded by `deck-presenter-agent-builder`. Build it
by opening this folder in Claude Code and running `/build-deck-agent`. `CLAUDE.md`
lists where each file lives and the rules for working here.

## Making a change

Edit the source, run the stage, then push only what changed. Every command below
prints its plan and asks before it touches the live account. Pass `--dry-run` to
see the plan only.

| You want to change | Stage | Then run |
|---|---|---|
| Tone, wording, opening line, restricted topics | `prompts` | `node scripts/update-prompts.mjs --project .` |
| A slide's content or talking points | `ingest` | Re-run `prompts` if the deck-specific rules cite that slide, then `update-prompts` |
| Where the agent goes for a topic | Edit `data/nav-rules.json`, then `prompts` | `node scripts/update-prompts.mjs --project .` |
| How a term is pronounced | Edit `prompts/pronunciation-guide.md` | `node scripts/update-prompts.mjs --project .`, then bundle and deploy (the captions use it too) |
| Knowledge-base content | Edit `data/kb/*.md` | `node scripts/update-kb.mjs --project .` |
| Turn on `features.knowledgeBase` after the first provision | Edit `project.json` | `node scripts/attach-knowledge-base.mjs --project .` |
| Voice, visual, or voice speed | Edit `project.json` `avatar` | `node scripts/update-avatar.mjs --project .` |
| Raw capability flags in `project.json.capabilities` | none | `node scripts/update-capabilities.mjs --project .` |
| Turn on `features.contactForm` or `features.endSessionTool` | Edit `project.json` | `node scripts/attach-tool.mjs --project .` |
| Turn on `features.followUpEmail` | Edit `project.json` | `node scripts/update-followup.mjs --project .` |
| Turn on `features.feedback` | Edit `project.json` | `node scripts/update-feedback.mjs --project .` |
| Agent name, tags, session length | Edit `project.json` | `node scripts/update-agent.mjs --project .` |
| The presenter page (client, branding) | Edit `client/` or `project.json.branding` | Bump `VERSION` in `client/app.js`, then bundle and deploy |

Bundle and deploy:

```sh
node scripts/bundle.mjs --project .
node scripts/deploy.mjs --project .
```

Account config changes (prompts, KB, avatar, capabilities) go live on the next
session. Page changes go live only after `deploy`. `deploy` refuses to run
when `VERSION` did not change, because the CDN caches each URL for months.

## Running the eval

```sh
node scripts/eval.mjs --project .              # full run
node scripts/eval.mjs --project . --skip-judge # deterministic checks only
```

Each run writes `docs/eval-runs/<timestamp>.json`, scored as "N passed / N total".
A full run creates a temporary judge intellect on the account and deletes it at the end.

To run it every night in GitHub Actions (`.github/workflows/nightly-eval.yml`):

| Set in repo settings | Kind | Value |
|---|---|---|
| `KALTURA_PARTNER_ID` | Secret | Your partner id |
| `KALTURA_ADMIN_SECRET` | Secret | Your admin secret |
| `KALTURA_CONFIG_ID` | Variable | `steps.configId.value` from `.provisioning-state.json` |
| `EVAL_NOTIFY_USER` | Variable, optional | A GitHub username. Each report is posted to an `eval-report` issue and mentions this user. |

Until the secrets and `KALTURA_CONFIG_ID` are set, the workflow skips and stays green.

## Checking startup timing

```sh
node scripts/bundle.mjs --project .
node scripts/verify-startup-timing.mjs --project . --runs 3
```

It changes no account config, but each run starts one real avatar session.
Run `npx playwright install chromium` once first. It opens `dist.html` in
headless Chromium, clicks through to the greeting, and checks each startup step against its budget using the median of
the runs. Results go to `docs/timing-runs/`.

To run it every night (`.github/workflows/nightly-timing.yml`), set the same two
secrets plus a `KALTURA_WIDGET_ID` variable (`steps.widgetId.value` from
`.provisioning-state.json`). The widget id is public, since it is in the deployed
page.

## Removing everything

```sh
node scripts/teardown.mjs --project .
```

Deletes only what this project created, as recorded in `.provisioning-state.json`.
