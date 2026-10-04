/**
 * Shared helpers for the Astro website QA engine.
 *
 * Every QA module imports from here so that config loading, URL handling,
 * severity resolution and result reporting behave identically everywhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const ROOT = process.cwd();
export const RESULTS_DIR = path.join(ROOT, 'qa-results');
export const SCREENSHOT_DIR = path.join(RESULTS_DIR, 'screenshots');
export const CRAWL_FILE = path.join(RESULTS_DIR, 'crawl.json');

export const PASS = 'pass';
export const WARNING = 'warning';
export const ERROR = 'error';
export const OFF = 'off';

/**
 * Default severity for every rule the engine can report.
 * Override any of these in qa-config.json -> "severity".
 * Use "off" to disable a rule entirely.
 */
export const DEFAULT_SEVERITY = {
  // pages / links / images
  brokenRequiredPage: ERROR,
  notFoundPage: ERROR,
  internalLink: ERROR,
  softNotFound: ERROR,
  externalLink: WARNING,
  externalTargetBlank: WARNING,
  criticalImage: ERROR,
  nonCriticalImage: WARNING,
  distortedImage: WARNING,
  backgroundImage: WARNING,
  imageSize: WARNING,
  lazyLoading: WARNING,
  imageFormat: WARNING,
  missingAlt: WARNING,
  // identity / contact
  missingForm: ERROR,
  formFields: ERROR,
  formLabels: WARNING,
  formIdentity: ERROR,
  forbiddenBusinessName: ERROR,
  missingBusinessName: WARNING,
  missingPhone: ERROR,
  phoneMismatch: WARNING,
  missingEmail: ERROR,
  emailDomain: WARNING,
  privacyPolicy: ERROR,
  logoLink: ERROR,
  // layout / design
  horizontalOverflow: ERROR,
  missingElement: ERROR,
  elementOverlap: WARNING,
  clippedText: WARNING,
  containerWidth: WARNING,
  pageGutter: WARNING,
  visualRegression: WARNING,
  typography: WARNING,
  brandColor: WARNING,
  focusIndicator: WARNING,
  hoverState: WARNING,
  interaction: ERROR,
  // seo / a11y
  seoTitle: ERROR,
  seoDescription: ERROR,
  seoH1: ERROR,
  seoNoindex: ERROR,
  seoViewport: ERROR,
  seoLang: ERROR,
  seoCanonical: WARNING,
  seoOpenGraph: WARNING,
  seoMultipleH1: WARNING,
  headingSkip: WARNING,
  accessibilityCritical: ERROR,
  accessibilityMinor: WARNING,
  robotsMissing: WARNING,
  robotsBlocked: ERROR,
  sitemap: WARNING,
  // runtime / browsers
  pageError: ERROR,
  consoleError: WARNING,
  failedRequest: WARNING,
  crossBrowser: ERROR,
  // lighthouse
  lighthouse: ERROR,
  // engine
  moduleCrash: ERROR,
};

