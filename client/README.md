# client/

The generic presenter web app. `engine/bundle.mjs` inlines one project's deck data, prompts, and branding into these files and writes a single self-contained `dist.html`. Nothing here should ever hold real deck content; that's the whole point of keeping this directory generic. See the root `CLAUDE.md` for the non-negotiables.

## Architecture

Everything lives in `app.js`, a single module with no build step of its own (`bundle.mjs` inlines data into it; it doesn't compile it). A few pure helpers (`echo-match.js`, `mic-stats.js`, `nav-cooldown.js`, `prompt-format.js`) are split out only so `node --test` can cover their logic directly, without a browser.

**Avatar session lifecycle** (`initAvatar()`): creates a Kaltura widget token, calls `appInit`, opens a `KalturaAvatarSession` (video/audio elements, a `gatedMicProcessor` for noise suppression and mic metering, deferred mic start), then a `Presenter` on top of it that drives slide navigation from the deck's own data (`SLIDE_DATA`). `registerSessionEvents()` wires session events (`stateChange`, `transcript`, `avatarStartTalking`, tool calls) to UI updates. The whole thing tears down on `beforeunload`: save memory, destroy the presenter, disconnect the session.

**Navigation and tool calls**: `presenter.goTo` is wrapped once, at the single call site in `initAvatar()`, to add app-level gates ahead of the SDK's own navigation: block while the contact modal is open, block for a short cooldown after it closes, and redirect to a saved resume slide on first load. `goToSlide(n, reason)` is the one path everything else uses to actually change slides, so every source (TOC click, PDF link, autoplay, the nav tool call) carries a `reason` string for nudge text and analytics-style debug logging. The agent's own slide-navigation tool call is registered via `session.onToolCall(TOOL_NAMES.nav, ...)`, matching the naming project.json's `data/nav-rules.json` produced at build time; `TOOL_NAMES.contact` and `TOOL_NAMES.endSession` follow the same pattern for the contact form and the goodbye flow.

**PDF render pipeline** (`loadPDF()` → `renderPage()` → `renderAnnotations()`): `pdf.js` loads the deck once, `renderPage(n)` renders the current page to the visible `<canvas>` and cancels any in-flight render for a superseded page (a `renderGeneration` counter guards against a slow render finishing after the viewer has already moved on). Right after the canvas render resolves, `renderAnnotations(page, viewport)` reads the page's link annotations and draws absolutely-positioned `<a>` elements over `#annotation-layer`: external links get a real `href`/`target=_blank`; internal links resolve their destination page through `pdfDoc.getDestination`/`getPageIndex` and call `goToSlide` directly, so a link click is just another navigation with `reason: 'pdf_link'`.

## Theming

Every color, radius, and shadow in `styles.css` is a CSS custom property on `:root`. Two of them, `--brand-primary` and `--brand-accent`, are the ones a project actually overrides: `applyBranding()` reads `BRANDING.primaryColor`/`BRANDING.accentColor` (bundled in from `project.json`'s optional `branding` object) and sets them on `document.documentElement.style` at runtime. Every other token derives from those two via `color-mix()` (`--color-primary-hover`, `--color-primary-muted`, `--shadow-glow`, etc.), so retheming a whole deployment is normally a two-color change in `project.json`, not a CSS edit.

To add a new themed element, reach for an existing `--color-*`/`--radius-*`/`--shadow-*` token before writing a literal color. The one deliberate exception is anything layered directly on top of the avatar's video feed (the pause overlay, the drag tooltip, the grab-dots) — those use fixed `rgba()` values instead of tokens, because they need to read consistently against live video regardless of the active brand colors.

## Adding a feature

Follow the shape of the PDF-annotation-links feature (`renderAnnotations()` above) as a template:

1. Add any new pure logic (parsing, matching, cooldown math) as a small exported function, and cover it with a `node --test` file first — no browser needed for the logic itself.
2. Wire the function into `app.js` at the point in the existing flow where it belongs (a render step, a session event, a tool call), not as a new parallel code path.
3. Add markup in `index.html` and styles in `styles.css` using existing tokens (see Theming above).
4. Add a `test/e2e/<feature>.e2e.mjs` file that drives the real, live avatar session end to end, matching the existing tests in that directory. Rebuild `demo/dist.html` (`node --env-file=.env engine/bundle.mjs --project demo`) before running it, since the suite serves the bundled file, not the raw source.
5. Run `npm run scan && npm test`, then `npm run test:e2e` at least twice to rule out a flaky pass.

## Running the E2E suite

`test/e2e/*.e2e.mjs` drives a real browser against a real, live Kaltura avatar session. It needs a provisioned project (the repo uses `demo/`, already live) and never uses mocks or fakes for the session itself.

```sh
node --env-file=.env engine/bundle.mjs --project demo   # rebuild demo/dist.html (gitignored)
npm run test:e2e
```

This costs real API calls against a real account, so it never runs on a pull request. `.github/workflows/live-e2e.yml` runs it only via `workflow_dispatch`, using `KALTURA_PARTNER_ID`/`KALTURA_ADMIN_SECRET` repo secrets to rebuild `dist.html` before the browser run. Locally, put the same two values in a root `.env` (see `.env.example`).

The suite launches Chromium with a fake microphone device (`--use-fake-device-for-media-stream`): there is no way to feed a real physical mic into headless CI. Everything downstream of that (signaling, the avatar's RTC session, the deck's own logic) is real and unmocked.
