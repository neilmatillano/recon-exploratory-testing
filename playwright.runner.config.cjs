// Minimal Playwright config used by the in-app test runner.
// Must be .cjs because package.json has "type": "module".
// Uses 'playwright/test' (not '@playwright/test') since only 'playwright' is installed.
const { defineConfig, devices } = require('playwright/test');

module.exports = defineConfig({
  testDir: './probe_runs',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
