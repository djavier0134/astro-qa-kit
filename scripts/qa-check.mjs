/**
 * Core QA module.
 *
 * Covers: required pages, the 404 page, contact forms, business-name and
 * form-identity consistency, phone/email, privacy policy, logo link,
 * typography, brand colours, heading hierarchy, basic SEO, accessible names,
 * robots.txt, sitemap and browser runtime errors.
 *
 * Writes qa-results/core.json. Always exits 0 — qa-reporter.mjs is the gate.
 */
import {
  attachCollectors,
  digitsOnly,
  fetchStatus,
  fetchText,
  firstFontFamily,
  gotoSettled,
  launchBrowser,
  normalizeColor,
  normalizeKey,
  rel,
  runModule,
  sameOrigin,
  truncate,
  uniq,
  urlFromPath,
  viewportOf,
} from './qa-lib.mjs';
import { getCrawl, okPages } from './qa-crawl.mjs';

/* ------------------------------------------------------------------ */
/* Page snapshot (runs inside the browser)                             */
/* ------------------------------------------------------------------ */

async function snapshot(page, opts) {
  return page.evaluate((o) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const meta = (selector) => {
      const el = document.querySelector(selector);
      return el ? clean(el.getAttribute('content')) : null;
    };
    const textOf = (selector) => {
      const el = selector ? document.querySelector(selector) : null;
      return el ? clean(el.innerText) : '';
    };

    const accessibleName = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim();
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const joined = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((n) => clean(n.textContent))
          .join(' ');
        if (joined.trim()) return joined.trim();
      }
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label && clean(label.textContent)) return clean(label.textContent);
      }
      const wrapping = el.closest('label');
      if (wrapping && clean(wrapping.textContent)) return clean(wrapping.textContent);
      const title = el.getAttribute('title');
      if (title && title.trim()) return title.trim();
      const img = el.querySelector('img[alt]');
      if (img && img.getAttribute('alt').trim()) return img.getAttribute('alt').trim();
      return '';
    };

    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
      level: Number(h.tagName.slice(1)),
      text: clean(h.textContent).slice(0, 120),
    }));

    const anchors = [...document.querySelectorAll('a[href]')].map((a) => ({
      href: a.href,
      raw: a.getAttribute('href') || '',
      text: clean(a.textContent).slice(0, 120),
      inHeader: !!a.closest(o.headerSelector || 'header'),
      inFooter: !!a.closest(o.footerSelector || 'footer'),
      inNav: !!a.closest(o.navSelector || 'nav'),
    }));

    // Logo
    let logo = { found: false };
    if (o.logoSelector) {
      const node = document.querySelector(o.logoSelector);
      if (node) {
        const anchor = node.tagName === 'A' ? node : node.closest('a') || node.querySelector('a');
        const rect = node.getBoundingClientRect();
        logo = {
          found: true,
          tag: node.tagName.toLowerCase(),
          href: anchor ? anchor.href : null,
          clickable: !!anchor,
          hasImage: !!node.querySelector('img,svg,picture') || node.tagName === 'IMG' || node.tagName === 'SVG',
          text: clean(node.textContent).slice(0, 80),
          visible: rect.width > 0 && rect.height > 0,
        };
      }
    }

    // Typography
    const typography = {};
    for (const rule of o.typography || []) {
      const el = document.querySelector(rule.selector);
      if (!el) {
        typography[rule.key] = { found: false, selector: rule.selector };
        continue;
      }
      const cs = getComputedStyle(el);
      typography[rule.key] = {
        found: true,
        selector: rule.selector,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
      };
    }

    // Brand colours
    const colors = (o.colorRules || []).map((rule) => {
      const el = document.querySelector(rule.selector);
      if (!el) return { name: rule.name || rule.selector, selector: rule.selector, found: false };
      const cs = getComputedStyle(el);
      return {
        name: rule.name || rule.selector,
        selector: rule.selector,
        property: rule.property || 'color',
        found: true,
        value: cs[rule.property || 'color'],
      };
    });

    // Forms
    const matchedSelectors = (o.formSelectors || []).filter((sel) => {
      try {
        return document.querySelectorAll(sel).length > 0;
      } catch {
        return false;
      }
    });

    const nativeForms = [...document.querySelectorAll('form')].map((form, index) => {
      const controls = [...form.querySelectorAll('input,select,textarea')].filter((el) => {
        const type = (el.getAttribute('type') || '').toLowerCase();
        return !['hidden', 'submit', 'button', 'reset', 'image'].includes(type);
      });
      return {
        index,
        id: form.id || null,
        name: form.getAttribute('name') || null,
        action: form.getAttribute('action') || null,
        heading: clean((form.closest('section,div,main') || form).querySelector('h1,h2,h3')?.textContent || '').slice(0, 120),
        text: clean(form.innerText).slice(0, 2000),
        hasSubmit: !!form.querySelector('button[type="submit"],input[type="submit"],button:not([type])'),
        fields: controls.map((el) => ({
          name: el.getAttribute('name') || el.id || '',
          type: (el.getAttribute('type') || el.tagName).toLowerCase(),
          required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
          label: accessibleName(el),
          placeholder: el.getAttribute('placeholder') || '',
        })),
      };
    });

    const embeddedForms = [...document.querySelectorAll('iframe[src]')].map((f) => ({
      src: f.getAttribute('src') || '',
      title: f.getAttribute('title') || '',
      visible: f.getBoundingClientRect().height > 0,
    }));

    // Functional icons / buttons without an accessible name
    const unlabelled = [...document.querySelectorAll('button, a[href], [role="button"]')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        if (clean(el.textContent)) return false;
        return !accessibleName(el);
      })
      .slice(0, 20)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        classes: (el.getAttribute('class') || '').slice(0, 80),
        href: el.getAttribute('href') || null,
      }));

    return {
      title: clean(document.title),
      metaDescription: meta('meta[name="description"]'),
      metaRobots: meta('meta[name="robots"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.href || null,
      ogTitle: meta('meta[property="og:title"]') || meta('meta[name="og:title"]'),
      ogDescription: meta('meta[property="og:description"]') || meta('meta[name="og:description"]'),
      lang: document.documentElement.getAttribute('lang') || null,
      viewportMeta: meta('meta[name="viewport"]'),
      headings,
      h1s: headings.filter((h) => h.level === 1).map((h) => h.text),
      text: clean(document.body?.innerText || '').slice(0, 200000),
      headerText: textOf(o.headerSelector || 'header'),
      footerText: textOf(o.footerSelector || 'footer'),
      anchors,
      logo,
      typography,
      colors,
      matchedSelectors,
      nativeForms,
      embeddedForms,
      unlabelled,
    };
  }, opts);
}

