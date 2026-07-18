import type { Page } from 'playwright';
import type { Reporter } from '../src/report.js';

export async function freeInstall({ page, reporter }: { page: Page; reporter: Reporter }): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  // ASSISTANT is the default tab; navigate to MARKETPLACE to reach the catalog.
  await page.getByRole('button', { name: 'Marketplace' }).click();
  await page.getByText('Packing List', { exact: false }).first().click();          // open detail
  const getBtn = page.getByRole('button', { name: /Get/ });
  await getBtn.waitFor({ state: 'visible', timeout: 20_000 });
  await reporter.shot(page, 'detail-before');
  await getBtn.click();
  // A "Before you install" consent dialog gates every acquire (free or paid) —
  // not in the plan's original guess, confirmed live: click through it.
  const installConfirmBtn = page.getByRole('button', { name: 'Install', exact: true });
  await installConfirmBtn.waitFor({ state: 'visible', timeout: 10_000 });
  reporter.step('"Before you install" consent dialog appeared', true);
  await installConfirmBtn.click();
  // SUCCESS: the acquire error banner must NOT appear and the CTA must advance past "Get".
  const errorBanner = page.locator('p.own-error[role="alert"]');
  const enableBtn = page.getByRole('button', { name: 'Enable' });
  const outcome = await Promise.race([
    enableBtn.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'installed' as const),
    errorBanner.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'error' as const),
  ]).catch(() => 'timeout' as const);
  await reporter.shot(page, 'detail-after');
  if (outcome === 'error') {
    reporter.step('free install', false, `error banner: ${await errorBanner.innerText()}`);
    throw new Error('free install showed an error banner');
  }
  reporter.step('free install (Enable CTA appeared, no error)', outcome === 'installed');
  if (outcome !== 'installed') throw new Error('free install did not reach the installed state');
}
