# Astro Website QA — CI/CD Gate

A reusable, automated pre-live QA engineer for Astro websites.

**QA runs on every push to every branch. Deployment does NOT run on every push. Production deploys only from `main`, and only after QA passes.**

> **Setting this up on a repo for the first time?** Follow [SETUP-GITHUB.md](SETUP-GITHUB.md) — the step-by-step runbook. On GitLab, read [SETUP-GITLAB.md](SETUP-GITLAB.md) first; the engine is identical, only the CI file differs. This README is the reference manual.

- Engine: Node + Playwright, modular, configured entirely by `scripts/qa-config.json`
- Gate: `scripts/qa-reporter.mjs` — the only thing that decides PASS/FAIL
- Output: `qa-report.md` (for project managers), `qa-report.json` (for tooling), `qa-report.junit.xml` (for CI test widgets), screenshots, Lighthouse reports
- Deploy: Cloudflare Pages via Wrangler, blocked by `needs: qa`

---

## 1. What it checks

| # | Check | Default severity on failure |
| --- | --- | --- |
| 1 | Required pages load (4xx/5xx/timeouts; redirects allowed) | ERROR |
| 2 | Custom 404 page: returns 404, has header/nav/content/footer, no broken assets, no overflow | ERROR |
| 3 | Internal links resolve (soft-404 detection included) | ERROR |
| 4 | External links reachable (rate-limited hosts are skipped, not failed) | WARNING |
| 5 | `target="_blank"` on external links (opt-in) | WARNING |
| 6 | Broken images — failed loads, zero natural size, broken background images | ERROR (critical) / WARNING (other) |
| 7 | Image distortion (stretched aspect ratio with `object-fit: fill`) | WARNING |
| 8 | Contact form present on each configured form page (native or embedded) | ERROR |
| 9 | Form required fields, accessible labels, submit button | ERROR / WARNING |
| 10 | Form identity — wrong client/company name inside a form | ERROR |
| 11 | Forbidden business names anywhere on the page (text, title, meta, OG, footer) | ERROR |
| 12 | Expected business name present on required pages | WARNING |
| 13 | Phone number — visible text and `tel:` links agree with the config | ERROR / WARNING |
| 14 | Email address and domain — visible text and `mailto:` links | ERROR / WARNING |
| 15 | Privacy policy page exists and is linked in header/nav/footer | ERROR |
| 16 | Logo is visible, clickable and links to `/` | ERROR |
| 17 | Responsive layout at 5 viewports: horizontal overflow, missing elements, clipped text, overlap | ERROR |
| 18 | Container max-width and page gutters | WARNING |
| 19 | Visual regression against approved baselines (opt-in) | WARNING |
| 20 | Typography — font family/size/weight/line-height per selector | WARNING |
| 21 | Brand colours on key selectors (RGB/HEX normalised) | WARNING |
| 22 | Heading hierarchy — missing H1, multiple H1, skipped levels | ERROR / WARNING |
| 23 | Hover, focus and keyboard-focus states produce a visible change | WARNING |
| 24 | Interactive elements — menus, mobile nav, dropdowns, accordions, tabs, modals, drawers | ERROR |
| 25 | Image optimisation — file-size budget, lazy loading below the fold, modern formats | WARNING |
| 26 | Basic SEO — title, meta description, H1, viewport, lang, accidental `noindex` | ERROR |
| 27 | Canonical and Open Graph metadata | WARNING |
| 28 | Image SEO — missing `alt`, unlabelled icon buttons | WARNING |
| 29 | Accessibility — axe-core WCAG 2.1 A/AA scan | ERROR (critical/serious) / WARNING |
| 30 | `robots.txt` exists and does not block the whole site | ERROR / WARNING |
| 31 | Sitemap exists | WARNING |
| 32 | Browser runtime — uncaught JS errors, console errors, failed same-origin requests | ERROR / WARNING |
| 33 | Cross-browser smoke suite — Firefox + WebKit | ERROR |
| 34 | Lighthouse CI — Performance ≥ 75, Accessibility ≥ 90, Best Practices ≥ 90, SEO ≥ 90 | ERROR |

