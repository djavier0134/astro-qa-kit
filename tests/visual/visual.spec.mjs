/**
 * Optional visual-regression suite (layout alignment / spacing, mode 2).
 *
 * Disabled until you set visualRegression.enabled = true in qa-config.json.
 *
 * First run (creates approved baselines — review them before committing):
 *   npx playwright test tests/visual --project=chromium --update-snapshots
 *
 * Later runs compare against those baselines with the configured
 * maxDiffRatio. Baselines live in tests/visual/visual.spec.mjs-snapshots/
 * and must be committed to Git.
 */
import fs from 'node:fs';

import { expect, test } from '@playwright/test';

const cfg = JSON.parse(fs.readFileSync('scripts/qa-config.json', 'utf8'));
const vr = cfg.visualRegression || {};
const pages = vr.pages?.length ? vr.pages : ['/'];
const viewportNames = vr.viewports?.length ? vr.viewports : ['desktop'];

const slug = (p) => p.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'home';

test.describe('visual regression', () => {
  test.skip(vr.enabled !== true, 'visualRegression.enabled is false in qa-config.json');

  for (const viewportName of viewportNames) {
    const viewport = cfg.viewports?.[viewportName];
    if (!viewport) continue;

    test.describe(viewportName, () => {
      test.use({ viewport });

      for (const pagePath of pages) {
        test(`${pagePath} matches the approved baseline`, async ({ page }) => {
          await page.goto(pagePath);
          await page.waitForLoadState('networkidle').catch(() => {});
          // Settle lazy content and web fonts before the comparison.
          await page.evaluate(async () => {
            for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight) {
              window.scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 80));
            }
            window.scrollTo(0, 0);
            if (document.fonts?.ready) await document.fonts.ready;
          });
          await page.waitForTimeout(300);

          await expect(page).toHaveScreenshot(`${slug(pagePath)}-${viewportName}.png`, {
            fullPage: true,
            maxDiffPixelRatio: vr.maxDiffRatio ?? 0.01,
            animations: 'disabled',
            caret: 'hide',
          });
        });
      }
    });
  }
});
