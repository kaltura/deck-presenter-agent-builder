# Build log

Filled in by `.claude/skills/build-deck-agent` as it runs (ARCHITECTURE.md 6.9). This is this
project's own record: what was asked, what was decided, what was generated,
which disclosure and synthetic-content label were applied and why, and links
to the live agent and share URL.

Add one entry per change, newest first, in this shape:

```markdown
## YYYY-MM-DD, short summary of the change (vX.Y.Z)

| Issue | Cause | Fix |
|---|---|---|
| What the visitor or eval saw | Why it happened | What changed, with file paths |

Checked:
- `npm test`, the eval run file, or another command and what it showed

| Live check | Result |
|---|---|
| What you checked on the deployed agent | What happened |

Not yet deployed:
- Changes pushed to the account config but not in the live bundle, or "none"
```

Leave out the live check table when nothing was checked live. Describe what a
real session showed, and keep the session's debug log out of this file and out
of git: it holds audience data.

Not yet built.
