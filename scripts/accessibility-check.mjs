/**
 * Accessibility QA module — Playwright + axe-core.
 *
 * Violations with a configured impact (critical/serious by default) are
 * errors; everything else is a warning. Lighthouse adds its own
 * accessibility score on top of this.
 *
 * Writes qa-results/accessibility.json.
 */
import {
  attachCollectors,
  gotoSettled,
  launchBrowser,
  normalizeKey,
  rel,
  runModule,
  truncate,
  urlFromPath,
  viewportOf,
} from './qa-lib.mjs';
import { getCrawl, okPages } from './qa-crawl.mjs';

await runModule('accessibility', async (cfg, results) => {
  const a11y = cfg.accessibility || {};
  if (a11y.enabled === false) {
    results.pass('Accessibility', 'Accessibility scanning is disabled in qa-config.json');
    return;
  }

  let AxeBuilder;
  try {
    ({ default: AxeBuilder } = await import('@axe-core/playwright'));
  } catch {
    results.warn('Accessibility', 'Install @axe-core/playwright to enable axe scans (npm i -D @axe-core/playwright)');
    return;
  }

  const crawl = await getCrawl(cfg);
  const targets = (a11y.pages?.length ? a11y.pages : cfg.requiredPages || ['/']).map((p) => normalizeKey(urlFromPath(cfg, p)));
  const known = new Map(okPages(crawl).map((p) => [p.url, p]));

  const errorImpacts = new Set(a11y.errorImpacts || ['critical', 'serious']);
  const browser = await launchBrowser('chromium');
  const context = await browser.newContext({ viewport: viewportOf(cfg, 'desktop') });
  const page = await context.newPage();
  attachCollectors(page, cfg);

  let totalViolations = 0;

  try {
    for (const url of targets) {
      const pagePath = rel(cfg, url);
      if (known.size && !known.has(url)) {
        // Still scan it — a required page may not have been crawled when
        // crawling is narrowed down, but skip anything known to be broken.
        const broken = crawl.pages.find((p) => p.url === url && !p.ok);
        if (broken) continue;
      }

      try {
        await gotoSettled(page, url, cfg);
      } catch (err) {
        results.warn('Accessibility', `Could not load ${pagePath}: ${truncate(String(err?.message || err), 90)}`, { page: pagePath });
        continue;
      }

      let scan;
      try {
        let builder = new AxeBuilder({ page }).withTags(a11y.tags || ['wcag2a', 'wcag2aa']);
        if (a11y.disableRules?.length) builder = builder.disableRules(a11y.disableRules);
        scan = await builder.analyze();
      } catch (err) {
        results.warn('Accessibility', `axe scan failed on ${pagePath}: ${truncate(String(err?.message || err), 100)}`, { page: pagePath });
        continue;
      }

      if (!scan.violations.length) {
        results.pass('Accessibility', `No axe violations on ${pagePath}`, { page: pagePath });
        continue;
      }

      for (const violation of scan.violations) {
        totalViolations += violation.nodes.length;
        const impact = violation.impact || 'minor';
        const key = errorImpacts.has(impact) ? 'accessibilityCritical' : 'accessibilityMinor';
        const sample = violation.nodes.slice(0, 3).map((n) => truncate(n.target.join(' '), 60));
        results.issue(cfg, key, `Accessibility: ${violation.id}`, `${impact.toUpperCase()} — ${violation.help} (${violation.nodes.length} element(s): ${sample.join(', ')})`, {
          page: pagePath,
          impact,
          helpUrl: violation.helpUrl,
          details: sample,
        });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (!totalViolations) {
    results.pass('Accessibility', `axe-core found no WCAG violations across ${targets.length} page(s)`);
  }
});
