/**
 * Image QA module: broken images, distortion, alt text, lazy loading and
 * file-size budgets.
 *
 * Writes qa-results/images.json.
 */
import {
  attachCollectors,
  fetchStatus,
  gotoSettled,
  launchBrowser,
  pool,
  runModule,
  sameOrigin,
  scrollThroughPage,
  truncate,
  viewportOf,
} from './qa-lib.mjs';
import { getCrawl, okPages } from './qa-crawl.mjs';

async function collectImages(page, criticalSelectors, checkBackgrounds) {
  return page.evaluate(
    (o) => {
      const describe = (el) => {
        const id = el.id ? `#${el.id}` : '';
        const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join('');
        return `${el.tagName.toLowerCase()}${id}${cls}`;
      };
      const matchesAny = (el, selectors) =>
        selectors.some((sel) => {
          try {
            return el.matches(sel) || !!el.closest(sel);
          } catch {
            return false;
          }
        });

      const images = [...document.querySelectorAll('img')].map((img) => {
        const rect = img.getBoundingClientRect();
        const cs = getComputedStyle(img);
        return {
          src: img.currentSrc || img.src || img.getAttribute('src') || '',
          hasAltAttribute: img.hasAttribute('alt'),
          alt: img.getAttribute('alt') || '',
          loading: img.getAttribute('loading') || '',
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          renderedWidth: Math.round(rect.width),
          renderedHeight: Math.round(rect.height),
          documentTop: Math.round(rect.top + window.scrollY),
          objectFit: cs.objectFit,
          display: cs.display,
          critical: matchesAny(img, o.criticalSelectors),
          selector: describe(img),
        };
      });

      const backgrounds = [];
      if (o.checkBackgrounds) {
        for (const el of document.querySelectorAll('body *')) {
          const bg = getComputedStyle(el).backgroundImage;
          if (!bg || bg === 'none' || !bg.includes('url(')) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          for (const match of bg.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
            const url = match[2];
            if (!url || url.startsWith('data:')) continue;
            backgrounds.push({ url: new URL(url, location.href).toString(), selector: describe(el), critical: matchesAny(el, o.criticalSelectors) });
          }
          if (backgrounds.length > 200) break;
        }
      }

      return { images, backgrounds, viewportHeight: window.innerHeight };
    },
    { criticalSelectors, checkBackgrounds }
  );
}

