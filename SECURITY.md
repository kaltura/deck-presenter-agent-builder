# Security policy

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. That opens a private advisory only maintainers can see.

Do not open a public issue, and do not include a working exploit in the first report. A description of the flaw and its impact is enough to start.

Expect an acknowledgement within 5 working days and an assessment within 10. If you get no reply in 10 working days, escalate by opening a public issue that says a private report is unanswered, without any technical detail.

## Scope

This toolkit runs on a developer's machine, holds Kaltura account credentials, and provisions billable resources on a real account. In scope:

- Anything that could expose or exfiltrate `.env` contents, an `adminSecret`, or a Kaltura session key. This includes a secret reaching the deployed HTML bundle, a log line, an error message, or a committed file.
- Anything that lets one generated project mutate or destroy another project's Kaltura resources.
- Code execution from untrusted input: a malicious deck, speaker-notes file, or support document processed by the ingestion pipeline, or a crafted `project.json`.
- Weaknesses in `bin/create-project.mjs`, which runs on machines with other cloud credentials present.
- A path that bypasses the confirmation gate before a mutating or billable Kaltura call.
- A path that removes the deployed agent's AI disclosure or synthetic-content label without editing code.

Out of scope:

- Vulnerabilities in the Kaltura platform itself. Report those to Kaltura.
- Content produced by a language model: a wrong number, a hallucinated claim, an off-tone answer. Those are quality bugs; open a normal issue.
- Findings that require an attacker to already have the victim's `adminSecret`.
- Anything in a fork or in a private project repo generated from this template. Those are their owner's to fix.

## Supported versions

Only the latest published release gets security fixes. There are no long-term support branches. Fixes ship as a new patch release, and projects scaffolded from an older template pick them up through `bin/check-template-update.mjs`.

Pre-1.0 releases are unsupported once superseded.

## What we will do

Confirmed reports get a fix, a patch release, and a published GitHub Security Advisory with a CVE where one applies. Reporters are credited unless they ask not to be.

If a report shows that a credential may have leaked, rotate the affected Kaltura credential first. Treat it as compromised from the moment of exposure; cleaning up git history is not a substitute.
