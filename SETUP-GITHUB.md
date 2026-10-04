# Implementing the QA gate in GitHub — step by step

A complete walkthrough for taking one Astro repo from "no QA" to "QA runs on every push and production can only deploy from `main` after it passes".

**Time:** about 60–90 minutes for the first site. 10 minutes for every site after that.

**You need:**

- An Astro site in a GitHub repo, with `package-lock.json` committed (the workflow uses `npm ci`)
- **Admin** access to that repo (needed for secrets, variables and rulesets)
- Node 20+ locally
- Access to the Cloudflare account that owns, or will own, the Pages project

---

## Phase 1 — Get it working on your machine first

Do not push anything until QA passes locally. A red first CI run with 40 findings is demoralising and slow to debug through the Actions log.

### Step 1. Branch

```bash
git checkout main && git pull
```

```bash
git checkout -b setup/qa-cicd
```

### Step 2. Copy the QA kit in

From wherever you keep `astro-qa-kit`:

```bash
node /path/to/astro-qa-kit/install-qa.mjs .
```

Run it from the root of the Astro project (the `.` is the target). It copies the engine, the workflow, `lighthouserc.cjs`, `playwright.config.mjs` and the test files, adds the `qa:*` npm scripts, and appends the QA output folders to `.gitignore`. It never overwrites a file that already exists — pass `--force` if you are deliberately upgrading a site that already has the kit.

Check what landed:

```bash
git status --short
```

You should see `scripts/`, `tests/`, `lighthouserc.cjs`, `playwright.config.mjs`, `.github/workflows/qa-deploy.yml`, plus modified `package.json` and `.gitignore`.

### Step 3. Install the QA dependencies

```bash
npm install -D playwright @playwright/test @lhci/cli wait-on wrangler @axe-core/playwright
```

```bash
npx playwright install --with-deps chromium firefox webkit
```

The browser download is ~400 MB and runs once per machine. On Windows, drop `--with-deps` (it installs Linux system packages and is a no-op elsewhere).

### Step 4. Configure the site

Open `scripts/qa-config.json`. This is the **only** file that changes between clients — the engine itself contains no client names or URLs.

Work through these in order:

**Identity — the checks that catch copy-paste disasters**

```json
"businessName": "Acme Plumbing",
"businessNameAliases": ["Acme Plumbing Ltd", "Acme"],
"forbiddenBusinessNames": ["Nextkin", "Lorem Ipsum Co", "Previous Client Name"],
```

`forbiddenBusinessNames` is the highest-value field here. Put in the name of whatever site this one was cloned from, plus any placeholder text your templates use. A leaked name is an instant FAIL, which is exactly what you want before a client sees it.

**Contact details**

```json
"phone": "+1 604 555 1234",
"requiredPhone": true,
"email": "hello@acmeplumbing.com",
"emailDomain": "acmeplumbing.com",
"requiredEmail": true,
```

The phone is compared on its last 10 digits, so `(604) 555-1234` and `+16045551234` both match. The engine checks visible text **and** `tel:`/`mailto:` links, and warns if they disagree.

**Pages**

```json
"requiredPages": ["/", "/about/", "/services/", "/contact/", "/privacy-policy/"],
"formPages": ["/contact/", "/request-a-quote/"],
"responsivePages": ["/", "/services/", "/contact/"],
"lighthousePages": ["/", "/about/", "/services/", "/contact/"],
"privacyPolicyUrl": "/privacy-policy/",
```

`requiredPages` doubles as the crawl seed list. Keep `responsivePages` and `lighthousePages` short — they are the slowest checks.

**Selectors — check these against the actual markup**

```json
"logoSelector": "header a.logo",
"headerSelector": "header",
"footerSelector": "footer",
"navSelector": "header nav",
"formSelectors": ["form", "iframe[src*='leadconnectorhq']", "iframe[src*='hubspot']"],
```

Open the site and confirm each one matches. A wrong `logoSelector` produces a confusing "logo not found" error on every run.

**Interactions — replace the placeholder**

