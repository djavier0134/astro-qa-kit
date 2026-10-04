#!/usr/bin/env node
/**
 * Copies this QA kit into an Astro project and patches its package.json.
 *
 *   node install-qa.mjs /path/to/astro-site
 *   node install-qa.mjs /path/to/astro-site --force    (overwrite existing files)
 *   node install-qa.mjs /path/to/astro-site --gitlab   (GitLab CI instead of GitHub Actions)
 *   node install-qa.mjs /path/to/astro-site --both     (both CI files)
 *
 * Existing files are never overwritten without --force, and npm scripts that
 * already exist are left alone. After running it:
 *
 *   cd /path/to/astro-site
 *   npm install -D playwright @playwright/test @lhci/cli wait-on wrangler @axe-core/playwright
 *   npx playwright install --with-deps chromium firefox webkit
 *   # then edit scripts/qa-config.json for this site
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = path.dirname(fileURLToPath(import.meta.url));

const FILES = [
  'scripts/qa-config.json',
  'scripts/qa-lib.mjs',
  'scripts/qa-crawl.mjs',
  'scripts/qa-layout.mjs',
  'scripts/qa-check.mjs',
  'scripts/check-links.mjs',
  'scripts/check-images.mjs',
  'scripts/responsive-check.mjs',
  'scripts/interaction-check.mjs',
  'scripts/accessibility-check.mjs',
  'scripts/cross-browser-check.mjs',
  'scripts/qa-reporter.mjs',
  'scripts/qa-all.mjs',
  'scripts/record-result.mjs',
  'tests/cross-browser.spec.mjs',
  'tests/visual/visual.spec.mjs',
  'lighthouserc.cjs',
  'playwright.config.mjs',
];

const CI_FILES = {
  github: '.github/workflows/qa-deploy.yml',
  gitlab: '.gitlab-ci.yml',
};

export const QA_SCRIPTS = {
  qa: 'node scripts/qa-check.mjs && node scripts/qa-reporter.mjs',
  'qa:all': 'node scripts/qa-all.mjs',
  'qa:core': 'node scripts/qa-check.mjs',
  'qa:links': 'node scripts/check-links.mjs',
  'qa:images': 'node scripts/check-images.mjs',
  'qa:responsive': 'node scripts/responsive-check.mjs',
  'qa:interactions': 'node scripts/interaction-check.mjs',
  'qa:accessibility': 'node scripts/accessibility-check.mjs',
  'qa:cross-browser': 'node scripts/cross-browser-check.mjs',
  'qa:visual': 'playwright test tests/visual --project=chromium',
  'qa:visual:update': 'playwright test tests/visual --project=chromium --update-snapshots',
  'qa:lighthouse': 'lhci autorun --config=lighthouserc.cjs',
  'qa:report': 'node scripts/qa-reporter.mjs',
};

const DEV_DEPENDENCIES = ['playwright', '@playwright/test', '@lhci/cli', 'wait-on', 'wrangler', '@axe-core/playwright'];

const GITIGNORE_ENTRIES = [
  'qa-results/',
  'qa-report.json',
  'qa-report.md',
  'qa-report.junit.xml',
  '.lighthouseci/',
  'preview.log',
  'test-results/',
];

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const target = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());

  // Which CI file to install. Default: GitHub Actions.
  const ciTargets = args.includes('--both')
    ? ['github', 'gitlab']
    : args.includes('--gitlab')
      ? ['gitlab']
      : ['github'];
  const files = [...FILES, ...ciTargets.map((name) => CI_FILES[name])];

  if (!fs.existsSync(path.join(target, 'package.json'))) {
    console.error(`No package.json found in ${target}. Point this at the root of an Astro project.`);
    process.exit(1);
  }
  if (target === KIT_ROOT) {
    console.error('Refusing to install the kit into itself. Pass the path to your Astro project.');
    process.exit(1);
  }

  const copied = [];
  const skipped = [];

  for (const relative of files) {
    const from = path.join(KIT_ROOT, relative);
    const to = path.join(target, relative);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to) && !force) {
      skipped.push(relative);
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied.push(relative);
  }

  // package.json scripts
  const pkgPath = path.join(target, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.scripts = pkg.scripts || {};
  const addedScripts = [];
  for (const [name, command] of Object.entries(QA_SCRIPTS)) {
    if (pkg.scripts[name] && !force) continue;
    pkg.scripts[name] = command;
    addedScripts.push(name);
  }
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  // .gitignore
  const gitignorePath = path.join(target, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const missing = GITIGNORE_ENTRIES.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (missing.length) {
    fs.writeFileSync(gitignorePath, `${existing.replace(/\s*$/, '')}\n\n# Website QA output\n${missing.join('\n')}\n`);
  }

  console.log(`QA kit installed into ${target}\n`);
  if (copied.length) console.log(`Copied:\n  ${copied.join('\n  ')}\n`);
  if (skipped.length) console.log(`Already present (left untouched, use --force to overwrite):\n  ${skipped.join('\n  ')}\n`);
  if (addedScripts.length) console.log(`Added npm scripts: ${addedScripts.join(', ')}\n`);
  if (missing.length) console.log(`Added to .gitignore: ${missing.join(', ')}\n`);

  console.log('Next steps:');
  console.log(`  1. cd ${target}`);
  console.log(`  2. npm install -D ${DEV_DEPENDENCIES.join(' ')}`);
  console.log('  3. npx playwright install --with-deps chromium firefox webkit');
  console.log('  4. Edit scripts/qa-config.json for this site (business name, phone, email, pages, selectors)');
  console.log('  5. npm run build && npm run preview -- --host 127.0.0.1 --port 4321');
  console.log('  6. In a second terminal: npm run qa:all');
  console.log('');
  console.log(
    ciTargets.includes('gitlab')
      ? 'GitLab + Cloudflare walkthrough: SETUP-GITLAB.md in the kit folder'
      : 'Full GitHub + Cloudflare walkthrough: SETUP-GITHUB.md in the kit folder'
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('install-qa.mjs')) {
  main();
}
