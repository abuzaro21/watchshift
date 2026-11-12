import { defineConfig, devices } from '@playwright/test';

// Local: run `npm run build` first. Set E2E_BASE_URL to test a deployed instance instead.
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3320';
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  retries: 0,
  use: { baseURL: base, trace: 'retain-on-failure', acceptDownloads: true },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'node --disable-warning=ExperimentalWarning src/main.ts',
    url: `${base}/api/health`,
    env: { PORT: '3320', WATCHSHIFT_SPEED: '3', WATCHSHIFT_TICK_MS: '100', WATCHSHIFT_DB: 'data/e2e.db' },
    reuseExistingServer: false,
  },
});
