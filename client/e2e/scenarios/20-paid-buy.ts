import type { Page } from 'playwright';
import type { Reporter } from '../src/report.js';

export async function paidBuy({ page, reporter }: { page: Page; reporter: Reporter }): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  // ASSISTANT is the default tab; navigate to MARKETPLACE to reach the catalog.
  await page.getByRole('button', { name: 'Marketplace' }).click();
  await page.getByText('Cooking Assistant', { exact: false }).first().click();
  const buyBtn = page.getByRole('button', { name: /Buy/ });
  await buyBtn.waitFor({ state: 'visible', timeout: 20_000 });
  await reporter.shot(page, 'detail-before');
  await buyBtn.click();
  // Same "Before you install" consent dialog as the free flow gates a paid buy too.
  const installConfirmBtn = page.getByRole('button', { name: 'Install', exact: true });
  await installConfirmBtn.waitFor({ state: 'visible', timeout: 10_000 });
  reporter.step('"Before you install" consent dialog appeared', true);
  await installConfirmBtn.click();
  // Identity gate: choose the anonymous device-only path if the dialog appears.
  const continueDevice = page.getByRole('button', { name: /continue on this device/i });
  if (await continueDevice.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await continueDevice.click();
    reporter.step('chose "continue on this device"', true);
  }
  // Fake provider self-settles; license (server device id + recovery step-up) + install then run.
  const errorBanner = page.locator('p.own-error[role="alert"]');
  const ownedCta = page.getByRole('button', { name: /Enable|Installed|Open|Owned/ });
  const outcome = await Promise.race([
    ownedCta.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'owned' as const),
    errorBanner.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'error' as const),
  ]).catch(() => 'timeout' as const);
  await reporter.shot(page, 'detail-after');
  if (outcome === 'error') {
    reporter.step('paid buy', false, `error banner: ${await errorBanner.innerText()}`);
    throw new Error('paid buy showed an error banner');
  }
  reporter.step('paid buy (owned/installed CTA appeared, no error)', outcome === 'owned');
  if (outcome !== 'owned') throw new Error('paid buy did not reach the owned/installed state');
}
