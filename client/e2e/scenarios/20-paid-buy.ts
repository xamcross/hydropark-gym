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
  // NOTE: `Locator.isVisible()` does NOT auto-wait — its `timeout` option is
  // deprecated and ignored (checks the DOM once, immediately). Using it right
  // after the "Install" click raced Angular's dialog render: the check ran
  // before the dialog mounted, always saw "not visible", and skipped the
  // click — stranding the auth dialog open and the buy() flow blocked
  // forever on `ensureForPurchase()`, which the 45s race below then timed
  // out on (no error banner, no owned CTA — this IS what "paid buy did not
  // reach the owned/installed state" without an error banner looked like).
  // `waitFor({ state: 'visible' })` actually polls up to the timeout.
  const continueDevice = page.getByRole('button', { name: /continue on this device/i });
  const deviceDialogShown = await continueDevice
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (deviceDialogShown) {
    await continueDevice.click();
    reporter.step('chose "continue on this device"', true);
  }
  // Fake provider self-settles; license (server device id + recovery step-up) + install then run.
  // A settled paid buy auto-enables (`onSettled` → `install(id, thenEnable=true)`),
  // so the real terminal ownership-button label is "Active" (`primaryCta()` in
  // catalog.model.ts) — "Installed"/"Open"/"Owned" are never actual button text
  // anywhere in the ownership-button component; "Enable" only ever appears as a
  // *disabled* secondary button during the brief owned/installing transition, so
  // it's kept here only as a defensive fallback, not the expected match.
  const errorBanner = page.locator('p.own-error[role="alert"]');
  const ownedCta = page.getByRole('button', { name: /Active|Enable/ });
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