function snapshotOptions(cfg) {
  return {
    headerSelector: cfg.headerSelector || 'header',
    footerSelector: cfg.footerSelector || 'footer',
    navSelector: cfg.navSelector || 'nav',
    logoSelector: cfg.logoSelector || null,
    formSelectors: cfg.formSelectors || [],
    colorRules: cfg.design.colorRules || [],
    typography: Object.entries(cfg.design.typography || {}).map(([key, rule]) => ({ key, ...rule })),
  };
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

function checkRequiredPages(cfg, results, crawl) {
  const byUrl = new Map(crawl.pages.map((p) => [p.url, p]));
  for (const configured of cfg.requiredPages || []) {
    const url = normalizeKey(urlFromPath(cfg, configured));
    const record = byUrl.get(url);
    if (!record) {
      results.issue(cfg, 'brokenRequiredPage', 'Required page', `${configured} was never reached by the crawler`, { page: configured });
      continue;
    }
    if (record.error) {
      results.issue(cfg, 'brokenRequiredPage', 'Required page', `${configured} failed to load: ${record.error}`, { page: configured });
    } else if (!record.ok) {
      results.issue(cfg, 'brokenRequiredPage', 'Required page', `${configured} returned HTTP ${record.status}`, { page: configured, status: record.status });
    } else if (record.softNotFound) {
      results.issue(cfg, 'softNotFound', 'Required page', `${configured} returned HTTP ${record.status} but renders "not found" content`, { page: configured });
    } else {
      results.pass('Required page', `${configured} loaded (HTTP ${record.status})`, { page: configured });
    }
  }
}

async function check404Page(cfg, results, page) {
  const probePath = cfg.notFoundPath || '/qa-404-probe-do-not-create/';
  const url = urlFromPath(cfg, probePath);
  const collectors = attachCollectors(page, cfg);
  collectors.reset();

  let response;
  try {
    response = await gotoSettled(page, url, cfg);
  } catch (err) {
    results.issue(cfg, 'notFoundPage', '404 page', `Could not load the 404 probe URL: ${String(err?.message || err)}`, { page: probePath });
    return;
  }

  const status = response ? response.status() : 0;
  if (status !== 404) {
    results.issue(cfg, 'notFoundPage', '404 page', `Unknown URL returned HTTP ${status} instead of 404 (soft 404)`, { page: probePath, status });
  } else {
    results.pass('404 page', 'Unknown URLs return HTTP 404', { page: probePath });
  }

  const health = await page.evaluate(
    (o) => ({
      hasHeading: !!document.querySelector('h1,h2'),
      bodyLength: (document.body?.innerText || '').trim().length,
      headerVisible: !!document.querySelector(o.header) && document.querySelector(o.header).getBoundingClientRect().height > 0,
      footerVisible: !!document.querySelector(o.footer) && document.querySelector(o.footer).getBoundingClientRect().height > 0,
      navLinks: document.querySelectorAll(`${o.header} a[href]`).length,
      brokenImages: [...document.images].filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.currentSrc || img.src),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }),
    { header: cfg.headerSelector || 'header', footer: cfg.footerSelector || 'footer' }
  );

  const layoutProblems = [];
  if (!health.hasHeading || health.bodyLength < 40) layoutProblems.push('no visible heading or body content');
  if (!health.headerVisible) layoutProblems.push('header missing');
  if (!health.footerVisible) layoutProblems.push('footer missing');
  if (health.navLinks === 0) layoutProblems.push('no navigation links');
  if (health.brokenImages.length) layoutProblems.push(`${health.brokenImages.length} broken image(s)`);
  if (health.overflow > (cfg.design.overflowTolerancePx ?? 2)) layoutProblems.push(`horizontal overflow of ${health.overflow}px`);

  if (layoutProblems.length) {
    results.issue(cfg, 'notFoundPage', '404 page layout', `404 page problems: ${layoutProblems.join('; ')}`, {
      page: probePath,
      details: health,
    });
  } else {
    results.pass('404 page layout', '404 page renders with header, navigation, content and footer', { page: probePath });
  }

  reportRuntime(cfg, results, collectors, probePath);
}

