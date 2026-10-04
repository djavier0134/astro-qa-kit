/**
 * Lighthouse CI configuration.
 *
 * Pages and thresholds come from scripts/qa-config.json so the same file
 * configures the whole QA system. Assertions are kept here for local use;
 * in CI the authoritative gate is qa-reporter.mjs, which reads
 * .lighthouseci/manifest.json and applies the same thresholds.
 */
const fs = require('node:fs');
const path = require('node:path');

const configPath = process.env.QA_CONFIG
  ? path.resolve(process.cwd(), process.env.QA_CONFIG)
  : path.join(process.cwd(), 'scripts', 'qa-config.json');

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const baseUrl = String(process.env.QA_BASE_URL || cfg.baseUrl).replace(/\/+$/, '');
const lh = cfg.lighthouse || {};

const urls = (cfg.lighthousePages && cfg.lighthousePages.length ? cfg.lighthousePages : ['/']).map((p) =>
  new URL(p, `${baseUrl}/`).toString()
);

const collect = {
  url: urls,
  numberOfRuns: lh.numberOfRuns || 2,
  settings: {
    chromeFlags: '--no-sandbox --disable-gpu --headless=new',
  },
};

if (lh.preset === 'desktop') {
  collect.settings.preset = 'desktop';
}

module.exports = {
  ci: {
    collect,
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: lh.performance ?? 0.75, aggregationMethod: 'median' }],
        'categories:accessibility': ['error', { minScore: lh.accessibility ?? 0.9, aggregationMethod: 'median' }],
        'categories:best-practices': ['error', { minScore: lh.bestPractices ?? 0.9, aggregationMethod: 'median' }],
        'categories:seo': ['error', { minScore: lh.seo ?? 0.9, aggregationMethod: 'median' }],
      },
    },
    upload: {
      // Writes .lighthouseci/manifest.json, which qa-reporter.mjs reads.
      target: 'filesystem',
      outputDir: '.lighthouseci',
      reportFilenamePattern: '%%HOSTNAME%%-%%PATHNAME%%-%%DATETIME%%.report.%%EXTENSION%%',
    },
  },
};