/** Human-readable titles used in the console banner and qa-report.md. */
export const MODULE_TITLES = {
  core: 'Pages / SEO / Identity',
  links: 'Links',
  images: 'Images',
  responsive: 'Responsive Layout',
  interactions: 'Interactive Elements',
  accessibility: 'Accessibility',
  crossbrowser: 'Cross-Browser',
  visual: 'Visual Regression',
  lighthouse: 'Lighthouse',
};

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function loadConfig() {
  const configPath = process.env.QA_CONFIG
    ? path.resolve(ROOT, process.env.QA_CONFIG)
    : path.join(ROOT, 'scripts', 'qa-config.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(`QA config not found at ${configPath}`);
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`QA config at ${configPath} is not valid JSON: ${err.message}`);
  }

  if (process.env.QA_BASE_URL) cfg.baseUrl = process.env.QA_BASE_URL;
  if (!cfg.baseUrl) throw new Error('qa-config.json must define "baseUrl"');
  cfg.baseUrl = String(cfg.baseUrl).replace(/\/+$/, '');

  cfg.severity = { ...DEFAULT_SEVERITY, ...(cfg.severity || {}) };
  cfg.timeouts = { navigationMs: 30000, requestMs: 15000, ...(cfg.timeouts || {}) };
  cfg.crawl = {
    enabled: true,
    maxPages: 100,
    concurrency: 5,
    checkExternal: true,
    requireExternalBlank: false,
    excludePatterns: [],
    softNotFoundText: [],
    ...(cfg.crawl || {}),
  };
  cfg.viewports = cfg.viewports || { mobile: { width: 375, height: 812 }, desktop: { width: 1920, height: 1080 } };
  cfg.design = {
    containerSelector: null,
    containerMaxWidth: 1280,
    pageGutterMin: 16,
    overflowTolerancePx: 2,
    requiredVisibleSelectors: [],
    noOverlapSelectors: [],
    brandColors: [],
    colorRules: [],
    typography: {},
    ...(cfg.design || {}),
  };
  cfg.imageRules = {
    maxFileSizeKB: 500,
    requireLazyLoadBelowFold: true,
    preferModernFormats: false,
    checkBackgroundImages: true,
    aspectRatioTolerance: 0.1,
    maxPages: 50,
    criticalSelectors: [],
    ...(cfg.imageRules || {}),
  };
  cfg.runtime = { ignorePatterns: [], ...(cfg.runtime || {}) };
  cfg.seo = { checkAllCrawledPages: true, pages: [], requireCanonical: true, requireOpenGraph: true, ...(cfg.seo || {}) };
  cfg.lighthouse = { enabled: true, numberOfRuns: 2, performance: 0.75, accessibility: 0.9, bestPractices: 0.9, seo: 0.9, ...(cfg.lighthouse || {}) };
  cfg.configPath = configPath;

  // Typography blocks may omit "selector"; default it to the config key.
  for (const [key, rule] of Object.entries(cfg.design.typography || {})) {
    if (rule && !rule.selector) rule.selector = key;
  }

  return cfg;
}

/** Resolve the configured severity for a rule key. */
export function sev(cfg, key) {
  const value = cfg?.severity?.[key] ?? DEFAULT_SEVERITY[key] ?? WARNING;
  return value === true ? ERROR : value === false ? OFF : value;
}

/* ------------------------------------------------------------------ */
/* URLs                                                                */
/* ------------------------------------------------------------------ */

const NON_HTTP_PREFIX = /^(mailto:|tel:|sms:|javascript:|data:|blob:|ftp:|callto:|whatsapp:)/i;
const ASSET_EXTENSION = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|wav|woff2?|ttf|eot|xml|txt|json|rss)$/i;

export function isSkippableHref(href) {
  if (!href) return true;
  const trimmed = href.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('#')) return true;
  return NON_HTTP_PREFIX.test(trimmed);
}

