# Build log

This project presents Canopy, a fictional precision-irrigation product from a
fictional company, Cascade Fieldworks. Every name, number, and story in this
project is invented for this demo. Nothing here describes a real product,
company, or customer.

## What was asked

Build a complete, working example project for `deck-presenter-agent-builder`:
a full pipeline input (deck outline, speaker notes) through generated content
(slides, nav rules, knowledge base, eval set) to filled-in prompts, so the
toolkit has one committed, non-NDA project to test against and to show new
users what a finished project looks like.

## What was decided

- 10 slides, 3 chapters: Introduction (1-3), How It Works (4-7), Results and
  Pricing (8-10). Small enough to read in one sitting, large enough to
  exercise chapters, navigation rules, and a knowledge base.
- Slide 8 tells an invented customer story (Fernvale Orchards) to exercise a
  results/proof slide. It is flagged fictional in four independent places:
  the slide content itself, its footnote, the glossary, and
  `prompts/restricted-topics.md`, so no single missed edit could let the
  agent present it as real.
- `avatar.source: "fresh"`, no consent record needed, since no real person's
  voice or likeness is used.
- `privacy.controllerContact` uses an `@example.com` address so the project
  carries no real contact detail while still exercising the field.
- `features.followUpEmail: false` to keep the demo's provisioning surface
  small; the other four optional features (contact form, end-session tool,
  knowledge base, feedback) are all on so the demo exercises them.

## What was generated

`data/slides/01.json`-`10.json`, `data/nav-rules.json`, `data/eval/held-out.json`,
`data/kb/*.md`, and every `prompts/*.md` file, filled with real (fictional)
content rather than left as template placeholders.

## Disclosure and synthetic-content labeling

`project.json.disclosure.text` names Wren as an AI presenter and states it
collects nothing unless the visitor uses the contact form. The Fernvale
Orchards slide additionally carries its own fictional-content disclosure, on
top of the standing AI disclosure every deployed agent shows.

## Live agent

Not deployed. This project is committed as a static example; it has not been
run through `provision`/`deploy` against a live Kaltura account.
