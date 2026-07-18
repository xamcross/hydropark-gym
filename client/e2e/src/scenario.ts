import { join } from 'node:path';
import { attachToApp } from './cdp.js';
import { launchApp, resetStore, stopApp, waitForCdp } from './app-lifecycle.js';
import { Reporter } from './report.js';
import type { Page } from 'playwright';

const ARTIFACTS = join(process.cwd(), 'artifacts');

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
  let ok = true;
  try {
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
