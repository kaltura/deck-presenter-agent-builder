# client/

The generic presenter web app. `engine/bundle.mjs` inlines one project's deck data, prompts, and branding into these files and writes a single self-contained `dist.html`. Nothing here should ever hold real deck content; that's the whole point of keeping this directory generic. See the root `CLAUDE.md` for the non-negotiables.

## Running the E2E suite

`test/e2e/*.e2e.mjs` drives a real browser against a real, live Kaltura avatar session. It needs a provisioned project (the repo uses `demo/`, already live) and never uses mocks or fakes for the session itself.

```sh
node --env-file=.env engine/bundle.mjs --project demo   # rebuild demo/dist.html (gitignored)
npm run test:e2e
```

This costs real API calls against a real account, so it never runs on a pull request. `.github/workflows/live-e2e.yml` runs it only via `workflow_dispatch`, using `KALTURA_PARTNER_ID`/`KALTURA_ADMIN_SECRET` repo secrets to rebuild `dist.html` before the browser run. Locally, put the same two values in a root `.env` (see `.env.example`).

The suite launches Chromium with a fake microphone device (`--use-fake-device-for-media-stream`): there is no way to feed a real physical mic into headless CI. Everything downstream of that (signaling, the avatar's RTC session, the deck's own logic) is real and unmocked.

More to come here as the client's architecture, theming tokens, and extension points get documented in full.