function reportRuntime(cfg, results, collectors, pagePath) {
  for (const err of collectors.pageErrors) {
    results.issue(cfg, 'pageError', 'Browser runtime', `Uncaught JavaScript error: ${truncate(err.text)}`, { page: pagePath });
  }
  if (collectors.consoleErrors.length) {
    results.issue(cfg, 'consoleError', 'Browser console', `${collectors.consoleErrors.length} console error(s), first: ${truncate(collectors.consoleErrors[0].text)}`, {
      page: pagePath,
      details: collectors.consoleErrors.slice(0, 5),
    });
  }
  const failures = collectors.sameOriginFailures();
  if (failures.length) {
    results.issue(cfg, 'failedRequest', 'Network requests', `${failures.length} failed same-origin request(s), first: ${truncate(failures[0].url)} (${failures[0].failure})`, {
      page: pagePath,
      details: failures.slice(0, 5),
    });
  }
  if (!collectors.pageErrors.length && !collectors.consoleErrors.length && !failures.length) {
    results.pass('Browser runtime', 'No JavaScript errors, console errors or failed same-origin requests', { page: pagePath });
  }
}

function checkSeo(cfg, results, pagePath, snap) {
  if (!snap.title) results.issue(cfg, 'seoTitle', 'SEO: title', 'Page has no <title>', { page: pagePath });
  if (!snap.metaDescription) results.issue(cfg, 'seoDescription', 'SEO: meta description', 'Page has no meta description', { page: pagePath });
  if (!snap.viewportMeta) results.issue(cfg, 'seoViewport', 'SEO: viewport meta', 'Page has no viewport meta tag', { page: pagePath });
  if (!snap.lang) results.issue(cfg, 'seoLang', 'SEO: html lang', '<html> has no lang attribute', { page: pagePath });

  const robots = (snap.metaRobots || '').toLowerCase();
  if (robots.includes('noindex')) {
    results.issue(cfg, 'seoNoindex', 'SEO: robots meta', `Page is set to noindex ("${snap.metaRobots}")`, { page: pagePath });
  }

  if (cfg.seo.requireCanonical && !snap.canonical) {
    results.issue(cfg, 'seoCanonical', 'SEO: canonical', 'Page has no canonical link', { page: pagePath });
  }
  if (cfg.seo.requireOpenGraph && (!snap.ogTitle || !snap.ogDescription)) {
    results.issue(cfg, 'seoOpenGraph', 'SEO: Open Graph', `Missing ${!snap.ogTitle ? 'og:title' : ''}${!snap.ogTitle && !snap.ogDescription ? ' and ' : ''}${!snap.ogDescription ? 'og:description' : ''}`, { page: pagePath });
  }

  if (snap.h1s.length === 0) {
    results.issue(cfg, 'seoH1', 'Heading hierarchy', 'Page has no H1', { page: pagePath });
  } else if (snap.h1s.length > 1) {
    results.issue(cfg, 'seoMultipleH1', 'Heading hierarchy', `Page has ${snap.h1s.length} H1 elements`, { page: pagePath, details: snap.h1s });
  }

  const skips = [];
  let previous = 0;
  for (const heading of snap.headings) {
    if (previous && heading.level > previous + 1) {
      skips.push(`H${previous} -> H${heading.level} ("${heading.text}")`);
    }
    previous = heading.level;
  }
  if (skips.length) {
    results.issue(cfg, 'headingSkip', 'Heading hierarchy', `${skips.length} skipped heading level(s): ${skips.slice(0, 3).join(', ')}`, { page: pagePath, details: skips });
  }

  if (snap.title && snap.metaDescription && snap.h1s.length === 1 && !robots.includes('noindex')) {
    results.pass('SEO basics', 'Title, meta description, single H1, viewport and lang present', { page: pagePath });
  }
}

