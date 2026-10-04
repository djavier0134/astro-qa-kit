/**
 * Interactive element QA module.
 *
 * Part A: configured interactions (menus, mobile nav, dropdowns, accordions,
 *         tabs, modals, drawers, sliders) open and close correctly, stay
 *         keyboard reachable and produce no console errors.
 * Part B: hover / focus states on key buttons and links produce a visible
 *         style change and a visible keyboard focus indicator.
 *
 * Writes qa-results/interactions.json.
 */
import path from 'node:path';

import {
  SCREENSHOT_DIR,
  attachCollectors,
  ensureDir,
  gotoSettled,
  launchBrowser,
  normalizeKey,
  runModule,
  safeFileName,
  truncate,
  urlFromPath,
  viewportOf,
} from './qa-lib.mjs';

const STYLE_PROPS = ['color', 'backgroundColor', 'borderColor', 'borderWidth', 'textDecorationLine', 'opacity', 'transform', 'boxShadow', 'outlineStyle', 'outlineWidth', 'outlineColor', 'filter'];

async function computedStyles(locator) {
  return locator.evaluate((el, props) => {
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs[p];
    return out;
  }, STYLE_PROPS);
}

function changedProps(before, after, props = STYLE_PROPS) {
  return props.filter((p) => before[p] !== after[p]);
}

/* ------------------------------------------------------------------ */
/* Part A — configured interactions                                    */
/* ------------------------------------------------------------------ */

