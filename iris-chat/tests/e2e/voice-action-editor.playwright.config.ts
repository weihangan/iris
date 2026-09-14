import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'voice-action-editor-focus.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    headless: true
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
});
