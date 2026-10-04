/**
 * Broken-link QA module.
 *
 * Internal link failures are errors; external link failures default to
 * warnings because third-party hosts rate-limit CI runners.
 *
 * Writes qa-results/links.json.
 */
import { fetchStatus, pool, rel, runModule, truncate, uniq } from './qa-lib.mjs';
import { getCrawl } from './qa-crawl.mjs';

/** Statuses that mean "the remote host blocked the bot", not "the link is dead". */
const BOT_BLOCKED = new Set([401, 403, 405, 429, 503, 999]);

function sourcesFor(links, target) {
  return uniq(links.filter((l) => l.to === target).map((l) => l.from)).slice(0, 5);
}

await runModule('links', async (cfg, results) => {
  const crawl = await getCrawl(cfg);

  /* ---------------- internal links ---------------- */

  const crawledStatus = new Map(crawl.pages.map((p) => [p.url, p]));
  const internalTargets = uniq(crawl.internalLinks.map((l) => l.to));
  let internalFailures = 0;

  const unknownTargets = internalTargets.filter((t) => !crawledStatus.has(t));
  const fetched = await pool(unknownTargets, cfg.crawl.concurrency, async (url) => ({
    url,
    ...(await fetchStatus(url, cfg)),
  }));
  const fetchedStatus = new Map(fetched.map((f) => [f.url, f]));

  for (const target of internalTargets) {
    const crawled = crawledStatus.get(target);
    const probe = fetchedStatus.get(target);
    const sources = sourcesFor(crawl.internalLinks, target);
    const where = sources.length ? ` — linked from ${sources.join(', ')}` : '';

    if (crawled) {
      if (crawled.error) {
        internalFailures += 1;
        results.issue(cfg, 'internalLink', 'Internal link', `${rel(cfg, target)} failed to load: ${truncate(crawled.error, 80)}${where}`, { page: sources[0] || null, target: rel(cfg, target) });
      } else if (!crawled.ok) {
        internalFailures += 1;
        results.issue(cfg, 'internalLink', 'Internal link', `${rel(cfg, target)} returned HTTP ${crawled.status}${where}`, { page: sources[0] || null, target: rel(cfg, target), status: crawled.status });
      } else if (crawled.softNotFound) {
        internalFailures += 1;
        results.issue(cfg, 'softNotFound', 'Internal link', `${rel(cfg, target)} returns HTTP ${crawled.status} but renders "not found" content${where}`, { page: sources[0] || null, target: rel(cfg, target) });
      }
      continue;
    }

    if (probe && !probe.ok) {
      internalFailures += 1;
      results.issue(cfg, 'internalLink', 'Internal link', `${rel(cfg, target)} returned ${probe.status || probe.error}${where}`, {
        page: sources[0] || null,
        target: rel(cfg, target),
        status: probe.status,
      });
    }
  }

  if (!internalFailures) {
    results.pass('Internal links', `All ${internalTargets.length} internal link target(s) resolve correctly`);
  }

  /* ---------------- external links ---------------- */

  if (cfg.crawl.checkExternal === false) {
    results.pass('External links', 'External link checking is disabled in qa-config.json');
  } else {
    const externalTargets = uniq(crawl.externalLinks.map((l) => l.to));
    const checked = await pool(externalTargets, cfg.crawl.concurrency, async (url) => {
      let res = await fetchStatus(url, cfg, { method: 'HEAD' });
      if (!res.ok && (res.status === 0 || res.status === 405 || res.status === 501)) {
        res = await fetchStatus(url, cfg, { method: 'GET' });
      }
      return { url, ...res };
    });

    let externalFailures = 0;
    let blockedCount = 0;
    for (const res of checked) {
      if (res.ok) continue;
      const sources = sourcesFor(crawl.externalLinks, res.url);
      if (BOT_BLOCKED.has(res.status)) {
        blockedCount += 1;
        continue; // the remote host blocked the CI runner, not a broken link
      }
      externalFailures += 1;
      results.issue(cfg, 'externalLink', 'External link', `${truncate(res.url, 90)} returned ${res.status || res.error}${sources.length ? ` — linked from ${sources.join(', ')}` : ''}`, {
        page: sources[0] || null,
        target: res.url,
        status: res.status,
      });
    }

    if (!externalFailures) {
      results.pass('External links', `All ${externalTargets.length} external link(s) reachable${blockedCount ? ` (${blockedCount} host(s) rate-limited the runner and were skipped)` : ''}`);
    }

    /* ---------------- target="_blank" convention ---------------- */

    if (cfg.crawl.requireExternalBlank) {
      const missing = crawl.externalLinks.filter((l) => (l.target || '').toLowerCase() !== '_blank');
      if (missing.length) {
        results.issue(cfg, 'externalTargetBlank', 'External link target', `${missing.length} external link(s) do not use target="_blank": ${missing.slice(0, 3).map((l) => `${truncate(l.to, 60)} on ${l.from}`).join('; ')}`, {
          details: missing.slice(0, 20),
        });
      } else {
        results.pass('External link target', 'All external links open in a new tab');
      }
    }
  }

  if (crawl.truncated) {
    results.warn('Crawl coverage', `Crawl stopped at the configured limit of ${cfg.crawl.maxPages} pages; some pages were not checked`);
  }
});
