# Transparency and consent

This page explains what a deployed presenter agent does by default, what you as the deployer still have to decide, and where to check the law that applies to you. It is not legal advice.

## 1. What this tool does by default

A project built with this toolkit ships with these defaults, on unless you change them:

- **AI disclosure.** A visible, screen-reader-reachable line tells the audience they are talking to an AI, not a human. If `disclosure.text` in `project.json` is empty, `bundle.mjs` warns and uses the toolkit's default line. The line itself cannot be turned off.
- **Synthetic-content label when the avatar is cloned.** If `avatar.source` is `"cloned"`, the persistent chrome shows a label saying the voice and appearance are a synthetic recreation. You can add it to the welcome screen too, or suppress it entirely with the same override mechanism.
- **No audience capture.** No audio or video of the audience is recorded or stored.
- **Session-only transcripts.** `privacy.transcriptRetention` defaults to `"none"`.
- **Live captions, keyboard operation, a pause control, a visible mute.** WCAG 2.2 AA is the target.
- **No contact collection and no follow-up email.** `features.followUpEmail` defaults to off. Turning it on means the platform extracts the visitor's name, email, company, role, and phone from the conversation and emails a summary. That's a new purpose your privacy panel needs to name explicitly if you turn it on.
- **No feedback capture.** `features.feedback` defaults to off. Turning it on means the platform extracts a `SESSIONFEEDBACK` insight (what stood out, what could be better, whether they'd recommend it) from the full transcript after the session ends, and emails it to configured recipients. Independent of `followUpEmail`: a project can capture feedback without collecting contact details, or the other way around. That's a new purpose your privacy panel needs to name explicitly if you turn it on.

## 2. What you still have to decide

- **Lawful basis for processing audience data**, if you collect any beyond the defaults above.
- **Retention period**, if you change `transcriptRetention` away from `"none"`.
- **Whether transcripts feed evaluation or model improvement** (`privacy.reuseForEval`). That's a separate purpose from answering the audience's question, and needs its own basis.
- **Who your processors are.** Kaltura and your model vendor may each act as a processor for audience data. Getting a data-processing agreement in place with each is on you.
- **Whether you are a provider or a deployer under the EU AI Act.** This depends on your specific setup (whose brand it runs under, who controls the parameters) and this toolkit can't answer it for you.
- **Voice or likeness consent**, if you clone a real person's voice or face. Your project repo's `consent/voice-consent.template.md` and `consent/visual-consent.template.md` exist for this: copy one to `voice-<id>.md` or `visual-<id>.md` (`<id>` is the Kaltura catalog id you're cloning from) and fill it in before running `provision`, which refuses the clone path when the matching file is missing. A blanket "you may use my voice" is not enough in several jurisdictions; the consent record needs a specific description of the intended use.

## 3. Where to check the law

- **EU AI Act, Article 50**: disclosure and synthetic-content labelling duties, applies from 2 August 2026.
- **GDPR**: if you process any personal data from your audience.
- **US state digital-replica laws**: for example California Labor Code § 927 and the Tennessee ELVIS Act, if you clone a real person's voice or likeness.
- **WCAG 2.2 AA**: the accessibility target this toolkit's client defaults aim for.
- **Your model vendor's usage policy**: most require AI disclosure for any external-facing interactive agent, independent of any law.
- **California AI Transparency Act**: operative 2 August 2026, but its duties attach above 1,000,000 monthly users; most deployments built with this toolkit are unlikely to hit that threshold.

## 4. The plain statement

The defaults above are a safe starting point, not a compliance guarantee. This toolkit gives no legal advice. What you actually owe your audience depends on where you and they are, what you collect, and what you turn on. Read the sections above, decide what applies to you, and get real legal advice if you're not sure.
