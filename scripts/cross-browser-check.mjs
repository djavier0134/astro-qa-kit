/**
 * Cross-browser smoke suite.
 *
 * Chromium runs the full QA suite elsewhere; this module runs a deliberately
 * small suite (critical pages load, no layout breakage, no runtime errors,
 * critical interactions still work) in Firefox and WebKit so CI stays fast.
 *
 * WebKit is an automated approximation of Safari — a final manual check on a
 * real Safari/iOS device is still worth doing before a release-critical launch.
 *
 * Writes qa-results/crossbrowser.json.
 */
import {
  attachCollectors,
  gotoSettled,
  launchBrowser,
  normalizeKey,
  rel,
  runModule,
  scrollThroughPage,
  truncate,
  urlFromPath,
  viewportOf,
} from './qa-lib.mjs';
import { auditLayout, reportLayout } from './qa-layout.mjs';

await runModule('crossbrowser', async (cfg, results) => {
  const engines = (cfg.browsers || ['chromium', 'firefox', 'webkit']).filter((b) => b !== 'chromium');
  if (!engines.length) {
    results.pass('Cross-browser', 'No secondary browsers configured');
    return;
  }

  const smoke = cfg.crossBrowser || {};
  const pages = (smoke.pages?.length ? smoke.pages : (cfg.requiredPages || ['/']).slice(0, 2)).map((p) => normalizeKey(urlFromPath(cfg, p)));
  const viewportNames = smoke.viewports?.length ? smoke.viewports : ['mobile', 'desktop'];
  const criticalInteractions = (cfg.interactions || []).filter((i) => i.critical !== false);

  for (const engine of engines) {
    let browser;
    try {
      browser = await launchBrowser(engine);
    } catch (err) {
      results.issue(cfg, 'crossBrowser', 'Cross-browser', `Could not launch ${engine}: ${truncate(String(err?.message || err), 120)} (run "npx playwright install --with-deps ${engine}")`, { browser: engine });
      continue;
    }

    try {
      for (const viewportName of viewportNames) {
        const context = await browser.newContext({ viewport: viewportOf(cfg, viewportName) });
        const page = await context.newPage();
        const collectors = attachCollectors(page, cfg);

        for (const url of pages) {
          const pagePath = rel(cfg, url);
          collectors.reset();

          let status = 0;
          try {
            const response = await gotoSettled(page, url, cfg);
            status = response ? response.status() : 0;
            await scrollThroughPage(page);
          } catch (err) {
            results.issue(cfg, 'crossBrowser', 'Cross-browser', `${engine}/${viewportName}: ${pagePath} failed to load — ${truncate(String(err?.message || err), 90)}`, {
              page: pagePath,
              browser: engine,
              viewport: viewportName,
            });
            continue;
          }

          if (status >= 400) {
            results.issue(cfg, 'crossBrowser', 'Cross-browser', `${engine}/${viewportName}: ${pagePath} returned HTTP ${status}`, { page: pagePath, browser: engine, viewport: viewportName });
            continue;
          }

          const audit = await auditLayout(page, cfg);
          reportLayout(cfg, results, audit, { page: pagePath, viewport: viewportName, browser: engine });

          if (collectors.pageErrors.length) {
            results.issue(cfg, 'pageError', 'Cross-browser runtime', `${engine}/${viewportName}: uncaught error on ${pagePath} — ${truncate(collectors.pageErrors[0].text)}`, {
              page: pagePath,
              browser: engine,
              viewport: viewportName,
            });
          }
        }

        // Critical interactions, at the viewport each one is configured for.
        for (const interaction of criticalInteractions) {
          if ((interaction.viewport || 'desktop') !== viewportName) continue;
          const pagePath = interaction.page || '/';
          try {
            await gotoSettled(page, normalizeKey(urlFromPath(cfg, pagePath)), cfg);
            const triggerCount = await page.locator(interaction.trigger).count();
            if (triggerCount === 0) {
              if (!interaction.optional) {
                results.issue(cfg, 'crossBrowser', 'Cross-browser interaction', `${engine}/${viewportName}: trigger for "${interaction.name}" not found`, {
                  page: pagePath,
                  browser: engine,
                  viewport: viewportName,
                });
              }
              continue;
            }
            await page.locator(interaction.trigger).first().click({ timeout: 10000 });
            await page
              .locator(interaction.target)
              .first()
              .waitFor({ state: (interaction.expect || 'visible') === 'hidden' ? 'hidden' : 'visible', timeout: interaction.timeoutMs || 5000 });
            results.pass('Cross-browser interaction', `${engine}/${viewportName}: "${interaction.name}" works`, { page: pagePath, browser: engine, viewport: viewportName });
          } catch (err) {
            results.issue(cfg, 'crossBrowser', 'Cross-browser interaction', `${engine}/${viewportName}: "${interaction.name}" failed — ${truncate(String(err?.message || err), 90)}`, {
              page: pagePath,
              browser: engine,
              viewport: viewportName,
            });
          }
        }

        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
});
