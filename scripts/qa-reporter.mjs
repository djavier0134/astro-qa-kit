/**
 * QA reporter — the single deployment gate.
 *
 * Reads every qa-results/<module>.json file plus the Lighthouse CI output,
 * applies the configured Lighthouse thresholds, writes qa-report.json and
 * qa-report.md, prints a report for non-technical readers with GitHub
 * Actions annotations, and exits 1 when any ERROR is present.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ERROR, MODULE_TITLES, PASS, RESULTS_DIR, ROOT, WARNING, loadConfig, sev, truncate } from './qa-lib.mjs';

const MODULE_ORDER = ['core', 'links', 'images', 'responsive', 'interactions', 'accessibility', 'crossbrowser', 'visual', 'lighthouse'];

function readModules() {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'crawl.json')
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ai = MODULE_ORDER.indexOf(a.module);
      const bi = MODULE_ORDER.indexOf(b.module);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
}

/* ------------------------------------------------------------------ */
/* Lighthouse                                                          */
/* ------------------------------------------------------------------ */

function readLighthouse(cfg) {
  const items = [];
  const scores = [];
  if (cfg.lighthouse?.enabled === false) return { items, scores };

  const manifestPath = path.join(ROOT, '.lighthouseci', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    items.push({
      module: 'lighthouse',
      check: 'Lighthouse',
      status: WARNING,
      message: 'No Lighthouse results found (.lighthouseci/manifest.json missing) — the Lighthouse step did not run',
    });
    return { items, scores };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    items.push({ module: 'lighthouse', check: 'Lighthouse', status: WARNING, message: `Could not read Lighthouse manifest: ${err.message}` });
    return { items, scores };
  }

  const thresholds = {
    performance: cfg.lighthouse.performance,
    accessibility: cfg.lighthouse.accessibility,
    'best-practices': cfg.lighthouse.bestPractices,
    seo: cfg.lighthouse.seo,
  };

  for (const run of manifest.filter((r) => r.isRepresentativeRun !== false)) {
    const summary = run.summary || {};
    const row = {
      url: run.url,
      performance: summary.performance,
      accessibility: summary.accessibility,
      bestPractices: summary['best-practices'],
      seo: summary.seo,
    };
    scores.push(row);

    const failures = [];
    for (const [category, threshold] of Object.entries(thresholds)) {
      if (typeof threshold !== 'number') continue;
      const score = summary[category];
      if (typeof score !== 'number') continue;
      if (score + 1e-9 < threshold) {
        failures.push(`${category} ${Math.round(score * 100)} < ${Math.round(threshold * 100)}`);
      }
    }

    const label = `Perf ${fmtScore(row.performance)} / A11y ${fmtScore(row.accessibility)} / BP ${fmtScore(row.bestPractices)} / SEO ${fmtScore(row.seo)}`;
    if (failures.length) {
      items.push({
        module: 'lighthouse',
        check: 'Lighthouse',
        status: sev(cfg, 'lighthouse'),
        rule: 'lighthouse',
        page: run.url,
        message: `${run.url} below threshold: ${failures.join(', ')} (${label})`,
      });
    } else {
      items.push({ module: 'lighthouse', check: 'Lighthouse', status: PASS, page: run.url, message: `${run.url} — ${label}` });
    }
  }

  return { items, scores };
}

function fmtScore(value) {
  return typeof value === 'number' ? String(Math.round(value * 100)) : '-';
}

/* ------------------------------------------------------------------ */
/* Report building                                                     */
/* ------------------------------------------------------------------ */

function worst(statuses) {
  if (statuses.includes(ERROR)) return ERROR;
  if (statuses.includes(WARNING)) return WARNING;
  return PASS;
}

