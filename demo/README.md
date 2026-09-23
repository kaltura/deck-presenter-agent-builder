# demo: Canopy (fictional)

A complete, working example project for `deck-presenter-agent-builder`.

Canopy, Cascade Fieldworks, Wren, and Fernvale Orchards are all fictional.
Nothing in this directory describes a real product, company, or customer.
This project exists so the toolkit has one committed, non-NDA example to test
against and to show what a finished project looks like end to end.

## What's here

- `input/`: a fake deck outline and speaker notes, standing in for the raw
  files a real project starts from.
- `data/slides/`, `data/nav-rules.json`, `data/eval/`, `data/kb/`: the
  generated content a real build would produce from `input/`.
- `prompts/`: every prompt surface, filled in with Canopy's content.
- `client/prompt-format.js` is vendored unchanged from the toolkit's `client/`.
  `content.mjs` is vendored unchanged from `templates/project/`.
- `docs/build-log.md`: what was invented and why.

## Using it

From the toolkit root:

```sh
node engine/bundle.mjs --project demo
```

The demo is also provisioned on the toolkit's own test account. `.github/workflows/live-e2e.yml`
runs the browser suite in `test/e2e/` against it on a manual dispatch. Its live ids live only in
the gitignored `.provisioning-state.json` and in the `DEMO_PROVISIONING_STATE` repo secret the
workflow reads. Refresh the secret after any command that changes the state file.
