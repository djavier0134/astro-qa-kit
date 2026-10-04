/**
 * Single-pass site crawler.
 *
 * Every module that needs "the list of pages" calls getCrawl(), which reuses
 * qa-results/crawl.json when it already exists. The site is therefore crawled
 * once per CI run, not once per QA module.
 */
import fs from 'node:fs';

import {
  CRAWL_FILE,
  RESULTS_DIR,
  absolute,
  ensureDir,
  isAssetUrl,
  isExcluded,
  isHttp,
  isSkippableHref,
  launchBrowser,
  normalizeKey,
  rel,
  sameOrigin,
  truncate,
  urlFromPath,
  viewportOf,
} from './qa-lib.mjs';

/**
 * @returns {Promise<{
 *   baseUrl: string, generatedAt: string, truncated: boolean,
 *   pages: Array<{url:string,path:string,status:number,ok:boolean,title:string,finalUrl:string,softNotFound:boolean,error:string|null}>,
 *   internalLinks: Array<{from:string,to:string,text:string,raw:string}>,
 *   externalLinks: Array<{from:string,to:string,text:string,target:string|null,rel:string|null}>,
 *   assets: string[]
 * }>}
 */
export async function getCrawl(cfg, { force = false } = {}) {
  if (!force && fs.existsSync(CRAWL_FILE) && process.env.QA_REUSE_CRAWL !== '0') {
    try {
      const cached = JSON.parse(fs.readFileSync(CRAWL_FILE, 'utf8'));
      if (cached.baseUrl === cfg.baseUrl) {
        console.log(`  (reusing crawl of ${cached.pages.length} pages from qa-results/crawl.json)`);
        return cached;
      }
    } catch {
      /* fall through and re-crawl */
    }
  }
  const crawl = await crawlSite(cfg);
  ensureDir(RESULTS_DIR);
  fs.writeFileSync(CRAWL_FILE, JSON.stringify(crawl, null, 2));
  return crawl;
}

export async function crawlSite(cfg) {
  const browser = await launchBrowser('chromium');
  const context = await browser.newContext({
    viewport: viewportOf(cfg, 'desktop'),
    userAgent: 'astro-qa-bot/1.0 (+github-actions)',
  });
  const page = await context.newPage();

  const seeds = cfg.crawl.enabled
    ? [...new Set(['/', ...(cfg.requiredPages || []), ...(cfg.formPages || [])])]
    : [...new Set(['/', ...(cfg.requiredPages || []), ...(cfg.formPages || [])])];

  const queue = seeds.map((p) => normalizeKey(urlFromPath(cfg, p)));
  const queued = new Set(queue);
  const pages = [];
  const internalLinks = [];
  const externalLinks = [];
  const assets = new Set();
  const softMarkers = (cfg.crawl.softNotFoundText || []).map((t) => String(t).toLowerCase());
  let truncated = false;

  console.log(`  crawling ${cfg.baseUrl} (max ${cfg.crawl.maxPages} pages)`);

  while (queue.length) {
    if (pages.length >= cfg.crawl.maxPages) {
      truncated = true;
      break;
    }
    const url = queue.shift();
    const record = { url, path: rel(cfg, url), status: 0, ok: false, title: '', finalUrl: url, softNotFound: false, error: null };

    let anchors = [];
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.navigationMs });
      record.status = response ? response.status() : 0;
      record.finalUrl = page.url();
      record.ok = record.status >= 200 && record.status < 400;
      record.title = truncate(await page.title(), 180);

      if (softMarkers.length) {
        const bodyText = (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();
        record.softNotFound = softMarkers.some((m) => bodyText.includes(m));
      }

      anchors = await page.$$eval('a[href]', (nodes) =>
        nodes.map((a) => ({
          raw: a.getAttribute('href') || '',
          href: a.href,
          text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          target: a.getAttribute('target'),
          rel: a.getAttribute('rel'),
        }))
      );
    } catch (err) {
      record.error = String(err?.message || err).split('\n')[0];
    }

    pages.push(record);

    for (const a of anchors) {
      if (isSkippableHref(a.raw)) continue;
      const resolved = absolute(a.href || a.raw, record.finalUrl);
      if (!resolved || !isHttp(resolved)) continue;
      const key = normalizeKey(resolved);

      if (!sameOrigin(key, cfg.baseUrl)) {
        externalLinks.push({ from: record.path, to: key, text: a.text, target: a.target || null, rel: a.rel || null });
        continue;
      }

      internalLinks.push({ from: record.path, to: key, text: a.text, raw: a.raw });

      if (isAssetUrl(key)) {
        assets.add(key);
        continue;
      }
      if (isExcluded(cfg, key)) continue;
      if (queued.has(key)) continue;
      queued.add(key);
      queue.push(key);
    }
  }

  await context.close();
  await browser.close();

  console.log(`  crawled ${pages.length} pages, found ${internalLinks.length} internal and ${externalLinks.length} external links`);
  if (truncated) console.log(`  note: crawl stopped at the configured maxPages limit (${cfg.crawl.maxPages})`);

  return {
    baseUrl: cfg.baseUrl,
    generatedAt: new Date().toISOString(),
    truncated,
    pages,
    internalLinks,
    externalLinks,
    assets: [...assets],
  };
}

/** Pages that loaded successfully — the usual input for per-page checks. */
export function okPages(crawl) {
  return crawl.pages.filter((p) => p.ok);
}

/** Resolve a configured list of paths to absolute URLs, falling back to the crawl. */
export function resolvePages(cfg, crawl, configured, { fallbackToCrawl = false } = {}) {
  if (configured && configured.length) {
    return configured.map((p) => normalizeKey(urlFromPath(cfg, p)));
  }
  if (fallbackToCrawl) return okPages(crawl).map((p) => p.url);
  return [];
}
