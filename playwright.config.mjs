import { defineConfig, devices } from '@playwright/test';

/**
 * Drives the real demo/dist.html against the live, already-provisioned demo
 * widget: real Kaltura calls, real avatar session. See
 * .github/workflows/live-e2e.yml and client/README.md's "Running the E2E
 * suite" section for when this runs in CI.
 *
 * No webkit project: Playwright has no fake-media mechanism for WebKit (no
 * `webkitUserPrefs` or equivalent), an upstream limitation, not a gap here.
 *
 * package.json pins @playwright/test to 1.62.1 (Firefox 153). The Firefox 155
 * in 1.63.0 never starts ICE gathering: both peer connections go straight to
 * `failed`, so no media arrives. Before you upgrade, check that the Firefox
 * tests still pass in live-e2e.yml.
 */
export default defineConfig({
  testDir: './test/e2e',
  testMatch: '*.e2e.mjs',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node test/e2e/static-server.mjs demo 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], permissions: ['microphone'], launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } } },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.streams.fake': true,
            'media.navigator.permission.disabled': true,
            // Download the OpenH264 plugin. test/e2e/helpers.mjs waits for it.
            'media.gmp-manager.updateEnabled': true,
            'media.gmp-provider.enabled': true,
            'media.gmp-gmpopenh264.enabled': true,
            'media.gmp-gmpopenh264.autoupdate': true,
          },
        },
      },
    },
  ],
});