await runModule('images', async (cfg, results) => {
  const crawl = await getCrawl(cfg);
  const pages = okPages(crawl).slice(0, cfg.imageRules.maxPages);
  if (!pages.length) {
    results.warn('Images', 'No pages available to check for images');
    return;
  }

  const browser = await launchBrowser('chromium');
  const context = await browser.newContext({ viewport: viewportOf(cfg, 'desktop') });
  const page = await context.newPage();
  attachCollectors(page, cfg); // keeps third-party noise out of the console

  const sizeCandidates = new Map(); // url -> first page that used it
  const backgroundCandidates = new Map();
  let brokenCount = 0;
  let distortedCount = 0;
  let missingAltTotal = 0;
  let lazyIssues = 0;
  let totalImages = 0;

  try {
    for (const record of pages) {
      const pagePath = record.path;
      let data;
      try {
        await gotoSettled(page, record.url, cfg);
        await scrollThroughPage(page);
        data = await collectImages(page, cfg.imageRules.criticalSelectors || [], cfg.imageRules.checkBackgroundImages !== false);
      } catch (err) {
        results.warn('Images', `Could not inspect images on ${pagePath}: ${truncate(String(err?.message || err), 100)}`, { page: pagePath });
        continue;
      }

      totalImages += data.images.length;

      for (const img of data.images) {
        const visible = img.renderedWidth > 0 && img.renderedHeight > 0 && img.display !== 'none';

        // Broken
        if (visible && (!img.src || (img.complete && img.naturalWidth === 0))) {
          brokenCount += 1;
          const key = img.critical ? 'criticalImage' : 'nonCriticalImage';
          results.issue(cfg, key, 'Broken image', `${img.critical ? 'Critical image' : 'Image'} failed to render: ${truncate(img.src || '(no src)', 90)}`, {
            page: pagePath,
            selector: img.selector,
            target: img.src,
          });
          continue;
        }

        // Distortion — only when object-fit lets the image stretch.
        if (visible && img.naturalWidth > 0 && img.naturalHeight > 0 && ['fill', 'none'].includes(img.objectFit)) {
          const naturalRatio = img.naturalWidth / img.naturalHeight;
          const renderedRatio = img.renderedWidth / img.renderedHeight;
          const drift = Math.abs(renderedRatio - naturalRatio) / naturalRatio;
          if (drift > (cfg.imageRules.aspectRatioTolerance ?? 0.1)) {
            distortedCount += 1;
            results.issue(cfg, 'distortedImage', 'Image distortion', `${truncate(img.src, 70)} is stretched: natural ${img.naturalWidth}x${img.naturalHeight}, rendered ${img.renderedWidth}x${img.renderedHeight}`, {
              page: pagePath,
              selector: img.selector,
            });
          }
        }

        // Alt attribute (alt="" is allowed — it marks a decorative image).
        if (!img.hasAltAttribute) missingAltTotal += 1;

        // Lazy loading below the fold
        if (
          cfg.imageRules.requireLazyLoadBelowFold &&
          visible &&
          img.documentTop > data.viewportHeight &&
          img.loading.toLowerCase() !== 'lazy'
        ) {
          lazyIssues += 1;
          if (lazyIssues <= 10) {
            results.issue(cfg, 'lazyLoading', 'Lazy loading', `Below-the-fold image is not lazy-loaded: ${truncate(img.src, 80)}`, {
              page: pagePath,
              selector: img.selector,
            });
          }
        }

        if (img.src && sameOrigin(img.src, cfg.baseUrl) && !sizeCandidates.has(img.src)) {
          sizeCandidates.set(img.src, pagePath);
        }
      }

      const pageMissingAlt = data.images.filter((i) => !i.hasAltAttribute).length;
      if (pageMissingAlt) {
        results.issue(cfg, 'missingAlt', 'Image alt text', `${pageMissingAlt} image(s) have no alt attribute`, { page: pagePath });
      }

      for (const bg of data.backgrounds) {
        if (!backgroundCandidates.has(bg.url)) backgroundCandidates.set(bg.url, { page: pagePath, ...bg });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  /* ---------------- background image availability ---------------- */

  const backgrounds = [...backgroundCandidates.values()].filter((b) => sameOrigin(b.url, cfg.baseUrl));
  const bgResults = await pool(backgrounds, cfg.crawl.concurrency, async (bg) => ({ ...bg, ...(await fetchStatus(bg.url, cfg, { method: 'HEAD' })) }));
  let brokenBackgrounds = 0;
  for (const bg of bgResults) {
    if (bg.ok) continue;
    brokenBackgrounds += 1;
    results.issue(cfg, bg.critical ? 'criticalImage' : 'backgroundImage', 'Background image', `Background image returned ${bg.status || bg.error}: ${truncate(bg.url, 90)}`, {
      page: bg.page,
      selector: bg.selector,
    });
  }

  /* ---------------- file size / format budgets ---------------- */

  const budget = (cfg.imageRules.maxFileSizeKB ?? 500) * 1024;
  const sized = await pool([...sizeCandidates.keys()], cfg.crawl.concurrency, async (url) => ({
    url,
    page: sizeCandidates.get(url),
    ...(await fetchStatus(url, cfg, { method: 'HEAD' })),
  }));

  let oversized = 0;
  let legacyFormat = 0;
  for (const asset of sized) {
    if (!asset.ok) continue;
    if (asset.contentLength && asset.contentLength > budget) {
      oversized += 1;
      results.issue(cfg, 'imageSize', 'Image weight', `${truncate(asset.url, 80)} is ${(asset.contentLength / 1024).toFixed(0)} KB (budget ${cfg.imageRules.maxFileSizeKB} KB)`, {
        page: asset.page,
        target: asset.url,
      });
    }
    if (cfg.imageRules.preferModernFormats && /\.(jpe?g|png)(\?|$)/i.test(asset.url) && (asset.contentLength || 0) > 100 * 1024) {
      legacyFormat += 1;
      results.issue(cfg, 'imageFormat', 'Image format', `${truncate(asset.url, 80)} is a large legacy format; consider WebP/AVIF`, { page: asset.page, target: asset.url });
    }
  }

  /* ---------------- summary ---------------- */

  if (!brokenCount && !brokenBackgrounds) {
    results.pass('Broken images', `All ${totalImages} image(s) across ${pages.length} page(s) rendered successfully`);
  }
  if (!distortedCount) results.pass('Image distortion', 'No visibly stretched images detected');
  if (!missingAltTotal) results.pass('Image alt text', 'Every image has an alt attribute');
  if (!oversized) results.pass('Image weight', `All same-origin images are within the ${cfg.imageRules.maxFileSizeKB} KB budget`);
  if (cfg.imageRules.requireLazyLoadBelowFold && !lazyIssues) results.pass('Lazy loading', 'Below-the-fold images use loading="lazy"');
  if (lazyIssues > 10) results.warn('Lazy loading', `${lazyIssues - 10} further lazy-loading warnings were suppressed`);
  if (cfg.imageRules.preferModernFormats && !legacyFormat) results.pass('Image format', 'No oversized legacy-format images found');
});