export function absolute(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function urlFromPath(cfg, p) {
  return new URL(p, `${cfg.baseUrl}/`).toString();
}

export function isHttp(url) {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function sameOrigin(url, baseUrl) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export function isAssetUrl(url) {
  try {
    return ASSET_EXTENSION.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Canonical form of a URL for de-duplication: no hash, sorted query,
 * trailing slash on extension-less paths.
 */
export function normalizeKey(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return String(input);
  }
  url.hash = '';
  const params = [...url.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  url.search = params.length ? new URLSearchParams(params).toString() : '';
  let pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (!ASSET_EXTENSION.test(pathname) && !pathname.endsWith('/')) pathname += '/';
  url.pathname = pathname;
  return url.toString();
}

/** Short display form: "/about/?x=1" instead of the whole absolute URL. */
export function rel(cfg, url) {
  try {
    const u = new URL(url);
    if (u.origin !== new URL(cfg.baseUrl).origin) return url;
    return `${u.pathname}${u.search}`;
  } catch {
    return String(url);
  }
}

export function isExcluded(cfg, url) {
  const patterns = cfg.crawl.excludePatterns || [];
  if (!patterns.length) return false;
  let target;
  try {
    const u = new URL(url);
    target = `${u.pathname}${u.search}`;
  } catch {
    target = String(url);
  }
  return patterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(target);
    } catch {
      return target.includes(p);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export class Results {
  constructor(moduleName) {
    this.module = moduleName;
    this.items = [];
    this.startedAt = new Date().toISOString();
  }

  record(status, check, message, extra = {}) {
    if (status === OFF) return null;
    const item = { module: this.module, check, status, message, ...extra };
    this.items.push(item);
    const prefix = status === ERROR ? 'FAIL' : status === WARNING ? 'WARN' : 'PASS';
    const where = extra.page ? ` (${extra.page})` : '';
    console.log(`  [${prefix}] ${check}: ${message}${where}`);
    return item;
  }

  pass(check, message, extra) {
    return this.record(PASS, check, message, extra);
  }

  warn(check, message, extra) {
    return this.record(WARNING, check, message, extra);
  }

  error(check, message, extra) {
    return this.record(ERROR, check, message, extra);
  }

  /** Record using the configured severity for `key`. */
  issue(cfg, key, check, message, extra) {
    return this.record(sev(cfg, key), check, message, { rule: key, ...extra });
  }

  counts() {
    return {
      pass: this.items.filter((i) => i.status === PASS).length,
      warning: this.items.filter((i) => i.status === WARNING).length,
      error: this.items.filter((i) => i.status === ERROR).length,
    };
  }

  save() {
    ensureDir(RESULTS_DIR);
    const payload = {
      module: this.module,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      counts: this.counts(),
      items: this.items,
    };
    fs.writeFileSync(path.join(RESULTS_DIR, `${this.module}.json`), JSON.stringify(payload, null, 2));
    return payload;
  }
}

/**
 * Wraps a module body so an unexpected crash becomes a reportable ERROR
 * instead of an opaque CI failure. Modules always exit 0; qa-reporter.mjs
 * is the single gate that decides PASS/FAIL.
 */
export async function runModule(moduleName, fn) {
  const results = new Results(moduleName);
  console.log(`\n--- QA module: ${moduleName} ---`);
  try {
    const cfg = loadConfig();
    await fn(cfg, results);
  } catch (err) {
    results.error('QA module crashed', `${moduleName}: ${err?.stack || err?.message || err}`, { rule: 'moduleCrash' });
  }
  const payload = results.save();
  console.log(
    `--- ${moduleName}: ${payload.counts.pass} pass / ${payload.counts.warning} warning / ${payload.counts.error} error ---`
  );
  return payload;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

export async function fetchStatus(url, cfg, { method = 'GET' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeouts.requestMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'astro-qa-bot/1.0 (+github-actions)' },
    });
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      contentType: res.headers.get('content-type') || '',
      contentLength: Number(res.headers.get('content-length')) || null,
    };
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url, cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeouts.requestMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: '', error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Run `worker` over `items` with a bounded concurrency. */
export async function pool(items, concurrency, worker) {
  const queue = [...items];
  const out = [];
  const size = Math.max(1, Math.min(concurrency, queue.length || 1));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (queue.length) {
        const item = queue.shift();
        out.push(await worker(item));
      }
    })
  );
  return out;
}

/* ------------------------------------------------------------------ */
/* Playwright helpers                                                  */
/* ------------------------------------------------------------------ */

export async function launchBrowser(browserName = 'chromium') {
  const playwright = await import('playwright');
  const engine = playwright[browserName];
  if (!engine) throw new Error(`Unknown Playwright browser: ${browserName}`);

  const options = { args: browserName === 'chromium' ? ['--no-sandbox'] : [] };

  // Locally you can run against an already-installed Chrome or Edge instead of
  // Playwright's bundled build: QA_CHROMIUM_CHANNEL=chrome npm run qa:all
  // CI should leave this unset so every run uses the pinned browser build.
  if (browserName === 'chromium' && process.env.QA_CHROMIUM_CHANNEL) {
    options.channel = process.env.QA_CHROMIUM_CHANNEL;
  }

  return engine.launch(options);
}

export function viewportOf(cfg, name, fallback = 'desktop') {
  return cfg.viewports[name] || cfg.viewports[fallback] || { width: 1366, height: 768 };
}

/**
 * Collect runtime noise (console errors, uncaught exceptions, failed
 * requests) from a page, filtered by the configured ignore patterns.
 */
export function attachCollectors(page, cfg) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const patterns = (cfg.runtime.ignorePatterns || []).map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  });
  const ignored = (text) => patterns.some((re) => re.test(String(text)));

  // The page's own navigation response is reported by the page/link checks;
  // counting it here would double-report every intentional 404 probe.
  const isMainDocument = (request) => {
    try {
      return request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      return false;
    }
  };

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const location = msg.location()?.url || null;
    // Browsers report resource failures without the URL in the message, so the
    // ignore patterns have to be matched against the location as well.
    if (ignored(text) || (location && ignored(location))) return;
    if (location && location === page.url()) return; // the page's own 404/500 response
    consoleErrors.push({ text, location });
  });
  page.on('pageerror', (err) => {
    const text = String(err?.message || err);
    if (!ignored(text)) pageErrors.push({ text });
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (ignored(url) || isMainDocument(req)) return;
    failedRequests.push({ url, status: 0, failure: req.failure()?.errorText || 'request failed' });
  });
  page.on('response', (res) => {
    const status = res.status();
    if (status < 400) return;
    const url = res.url();
    if (ignored(url) || isMainDocument(res.request())) return;
    failedRequests.push({ url, status, failure: `HTTP ${status}` });
  });

  return {
    consoleErrors,
    pageErrors,
    failedRequests,
    sameOriginFailures: () => failedRequests.filter((f) => sameOrigin(f.url, cfg.baseUrl)),
    reset() {
      consoleErrors.length = 0;
      pageErrors.length = 0;
      failedRequests.length = 0;
    },
  };
}

