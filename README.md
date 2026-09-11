# deck-presenter-agent-builder

Turn a deck into a live AI presenter agent. Drop in a PDF and speaker notes, answer a few questions, and get a deployed page where an avatar presents your slides and answers questions about them.

Built on Kaltura's agent platform. You need a Kaltura account; you do not need to know its API.

> **Status: implemented and tested.** `PLAN.md` is the design this repo follows; `npm test` and `npm run scan` are green. See `CLAUDE.md` for how to work on it.

## How it works

```
npx deck-presenter-agent-builder create my-deck
cd my-deck
# drop input/deck.pdf and input/speaker-notes.md into place
claude
> build the presenter agent from this deck
```

Claude Code then reads the deck, drafts the agent's prompts and knowledge base, shows you a diff, and on your confirmation provisions the agent, deploys the page, and runs a test pass. You get a share link and a build log.

## Design in one paragraph

This repo is a **template, not a workspace**. It holds the engine, a generic presenter web app, prompt templates with placeholders, and the Claude Code skill that drives the build. Your actual deck lives in a separate private repo that `create-project.mjs` scaffolds for you. That separation is why no deck content, no customer data, and no account credentials can ever reach this public repo: they never exist in its working directory.

## What ships on by default

- The agent tells the audience it is an AI, in real text a screen reader can reach.
- Nothing about the audience is recorded or stored. No audio, no video, no kept transcript.
- Live captions, keyboard operation, a pause control, and a visible mute. WCAG 2.2 AA is the target.
- Cloning a real person's voice or face requires a consent record in your project repo before the tool will do it.

These are safe defaults, not a compliance guarantee, and every one of them (except the `.env` secret-leak scan) can be overridden. See `docs/transparency-and-consent.md` for what you still own if you do.

## Requirements

Node 22 or newer, Claude Code, and a Kaltura account with a partner id and admin secret.

## Docs

| File | What it covers |
|---|---|
| `PLAN.md` | Full design: architecture, data contracts, pipeline stages, roadmap. |
| `docs/implementation-appendix.md` | The Kaltura API contract the engine implements. |
| `docs/transparency-and-consent.md` | What ships by default, what you still decide, where to check the law. |
| `CLAUDE.md` | Rules for contributing to this repo. |
| `SECURITY.md` | How to report a vulnerability. |

## License

Apache-2.0. See `LICENSE`.
