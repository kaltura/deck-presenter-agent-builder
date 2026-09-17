# deck-presenter-agent-builder

Turn a deck into a live AI presenter agent. Drop in a PDF and speaker notes, answer a few questions, get a deployed page where an avatar presents your slides and answers questions about them.

Built on Kaltura's agent platform. You need a Kaltura account; you do not need to know its API.

> **Status: implemented and tested.** `PLAN.md` is the design this repo follows; `npm test` and `npm run scan` are green. See `CLAUDE.md` for how to work on it.

## Quickstart

You need: Node 22+, [Claude Code](https://claude.com/claude-code), a Kaltura partner id and admin secret (KMC → Settings → Integration Settings), and git access to this repo.

```sh
npx --yes github:kaltura/deck-presenter-agent-builder create my-deck
cd my-deck
cp .env.example .env
```

Paste your partner id and admin secret into `.env`. That's setup, done in under a minute.

Now add your content and let Claude Code build it:

```sh
mkdir -p input
cp /path/to/your-deck.pdf input/deck.pdf
cp /path/to/speaker-notes.md input/speaker-notes.md
# optional: any FAQ, spec sheet, or other reference doc also goes in input/
claude
> build the presenter agent from this deck
```

From here it's not instant, and by design: Claude Code reads every slide (text and a vision pass, cross-checked against each other so a misread number never becomes what the agent says), then **stops and shows you** the drafted prompts, the knowledge base, and the exact plan of what it's about to create on your Kaltura account, before asking a short batch of questions (persona, tone, restricted topics). Nothing goes live until you confirm. After that, provisioning and deployment against the real Kaltura API typically take a few minutes, then it runs a full test pass and hands you a share link.

That one confirmation step is the only manual gate in the whole pipeline, and it's there on purpose: your account, your content, your call before anything is created or billed.

## Design in one paragraph

This repo is a **template, not a workspace**. It holds the engine, a generic presenter web app, prompt templates with placeholders, and the Claude Code skill that drives the build. Your actual deck lives in the new project directory `create` just scaffolded for you, never in this repo. That separation is why no deck content, no customer data, and no account credentials can ever reach this public repo: they never exist in its working directory.

## What ships on by default

- The agent tells the audience it is an AI, in real text a screen reader can reach.
- Nothing about the audience is recorded or stored. No audio, no video, no kept transcript.
- Live captions, keyboard operation, a pause control, and a visible mute. WCAG 2.2 AA is the target.
- Cloning a real person's voice or face requires a consent record in your project repo before the tool will do it.

These are safe defaults, not a compliance guarantee, and every one of them (except the `.env` secret-leak scan) can be overridden. See `docs/transparency-and-consent.md` for what you still own if you do.

## Common next steps

- **Changed one slide, or want a different tone?** You don't need to rebuild everything. Back in Claude Code: `/build-deck-agent ingest` for a changed slide, `/build-deck-agent prompts` for a tone or wording change. Each stage is idempotent: rerunning one with nothing actually changed makes no live call.
- **Want a knowledge base from your reference docs, not just the deck?** Set `project.json`'s `features.knowledgeBase` to `true` before the `kb` stage runs, and put those docs in `input/` alongside the deck.
- **Something went wrong partway through provisioning?** Re-run `/build-deck-agent provision`; it resumes from `.provisioning-state.json` instead of starting over.

## Requirements

Node 22 or newer, Claude Code, and a Kaltura account with a partner id and admin secret.

## Docs

| File | What it covers |
|---|---|
| `PLAN.md` | Full design: architecture, data contracts, pipeline stages, roadmap. |
| `docs/implementation-appendix.md` | The Kaltura API contract the engine implements. |
| `docs/transparency-and-consent.md` | What ships by default, what you still decide, where to check the law. |
| `client/README.md` | The presenter web app: architecture, theming, extension points, running the E2E suite. |
| `CLAUDE.md` | Rules for contributing to this repo. |
| `SECURITY.md` | How to report a vulnerability. |

## License

Apache-2.0. See `LICENSE`.