function banner(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.module}|${item.check}`;
    if (!groups.has(key)) groups.set(key, { module: item.module, check: item.check, statuses: [], errors: 0, warnings: 0 });
    const group = groups.get(key);
    group.statuses.push(item.status);
    if (item.status === ERROR) group.errors += 1;
    if (item.status === WARNING) group.warnings += 1;
  }

  const lines = [];
  for (const group of groups.values()) {
    const status = worst(group.statuses);
    const tag = status === ERROR ? 'FAIL' : status === WARNING ? 'WARN' : 'PASS';
    const detail =
      status === ERROR ? ` (${group.errors} error${group.errors === 1 ? '' : 's'})` : status === WARNING ? ` (${group.warnings} warning${group.warnings === 1 ? '' : 's'})` : '';
    lines.push(`[${tag}] ${group.check}${detail}`);
  }
  return lines;
}

function markdown(cfg, modules, items, lighthouseScores, counts) {
  const errors = items.filter((i) => i.status === ERROR);
  const warnings = items.filter((i) => i.status === WARNING);
  const verdict = counts.error ? 'FAILED' : 'PASSED';

  const lines = [];
  lines.push('# Website QA Report');
  lines.push('');
  lines.push(`**Result: QA ${verdict}**`);
  lines.push('');
  lines.push(`- Site under test: \`${cfg.baseUrl}\``);
  lines.push(`- Business: ${cfg.businessName || '(not configured)'}`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Totals: **${counts.error} error(s)**, ${counts.warning} warning(s), ${counts.pass} passed check(s)`);
  lines.push('');
  lines.push('Errors block deployment. Warnings are visible but do not block unless configured otherwise.');
  lines.push('');

  lines.push('## Summary by area');
  lines.push('');
  lines.push('| Area | Passed | Warnings | Errors |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const mod of modules) {
    lines.push(`| ${MODULE_TITLES[mod.module] || mod.module} | ${mod.counts.pass} | ${mod.counts.warning} | ${mod.counts.error} |`);
  }
  lines.push('');

  if (lighthouseScores.length) {
    lines.push('## Lighthouse');
    lines.push('');
    lines.push('| Page | Performance | Accessibility | Best Practices | SEO |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const row of lighthouseScores) {
      lines.push(`| ${row.url} | ${fmtScore(row.performance)} | ${fmtScore(row.accessibility)} | ${fmtScore(row.bestPractices)} | ${fmtScore(row.seo)} |`);
    }
    lines.push('');
    lines.push(`Thresholds: Performance ${Math.round(cfg.lighthouse.performance * 100)}, Accessibility ${Math.round(cfg.lighthouse.accessibility * 100)}, Best Practices ${Math.round(cfg.lighthouse.bestPractices * 100)}, SEO ${Math.round(cfg.lighthouse.seo * 100)}.`);
    lines.push('');
  }

  const section = (title, list) => {
    lines.push(`## ${title} (${list.length})`);
    lines.push('');
    if (!list.length) {
      lines.push('_None._');
      lines.push('');
      return;
    }
    lines.push('| Area | Check | Page | Detail |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of list) {
      const where = item.page || item.url || '-';
      const extra = [item.viewport, item.browser].filter(Boolean).join(' / ');
      lines.push(`| ${MODULE_TITLES[item.module] || item.module} | ${item.check} | ${mdEscape(where)}${extra ? ` (${extra})` : ''} | ${mdEscape(item.message)} |`);
    }
    lines.push('');
  };

  section('Errors - deployment blocked', errors);
  section('Warnings', warnings);

  const a11y = items.filter((i) => i.module === 'accessibility' && i.status !== PASS);
  lines.push(`## Accessibility summary (${a11y.length} issue${a11y.length === 1 ? '' : 's'})`);
  lines.push('');
  if (!a11y.length) {
    lines.push('No automated WCAG violations were detected by axe-core on the scanned pages.');
  } else {
    for (const item of a11y) {
      lines.push(`- **${item.check}** on \`${item.page || '-'}\` — ${mdEscape(item.message)}${item.helpUrl ? ` ([how to fix](${item.helpUrl}))` : ''}`);
    }
  }
  lines.push('');
  lines.push('Automated checks catch roughly a third of accessibility problems. Keyboard-only and screen-reader spot checks are still worth doing before launch.');
  lines.push('');

  const screenshots = fs.existsSync(path.join(RESULTS_DIR, 'screenshots'))
    ? fs.readdirSync(path.join(RESULTS_DIR, 'screenshots')).filter((f) => f.endsWith('.png'))
    : [];
  if (screenshots.length) {
    lines.push(`## Screenshots (${screenshots.length})`);
    lines.push('');
    lines.push('Download the `qa-report` artifact from this workflow run to view them.');
    lines.push('');
    for (const file of screenshots) lines.push(`- \`qa-results/screenshots/${file}\``);
    lines.push('');
  }

  lines.push('<details><summary>Passed checks</summary>');
  lines.push('');
  for (const item of items.filter((i) => i.status === PASS)) {
    lines.push(`- ${item.check}: ${mdEscape(item.message)}${item.page ? ` (\`${item.page}\`)` : ''}`);
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');

  return lines.join('\n');
}

function mdEscape(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/* ------------------------------------------------------------------ */
/* JUnit XML — renders as a test report in GitLab merge requests and   */
/* in any other CI that understands JUnit.                             */
/* ------------------------------------------------------------------ */

function xmlEscape(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip control characters that are illegal in XML 1.0.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function junit(modules, items, counts) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(
    `<testsuites name="Website QA" tests="${items.length}" failures="${counts.error}" errors="0" skipped="${counts.warning}">`
  );

  for (const mod of modules) {
    const suiteName = MODULE_TITLES[mod.module] || mod.module;
    lines.push(
      `  <testsuite name="${xmlEscape(suiteName)}" tests="${mod.items.length}" failures="${mod.counts.error}" errors="0" skipped="${mod.counts.warning}">`
    );

    for (const item of mod.items) {
      const where = [item.page, item.viewport, item.browser].filter(Boolean).join(' ');
      const name = `${item.check}${where ? ` [${where}]` : ''}`;
      const open = `    <testcase name="${xmlEscape(name)}" classname="${xmlEscape(suiteName)}"`;

      if (item.status === ERROR) {
        lines.push(`${open}>`);
        lines.push(`      <failure message="${xmlEscape(truncate(item.message, 300))}" type="${xmlEscape(item.rule || 'error')}">${xmlEscape(item.message)}</failure>`);
        lines.push('    </testcase>');
      } else if (item.status === WARNING) {
        // GitLab has no "warning" state; skipped keeps warnings visible in the
        // merge request without them counting as failures.
        lines.push(`${open}>`);
        lines.push(`      <skipped message="${xmlEscape(`WARNING: ${truncate(item.message, 300)}`)}"/>`);
        lines.push('    </testcase>');
      } else {
        lines.push(`${open}/>`);
      }
    }

    lines.push('  </testsuite>');
  }

  lines.push('</testsuites>');
  return lines.join('\n');
}

function annotate(items) {
  if (!process.env.GITHUB_ACTIONS) return;
  for (const item of items) {
    if (item.status === PASS) continue;
    const level = item.status === ERROR ? 'error' : 'warning';
    const title = `${MODULE_TITLES[item.module] || item.module}: ${item.check}`;
    const where = [item.page, item.viewport, item.browser].filter(Boolean).join(' ');
    console.log(`::${level} title=${title}::${truncate(item.message, 400)}${where ? ` [${where}]` : ''}`);
  }
}

/* ------------------------------------------------------------------ */

const cfg = loadConfig();
const modules = readModules();
const { items: lighthouseItems, scores } = readLighthouse(cfg);

if (lighthouseItems.length) {
  modules.push({
    module: 'lighthouse',
    counts: {
      pass: lighthouseItems.filter((i) => i.status === PASS).length,
      warning: lighthouseItems.filter((i) => i.status === WARNING).length,
      error: lighthouseItems.filter((i) => i.status === ERROR).length,
    },
    items: lighthouseItems,
  });
}

const items = modules.flatMap((m) => m.items);
const counts = {
  pass: items.filter((i) => i.status === PASS).length,
  warning: items.filter((i) => i.status === WARNING).length,
  error: items.filter((i) => i.status === ERROR).length,
};

if (!modules.length) {
  console.error('No QA results found in qa-results/. Did the QA modules run?');
  process.exit(1);
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl: cfg.baseUrl,
  businessName: cfg.businessName || null,
  status: counts.error ? 'fail' : counts.warning ? 'pass-with-warnings' : 'pass',
  counts,
  lighthouse: scores,
  modules: modules.map((m) => ({ module: m.module, counts: m.counts })),
  items,
};

fs.writeFileSync(path.join(ROOT, 'qa-report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(ROOT, 'qa-report.md'), markdown(cfg, modules, items, scores, counts));
fs.writeFileSync(path.join(ROOT, 'qa-report.junit.xml'), junit(modules, items, counts));

console.log('');
console.log('==================================');
console.log('WEBSITE QA REPORT');
console.log('==================================');
for (const line of banner(items)) console.log(line);
console.log('');
console.log(`${counts.error} error(s), ${counts.warning} warning(s), ${counts.pass} passed check(s)`);
console.log('');

annotate(items);

const failOnWarnings = cfg.failOnWarnings === true || process.env.QA_FAIL_ON_WARNINGS === '1';
const failed = counts.error > 0 || (failOnWarnings && counts.warning > 0);

console.log(failed ? 'QA FAILED - deployment blocked' : 'QA PASSED');
console.log('Reports written to qa-report.md, qa-report.json and qa-report.junit.xml');

if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, fs.readFileSync(path.join(ROOT, 'qa-report.md'), 'utf8'));
  } catch {
    /* the workflow also cats the report, so this is best-effort */
  }
}

process.exit(failed ? 1 : 0);
