import { defineConfig } from '@playwright/test';

const url = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  use: {
    baseURL: url,
    channel: process.env.PLAYWRIGHT_CHANNEL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url,
    reuseExistingServer: !process.env.CI,
  },
});
