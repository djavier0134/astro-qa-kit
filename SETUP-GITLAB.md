# Running the QA gate on GitLab

The QA engine is plain Node + Playwright. Nothing in `scripts/` knows or cares which CI system is running it — it reads `qa-config.json`, drives a browser, writes `qa-report.*` and exits 0 or 1. Only the CI wrapper is platform-specific.

So GitLab is a perfectly good place to prove this out before committing to it across your GitHub repos. When you move, you swap one file.

---

## What changes, what doesn't

| | GitHub Actions | GitLab CI |
| --- | --- | --- |
| QA engine (`scripts/`) | identical | identical |
| `scripts/qa-config.json` | identical | identical |
| `lighthouserc.cjs`, `playwright.config.mjs`, `tests/` | identical | identical |
| npm scripts | identical | identical |
| CI definition | `.github/workflows/qa-deploy.yml` | `.gitlab-ci.yml` |
| Secrets | Settings → Secrets and variables → Actions | Settings → CI/CD → Variables |
| Branch rules | Rulesets → require `Website QA` check | Protected branches + "Pipelines must succeed" |
| Findings shown in review | `::error::` annotations + job summary | **JUnit test report** in the merge request widget |
| Artifacts | `actions/upload-artifact` | `artifacts:` paths |

The reporter writes `qa-report.junit.xml` alongside the markdown and JSON reports. GitLab reads it and renders every check in the merge request: errors appear as **failed tests**, warnings as **skipped**, passes as passed. That is the GitLab equivalent of GitHub's inline annotations, and it is arguably nicer — a reviewer sees the list without opening the job log.

---

## Setup

### 1. Install the kit with the GitLab CI file

```bash
node /path/to/astro-qa-kit/install-qa.mjs . --gitlab
```

That copies `.gitlab-ci.yml` instead of the GitHub workflow. Use `--both` if you want to run the two side by side while migrating.

Then the same local setup as anywhere else:

```bash
npm install -D playwright @playwright/test @lhci/cli wait-on wrangler @axe-core/playwright
```

```bash
npx playwright install --with-deps chromium firefox webkit
```

Configure `scripts/qa-config.json`, get a clean local run with `npm run qa:all`, and only then push. (Steps 1–7 of [SETUP-GITHUB.md](SETUP-GITHUB.md) apply unchanged — they are all local.)

### 2. Add the CI/CD variables

**Settings → CI/CD → Variables → Add variable**, three times:

| Key | Value | Flags |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Scoped token (Account → Cloudflare Pages → Edit) | **Masked**, **Protected** |
| `CLOUDFLARE_ACCOUNT_ID` | From Workers & Pages → Overview | **Masked**, **Protected** |
| `CLOUDFLARE_PROJECT` | Pages project name, exactly | **Protected** |

**Protected** means the variable is only exposed to jobs on protected branches — so a merge request from a fork or a feature branch can never read your Cloudflare token. Set this before you push anything; it is the single most important box on that screen.

Leave `CLOUDFLARE_PROJECT` unmasked: masking requires a minimum length and no special characters, and a project name often fails those rules. It is not sensitive.

### 3. Protect the default branch

**Settings → Repository → Protected branches**

- Branch: `main`
- Allowed to push: **No one**
- Allowed to merge: Maintainers (or Developers + Maintainers)
- Allowed to force push: off

**Settings → Merge requests**

- ☑ **Pipelines must succeed**
- ☑ **All threads must be resolved** (optional, but it pairs well)

"Pipelines must succeed" is the GitLab equivalent of GitHub's required status check. Because `qa-reporter.mjs` exits 1 on any error, a failing QA run fails the job, fails the pipeline, and blocks the merge.

### 4. Push and watch

Push the branch, open a merge request, and check:

- **CI/CD → Pipelines** — the `qa` job runs; the `deploy` job does not appear for a merge request
- **The merge request page** — a test summary widget listing every check
- **Job → Browse artifacts** — `qa-report.md`, screenshots, Lighthouse HTML reports

