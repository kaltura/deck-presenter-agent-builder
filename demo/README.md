# demo: Canopy (fictional)

A complete, working example project for `deck-presenter-agent-builder`.

Canopy, Cascade Fieldworks, Wren, and Fernvale Orchards are all fictional.
Nothing in this directory describes a real product, company, or customer.
This project exists so the toolkit has one committed, non-NDA example to test
against and to show what a finished project looks like end to end.

## What's here

- `input/` — a fake deck outline and speaker notes, standing in for the raw
  files a real project starts from.
- `data/slides/`, `data/nav-rules.json`, `data/eval/`, `data/kb/` — the
  generated content a real build would produce from `input/`.
- `prompts/` — every prompt surface, filled in with Canopy's content.
- `client/prompt-format.js`, `content.mjs` — vendored unchanged from
  `templates/project/`.
- `docs/build-log.md` — what was invented and why.

## Using it

From the toolkit root:

```sh
node engine/bundle.mjs --project demo
```

This project has not been run through `provision`/`deploy`; it is a static
example, not a live agent.
