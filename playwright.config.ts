import { defineConfig } from '@playwright/test';
import { LOCAL_DOCS_SITE } from './e2e/playwright/docs-site';

export default defineConfig({
  testDir: './e2e/playwright',
  timeout: 60_000,
  use: {
    baseURL: LOCAL_DOCS_SITE,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'bundle exec jekyll serve --host 127.0.0.1 --port 4000',
    cwd: 'docs',
    url: LOCAL_DOCS_SITE,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