async function runInteraction(cfg, results, browser, interaction) {
  const name = interaction.name || interaction.trigger;
  const pagePath = interaction.page || '/';
  const viewportName = interaction.viewport || 'desktop';
  const viewport = viewportOf(cfg, viewportName);
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 768 });
  const page = await context.newPage();
  const collectors = attachCollectors(page, cfg);

  try {
    await gotoSettled(page, normalizeKey(urlFromPath(cfg, pagePath)), cfg);

    const trigger = page.locator(interaction.trigger).first();
    if ((await page.locator(interaction.trigger).count()) === 0) {
      if (interaction.optional) {
        results.pass('Interaction', `${name}: no element matched "${truncate(interaction.trigger, 60)}" — optional interaction skipped`, { page: pagePath, viewport: viewportName });
      } else {
        results.issue(cfg, 'interaction', 'Interaction', `${name}: trigger "${truncate(interaction.trigger, 60)}" not found`, { page: pagePath, viewport: viewportName });
      }
      return;
    }

    if (!(await trigger.isVisible())) {
      results.issue(cfg, 'interaction', 'Interaction', `${name}: trigger exists but is not visible at ${viewportName}`, { page: pagePath, viewport: viewportName });
      return;
    }

    // Keyboard reachability of the trigger.
    const reachable = await trigger.evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      if (['button', 'a', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
      const tabindex = el.getAttribute('tabindex');
      return tabindex !== null && Number(tabindex) >= 0;
    });
    if (!reachable) {
      results.issue(cfg, 'accessibilityMinor', 'Interaction', `${name}: trigger is not keyboard focusable (not a button/link and no tabindex)`, { page: pagePath, viewport: viewportName });
    }

    collectors.reset();
    await trigger.click({ timeout: 10000 });

    const expect = interaction.expect || 'visible';
    const target = page.locator(interaction.target).first();
    let opened = true;
    try {
      await target.waitFor({ state: expect === 'hidden' ? 'hidden' : 'visible', timeout: interaction.timeoutMs || 5000 });
    } catch {
      opened = false;
    }

    if (!opened) {
      const file = path.join(SCREENSHOT_DIR, `interaction--${safeFileName(name)}--${viewportName}.png`);
      ensureDir(SCREENSHOT_DIR);
      try {
        await page.screenshot({ path: file, fullPage: false });
      } catch {
        /* screenshot is best-effort */
      }
      results.issue(cfg, 'interaction', 'Interaction', `${name}: after activating the trigger, "${truncate(interaction.target, 60)}" was not ${expect}`, {
        page: pagePath,
        viewport: viewportName,
        screenshot: path.relative(process.cwd(), file),
      });
      return;
    }

    // Close again (Escape first, then the trigger itself).
    if (interaction.closeAfter !== false) {
      await page.keyboard.press('Escape').catch(() => {});
      let closed = await target.isHidden().catch(() => false);
      if (!closed) {
        await trigger.click({ timeout: 5000 }).catch(() => {});
        closed = await target.isHidden().catch(() => false);
      }
      if (!closed) {
        results.warn('Interaction', `${name}: opened correctly but did not close with Escape or a second activation`, { page: pagePath, viewport: viewportName });
      }
    }

    if (collectors.pageErrors.length) {
      results.issue(cfg, 'pageError', 'Interaction', `${name}: JavaScript error during the interaction — ${truncate(collectors.pageErrors[0].text)}`, { page: pagePath, viewport: viewportName });
    } else if (collectors.consoleErrors.length) {
      results.issue(cfg, 'consoleError', 'Interaction', `${name}: ${collectors.consoleErrors.length} console error(s) during the interaction — ${truncate(collectors.consoleErrors[0].text)}`, {
        page: pagePath,
        viewport: viewportName,
      });
    }

    results.pass('Interaction', `${name} opens and closes correctly at ${viewportName}`, { page: pagePath, viewport: viewportName });
  } catch (err) {
    results.issue(cfg, 'interaction', 'Interaction', `${name}: ${truncate(String(err?.message || err), 120)}`, { page: pagePath, viewport: viewportName });
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* Part B — hover / focus states                                       */
/* ------------------------------------------------------------------ */

async function runStateChecks(cfg, results, browser) {
  const states = cfg.states || {};
  if (states.enabled === false) return;

  const pages = states.pages?.length ? states.pages : ['/'];
  const selectors = states.selectors || [];
  if (!selectors.length) return;

  const context = await browser.newContext({ viewport: viewportOf(cfg, 'desktop') });
  const page = await context.newPage();
  attachCollectors(page, cfg);

  try {
    for (const pagePath of pages) {
      try {
        await gotoSettled(page, normalizeKey(urlFromPath(cfg, pagePath)), cfg);
      } catch (err) {
        results.warn('Button states', `Could not load ${pagePath}: ${truncate(String(err?.message || err), 90)}`, { page: pagePath });
        continue;
      }

      // Any overflow the page already has is the responsive module's finding,
      // not a hover-state problem — only an increase counts here.
      const baselineOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

      for (const selector of selectors) {
        const all = page.locator(selector);
        const total = await all.count();
        if (total === 0) {
          results.warn('Button states', `No element matched "${selector}"`, { page: pagePath, selector });
          continue;
        }

        const limit = Math.min(total, states.maxElementsPerSelector || 5);
        let hoverChanges = 0;
        let focusIndicators = 0;
        let checked = 0;

        for (let i = 0; i < limit; i += 1) {
          const el = all.nth(i);
          if (!(await el.isVisible().catch(() => false))) continue;
          checked += 1;

          const label = truncate(await el.innerText().catch(() => ''), 40) || `${selector} #${i + 1}`;

          try {
            const base = await computedStyles(el);

            await el.hover({ timeout: 5000 });
            await page.waitForTimeout(150);
            const hovered = await computedStyles(el);
            if (changedProps(base, hovered).length) hoverChanges += 1;

            // Move the pointer away before testing focus.
            await page.mouse.move(0, 0);
            await page.waitForTimeout(100);

            await el.focus({ timeout: 5000 });
            await page.waitForTimeout(100);
            const focused = await computedStyles(el);
            const focusDiff = changedProps(base, focused, ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderColor', 'backgroundColor', 'color']);
            if (focusDiff.length) focusIndicators += 1;
            else if (states.requireFocusIndicator !== false) {
              results.issue(cfg, 'focusIndicator', 'Focus indicator', `"${label}" shows no visible focus style when focused by keyboard`, { page: pagePath, selector });
            }

            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            const added = overflow - baselineOverflow;
            if (added > (cfg.design.overflowTolerancePx ?? 2)) {
              results.issue(cfg, 'hoverState', 'Hover state', `Interacting with "${label}" added ${added}px of horizontal overflow`, { page: pagePath, selector });
            }
          } catch (err) {
            results.warn('Button states', `Could not test "${label}": ${truncate(String(err?.message || err), 80)}`, { page: pagePath, selector });
          }
        }

        if (!checked) continue;
        if (!hoverChanges) {
          results.issue(cfg, 'hoverState', 'Hover state', `No element matching "${selector}" changed style on hover`, { page: pagePath, selector });
        } else {
          results.pass('Hover state', `"${selector}" responds to hover`, { page: pagePath, selector });
        }
        if (focusIndicators === checked) {
          results.pass('Focus indicator', `"${selector}" shows a visible keyboard focus indicator`, { page: pagePath, selector });
        }
      }
    }
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */

await runModule('interactions', async (cfg, results) => {
  const interactions = cfg.interactions || [];
  const browser = await launchBrowser('chromium');

  try {
    if (!interactions.length) {
      results.warn('Interaction', 'No interactions configured — add menus, modals and dropdowns to qa-config.json -> interactions');
    }
    for (const interaction of interactions) {
      await runInteraction(cfg, results, browser, interaction);
    }
    await runStateChecks(cfg, results, browser);
  } finally {
    await browser.close();
  }
});
