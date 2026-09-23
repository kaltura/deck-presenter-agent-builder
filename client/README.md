# client/

The generic presenter web app. `engine/bundle.mjs` inlines one project's deck data, prompts, and branding into these files and writes a single self-contained `dist.html`. Nothing here should ever hold real deck content; that's the whole point of keeping this directory generic. See the root `CLAUDE.md` for the non-negotiables.

## Architecture

Everything lives in `app.js`, a single module with no build step of its own (`bundle.mjs` inlines data into it; it doesn't compile it). A few pure helpers (`echo-match.js`, `mic-stats.js`, `nav-cooldown.js`, `prompt-format.js`, `nav-ack.js`, `presenter-memory.js`, `autoplay-state.js`) are split out only so `node --test` can cover their logic directly, without a browser.

**Avatar session lifecycle** (`preloadAvatar()` / `startSession()`): the two are split so the socket/media handshake overlaps the welcome and disclaimer dwell time instead of blocking after the visitor's acknowledge click. `preloadAvatar()` fires on the welcome dialog's Continue click: it creates a Kaltura widget token, calls `appInit`, and opens a `KalturaAvatarSession` (video/audio elements, a `gatedMicProcessor` for noise suppression and mic metering) with `requireDisclosureAck: true`, then builds a `Presenter` on top of it that drives slide navigation from the deck's own data (`SLIDE_DATA`), and calls `connect()`. `startSession()` fires on the disclaimer's acknowledge click: it awaits `preloadAvatar()`, calls `acknowledgeDisclosure()` to release the held opening greeting, starts the mic (not awaited, so a slow permission prompt doesn't block the deck from starting), and calls `presenter.start()`. Error toasts from the preload phase are held behind a `sessionRevealed` flag so a preload failure never surfaces over the disclaimer. `registerSessionEvents()` wires session events (`stateChange`, `transcript`, `avatarStartTalking`, tool calls, `reconnecting`/`reconnected`) to UI updates, including a `frameReady`/`mediaReady` dual gate (via `video.requestVideoFrameCallback`, with a `loadeddata` fallback) before the avatar's loading overlay is hidden. The whole thing tears down on `beforeunload`: save memory (unless the visitor just clicked "clear memory"), destroy the presenter, disconnect the session.

**Resuming a returning visitor**: `presenter-memory.js`'s `peekResumeSlide()` does a read-only peek at the same localStorage record the SDK's own `Presenter` class owns (same key, same max age), before the session or the `Presenter` exist. `preloadAvatar()` passes the result as `resume_slide`/`resume_label` in the session's `requestVars`, so the avatar's very first spoken greeting can reference where the visitor left off, ahead of `Presenter`'s own later `page_context` injection. `onSlideChange()` keeps the intellect's rejoin hint current mid-session via `session.updateRequestVars({ rejoin_slide, rejoin_label })`.

**Navigation and tool calls**: `presenter.goTo` is wrapped once, at the single call site in `preloadAvatar()`, to add app-level gates ahead of the SDK's own navigation: block while the contact modal is open, block for a short cooldown after it closes, and hold autoplay after a manual move back to an earlier slide. `goToSlide(n, reason)` is the one path everything else uses to actually change slides, so every source (TOC click, PDF link, autoplay, the nav tool call) carries a `reason` string for nudge text and analytics-style debug logging. The agent's own slide-navigation tool call is registered via `session.onToolCall(TOOL_NAMES.nav, ...)`, matching the naming project.json's `data/nav-rules.json` produced at build time; the ack it sends back uses `navAckPayload()` from `nav-ack.js`, describing the slide the deck actually landed on (`presenter.current`) for a `reason: 'resume'` call, since `Presenter`'s own nav handler (wired first, at construction) has already resolved and moved to the real resume target by the time this handler runs. `TOOL_NAMES.contact` and `TOOL_NAMES.endSession` follow the same pattern for the contact form and the goodbye flow.

**Autoplay, goodbye, and nudges**:

| Behavior | Rule |
|---|---|
| Autoplay countdown | Scheduled from `turnEnd` and `avatarStopTalking`, never from `responseSettled` (a nav tool call settles a response before the avatar speaks). Each schedule and each timer fire first checks the pure `autoPlayBlocked(snapshot)` in `autoplay-state.js`. `avatarStartTalking` cancels it, and `interrupted` clears the speaking flag, since it ends speech without an `avatarStopTalking`. |
| Goodbye | `handleGoodbye()` pauses the deck and starts a `GOODBYE_GRACE_MS` timer that disconnects and shows the session-ended screen. Any slide change, or a new visitor turn that is not a goodbye, cancels it. An end-session tool call is ignored when the visitor navigated after their last message, so a late call cannot end a session the visitor re-engaged. |
| Nav nudge | Sent after each slide change (a click, a PDF link, autoplay). Skipped for `reason: 'avatar'` and `'resume'`, because the nav ack already carries the slide content and a nudge would cut off the answer in progress. |

**Debug timeline**: every `addDebugEntry(text)` call also pushes `{ tMs: performance.now(), text }` onto `window.__debugTimeline` (created on first use), independent of whether the debug transcript panel is visible. A startup-timing harness can read this array for exact-match strings like `startup: session.connect() called` without needing the panel open.

**PDF render pipeline** (`loadPDF()` → `renderPage()` → `renderAnnotations()`): `pdf.js` loads the deck once, `renderPage(n)` renders the current page to the visible `<canvas>` and cancels any in-flight render for a superseded page (a `renderGeneration` counter guards against a slow render finishing after the viewer has already moved on). Right after the canvas render resolves, `renderAnnotations(page, viewport)` reads the page's link annotations and draws absolutely-positioned `<a>` elements over `#annotation-layer`: external links get a real `href`/`target=_blank`; internal links resolve their destination page through `pdfDoc.getDestination`/`getPageIndex` and call `goToSlide` directly, so a link click is just another navigation with `reason: 'pdf_link'`.

## Theming

Every color, radius, and shadow in `styles.css` is a CSS custom property on `:root`. Two of them, `--brand-primary` and `--brand-accent`, are the ones a project actually overrides: `applyBranding()` reads `BRANDING.primaryColor`/`BRANDING.accentColor` (bundled in from `project.json`'s optional `branding` object) and sets them on `document.documentElement.style` at runtime. Every other token derives from those two via `color-mix()` (`--color-primary-hover`, `--color-primary-muted`, `--shadow-glow`, etc.), so retheming a whole deployment is normally a two-color change in `project.json`, not a CSS edit.

To add a new themed element, reach for an existing `--color-*`/`--radius-*`/`--shadow-*` token before writing a literal color. The one deliberate exception is anything layered directly on top of the avatar's video feed (the pause overlay, the drag tooltip, the grab-dots): those use fixed `rgba()` values instead of tokens, because they need to read consistently against live video regardless of the active brand colors.

## Adding a feature

Follow the shape of the PDF-annotation-links feature (`renderAnnotations()` above) as a template:

1. Add any new pure logic (parsing, matching, cooldown math) as a small exported function, and cover it with a `node --test` file first. No browser needed for the logic itself.
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

This costs real API calls against a real account. `.github/workflows/live-e2e.yml` runs it only on a manual `workflow_dispatch` by someone with write access, never on push or pull request. It uses the `KALTURA_PARTNER_ID`/`KALTURA_ADMIN_SECRET` repo secrets to rebuild `dist.html` before the browser run. Push and pull request runs get the secretless checks in `ci.yml`. Locally, put the same two values in a root `.env` (see `.env.example`).

The suite launches Chromium and Firefox with a fake microphone device (Chromium's `--use-fake-device-for-media-stream`, Firefox's `media.navigator.streams.fake` pref): there is no way to feed a real physical mic into headless CI. Everything downstream of that (signaling, the avatar's RTC session, the deck's own logic) is real and unmocked.
