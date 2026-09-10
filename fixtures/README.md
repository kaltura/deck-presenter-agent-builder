# Fixtures

`smoke-project/` is a three-slide throwaway project for testing the engine offline. Everything in it is invented. Northwind Lumen is not a real product.

It exists so you can run the engine before any real deck exists:

```sh
node engine/bundle.mjs   --project fixtures/smoke-project
node engine/provision.mjs --project fixtures/smoke-project --dry-run
node engine/verify.mjs    --project fixtures/smoke-project --dry-run
```

Three slides, numbered 1 to 3 with no gaps, so the bundler's contiguity check has something valid to pass and something easy to break on purpose.

It is not the demo. `demo/` is a fuller fictional deck for people evaluating the tool, and is Phase 1 work. This is a test fixture: minimal on purpose, and it stays that way.

## What each part is for

| Path | Exercises |
|---|---|
| `project.json` | Config parsing, the partial `capabilities` override, `sessionMaxSeconds` agreement. |
| `data/slides/*.json` | Slide loading, the `slide` number field, contiguity, inlining into `dist.html`. |
| `data/nav-rules.json` | Navigation rule parsing. |
| `prompts/*.md` | Placeholder substitution. Every `{{PLACEHOLDER}}` here must resolve. |
| `prompts/client/*.md` | Runtime prompt inlining, and the check that no `fetch()` survives bundling. |
| `prompts/tools/*.md` | Tool description wiring. |

Provisioning against a real account needs credentials in `.env`. Without them, `--dry-run` is as far as this fixture goes, which is enough to cover bundling, validation, and payload assembly.