/** Navigate and settle the page (fonts, lazy content) before measuring. */
export async function gotoSettled(page, url, cfg, { waitUntil = 'domcontentloaded' } = {}) {
  const response = await page.goto(url, { waitUntil, timeout: cfg.timeouts.navigationMs });
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    /* networkidle is best-effort; third-party embeds often keep connections open */
  }
  return response;
}

/** Scroll the full page so lazy-loaded content renders before measuring. */
export async function scrollThroughPage(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, window.innerHeight * 0.8);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 120));
  });
}

/* ------------------------------------------------------------------ */
/* Value normalisation                                                 */
/* ------------------------------------------------------------------ */

export function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

/** Compare phone numbers by their last 10 digits (ignores country prefix style). */
export function phoneMatches(a, b) {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db) return false;
  const tail = (s) => s.slice(-10);
  return tail(da) === tail(db);
}

/** Normalise "#2563EB", "rgb(37, 99, 235)", "rgba(37,99,235,1)" to "#2563eb". */
export function normalizeColor(value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
  const hex = raw.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return `#${h.slice(0, 6)}`;
  }
  const rgb = raw.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((n) => {
      const v = n.endsWith('%') ? Math.round((parseFloat(n) / 100) * 255) : Math.round(parseFloat(n));
      return Math.max(0, Math.min(255, v || 0));
    });
    if (parts.length === 3) return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }
  return raw;
}

/** The first family in a computed font stack, unquoted and lower-cased. */
export function firstFontFamily(stack) {
  return String(stack || '')
    .split(',')[0]
    .replace(/["']/g, '')
    .trim()
    .toLowerCase();
}

export function pxValue(value) {
  const n = parseFloat(String(value || ''));
  return Number.isFinite(n) ? n : null;
}

export function uniq(list) {
  return [...new Set(list)];
}

export function truncate(text, max = 140) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

export function safeFileName(input) {
  return String(input)
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'page';
}
