/**
 * Folds the outcome of an external CI step (visual regression, a bespoke
 * Playwright suite, a custom script) into the QA report.
 *
 * Usage:
 *   node scripts/record-result.mjs \
 *     --module visual --check "Visual regression" --rule visualRegression \
 *     --outcome failure --message "Screenshots differ from the baseline"
 *
 * --outcome accepts success | failure | skipped (GitHub step outcomes).
 */
import { Results, loadConfig } from './qa-lib.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
    args[key] = value;
    if (value !== 'true') i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const moduleName = args.module || 'external';
const check = args.check || 'External check';
const outcome = (args.outcome || 'success').toLowerCase();
const rule = args.rule || null;
const message = args.message || `${check} ${outcome}`;

const cfg = loadConfig();
const results = new Results(moduleName);

if (outcome === 'failure') {
  if (rule) results.issue(cfg, rule, check, message);
  else results.error(check, message);
} else if (outcome === 'skipped' || outcome === 'cancelled') {
  results.warn(check, `${message} (step ${outcome})`);
} else {
  results.pass(check, message);
}

results.save();