function checkBusinessName(cfg, results, pagePath, snap, isRequiredPage) {
  const haystack = [snap.text, snap.title, snap.metaDescription, snap.ogTitle, snap.ogDescription, snap.footerText]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();

  for (const forbidden of cfg.forbiddenBusinessNames || []) {
    if (!forbidden) continue;
    if (haystack.includes(String(forbidden).toLowerCase())) {
      results.issue(cfg, 'forbiddenBusinessName', 'Business name', `Forbidden business name "${forbidden}" found on the page`, { page: pagePath, detected: forbidden });
    }
  }

  if (cfg.businessName && isRequiredPage) {
    const names = [cfg.businessName, ...(cfg.businessNameAliases || [])].map((n) => String(n).toLowerCase());
    if (!names.some((n) => haystack.includes(n))) {
      results.issue(cfg, 'missingBusinessName', 'Business name', `"${cfg.businessName}" does not appear anywhere on this page`, { page: pagePath });
    }
  }
}

function checkAccessibleNames(cfg, results, pagePath, snap) {
  if (snap.unlabelled.length) {
    results.issue(cfg, 'accessibilityMinor', 'Accessible names', `${snap.unlabelled.length} icon/button element(s) have no text or accessible label`, {
      page: pagePath,
      details: snap.unlabelled,
    });
  }
}