---

## Runner requirements

The pipeline needs a **Docker executor** runner (the default on GitLab.com shared runners). It uses `node:20-bookworm` and installs Playwright's browsers with `--with-deps`, which needs root in the container — fine on shared runners, fine on most self-hosted ones.

A few things to be aware of:

**Speed.** The first run downloads about 400 MB of browsers. The pipeline caches them in `.playwright/` keyed on `package-lock.json`, so later runs reuse them. Expect roughly 8–15 minutes for a first run and 4–8 after that.

**Faster alternative.** Swap the image for Microsoft's Playwright image, which ships the browsers preinstalled:

```yaml
variables:
  NODE_IMAGE: "mcr.microsoft.com/playwright:v1.49.0-noble"
```

and delete the `npx playwright install` line. **The image tag must match the Playwright version in your `package-lock.json`** — a mismatch produces a confusing "Executable doesn't exist" error. If you would rather not track that, keep the `node:20-bookworm` default.

**Shared runner minutes.** On GitLab.com's free tier, Playwright plus Lighthouse on every push to every branch will consume compute minutes quickly. For a trial, narrow it while you evaluate:

```yaml
qa:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

That runs QA on merge requests and on `main` only, rather than on every branch push. Self-hosted runners have no such limit — run it on everything.

---

## Deploying from GitLab to Cloudflare

`wrangler pages deploy` works identically from GitLab; it only needs the token and account ID in the environment, which the pipeline provides.

**The double-deploy warning applies here too, with a twist.** Cloudflare Pages' Git integration supports GitHub and GitLab both. If this project is already connected to Cloudflare, Cloudflare will build and deploy on its own without ever looking at your QA result. Disconnect it at **Workers & Pages → your project → Settings → Builds & deployments**, or delete the `deploy` job and let Cloudflare own production while QA stays advisory.

**Manual approval before production** is GitLab's protected environments feature (**Settings → CI/CD → Protected environments**), which needs a Premium plan. On Free, the simplest equivalent is adding `when: manual` to the `deploy` job so a person has to click the play button:

```yaml
deploy:
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"
      when: manual
```

---

## Moving to GitHub later

Everything you tune on GitLab carries over. In each repo:

1. Delete `.gitlab-ci.yml`
2. Copy `.github/workflows/qa-deploy.yml` from the kit
3. Move the three CI/CD variables to GitHub as two secrets and one variable
4. Replace the protected-branch rules with a ruleset requiring the `Website QA` check

`scripts/`, `qa-config.json`, `lighthouserc.cjs`, `playwright.config.mjs`, `tests/` and your `package.json` scripts are untouched. All the real work — getting the config right for each client and tuning severities — transfers as-is.

---

## Troubleshooting on GitLab

| Symptom | Fix |
| --- | --- |
| `Executable doesn't exist` for a browser | Playwright image tag does not match the installed Playwright version, or the `.playwright/` cache is stale. Clear the cache (**CI/CD → Pipelines → Clear runner caches**) and re-run. |
| Deploy job can't see `CLOUDFLARE_API_TOKEN` | The variable is **Protected** but the branch is not. Protect `main` first (step 3), then re-run. |
| Two pipelines per push | The `workflow:rules` block at the top of `.gitlab-ci.yml` prevents this — make sure you copied it. |
| Merge request shows no test report | The `qa` job must finish (pass or fail) and upload `qa-report.junit.xml`. Check the job's artifacts; `artifacts: when: always` should have uploaded it even on failure. |
| `wait-on` times out | The preview server never came up — read `preview.log` in the artifacts. SSR sites can't use `astro preview`. |
| Job hits the timeout | Lower `crawl.maxPages`, `responsivePages` and `lighthousePages` in `qa-config.json`, or raise `timeout:` on the job. |

Everything else behaves identically to the GitHub setup — see the troubleshooting table in [README.md](README.md).
