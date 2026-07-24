import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachToApp } from './cdp.js';
import { launchApp, resetStore, stopApp, waitForCdp } from './app-lifecycle.js';
import { Reporter } from './report.js';
import type { Page } from 'playwright';

const ARTIFACTS = join(process.cwd(), 'artifacts');

/**
 * Bring the shell to a known state before handing the page to a scenario.
 *
 * `resetStore()` wipes the SQLite store but NOT localStorage, which lives in the
 * WebView2 profile — so while the harness shared the default profile, scenarios
 * silently inherited an already-dismissed onboarding from whoever ran the app
 * first. Now that the harness owns its profile (app-lifecycle.ts), every run is
 * genuinely first-run, and the onboarding backdrop — plus the tour overlay that
 * dismissing it starts — swallow clicks meant for the shell.
 *
 * Both dismissals are no-ops when the overlay isn't showing, so this stays
 * correct on a warm profile. Scenarios that want the tour open it explicitly.
 */
async function dismissFirstRunOverlays(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  // Present (though click-intercepted) as soon as Angular boots, so this doubles
  // as the readiness gate: once it is visible the overlays' state is decided.
  await page.getByRole('button', { name: 'Marketplace' }).waitFor({ state: 'visible', timeout: 30_000 });

  const skipOnboarding = page.getByRole('button', { name: /Skip for now/i });
  if (await skipOnboarding.isVisible().catch(() => false)) {
    await skipOnboarding.click();
    await skipOnboarding.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  }

  // Onboarding's complete() hands off to TourService.start(), so on a first-run
  // profile the tour opens the moment onboarding closes.
  const tooltip = page.locator('.tour-tooltip');
  await tooltip.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
  const skipTour = tooltip.locator('[data-act="skip"]');
  if (await skipTour.isVisible().catch(() => false)) {
    await skipTour.click();
    await tooltip.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  }
}

export async function runScenario(
  name: string,
  fn: (ctx: { page: Page; reporter: Reporter }) => Promise<void>,
  opts: { freshStore?: boolean } = {},
): Promise<boolean> {
  const runDir = join(ARTIFACTS, `${Date.now()}-${name}`);
  const reporter = new Reporter(runDir);
  if (opts.freshStore) await resetStore();
  await launchApp();
  await waitForCdp();
  const { browser, page } = await attachToApp();
  // Capture the webview console + page errors → the real acquire/IPC error the
  // generic "We couldn't install this skill." banner hides. Self-diagnosing failures.
  const consoleLog = join(runDir, 'console.log');
  page.on('console', (m) => { try { appendFileSync(consoleLog, `[${m.type()}] ${m.text()}\n`); } catch { /* ignore */ } });
  page.on('pageerror', (e) => { try { appendFileSync(consoleLog, `[pageerror] ${e.message}\n`); } catch { /* ignore */ } });
  let ok = true;
  try {
    await dismissFirstRunOverlays(page);
    await fn({ page, reporter });
  } catch (e) {
    ok = false;
    reporter.step(`scenario '${name}' threw`, false, String(e));
    try { await reporter.shot(page, 'FAILURE'); } catch { /* page may be dead */ }
  } finally {
    await browser.close();
    await stopApp();
  }
  const res = reporter.finish();
  console.log(`[${name}] ${res.failed === 0 && ok ? 'PASS' : 'FAIL'} (${res.passed} ok, ${res.failed} failed) → ${runDir}`);
  return res.failed === 0 && ok;
}