function checkTypography(cfg, results, pagePath, snap) {
  const rules = cfg.design.typography || {};
  if (!Object.keys(rules).length) return;

  for (const [key, expected] of Object.entries(rules)) {
    const actual = snap.typography[key];
    if (!actual || !actual.found) {
      results.issue(cfg, 'typography', 'Typography', `Selector "${expected.selector}" (${key}) not found on the page`, { page: pagePath });
      continue;
    }
    const diffs = [];
    if (expected.fontFamily && firstFontFamily(actual.fontFamily) !== String(expected.fontFamily).toLowerCase()) {
      diffs.push(`font-family expected "${expected.fontFamily}", got "${firstFontFamily(actual.fontFamily)}"`);
    }
    for (const prop of ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing']) {
      if (!expected[prop]) continue;
      if (String(actual[prop]).toLowerCase() !== String(expected[prop]).toLowerCase()) {
        diffs.push(`${prop} expected "${expected[prop]}", got "${actual[prop]}"`);
      }
    }
    if (diffs.length) {
      results.issue(cfg, 'typography', 'Typography', `${key}: ${diffs.join('; ')}`, { page: pagePath, selector: expected.selector, details: diffs });
    } else {
      results.pass('Typography', `${key} matches the design specification`, { page: pagePath });
    }
  }
}

function checkBrandColors(cfg, results, pagePath, snap) {
  const rules = cfg.design.colorRules || [];
  if (!rules.length) return;

  const palette = (cfg.design.brandColors || []).map(normalizeColor);
  for (const rule of rules) {
    const actual = snap.colors.find((c) => c.selector === rule.selector && (c.property || 'color') === (rule.property || 'color'));
    if (!actual || !actual.found) {
      results.issue(cfg, 'brandColor', 'Brand colours', `Selector "${rule.selector}" not found for colour check`, { page: pagePath });
      continue;
    }
    const got = normalizeColor(actual.value);
    const expected = rule.expected ? [].concat(rule.expected).map(normalizeColor) : palette;
    if (expected.length && !expected.includes(got)) {
      results.issue(cfg, 'brandColor', 'Brand colours', `${rule.name || rule.selector} ${rule.property || 'color'} is ${got}, expected ${expected.join(' or ')}`, {
        page: pagePath,
        selector: rule.selector,
      });
    } else {
      results.pass('Brand colours', `${rule.name || rule.selector} uses an approved colour (${got})`, { page: pagePath });
    }
  }
}

