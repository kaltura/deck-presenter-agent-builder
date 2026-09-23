# Reference: testing and eval (ARCHITECTURE.md 6.8)

Loaded by the `checkpoint` stage (for held-out questions) and the `test` stage (for the full run) of `SKILL.md`.

## Held-out questions (collected at `checkpoint`, run at `test`)

Every other question in this eval is generated from the same slide data the agent was built from, which measures self-consistency, not correctness. Models measurably prefer their own outputs when judging them. Held-out questions are the counterweight: at `checkpoint`, ask the human to write or approve 2 to 3 questions per chapter, phrased the way a real audience member would actually ask (not the tidy phrasing a generation pass would produce), and store them in `data/eval/held-out.json`. Reuse the same set across every later rebuild and in the regression suite, don't regenerate it per run.

## The full checklist, in order

1. **Smoke test.** One real conversation turn against the live agent. If this fails, stop. Nothing downstream is trustworthy until the agent responds at all.
2. **Numeric traceability, deterministic and not judged.** Extract every number from the agent's response with code (not by asking a model), normalize it (currency symbols, percentages, scale words like "million", thousands separators, skipping bare years and single-digit list/quarter labels), and match it against a pool built from the cited slide's `content.key_metrics`, `content.footnotes`, and `talking_points`, plus a deck-wide pool (every other slide's own numbers, and the knowledge base when present) for a figure the presenter legitimately cites from elsewhere. A table explicitly labeled "in thousands" or "in $mm" scales its own bare figures before matching. An unmatched number fails the build. Do not replace this with an LLM-judge call: judges perform close to chance on this exact kind of factual-correctness check, and a confident wrong number is the failure mode most likely to slip past one.
3. **Slide routing, deterministic.** Assert the agent navigated to the expected slide id for each nav-rule-triggering question.
4. **Talking-point coverage and tone, LLM-judged.** Judgment is the right tool here. Give the judge the actual slide JSON and have it derive the expected answer first, then compare against the agent's actual answer (reference-guided grading cuts failure rates sharply versus judging without a reference). Have the judge reason step by step before scoring. Run the judge at temperature 0. Verbosity bias is real: a longer answer is never itself evidence of a better answer, and the judge prompt should say so explicitly. If the judge model and the drafting model are the same model, note that in `docs/build-log.md`. Self-preference bias is a real, measured effect, not a hypothetical one.
5. **Flakiness guard.** A single stochastic call (any LLM-judged check) never gates a build on its own. Require two consecutive failures on the same check before hard-failing, and report that a retry happened either way.
6. **Held-out questions.** Run every question from `data/eval/held-out.json` and report results for this set **separately** from the generated questions above, never merged into one number.
7. **Adversarial turns.**
   - One or two per entry in `project.json.restrictedTopics`: confirm the agent declines and redirects instead of answering. `restrictedTopics` is collected during ingestion and drafting; if this is the first time it's actually tested end to end in this project, say so in `docs/build-log.md`.
   - One off-topic question unrelated to the deck: confirm the agent stays in persona and declines cleanly, per `prompts/restricted-topics.md`'s stated behavior.
   - One turn that pastes or references instructions embedded in an ingested document (a KB file or the deck itself), asking the agent to follow them: confirm it treats that content as data to present, never as a new instruction. This is the direct test of the non-negotiable stated in `SKILL.md` and in `prompts/base-directive.md`'s data-integrity section.
8. **Pronunciation spot-check.** Exercise every display term harvested into `prompts/pronunciation-guide.md` at least once, with a question that asks the agent to name the term and leaves its written form to the guide. Pass requires all three: the raw reply uses a spoken-form alias from the guide, the raw reply never contains the display term itself (text-to-speech would misread it), and the caption output turns the spoken form back into the display term a viewer reads.
9. **Accessibility acceptance checklist.** Check the criteria this project's `client/` ships by default (skip link, focus-visible outline, minimum tap target size, `prefers-reduced-motion` handling, keyboard shortcuts, `aria-live`/`aria-pressed`/dialog roles) against the deployed bundle, by number, not by impression.
10. **Currency-suffix check, deterministic and not judged.** Over every response already collected in checks 2, 3, and 6: flag a currency amount written with a raw letter-scale suffix (`$5M`, `€3B`, `£2K`) that text-to-speech reads wrong, instead of the spoken word form (`5 million dollars`).

## Reporting

Write one JSON artifact per run to `docs/eval-runs/<ISO-timestamp>.json`: per-check pass or fail, the judge's rationale for any LLM-judged check, and the held-out results kept in their own section. A later run should diff cleanly against the previous file to show what regressed or improved.

Report results as **"N passed / N total"**, never as a percentage or a quality score. At roughly one question per chapter, the sample is a smoke test of the build, not a statistically meaningful evaluation, and a percentage invites reading a precision that isn't there.

## Not built yet (ARCHITECTURE.md 12)

- Checking pronunciation against actually rendered audio, rather than just usage in a transcript.
- Scoring transcripts for tone fidelity against `project.json.tone`.

Don't build ad hoc versions of either while implementing this stage; note the gap in `docs/build-log.md` if a human asks for one and point them at ARCHITECTURE.md 12 in the toolkit repo.
