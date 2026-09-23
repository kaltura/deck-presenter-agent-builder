# Reference: nav-rules and prompt drafting (ARCHITECTURE.md 6.4)

Loaded by the `prompts` stage of `SKILL.md`.

## Order matters

1. Draft `data/nav-rules.json` and write it to disk.
2. Deterministically render `data/routes.json` and `prompts/base-directive.md`'s deck-specific section from that file.
3. Fill placeholders everywhere else.
4. Lint.

Never do these out of order and never hand-edit the two rendered outputs (`data/routes.json`, the deck-specific section) directly. If one of them is wrong, the source of truth (`data/nav-rules.json`) is wrong; fix it there and re-render, so the routing data and the directive prose can never disagree about a slide number.

## Drafting `data/nav-rules.json`

This is the highest-leverage, highest-risk artifact in the whole build. Most navigation bugs in a deployed presenter trace back to ambiguous wording here, not to the engine or the client.

Before drafting, write down (in your own working notes, not necessarily a file) a one-paragraph working definition of these two terms, so a second drafting pass on the same deck can't land on a different meaning:

- **Forward-reference guard**: when a visitor asks about something the deck covers *later* than the current slide, the agent should say so and offer to jump ahead, rather than answering from general knowledge or pretending the later content doesn't exist. The rule needs a trigger (how the agent recognizes this case) and a target (which slide to offer).
- **Proof-point-slide handling**: when a visitor asks for evidence, a number, or a customer example, the agent should navigate to (or cite) the specific slide carrying that proof point, identified by its `content.key_metrics` or a footnote, not restate a vaguer claim from the current slide.

Schema (schema-enforced at generation if your tooling supports Structured Outputs; otherwise validate by hand before writing):

```json
{
  "rules": [
    { "when": "the visitor asks how it works", "goToSlide": 2 },
    { "when": "the visitor asks about price or cost", "goToSlide": 3 }
  ]
}
```

Extend this base shape per-project with whatever the deck needs: per-chapter slide ranges, per-topic entry slide ids, forward-reference triggers and targets, proof-point slide ids. Every `goToSlide` (or any slide-id field you add) must be a real slide number that exists in `data/slides/`.

**Verification pass.** Before moving on, re-derive each nav-rules entry independently from the slide data (read the slides again, ask "what rule would I write for this topic, from scratch") and reconcile against the draft. Don't just accept the first draft as final; a second independent pass catches the entries that seemed right the first time but cite the wrong slide.

## Rendering `data/routes.json` and the deck-specific directive section

Both are deterministic transforms of `data/nav-rules.json`; no drafting judgment happens here, only rendering:

- `data/routes.json`: `[{ topic, entrySlide, aliases: [] }]`, one entry per topic-level nav rule.
- The deck-specific section of `prompts/base-directive.md` (the file's final `# DECK-SPECIFIC PRESENTING RULES` heading and everything under it): prose that cites the same slide numbers and chapter boundaries as `data/nav-rules.json`, so a reader can spot-check every claim against a real slide.

The caption map (`{ "spoken form": "display form" }`) is a separate deterministic transform, derived from `prompts/pronunciation-guide.md` at bundle time by `scripts/lib/caption-map.mjs`. Nothing to draft here: it happens automatically when `scripts/bundle.mjs` runs.

## Filling placeholders

Walk every file under `prompts/`. Most files already carry `{{PLACEHOLDER}}` tokens with no real wording (from `templates/prompts/`); fill each one from `project.json` and the ingestion/terminology output:

- `goal.md`: `{{GOAL_DETAIL}}` (what success looks like for a session, specific to this deck's actual content, not a generic sales pitch).
- `restricted-topics.md`: `{{ADDITIONAL_RESTRICTED_TOPICS}}` (one line per entry in `project.json.restrictedTopics`, each with the reason and the redirect behavior; paired positive alternative, see below).
- `target-audience.md`: `{{AUDIENCE_DESCRIPTION}}` and `{{ASSUMED_BACKGROUND}}`, from `project.json.audience`.
- `glossary.md`: `{{ONE_LINE_DEFINITION}}` per harvested term (from the `terms` stage).
- `pronunciation-guide.md`: already filled by the `terms` stage. A well-known name (a famous brand, person, or place) can resist a plain `TERM -> "how it sounds"` row: the model already "knows" the standard spelling and keeps writing that instead of the phonetic form, even after the row is right. If a live spot check still shows the old spelling, add a short paragraph right after the table stating the rule directly ("BRAND is spoken and captioned as three separate words: 'B and D'. Never write the character '&' for BRAND, in any sentence, in any language. Write 'B and D' instead, every single time, with no exceptions."), push with `scripts/update-prompts.mjs`, and spot check again with a few different questions before trusting it.
- `client/route-answers.md`: one `{{TOPIC_KEY}}` / `{{SLIDE_NUM}}` / `{{SUMMARY}}` block per `data/routes.json` entry.
- `persona-name.md`, `opening-phrase.md`: from `project.json.personaName`. Keep the name consistent across both files and the base directive's own references to the presenter. A mismatch reads as the agent forgetting who it is.
- `opening-phrase.md` is a Jinja template the platform renders from the client's request variables. It has three branches: `rejoin_slide` (a dropped connection came back), `resume_slide` (a returning visitor), and a new visitor. Every branch says the presenter is an AI. Keep the lowercase `{{ resume_label }}` style for Jinja variables: `content.mjs` substitutes only exact uppercase `{{KEY}}` placeholders, so Jinja variables pass through untouched. The base directive's OPENING section tells the model what to do after each branch.

Any `{{PLACEHOLDER}}` still present after this step is a bug in this stage, not something to leave for a human to notice later.

## The lint (run every time, fail the build on a miss)

Shape validity is already guaranteed by schema-enforced generation, so this lint is **semantic only**:

- Every slide-number reference anywhere in `prompts/` or `data/routes.json` exists in `data/slides/`.
- Every such reference falls inside the chapter range it claims to belong to.
- A reference presented as a proof-point citation points at a slide whose `content.key_metrics` is non-empty.
- Every KB file's `sourceSlides` frontmatter resolves to real slides inside its stated `chapter`.
- Every negative directive rule ("never do X") is paired with a stated positive alternative ("say Y instead"). A rule sentence that only forbids, with nothing stated to do instead, fails.
- Everything in `base-directive.md` above the final `# DECK-SPECIFIC PRESENTING RULES` heading is the fixed skeleton `create-project.mjs` copied in. It is never rewritten, only its `{{VAR}}` placeholders resolved. If that fixed text needs to change, that is a toolkit-level edit to `templates/prompts/base-directive.md`, not something to draft per project.

A lint failure blocks the `checkpoint` stage. Fix the draft and re-lint; don't hand-wave a miss as acceptable because a human will "probably notice."
