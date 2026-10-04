/**
 * Playwright test-runner config for the OPTIONAL suites in tests/:
 *   - tests/cross-browser.spec.mjs  (smoke suite in Chromium/Firefox/WebKit)
 *   - tests/visual/visual.spec.mjs  (screenshot regression against baselines)
 *
 * The main QA engine in scripts/ uses the Playwright *library* directly and
 * does not need this file. Requires: npm i -D @playwright/test
 */
import fs from 'node:fs';
import path from 'node:path';

import { defineConfig } from '@playwright/test';

const configPath = process.env.QA_CONFIG
  ? path.resolve(process.cwd(), process.env.QA_CONFIG)
  : path.join(process.cwd(), 'scripts', 'qa-config.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const baseURL = String(process.env.QA_BASE_URL || cfg.baseUrl).replace(/\/+$/, '');

const browsers = cfg.browsers && cfg.browsers.length ? cfg.browsers : ['chromium', 'firefox', 'webkit'];
const engineFor = { chromium: 'chromium', firefox: 'firefox', webkit: 'webkit' };

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: cfg.visualRegression?.maxDiffRatio ?? 0.01,
      animations: 'disabled',
    },
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'qa-results/playwright-report' }]] : [['list']],
  outputDir: 'qa-results/playwright-output',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: cfg.timeouts?.navigationMs ?? 30_000,
  },
  projects: browsers.map((name) => ({
    name,
    use: {
      browserName: engineFor[name] || 'chromium',
      viewport: cfg.viewports?.desktop || { width: 1920, height: 1080 },
    },
  })),
});
