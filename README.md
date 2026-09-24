# deck-presenter-agent-builder

Turn a deck into a live AI presenter agent. Drop in a PDF and speaker notes, answer a few questions, get a deployed page where an avatar presents your slides and answers questions about them.

What it does that you'd otherwise have to do by hand:

- Reads every slide twice, a text pass and a vision pass, and cross-checks every number between them, so a misread figure never becomes the agent's ground truth.
- Drafts and lints the navigation rules, prompts, and knowledge base against your deck's actual slide numbers, so the agent can't be told to cite a slide that doesn't exist.
- Builds an eval suite before anything goes live: deterministic checks for numbers and slide routing, LLM-judged checks for tone and coverage, plus held-out questions you write yourself.

Built on Kaltura's agent platform. Needs a Kaltura account, not API knowledge.

Want to see a finished example before you start? `demo/` is a full worked project (a fictional deck, prompts, and knowledge base) checked into this repo end to end.

## Quickstart

Needs: Node 22+, [Claude Code](https://claude.com/claude-code), a Kaltura partner id and admin secret (KMC → Settings → Integration Settings), git access to this repo.

**1. Scaffold a project and set credentials:**

```sh
npx --yes --prefer-online github:kaltura/deck-presenter-agent-builder create my-agentic-deck
cd my-agentic-deck
cp .env.example .env
```

Paste your partner id and admin secret into `.env`. Setup done, under a minute.

**2. Add your content:**

```sh
mkdir -p input
cp /path/to/your-deck.pdf input/deck.pdf
cp /path/to/speaker-notes.md input/speaker-notes.md
# optional: FAQ, spec sheet, or any other reference doc also goes in input/
```

**3. Build it:**

```sh
claude
> build the presenter agent from this deck
```

What happens next:

1. Claude Code reads every slide: a text pass and a vision pass, cross-checked against each other.
2. It stops and shows you the drafted prompts, the knowledge base, and the exact provisioning plan.
3. It asks a short batch of questions: persona, tone, restricted topics.
4. Only after you confirm: provisioning and deployment run against the real Kaltura API (a few minutes), then a full test pass, then a share link.

One confirmation gate, by design: your account, your content, your call, before anything is created or billed.

## Design, in brief

- **Template, not a workspace.** This repo holds the engine, a generic presenter web app, prompt templates, and the Claude Code skill that drives the build.
- Your deck lives only in the project directory `create` scaffolds for you, never in this repo.
- Result: no deck content, customer data, or credential can ever reach this public repo, because none of it ever exists in its working directory.

## What ships on by default

- Discloses it's an AI, in text a screen reader can reach.
- Records nothing about the audience: no audio, no video, no kept transcript.
- Live captions, keyboard operation, a pause control, a visible mute. Target: WCAG 2.2 AA.
- Cloning a real voice or face needs a signed consent record in your project repo first.

Safe defaults, not a compliance guarantee. The AI disclosure line and the no-audience-capture rule can't be turned off; the synthetic-content label can be suppressed once you've acknowledged it; everything else in `project.json` is yours to set. See `docs/transparency-and-consent.md` for what you still own.

## Common next steps

| Situation | Do this |
|---|---|
| Changed a slide | `/build-deck-agent ingest` |
| Want a different tone or wording | `/build-deck-agent prompts` |
| Want a knowledge base from reference docs, not just the deck | set `project.json`'s `features.knowledgeBase` to `true`, drop docs in `input/`, run `/build-deck-agent kb` |
| Provisioning died partway through | `/build-deck-agent provision`, resumes from `.provisioning-state.json` |
| Toolkit updated since you scaffolded | clone this repo, run `node deck-presenter-agent-builder/bin/check-template-update.mjs --project /path/to/your-project`, lists what changed upstream in `engine/`/`client/`; port each change into your project's `scripts/`/`client/` by hand |
| Something failed and you don't know why | `node doctor.mjs --project .` in your project: a read-only preflight that checks the Node version, `.env`, and one authenticated call, before you dig further |
| Done with a project, want it off the account | `node scripts/teardown.mjs --project .` in your project: deletes only the Kaltura resources this project created |

Every stage is idempotent: rerunning one with nothing actually changed makes no live call.

## Requirements

Node 22+, Claude Code, a Kaltura account with a partner id and admin secret.

## Docs

| File | What it covers |
|---|---|
| `ARCHITECTURE.md` | Full design: approach, data contracts, pipeline stages, extension guidelines. |
| `docs/implementation-appendix.md` | The Kaltura API contract the engine implements. |
| `docs/transparency-and-consent.md` | What ships by default, what you still decide, where to check the law. |
| `client/README.md` | The presenter web app: architecture, theming, extension points, running the E2E suite. |
| `CLAUDE.md` | Rules for contributing to this repo. |
| `SECURITY.md` | How to report a vulnerability. |

Questions or found a bug? Open a [GitHub issue](https://github.com/kaltura/deck-presenter-agent-builder/issues).

## License

Apache-2.0. See `LICENSE`.