The shipped config has one `optional` mobile-nav entry with guessed selectors. Point it at your real markup and set `optional: false` once the component exists:

```json
"interactions": [
  {
    "name": "Mobile navigation",
    "page": "/",
    "viewport": "mobile",
    "trigger": "[data-qa='menu-toggle']",
    "target": "[data-qa='mobile-menu']",
    "expect": "visible",
    "closeAfter": true,
    "optional": false
  }
]
```

Add one entry per menu, modal, dropdown, accordion and drawer. If you control the templates, add `data-qa` attributes — they survive CSS refactors in a way that `.nav__toggle--active` does not.

**Leave these alone for now:** `design.colorRules`, `design.noOverlapSelectors` and `visualRegression` ship empty/disabled on purpose. Turn them on once the design is signed off, or you will spend the first week chasing false failures.

### Step 5. Run it locally

Terminal 1:

```bash
npm run build && npm run preview -- --host 127.0.0.1 --port 4321
```

Terminal 2:

```bash
npm run qa:all
```

While iterating, skip the slow modules:

```bash
npm run qa:all -- --skip lighthouse,crossbrowser
```

Read `qa-report.md` for the full detail. Failed responsive viewports leave screenshots in `qa-results/screenshots/`.

### Step 6. Get to a clean run

Triage every finding into one of three buckets:

| Finding is… | Do this |
| --- | --- |
| A real bug | Fix the site |
| A real rule you are not ready to enforce | Set it to `"warning"` or `"off"` in `severity` |
| A misconfiguration | Fix `qa-config.json` |

What **not** to do is disable things wholesale. The ones worth keeping strict from day one: `forbiddenBusinessName`, `internalLink`, `missingForm`, `brokenRequiredPage`, `horizontalOverflow`, `seoNoindex`, `privacyPolicy`.

Common day-one softenings:

```json
"severity": {
  "accessibilityMinor": "off",
  "lazyLoading": "warning",
  "typography": "warning",
  "externalLink": "off"
}
```

Target: **0 errors.** Warnings are fine to carry.

### Step 7. Commit and push

```bash
git add .
```

```bash
git commit -m "Add automated website QA CI/CD"
```

```bash
git push -u origin setup/qa-cicd
```

---

## Phase 2 — First CI run

### Step 8. Open the pull request

GitHub → **Pull requests** → **New pull request** → base `main`, compare `setup/qa-cicd` → **Create pull request**.

### Step 9. Watch it run

**Actions** tab → the **QA and Deploy** run. You should see the `Website QA` job execute: install → Playwright browsers → build → preview server → the seven QA modules → Lighthouse → report.

The `Deploy to Cloudflare Pages` job will show as **skipped**. That is correct — pull requests never deploy.

If the org restricts GitHub Actions, the run may be blocked. Fix at **Settings → Actions → General → Actions permissions**, allowing at minimum `actions/checkout`, `actions/setup-node`, `actions/cache` and `actions/upload-artifact`.

### Step 10. Read the results

Three places, in order of usefulness:

1. **Job summary** — scroll to the bottom of the run page. The whole `qa-report.md` is rendered there, tables and all. This is the link to send a project manager.
2. **Annotations** — errors and warnings appear inline at the top of the run and against the PR.
3. **Artifacts** — `qa-report-<run id>` at the bottom of the run page, containing `qa-report.md`, `qa-report.json`, screenshots, Lighthouse HTML reports and `preview.log`. Uploaded even when QA fails.

CI is a different machine from yours — expect a few new findings (different fonts, slower Lighthouse). Fix or tune, push again, repeat until green.

---

## Phase 3 — Cloudflare

Skip to Phase 4 if production deploys stay with Cloudflare's own Git integration (see Step 15, Option B).

### Step 11. Make sure a Pages project exists

If the site is already on Cloudflare Pages, note the exact project name (case-sensitive) and go to Step 12.

If not, create a **Direct Upload** project — do not connect it to GitHub, since the workflow is going to do the deploying:

```bash
npx wrangler pages project create acme-plumbing --production-branch=main
```

