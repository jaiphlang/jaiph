import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e-samples',
  timeout: 60_000,
  use: {
    baseURL: process.env.SITE_URL || 'http://127.0.0.1:4000',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: process.env.SITE_URL
    ? undefined
    : {
        command: 'bundle exec jekyll serve --host 127.0.0.1 --port 4000',
        cwd: 'docs',
        url: 'http://127.0.0.1:4000',
        reuseExistingServer: true,
        timeout: 30_000,
      },
});