function checkContactDetails(cfg, results, pages) {
  // pages: Array<{path, snap}>
  const allText = pages.map((p) => p.snap.text).join(' ');
  const digits = digitsOnly(allText);
  const telLinks = uniq(
    pages.flatMap((p) => p.snap.anchors.filter((a) => a.raw.toLowerCase().startsWith('tel:')).map((a) => a.raw.slice(4).trim()))
  );
  const mailtoLinks = uniq(
    pages.flatMap((p) =>
      p.snap.anchors.filter((a) => a.raw.toLowerCase().startsWith('mailto:')).map((a) => a.raw.slice(7).split('?')[0].trim().toLowerCase())
    )
  );

  // Phone
  if (cfg.phone) {
    const expected = digitsOnly(cfg.phone).slice(-10);
    const visible = expected.length >= 7 && digits.includes(expected);
    const inTel = telLinks.some((t) => digitsOnly(t).slice(-10) === expected);

    if (!visible && !inTel) {
      if (cfg.requiredPhone) {
        results.issue(cfg, 'missingPhone', 'Phone number', `Configured phone "${cfg.phone}" was not found in page text or tel: links`, { details: { telLinks } });
      } else {
        results.pass('Phone number', 'No phone configured as required; skipped');
      }
    } else if (visible !== inTel) {
      results.issue(cfg, 'phoneMismatch', 'Phone number', visible ? 'Phone appears as text but no matching tel: link was found' : 'A tel: link exists but the number is not visible as text', {
        details: { telLinks },
      });
    } else {
      results.pass('Phone number', `Phone "${cfg.phone}" found in text and tel: links`);
    }

    const strayTel = telLinks.filter((t) => digitsOnly(t).slice(-10) !== expected);
    if (strayTel.length) {
      results.issue(cfg, 'phoneMismatch', 'Phone number', `tel: link(s) point to a different number: ${strayTel.join(', ')}`, { details: { strayTel } });
    }
  } else if (cfg.requiredPhone) {
    results.issue(cfg, 'missingPhone', 'Phone number', 'requiredPhone is true but no "phone" is configured', {});
  }

  // Email
  if (cfg.email) {
    const expected = String(cfg.email).toLowerCase();
    const visible = allText.toLowerCase().includes(expected);
    const inMailto = mailtoLinks.includes(expected);
    if (!visible && !inMailto) {
      if (cfg.requiredEmail) {
        results.issue(cfg, 'missingEmail', 'Email address', `Configured email "${cfg.email}" was not found in page text or mailto: links`, { details: { mailtoLinks } });
      }
    } else {
      results.pass('Email address', `Email "${cfg.email}" found on the site`);
    }
  } else if (cfg.requiredEmail) {
    results.issue(cfg, 'missingEmail', 'Email address', 'requiredEmail is true but no "email" is configured', {});
  }

  if (cfg.emailDomain) {
    const wrongDomain = mailtoLinks.filter((m) => m.includes('@') && m.split('@')[1] !== String(cfg.emailDomain).toLowerCase());
    if (wrongDomain.length) {
      results.issue(cfg, 'emailDomain', 'Email address', `mailto: link(s) use an unexpected domain: ${wrongDomain.join(', ')}`, { details: { wrongDomain } });
    }
  }
}

async function checkPrivacyPolicy(cfg, results, homeSnap) {
  if (!cfg.privacyPolicyUrl) return;
  const url = urlFromPath(cfg, cfg.privacyPolicyUrl);
  const status = await fetchStatus(url, cfg);
  if (!status.ok) {
    results.issue(cfg, 'privacyPolicy', 'Privacy policy', `${cfg.privacyPolicyUrl} returned HTTP ${status.status || status.error}`, { page: cfg.privacyPolicyUrl });
  } else {
    results.pass('Privacy policy', `${cfg.privacyPolicyUrl} exists (HTTP ${status.status})`, { page: cfg.privacyPolicyUrl });
  }

  const target = normalizeKey(url);
  const link = homeSnap.anchors.find((a) => {
    if (normalizeKey(a.href) === target) return true;
    return /privacy/i.test(a.text);
  });
  if (!link) {
    results.issue(cfg, 'privacyPolicy', 'Privacy policy link', 'No Privacy Policy link found in the header, navigation or footer of the homepage', { page: '/' });
  } else if (!link.inHeader && !link.inFooter && !link.inNav) {
    results.issue(cfg, 'privacyPolicy', 'Privacy policy link', 'Privacy Policy link exists but is not in the header, navigation or footer', { page: '/' });
  } else {
    results.pass('Privacy policy link', 'Privacy Policy is linked from global navigation or footer', { page: '/' });
  }
}

function checkLogo(cfg, results, homeSnap) {
  if (!cfg.logoSelector) return;
  const logo = homeSnap.logo;
  if (!logo || !logo.found) {
    results.issue(cfg, 'logoLink', 'Logo link', `No element matched the configured logoSelector "${cfg.logoSelector}"`, { page: '/' });
    return;
  }
  if (!logo.clickable || !logo.href) {
    results.issue(cfg, 'logoLink', 'Logo link', 'Logo is not clickable (no surrounding or inner <a>)', { page: '/' });
    return;
  }
  const home = normalizeKey(`${cfg.baseUrl}/`);
  if (normalizeKey(logo.href) !== home) {
    results.issue(cfg, 'logoLink', 'Logo link', `Logo links to ${rel(cfg, logo.href)} instead of /`, { page: '/' });
    return;
  }
  if (!logo.visible) {
    results.issue(cfg, 'logoLink', 'Logo link', 'Logo element is present but not visible', { page: '/' });
    return;
  }
  results.pass('Logo link', 'Logo is visible, clickable and links to the homepage', { page: '/' });
}

