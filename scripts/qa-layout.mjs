/**
 * Shared layout audit used by responsive-check.mjs and cross-browser-check.mjs.
 * Everything here runs inside the browser and returns plain data.
 */

export async function auditLayout(page, cfg) {
  return page.evaluate((o) => {
    const describe = (el) => {
      const id = el.id ? `#${el.id}` : '';
      const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join('');
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };

    const docWidth = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - docWidth;

    // Elements that stick out past the right edge of the viewport.
    const overflowOffenders = [];
    if (overflow > o.tolerance) {
      for (const el of document.querySelectorAll('body *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right <= docWidth + o.tolerance) continue;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' && cs.visibility === 'hidden') continue;
        // Report the outermost offender of each branch only.
        if (overflowOffenders.some((x) => x.node.contains(el))) continue;
        overflowOffenders.push({ node: el, selector: describe(el), right: Math.round(rect.right), width: Math.round(rect.width) });
        if (overflowOffenders.length >= 8) break;
      }
    }

    // Elements that must stay visible at every breakpoint.
    const missing = [];
    for (const selector of o.requiredVisibleSelectors || []) {
      const el = document.querySelector(selector);
      if (!el) {
        missing.push({ selector, reason: 'not in the DOM' });
        continue;
      }
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
        missing.push({ selector, reason: 'present but not visible' });
      }
    }

    // Text that is cut off without an intentional ellipsis.
    const clipped = [];
    for (const el of document.querySelectorAll('h1,h2,h3,h4,p,a,button,li,td,th,label')) {
      const cs = getComputedStyle(el);
      if (!['hidden', 'clip'].includes(cs.overflowX) && !['hidden', 'clip'].includes(cs.overflow)) continue;
      if (cs.textOverflow === 'ellipsis') continue;
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        clipped.push({ selector: describe(el), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
        if (clipped.length >= 10) break;
      }
    }

    // Container width and page gutters.
    let container = null;
    if (o.containerSelector) {
      const el = document.querySelector(o.containerSelector);
      if (el) {
        const rect = el.getBoundingClientRect();
        container = {
          found: true,
          width: Math.round(rect.width),
          gutterLeft: Math.round(rect.left),
          gutterRight: Math.round(docWidth - rect.right),
        };
      } else {
        container = { found: false };
      }
    }

    // Opt-in overlap detection between configured selectors.
    const overlaps = [];
    const nodes = [];
    for (const selector of o.noOverlapSelectors || []) {
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) nodes.push({ selector, el, rect });
      }
    }
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (width <= 1 || height <= 1) continue;
        const area = width * height;
        const smallest = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
        if (area / smallest > 0.25) {
          overlaps.push({ a: describe(a.el), b: describe(b.el), coverage: Number((area / smallest).toFixed(2)) });
        }
      }
    }

    return {
      viewportWidth: docWidth,
      overflow,
      overflowOffenders: overflowOffenders.map(({ selector, right, width }) => ({ selector, right, width })),
      missing,
      clipped,
      container,
      overlaps: overlaps.slice(0, 10),
    };
  }, {
    tolerance: cfg.design.overflowTolerancePx ?? 2,
    requiredVisibleSelectors: cfg.design.requiredVisibleSelectors || [],
    containerSelector: cfg.design.containerSelector || null,
    noOverlapSelectors: cfg.design.noOverlapSelectors || [],
  });
}

/**
 * Turn an audit into result items. Shared so the responsive module and the
 * cross-browser smoke suite report layout problems identically.
 */
export function reportLayout(cfg, results, audit, { page, viewport, browser }) {
  const label = [viewport, browser].filter(Boolean).join(' / ');
  const context = { page, viewport, browser };
  let failed = false;

  if (audit.overflow > (cfg.design.overflowTolerancePx ?? 2)) {
    failed = true;
    const offenders = audit.overflowOffenders.map((o) => `${o.selector} (right ${o.right}px)`).slice(0, 3).join(', ');
    results.issue(cfg, browser ? 'crossBrowser' : 'horizontalOverflow', 'Horizontal overflow', `${label}: page scrolls ${audit.overflow}px horizontally${offenders ? ` — ${offenders}` : ''}`, {
      ...context,
      details: audit.overflowOffenders,
    });
  }

  for (const miss of audit.missing) {
    failed = true;
    results.issue(cfg, browser ? 'crossBrowser' : 'missingElement', 'Missing element', `${label}: "${miss.selector}" is ${miss.reason}`, context);
  }

  if (audit.clipped.length) {
    failed = true;
    results.issue(cfg, 'clippedText', 'Clipped text', `${label}: ${audit.clipped.length} element(s) have text cut off — ${audit.clipped.slice(0, 2).map((c) => `${c.selector} "${c.text}"`).join('; ')}`, {
      ...context,
      details: audit.clipped,
    });
  }

  if (audit.overlaps.length) {
    failed = true;
    results.issue(cfg, 'elementOverlap', 'Element overlap', `${label}: ${audit.overlaps.length} overlapping element pair(s) — ${audit.overlaps.slice(0, 2).map((o) => `${o.a} over ${o.b}`).join('; ')}`, {
      ...context,
      details: audit.overlaps,
    });
  }

  if (audit.container) {
    if (!audit.container.found) {
      results.issue(cfg, 'containerWidth', 'Container', `${label}: containerSelector "${cfg.design.containerSelector}" not found`, context);
      failed = true;
    } else {
      const max = cfg.design.containerMaxWidth;
      if (max && audit.container.width > max + 2) {
        failed = true;
        results.issue(cfg, 'containerWidth', 'Container', `${label}: container is ${audit.container.width}px wide, max is ${max}px`, context);
      }
      // Gutters only matter while the viewport is narrower than the container cap.
      const minGutter = cfg.design.pageGutterMin ?? 0;
      const gutter = Math.min(audit.container.gutterLeft, audit.container.gutterRight);
      const containerIsFullWidth = !max || audit.viewportWidth <= max;
      if (minGutter && containerIsFullWidth && gutter < minGutter) {
        failed = true;
        results.issue(cfg, 'pageGutter', 'Page gutter', `${label}: page gutter is ${gutter}px, minimum is ${minGutter}px`, context);
      }
    }
  }

  if (!failed) {
    results.pass('Layout', `${label}: no overflow, missing elements, clipping or overlap`, context);
  }
  return failed;
}
