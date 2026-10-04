/**
 * Responsive / layout QA module.
 *
 * Loads every configured page at every configured viewport and checks for
 * horizontal overflow, disappearing elements, clipped text, overlap and
 * container/gutter rules. Screenshots are captured for every failing
 * viewport and uploaded as a GitHub Actions artifact.
 *
 * Writes qa-results/responsive.json and qa-results/screenshots/*.png.
 */
import path from 'node:path';

import {
  SCREENSHOT_DIR,
  attachCollectors,
  ensureDir,
  gotoSettled,
  launchBrowser,
  normalizeKey,
  rel,
  runModule,
  safeFileName,
  scrollThroughPage,
  truncate,
  urlFromPath,
} from './qa-lib.mjs';
import { getCrawl } from './qa-crawl.mjs';
import { auditLayout, reportLayout } from './qa-layout.mjs';

await runModule('responsive', async (cfg, results) => {
  const crawl = await getCrawl(cfg);

  const configured = cfg.responsivePages?.length ? cfg.responsivePages : cfg.requiredPages || ['/'];
  const targets = configured.map((p) => normalizeKey(urlFromPath(cfg, p)));
  const viewportNames = Object.keys(cfg.viewports);

  if (!viewportNames.length) {
    results.warn('Responsive', 'No viewports configured');
    return;
  }

  ensureDir(SCREENSHOT_DIR);
  const browser = await launchBrowser('chromium');

  try {
    for (const viewportName of viewportNames) {
      const viewport = cfg.viewports[viewportName];
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      attachCollectors(page, cfg);

      for (const url of targets) {
        const pagePath = rel(cfg, url);
        const known = crawl.pages.find((p) => p.url === url);
        if (known && !known.ok) continue; // already reported as a broken page

        try {
          await gotoSettled(page, url, cfg);
          await scrollThroughPage(page);
        } catch (err) {
          results.issue(cfg, 'horizontalOverflow', 'Responsive', `${pagePath} failed to load at ${viewportName}: ${truncate(String(err?.message || err), 90)}`, {
            page: pagePath,
            viewport: viewportName,
          });
          continue;
        }

        const audit = await auditLayout(page, cfg);
        const failed = reportLayout(cfg, results, audit, { page: pagePath, viewport: viewportName });

        if (failed) {
          const file = path.join(SCREENSHOT_DIR, `${safeFileName(pagePath)}--${viewportName}.png`);
          try {
            await page.screenshot({ path: file, fullPage: true });
            // Informational: the failure itself is already recorded above.
            results.pass('Screenshot', `Captured ${path.relative(process.cwd(), file)} for the failed viewport`, { page: pagePath, viewport: viewportName });
          } catch (err) {
            results.warn('Screenshot', `Could not capture a screenshot: ${truncate(String(err?.message || err), 90)}`, { page: pagePath, viewport: viewportName });
          }
        }
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }
});
