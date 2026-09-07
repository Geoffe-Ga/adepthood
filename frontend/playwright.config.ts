import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.browser.e2e.test.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: './e2e/browserGlobalSetup.ts',
  globalTeardown: './e2e/browserGlobalTeardown.ts',
  reporter: [['line']],
  use: {
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL,
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
  },
});
