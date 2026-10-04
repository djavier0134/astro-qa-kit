/**
 * Runs the whole QA suite locally, in the same order as CI, and ends with the
 * report. Cross-platform (works on Windows, macOS and Linux).
 *
 *   npm run qa:all
 *   npm run qa:all -- --skip lighthouse,crossbrowser
 *   npm run qa:all -- --keep-results      (reuse the previous crawl)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RESULTS_DIR, loadConfig } from './qa-lib.mjs';

const argv = process.argv.slice(2);
const skipArg = argv.includes('--skip') ? argv[argv.indexOf('--skip') + 1] : '';
const skip = new Set(skipArg.split(',').map((s) => s.trim()).filter(Boolean));
const keepResults = argv.includes('--keep-results');

const cfg = loadConfig();

const steps = [
  { id: 'core', label: 'Pages / SEO / forms / identity', command: 'node', args: ['scripts/qa-check.mjs'] },
  { id: 'links', label: 'Broken links', command: 'node', args: ['scripts/check-links.mjs'] },
  { id: 'images', label: 'Broken images', command: 'node', args: ['scripts/check-images.mjs'] },
  { id: 'responsive', label: 'Responsive layout', command: 'node', args: ['scripts/responsive-check.mjs'] },
  { id: 'interactions', label: 'Interactive elements', command: 'node', args: ['scripts/interaction-check.mjs'] },
  { id: 'accessibility', label: 'Accessibility', command: 'node', args: ['scripts/accessibility-check.mjs'] },
  { id: 'crossbrowser', label: 'Cross-browser smoke tests', command: 'node', args: ['scripts/cross-browser-check.mjs'] },
];

if (cfg.visualRegression?.enabled) {
  steps.push({ id: 'visual', label: 'Visual regression', command: 'npx', args: ['playwright', 'test', 'tests/visual', '--project=chromium'], soft: true, rule: 'visualRegression' });
}
if (cfg.lighthouse?.enabled !== false) {
  steps.push({ id: 'lighthouse', label: 'Lighthouse CI', command: 'npx', args: ['lhci', 'autorun', '--config=lighthouserc.cjs'], soft: true });
}

function run(command, args, { soft = false } = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0 && !soft) {
    console.error(`\n"${command} ${args.join(' ')}" exited with ${result.status}`);
  }
  return result.status ?? 1;
}

if (!keepResults && fs.existsSync(RESULTS_DIR)) {
  fs.rmSync(RESULTS_DIR, { recursive: true, force: true });
}
for (const stale of ['qa-report.md', 'qa-report.json']) {
  const file = path.join(process.cwd(), stale);
  if (fs.existsSync(file)) fs.rmSync(file);
}

console.log(`Running QA against ${cfg.baseUrl}\n`);

for (const step of steps) {
  if (skip.has(step.id)) {
    console.log(`\n== Skipping ${step.label} ==`);
    continue;
  }
  console.log(`\n== ${step.label} ==`);
  const status = run(step.command, step.args, { soft: step.soft });

  // Visual regression runs in the Playwright runner, so fold its outcome in.
  if (step.id === 'visual') {
    run('node', [
      'scripts/record-result.mjs',
      '--module', 'visual',
      '--check', 'Visual regression',
      '--rule', step.rule,
      '--outcome', status === 0 ? 'success' : 'failure',
      '--message', 'Screenshot comparison against the approved baselines',
    ], { soft: true });
  }
}

console.log('\n== QA report ==');
process.exit(run('node', ['scripts/qa-reporter.mjs'], { soft: true }));