function checkForms(cfg, results, pagePath, snap) {
  const hasNative = snap.nativeForms.length > 0;
  const hasEmbedded = snap.matchedSelectors.some((s) => s !== 'form');

  if (!hasNative && !hasEmbedded) {
    results.issue(cfg, 'missingForm', 'Contact form', `Required form not found on ${pagePath} (tried: ${(cfg.formSelectors || []).join(', ')})`, { page: pagePath });
    return;
  }
  results.pass('Contact form', `Form present on ${pagePath} (${hasNative ? `${snap.nativeForms.length} native form(s)` : 'embedded form'})`, { page: pagePath });

  for (const form of snap.nativeForms) {
    const label = form.id || form.name || `form #${form.index + 1}`;

    const missingFields = (cfg.formRequiredFields || []).filter((token) => {
      const needle = String(token).toLowerCase();
      return !form.fields.some((f) =>
        [f.name, f.label, f.placeholder, f.type].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle))
      );
    });
    if (missingFields.length) {
      results.issue(cfg, 'formFields', 'Form fields', `${label} is missing required field(s): ${missingFields.join(', ')}`, { page: pagePath });
    }

    if (!form.hasSubmit) {
      results.issue(cfg, 'formFields', 'Form fields', `${label} has no submit button`, { page: pagePath });
    }

    const unlabelled = form.fields.filter((f) => !f.label);
    if (unlabelled.length) {
      results.issue(cfg, 'formLabels', 'Form labels', `${label} has ${unlabelled.length} field(s) with no label or accessible name: ${unlabelled.map((f) => f.name || f.type).join(', ')}`, {
        page: pagePath,
      });
    }

    if (!missingFields.length && form.hasSubmit && !unlabelled.length) {
      results.pass('Form fields', `${label} has required fields, labels and a submit button`, { page: pagePath });
    }

    // Identity consistency inside the form region
    const region = `${form.heading} ${form.text}`.toLowerCase();
    for (const forbidden of cfg.forbiddenBusinessNames || []) {
      if (forbidden && region.includes(String(forbidden).toLowerCase())) {
        results.issue(cfg, 'formIdentity', 'Form identity', `${label} contains the wrong company name "${forbidden}"`, { page: pagePath, detected: forbidden });
      }
    }
  }

  for (const frame of snap.embeddedForms) {
    const text = `${frame.title} ${frame.src}`.toLowerCase();
    for (const forbidden of cfg.forbiddenBusinessNames || []) {
      if (forbidden && text.includes(String(forbidden).toLowerCase())) {
        results.issue(cfg, 'formIdentity', 'Form identity', `Embedded form references the wrong company name "${forbidden}" (${truncate(frame.src, 80)})`, {
          page: pagePath,
          detected: forbidden,
        });
      }
    }
  }
}

async function checkRobots(cfg, results) {
  if (cfg.robots?.enabled === false) return;
  const url = urlFromPath(cfg, '/robots.txt');
  const res = await fetchText(url, cfg);
  if (!res.ok) {
    results.issue(cfg, 'robotsMissing', 'robots.txt', `/robots.txt returned HTTP ${res.status || res.error}`, { page: '/robots.txt' });
    return;
  }

  // Look for a global block that disallows the whole site.
  const lines = res.body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  let inGlobalBlock = false;
  let blocked = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      inGlobalBlock = value === '*';
    } else if (inGlobalBlock && key === 'disallow' && value === '/') {
      blocked = true;
    }
  }

  if (blocked) {
    results.issue(cfg, 'robotsBlocked', 'robots.txt', 'robots.txt blocks the entire site (User-agent: * / Disallow: /)', { page: '/robots.txt' });
  } else {
    results.pass('robots.txt', 'robots.txt exists and does not block the whole site', { page: '/robots.txt' });
  }
}