### Step 12. Create a least-privilege API token

Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token**.

Use the **Edit Cloudflare Workers** template, or build a custom token with:

- **Permissions:** Account → *Cloudflare Pages* → **Edit**
- **Account Resources:** Include → your account only

Copy the token — Cloudflare shows it once.

**Never use the Global API Key.** It has full access to every zone and cannot be scoped.

### Step 13. Find the account ID

Cloudflare dashboard → **Workers & Pages** → **Overview**. The Account ID is in the right-hand sidebar. It is also the hex string in the dashboard URL after `/dash.cloudflare.com/`.

### Step 14. Add the secrets and the variable

Repo → **Settings** → **Secrets and variables** → **Actions**.

On the **Secrets** tab, **New repository secret**, twice:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The token from Step 12 |
| `CLOUDFLARE_ACCOUNT_ID` | The ID from Step 13 |

On the **Variables** tab, **New repository variable**:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_PROJECT` | The Pages project name, exactly |

The project name is a variable rather than a secret deliberately — it is not sensitive, and having it visible makes misconfiguration obvious. The deploy job checks all three before it tries to deploy and fails with a readable annotation naming whichever is missing.

### Step 15. Prevent double deployment

**This is the step people skip, and it quietly defeats the whole gate.**

If Cloudflare Pages is connected directly to the GitHub repo, Cloudflare builds and deploys on its own whenever `main` changes — without ever looking at your QA result. You would have a QA gate that blocks nothing.

Pick one:

**Option A — GitHub Actions owns production.** *(recommended)*

Cloudflare dashboard → **Workers & Pages** → your project → **Settings** → **Builds & deployments** → **Disconnect** the Git integration.

The project, its domain and its deployment history all stay. Only the automatic Git build stops. `wrangler pages deploy` keeps working through the Direct Upload path. From here, nothing reaches production without passing QA.

**Option B — Cloudflare owns production, QA is advisory.**

Keep the Git integration, delete the `deploy` job from `.github/workflows/qa-deploy.yml`, and rely on the branch protection in Phase 4: QA must pass before a PR can merge to `main`, and only merges to `main` trigger Cloudflare's build.

Weaker, because a repo admin pushing straight to `main` bypasses QA entirely. Only choose this if something else depends on Cloudflare's own build pipeline.

### Step 16 (optional). Require a human for production

Repo → **Settings** → **Environments** → **production** → **Required reviewers**.

The deploy job already runs in the `production` environment. Adding reviewers means every production deploy waits for a named person to click approve, even after QA passes. Worth it for a high-stakes client site; unnecessary friction for a brochure site.

---

## Phase 4 — Protect `main`

### Step 17. Create the ruleset

Repo → **Settings** → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**.

- **Name:** `Protect main`
- **Enforcement status:** **Active**
- **Target branches:** Add target → **Include default branch**

Then enable:

- ☑ **Require a pull request before merging** (1 approval is a sensible default)
- ☑ **Require status checks to pass** → **Add checks** → search for and select **`Website QA`**
- ☑ **Block force pushes**

**Create**.

> **`Website QA` not in the list?** The check name only appears after it has reported at least once. Make sure the Phase 2 run finished, then search again. The name comes from the job's `name:` in the workflow — if you rename the job, update the ruleset to match or the rule silently stops protecting anything.

### Step 18. Confirm it bites

On the open PR, the merge button should now be blocked until `Website QA` reports success. Push a commit that fails QA and confirm merging is blocked.

---

## Phase 5 — Prove the gate actually works

Do not trust a gate you have not watched fail. Run these on the setup branch before merging — each one takes about 3 minutes of CI.

| # | Break this | Expected result |
| --- | --- | --- |
| 1 | Push any ordinary change | QA runs, deploy skipped |
| 2 | Add `<a href="/this-page-does-not-exist/">x</a>` | **FAIL** — names the broken target and the page linking to it |
| 3 | Point an `<img src>` at a missing file | **FAIL** or **WARN** per config — names the image and page |
| 4 | Visit any invalid route in a browser | 404 status, header/nav/content/footer intact |
| 5 | Add `<div style="width:1800px">x</div>` | **FAIL** at mobile/tablet + screenshot in the artifact |
| 6 | Delete the form from `/contact/` | **FAIL** — "Required form not found" |
| 7 | Put a `forbiddenBusinessNames` value on a page | **FAIL** — names the value and the page |
| 8 | Break the mobile menu toggle | **FAIL** — interaction check |
| 9 | Remove a `<label>` from a form field | axe reports it at the configured severity |
| 10 | Set `lighthouse.performance` to `0.99` | **FAIL** — deploy does not run |

Revert each one after you have seen it fail. Then confirm the suite is green again.

### Step 19. Merge and watch production deploy

Merge the PR into `main`. The workflow runs again on the push to `main`, and this time — after QA passes — the `Deploy to Cloudflare Pages` job runs `wrangler pages deploy dist`.

Check the Cloudflare dashboard for the new deployment, then load the live site.

**If `npm run build` does not output to `dist/`** (an `outDir` in `astro.config.mjs`), change `dist` in the workflow's deploy step to match.

---

## Phase 6 — The next site

Once the first repo is done, each additional Astro site is:

```bash
git checkout -b setup/qa-cicd
node /path/to/astro-qa-kit/install-qa.mjs .
npm install -D playwright @playwright/test @lhci/cli wait-on wrangler @axe-core/playwright
```

Then edit `scripts/qa-config.json`, add the two secrets and one variable, create the ruleset, and merge. The engine files are identical across every site — only the config differs. When you improve the engine, re-run the installer with `--force` on each site and the configs stay untouched.

Consider keeping `astro-qa-kit` in its own repo so `install-qa.mjs` always pulls the current version.

---

## Daily workflow once it is live

```
Developer branches and pushes
  → GitHub QA runs automatically (every branch, every push)
     → FAIL: developer reads the job summary, fixes, pushes again
     → PASS: PR can be reviewed and approved
  → Merge to main
     → QA runs again
        → PASS → Cloudflare production deployment
        → FAIL → deployment never starts