Every severity is configurable, including `"off"` to disable a rule. See [Severity](#6-severity-tuning).

---

## 2. Install

### Into a new Astro project

From this kit's folder:

```bash
node install-qa.mjs /path/to/your-astro-site
```

That copies the engine, workflow, configs and tests, adds the npm scripts and updates `.gitignore` without overwriting anything that already exists (`--force` overwrites).

Then, in the Astro project:

```bash
npm install -D playwright @playwright/test @lhci/cli wait-on wrangler @axe-core/playwright
```

```bash
npx playwright install --with-deps chromium firefox webkit
```

### Manual install

Copy these into the project root, keeping the paths:

```
scripts/qa-config.json          scripts/qa-check.mjs            scripts/responsive-check.mjs
scripts/qa-lib.mjs              scripts/check-links.mjs         scripts/interaction-check.mjs
scripts/qa-crawl.mjs            scripts/check-images.mjs        scripts/accessibility-check.mjs
scripts/qa-layout.mjs           scripts/qa-reporter.mjs         scripts/cross-browser-check.mjs
scripts/qa-all.mjs              scripts/record-result.mjs
tests/cross-browser.spec.mjs    tests/visual/visual.spec.mjs
lighthouserc.cjs                playwright.config.mjs           .github/workflows/qa-deploy.yml
```

### package.json

```json
{
  "scripts": {
    "qa": "node scripts/qa-check.mjs && node scripts/qa-reporter.mjs",
    "qa:all": "node scripts/qa-all.mjs",
    "qa:core": "node scripts/qa-check.mjs",
    "qa:links": "node scripts/check-links.mjs",
    "qa:images": "node scripts/check-images.mjs",
    "qa:responsive": "node scripts/responsive-check.mjs",
    "qa:interactions": "node scripts/interaction-check.mjs",
    "qa:accessibility": "node scripts/accessibility-check.mjs",
    "qa:cross-browser": "node scripts/cross-browser-check.mjs",
    "qa:visual": "playwright test tests/visual --project=chromium",
    "qa:visual:update": "playwright test tests/visual --project=chromium --update-snapshots",
    "qa:lighthouse": "lhci autorun --config=lighthouserc.cjs",
    "qa:report": "node scripts/qa-reporter.mjs"
  }
}
```

### .gitignore

```
qa-results/
qa-report.json
qa-report.md
.lighthouseci/
preview.log
test-results/
```

---

## 3. Configure for a site

Everything site-specific lives in `scripts/qa-config.json`. The QA engine itself contains no client names or URLs, so the same engine drops into every Astro site you build.

The fields you will change for each client:

| Field | What it does |
| --- | --- |
| `businessName`, `businessNameAliases` | The name that must appear on required pages |
| `forbiddenBusinessNames` | Names from a previous client/template that must never appear — a copy-paste leak is an instant FAIL |
| `phone`, `requiredPhone` | Number checked in visible text and `tel:` links (compared on the last 10 digits, so formatting does not matter) |
| `email`, `emailDomain`, `requiredEmail` | Address checked in visible text and `mailto:` links |
| `privacyPolicyUrl` | Must exist and be linked from header/nav/footer |
| `requiredPages` | Pages that must load, and the crawl seeds |
| `formPages`, `formSelectors`, `formRequiredFields` | Where forms must exist and how to find them (GoHighLevel/LeadConnector, HubSpot and iframe embeds supported) |
| `logoSelector` | The logo element; it must link to `/` |
| `headerSelector`, `footerSelector`, `navSelector` | Site landmarks, if yours are not `header`/`footer`/`nav` |
| `viewports`, `responsivePages` | Breakpoints to test and the pages to test at each |
| `design.*` | Container width, gutters, required-visible selectors, typography and brand-colour rules |
| `imageRules.*` | File-size budget, lazy-loading policy, which images count as critical |
| `interactions[]` | Menus, modals, dropdowns — see below |
| `accessibility.*` | Pages to scan, WCAG tags, rules to disable, which impacts are errors |
| `lighthousePages`, `lighthouse.*` | Pages and thresholds |
| `severity.*` | Per-rule overrides |

### Interactions

Each entry drives one open/close test:

```json
{
  "name": "Mobile navigation",
  "page": "/",
  "viewport": "mobile",
  "trigger": "[data-qa='menu-toggle']",
  "target": "[data-qa='mobile-menu']",
  "expect": "visible",
  "closeAfter": true,
  "optional": false,
  "critical": true
}
```

- `optional: true` — pass quietly when the trigger does not exist (use while a component is still being built)
- `critical: true` (the default) — also run in the Firefox/WebKit smoke suite
- The engine also checks the trigger is keyboard focusable, that Escape or a second activation closes the target, and that no console errors fire

The shipped config has one `optional` mobile-nav entry with common selectors. Replace it with your real selectors — ideally `data-qa` attributes, which survive CSS refactors.

### Typography and colours

```json
"design": {
  "typography": {
    "body": { "selector": "body", "fontFamily": "Inter", "fontSize": "16px", "lineHeight": "24px" },
    "h1":   { "selector": "h1", "fontFamily": "Inter", "fontSize": "48px", "fontWeight": "700" },
    "nav":  { "selector": "header nav a", "fontSize": "16px" }
  },
  "brandColors": ["#111827", "#2563EB"],
  "colorRules": [
    { "name": "Primary button", "selector": ".btn-primary", "property": "backgroundColor", "expected": "#2563EB" },
    { "name": "Body text", "selector": "body", "property": "color", "expected": "#111827" }
  ]
}
```

`colorRules` with no `expected` fall back to the `brandColors` palette. With `colorRules` empty, colour checking is skipped — deliberately, so you do not get false failures before you have specified the design.

### Layout rules

```json
"design": {
  "containerSelector": ".container",
  "containerMaxWidth": 1280,
  "pageGutterMin": 16,
  "overflowTolerancePx": 2,
  "requiredVisibleSelectors": ["header", "main", "footer", "header nav"],
  "noOverlapSelectors": []
}
```

`noOverlapSelectors` is opt-in because generic overlap detection is noisy. List only the elements that must never collide, e.g. `["header .logo", "header nav", ".hero h1"]`.

---

## 4. Run it locally

Terminal 1:

```bash
npm run build && npm run preview -- --host 127.0.0.1 --port 4321
```

Terminal 2:

```bash
npm run qa:all
```

Useful variants:

```bash
npm run qa:all -- --skip lighthouse,crossbrowser
```

```bash
QA_BASE_URL=https://staging.example.com npm run qa:all
```

Individual modules (`npm run qa:core`, `qa:links`, `qa:images`, `qa:responsive`, `qa:interactions`, `qa:accessibility`, `qa:cross-browser`) write to `qa-results/` and always exit 0. `npm run qa:report` aggregates them and is the only command that exits non-zero.

| Environment variable | Effect |
| --- | --- |
| `QA_BASE_URL` | Overrides `baseUrl` (CI sets `http://127.0.0.1:4321`) |
| `QA_CONFIG` | Use a different config file — handy for multi-site repos |
| `QA_REUSE_CRAWL=0` | Force a fresh crawl instead of reusing `qa-results/crawl.json` |
| `QA_FAIL_ON_WARNINGS=1` | Make warnings block deployment too |
| `QA_CHROMIUM_CHANNEL=chrome` | Run against installed Chrome/Edge instead of Playwright's build (local convenience; leave unset in CI) |

The site is crawled **once** per run and cached in `qa-results/crawl.json`; every module reuses it. `npm run qa:all` clears the cache at the start.

---

## 5. How the deployment gate works

```
Developer push
  -> GitHub Actions (every branch)
  -> npm ci -> Playwright browsers -> astro build -> preview server
  -> core / links / images / responsive / interactions / accessibility / cross-browser
  -> Lighthouse CI
  -> qa-reporter.mjs  ->  exit 0 = PASS, exit 1 = FAIL
       |
       +-- FAIL -> job fails -> deploy job never starts
       +-- PASS + push to main -> wrangler pages deploy dist
```

- Each QA module records findings and exits 0, so one crashing module cannot hide the other results. A crash is itself recorded as an ERROR.
- `qa-reporter.mjs` applies the configured severities, writes the reports and exits 1 if any ERROR exists.
- The `deploy` job has `needs: qa` plus `if: github.ref == 'refs/heads/main' && github.event_name == 'push'`. A failing QA job means the deploy job is skipped; a pull request never deploys.
- Artifacts upload with `if: always()`, so you get the report and screenshots **especially** when QA fails.

---

## 6. Severity tuning

Override any rule in `qa-config.json`:

```json
"severity": {
  "missingAlt": "error",
  "externalLink": "off",
  "typography": "error",
  "lazyLoading": "off",
  "accessibilityMinor": "off"
}
```

Values: `"error"` (blocks deployment), `"warning"` (visible, non-blocking), `"off"` (not reported).

Rule keys: `brokenRequiredPage`, `notFoundPage`, `internalLink`, `softNotFound`, `externalLink`, `externalTargetBlank`, `criticalImage`, `nonCriticalImage`, `distortedImage`, `backgroundImage`, `imageSize`, `lazyLoading`, `imageFormat`, `missingAlt`, `missingForm`, `formFields`, `formLabels`, `formIdentity`, `forbiddenBusinessName`, `missingBusinessName`, `missingPhone`, `phoneMismatch`, `missingEmail`, `emailDomain`, `privacyPolicy`, `logoLink`, `horizontalOverflow`, `missingElement`, `elementOverlap`, `clippedText`, `containerWidth`, `pageGutter`, `visualRegression`, `typography`, `brandColor`, `focusIndicator`, `hoverState`, `interaction`, `seoTitle`, `seoDescription`, `seoH1`, `seoNoindex`, `seoViewport`, `seoLang`, `seoCanonical`, `seoOpenGraph`, `seoMultipleH1`, `headingSkip`, `accessibilityCritical`, `accessibilityMinor`, `robotsMissing`, `robotsBlocked`, `pageError`, `consoleError`, `failedRequest`, `crossBrowser`, `lighthouse`, `moduleCrash`.

Set `"failOnWarnings": true` at the top level of the config to make warnings block deployment as well.

---

## 7. GitHub setup

### Secrets — Settings → Secrets and variables → Actions → **Secrets**

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Least-privilege token (see below) |
| `CLOUDFLARE_ACCOUNT_ID` | From the Cloudflare dashboard URL or Workers & Pages overview |

### Variables — same screen, **Variables** tab

| Name | Value |
| --- | --- |
| `CLOUDFLARE_PROJECT` | The Cloudflare Pages project name |

The deploy job fails fast with a clear annotation if any of the three is missing. Credentials are never hardcoded and never passed on the command line.

### Cloudflare API token

Cloudflare dashboard → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template, or a custom token with:

- Permissions: `Account` → `Cloudflare Pages` → `Edit`
- Account Resources: your account only

Do **not** use the Global API Key.

### Branch protection — Settings → Rules → Rulesets

1. New ruleset → Branch ruleset, target `main`
2. Enable **Require a pull request before merging**
3. Enable **Require status checks to pass** and add **`Website QA`** (the job's name; it appears in the list after the workflow has run at least once)
4. Enable **Block force pushes**

Now a PR cannot be merged into `main` until QA passes, and `main` cannot be pushed to directly.

### Preventing double deployment

If Cloudflare Pages is already connected directly to the GitHub repo, **both** Cloudflare and this workflow will deploy — and Cloudflare's own build ignores your QA gate entirely, which defeats the purpose.

Pick one:

**Option A (recommended) — GitHub Actions owns production.**
Cloudflare dashboard → Workers & Pages → your project → Settings → Builds & deployments → **Disconnect** the Git integration (or set Production branch to a branch nobody pushes to, e.g. `cloudflare-disabled`). The project stays; only the automatic Git build stops. `wrangler pages deploy` continues to work via the Direct Upload path.

**Option B — Cloudflare owns production, QA stays advisory.**
Keep the Git integration, delete the `deploy` job from the workflow, and rely on branch protection: QA must pass before a PR can merge into `main`, and only merges into `main` trigger the Cloudflare build. Slightly weaker — a direct push to `main` by an admin would skip QA.

Astro project note: `npm run build` must output to `dist/`. If `astro.config.mjs` sets `outDir`, change `dist` in the workflow's deploy step to match.

---

## 8. Example output

### PASS

```
==================================
WEBSITE QA REPORT
==================================
[PASS] Required page
[PASS] SEO basics
[PASS] Browser runtime
[PASS] Contact form
[PASS] Form fields
[PASS] Typography
[PASS] Logo link
[PASS] Privacy policy
[PASS] Privacy policy link
[PASS] Phone number
[PASS] Email address
[PASS] 404 page
[PASS] 404 page layout
[PASS] robots.txt
[PASS] Sitemap
[PASS] Internal links
[PASS] External links
[PASS] Broken images
[PASS] Image distortion
[PASS] Image alt text
[PASS] Image weight
[PASS] Lazy loading
[PASS] Layout
[PASS] Interaction
[PASS] Hover state
[PASS] Focus indicator
[PASS] Accessibility
[PASS] Cross-browser
[PASS] Lighthouse

0 error(s), 0 warning(s), 51 passed check(s)

QA PASSED
```

Exit code 0 → on `main`, the Cloudflare deploy job runs.

### FAIL

```
==================================
WEBSITE QA REPORT
==================================
[FAIL] Business name (1 error)
[FAIL] Contact form (1 error)
[FAIL] Internal link (1 error)
[FAIL] Horizontal overflow (4 errors)
[WARN] Broken image (1 warning)
[WARN] Image alt text (1 warning)
[WARN] Button states (1 warning)

6 error(s), 5 warning(s), 45 passed check(s)

QA FAILED - deployment blocked
```

With, in the Actions log and on the PR:

```
::error title=Pages / SEO / Identity: Business name::Forbidden business name "Old Client Company" found on the page [/]
::error title=Links: Internal link::/this-page-does-not-exist/ returned HTTP 404 — linked from / [/]
::error title=Responsive Layout: Horizontal overflow::mobile: page scrolls 1441px horizontally — div (right 1816px) [/ mobile]
```

Exit code 1 → the deploy job is skipped.

`qa-report.md` is also posted to the workflow's job summary, so non-technical reviewers can read the result without opening logs.

---

## 9. Verifying the gate (do this once per repo)

| Test | Change | Expected |
| --- | --- | --- |
| Normal push | Push any branch | QA runs, no deploy |
| Broken internal link | Add `<a href="/this-page-does-not-exist/">x</a>` | FAIL, names the page and link |
| Broken image | Point an `<img src>` at a missing file | FAIL or WARN per config, names image and page |
| 404 page | Visit any invalid route | 404 status, intact layout |
| Responsive breakage | Add `<div style="width:1800px">` | FAIL at mobile/tablet + screenshot artifact |
| Missing form | Remove the form from `/contact/` | FAIL "Required form not found" |
| Wrong company name | Put a `forbiddenBusinessNames` value on a page | FAIL, names the value and page |
| Interaction | Break the mobile menu toggle | Interaction check FAILs |
| Accessibility | Remove a form label | axe reports it at the configured severity |
| Cross-browser | — | Firefox + WebKit smoke jobs run |
| Lighthouse gating | Temporarily set `performance: 0.99` | FAIL, deploy skipped |
| Production deploy | Merge a passing PR to `main` | QA runs again, then Cloudflare deploys |

Every row above except the last two (which need a real repo and Cloudflare project) was exercised against a fixture site while this kit was built — broken links, broken images, the 404 probe, mobile overflow, a removed form, a leaked company name, a dead menu toggle, an axe `image-alt` violation and a deliberately unreachable Lighthouse threshold all produced the messages shown here, and the reporter exited 1 each time.

---

## 10. Visual regression (optional)

Off by default. Enable it when a design is signed off and stable:

```json
"visualRegression": { "enabled": true, "maxDiffRatio": 0.01, "pages": ["/"], "viewports": ["mobile", "desktop"] }
```

Create and review baselines, then commit them:

```bash
npm run qa:visual:update
```

Baselines live in `tests/visual/visual.spec.mjs-snapshots/`. They are platform-specific — generate them on Linux (or in the CI container) if CI is to compare against them, otherwise antialiasing differences will produce noise. Failures are recorded as `visualRegression` severity (WARNING by default).

---

## 11. Troubleshooting

**`browserType.launch: Executable doesn't exist`**
Run `npx playwright install --with-deps chromium firefox webkit`. In CI, make sure the cache key includes `package-lock.json` so a Playwright upgrade re-downloads browsers.

**QA cannot reach the site / `wait-on` times out**
The preview server did not start. Check `preview.log` in the artifact. Astro's preview needs `--host 127.0.0.1 --port 4321`; if you changed the port, change `QA_BASE_URL` in the workflow too. Note `astro preview` does not work with SSR adapters — for an SSR site, serve the built output with the adapter's own command and point `QA_BASE_URL` at it.

**Every external link fails in CI but works in a browser**
Third-party hosts rate-limit GitHub runners. 401/403/405/429/503/999 responses are already skipped. Set `crawl.checkExternal: false` or `severity.externalLink: "off"` if it is still noisy.

**Lighthouse scores swing between runs**
Runner CPU is shared. Raise `lighthouse.numberOfRuns` to 3 (median is used), or lower the performance threshold. Keep Accessibility/Best Practices/SEO strict — those are stable.

**Lighthouse step passes but the report says no results**
`lhci autorun` must complete its upload step to write `.lighthouseci/manifest.json`. Check the Lighthouse step's log; the workflow runs it with `continue-on-error` so a Lighthouse crash shows up as a warning rather than silently passing.

**Too many accessibility findings on day one**
Set `severity.accessibilityMinor: "off"` and fix critical/serious first, or list specific rule ids in `accessibility.disableRules`.

**Interaction checks fail with "trigger not found"**
Your selectors differ from the defaults. Add `data-qa` attributes to the toggle and the panel and point the config at them, or set `"optional": true` while the component is in progress.

**Crawl is slow / times out**
Lower `crawl.maxPages`, add patterns to `crawl.excludePatterns`, and reduce `imageRules.maxPages`. The crawl runs once and is shared by all modules.

**`wrangler pages deploy` fails with an authentication error**
The token lacks `Cloudflare Pages: Edit`, or `CLOUDFLARE_ACCOUNT_ID` belongs to a different account. Confirm the project name matches `CLOUDFLARE_PROJECT` exactly (case-sensitive).

**The site deployed even though QA failed**
Cloudflare's own Git integration is still connected. See [Preventing double deployment](#preventing-double-deployment).

---

## 12. Project structure

```
project/
├── src/
├── public/
├── scripts/
│   ├── qa-config.json           ← the only file you edit per site
│   ├── qa-lib.mjs               shared helpers, severity map, result model
│   ├── qa-crawl.mjs             single shared crawl, cached in qa-results/
│   ├── qa-layout.mjs            shared layout audit
│   ├── qa-check.mjs             pages, 404, SEO, identity, contact, forms, robots, sitemap
│   ├── check-links.mjs          internal + external links
│   ├── check-images.mjs         broken/distorted images, alt, weight, lazy loading
│   ├── responsive-check.mjs     viewports, overflow, clipping, screenshots
│   ├── interaction-check.mjs    menus/modals/dropdowns + hover/focus states
│   ├── accessibility-check.mjs  axe-core WCAG scan
│   ├── cross-browser-check.mjs  Firefox + WebKit smoke suite
│   ├── qa-reporter.mjs          the gate — qa-report.md / qa-report.json, exit 0/1
│   ├── qa-all.mjs               run everything locally, in CI order
│   └── record-result.mjs        fold an external CI step into the report
├── tests/
│   ├── cross-browser.spec.mjs   optional Playwright-runner smoke suite
│   └── visual/visual.spec.mjs   optional visual regression
├── .github/workflows/qa-deploy.yml
├── lighthouserc.cjs
├── astro.config.mjs
└── package.json
```

Adding a new check: create `scripts/<name>-check.mjs`, wrap the body in `runModule('<name>', async (cfg, results) => { ... })`, record findings with `results.issue(cfg, '<ruleKey>', 'Check name', 'message', { page })`, add a default severity to `DEFAULT_SEVERITY` in `qa-lib.mjs`, and add a step to the workflow. The reporter picks it up automatically.
