/**
 * Optional cross-browser smoke suite for the Playwright test runner.
 *
 * The CI pipeline runs scripts/cross-browser-check.mjs instead (its results
 * feed qa-report.md). Use this suite locally when you want traces, the HTML
 * report and `--ui` mode while debugging a browser-specific problem:
 *
 *   npx playwright test tests/cross-browser.spec.mjs --project=webkit --ui
 */
import fs from 'node:fs';

import { expect, test } from '@playwright/test';

const cfg = JSON.parse(fs.readFileSync('scripts/qa-config.json', 'utf8'));
const pages = cfg.crossBrowser?.pages?.length ? cfg.crossBrowser.pages : (cfg.requiredPages || ['/']).slice(0, 2);
const viewportNames = cfg.crossBrowser?.viewports?.length ? cfg.crossBrowser.viewports : ['mobile', 'desktop'];
const tolerance = cfg.design?.overflowTolerancePx ?? 2;

for (const viewportName of viewportNames) {
  const viewport = cfg.viewports?.[viewportName];
  if (!viewport) continue;

  test.describe(`${viewportName} (${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport });

    for (const pagePath of pages) {
      test(`${pagePath} renders without layout breakage`, async ({ page }) => {
        const errors = [];
        page.on('pageerror', (err) => errors.push(String(err?.message || err)));

        const response = await page.goto(pagePath);
        expect(response?.status(), `${pagePath} should not return an error status`).toBeLessThan(400);

        for (const selector of cfg.design?.requiredVisibleSelectors || ['header', 'main', 'footer']) {
          await expect(page.locator(selector).first(), `${selector} should be visible`).toBeVisible();
        }

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${pagePath} should not scroll horizontally`).toBeLessThanOrEqual(tolerance);

        expect(errors, 'no uncaught JavaScript errors').toEqual([]);
      });
    }
  });
}