```

**The rule:** QA runs on every push. Deployment does not. Production deploys only from `main`, only after QA passes.

---

## If something goes wrong

| Symptom | Cause and fix |
| --- | --- |
| `browserType.launch: Executable doesn't exist` | Playwright browsers missing. In CI, confirm the cache key includes `package-lock.json` so a Playwright upgrade re-downloads them. |
| `wait-on` times out | The preview server never came up. Open `preview.log` in the artifact. SSR sites cannot use `astro preview` — serve with the adapter's own command and point `QA_BASE_URL` at it. |
| Every external link fails in CI only | Third-party hosts rate-limit GitHub runners. 401/403/405/429/503/999 are already skipped; set `severity.externalLink: "off"` if still noisy. |
| Lighthouse scores move run to run | Shared runner CPU. Raise `lighthouse.numberOfRuns` to 3 (median is used) or lower the performance threshold. Keep A11y/BP/SEO strict — those are stable. |
| Report says "No Lighthouse results found" | `lhci autorun` did not finish its upload step, so `.lighthouseci/manifest.json` was never written. The step runs with `continue-on-error`, so check its log. |
| Dozens of accessibility findings | Set `severity.accessibilityMinor: "off"`, fix critical/serious first, or list rule ids in `accessibility.disableRules`. |
| "Trigger not found" on interactions | Your selectors differ from the config. Add `data-qa` attributes, or set `"optional": true` while the component is being built. |
| Crawl is slow | Lower `crawl.maxPages`, add `crawl.excludePatterns`, reduce `imageRules.maxPages`. The crawl runs once and is shared by all modules. |
| `wrangler` authentication error | Token lacks `Cloudflare Pages: Edit`, or the account ID belongs to a different account. Confirm `CLOUDFLARE_PROJECT` matches exactly, including case. |
| **The site deployed even though QA failed** | Cloudflare's Git integration is still connected. Go back to Step 15. |

Full configuration reference, the complete severity key list and the per-check breakdown are in [README.md](README.md).