async function checkSitemap(cfg, results) {
  if (cfg.sitemap?.enabled === false) return;
  const paths = cfg.sitemap?.paths?.length ? cfg.sitemap.paths : ['/sitemap-index.xml', '/sitemap.xml'];
  const found = [];
  for (const p of paths) {
    const status = await fetchStatus(urlFromPath(cfg, p), cfg);
    if (status.ok) found.push(p);
  }
  if (found.length) {
    results.pass('Sitemap', `Sitemap available at ${found.join(', ')}`);
  } else {
    results.issue(cfg, 'sitemap', 'Sitemap', `No sitemap found (checked ${paths.join(', ')})`);
  }
}

/* ------------------------------------------------------------------ */
/* Module entry point                                                  */
/* ------------------------------------------------------------------ */

await runModule('core', async (cfg, results) => {
  const crawl = await getCrawl(cfg);

  checkRequiredPages(cfg, results, crawl);

  const requiredSet = new Set((cfg.requiredPages || []).map((p) => normalizeKey(urlFromPath(cfg, p))));
  const formSet = new Set((cfg.formPages || []).map((p) => normalizeKey(urlFromPath(cfg, p))));

  let seoTargets;
  if (cfg.seo.pages?.length) {
    seoTargets = cfg.seo.pages.map((p) => normalizeKey(urlFromPath(cfg, p)));
  } else if (cfg.seo.checkAllCrawledPages) {
    seoTargets = okPages(crawl).map((p) => p.url);
  } else {
    seoTargets = [...requiredSet];
  }

  const targets = uniq([...requiredSet, ...formSet, ...seoTargets, normalizeKey(`${cfg.baseUrl}/`)]);

  const browser = await launchBrowser('chromium');
  const context = await browser.newContext({ viewport: viewportOf(cfg, 'desktop') });
  const page = await context.newPage();
  const collectors = attachCollectors(page, cfg);
  const opts = snapshotOptions(cfg);

  const snapshots = [];
  try {
    for (const url of targets) {
      const pagePath = rel(cfg, url);
      collectors.reset();
      try {
        const response = await gotoSettled(page, url, cfg);
        if (response && response.status() >= 400) {
          // Already reported by the required-page check; skip content assertions.
          continue;
        }
      } catch (err) {
        results.issue(cfg, 'brokenRequiredPage', 'Page load', `${pagePath} failed to load: ${truncate(String(err?.message || err))}`, { page: pagePath });
        continue;
      }

      const snap = await snapshot(page, opts);
      snapshots.push({ path: pagePath, url, snap });

      if (seoTargets.includes(url)) checkSeo(cfg, results, pagePath, snap);
      checkBusinessName(cfg, results, pagePath, snap, requiredSet.has(url));
      checkAccessibleNames(cfg, results, pagePath, snap);
      if (formSet.has(url)) checkForms(cfg, results, pagePath, snap);
      reportRuntime(cfg, results, collectors, pagePath);
    }

    const home = snapshots.find((s) => s.url === normalizeKey(`${cfg.baseUrl}/`)) || snapshots[0];
    if (home) {
      checkTypography(cfg, results, home.path, home.snap);
      checkBrandColors(cfg, results, home.path, home.snap);
      checkLogo(cfg, results, home.snap);
      await checkPrivacyPolicy(cfg, results, home.snap);
    }

    checkContactDetails(cfg, results, snapshots);

    await check404Page(cfg, results, page);
  } finally {
    await context.close();
    await browser.close();
  }

  await checkRobots(cfg, results);
  await checkSitemap(cfg, results);
});
