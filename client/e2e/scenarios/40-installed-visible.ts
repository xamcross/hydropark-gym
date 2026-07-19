import type { Locator, Page } from 'playwright';
import type { Reporter } from '../src/report.js';

/** Poll `aria-checked` on a toggle until it matches `expected`, or time out. */
async function waitForAriaChecked(locator: Locator, expected: boolean, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await locator.getAttribute('aria-checked');
    if ((val === 'true') === expected) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * W06 gap fix verification: a skill installed beyond the two hardcoded P0
 * ones (kitchen-timer / cooking-assistant) used to succeed on install but
 * then be INVISIBLE in the Assistant dashboard's skill list, with no way to
 * enable it. This scenario installs the free "Packing List" skill (mirrors
 * `10-free-install.ts`'s install flow) and then asserts it (a) appears as its
 * own toggle row in the Assistant dashboard, starting NOT enabled, and
 * (b) can actually be enabled by clicking that row's toggle.
 */
export async function installedVisible({ page, reporter }: { page: Page; reporter: Reporter }): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  // ── install Packing List via the Marketplace (same flow as 10-free-install.ts) ──
  await page.getByRole('button', { name: 'Marketplace' }).click();
  await page.getByText('Packing List', { exact: false }).first().click();
  const getBtn = page.getByRole('button', { name: /Get/ });
  await getBtn.waitFor({ state: 'visible', timeout: 20_000 });
  await getBtn.click();
  const installConfirmBtn = page.getByRole('button', { name: 'Install', exact: true });
  await installConfirmBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await installConfirmBtn.click();

  const errorBanner = page.locator('p.own-error[role="alert"]');
  const enableBtn = page.getByRole('button', { name: 'Enable' });
  const outcome = await Promise.race([
    enableBtn.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'installed' as const),
    errorBanner.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'error' as const),
  ]).catch(() => 'timeout' as const);
  if (outcome === 'error') {
    reporter.step('install Packing List (prerequisite)', false, `error banner: ${await errorBanner.innerText()}`);
    throw new Error('install failed before the W06 visibility check could run');
  }
  reporter.step('install Packing List (prerequisite)', outcome === 'installed');
  if (outcome !== 'installed') throw new Error('install did not reach the installed state');

  // ── W06 check #1: the just-installed skill is no longer invisible ──────────
  // Switch to the ASSISTANT tab — app.component.html mounts
  // app-installed-skills inside the `view() === 'assistant'` @if block, which
  // Angular destroys/recreates on every tab switch, so this remount is what
  // refreshes the list against the install that just completed.
  await page.getByRole('button', { name: 'Assistant' }).click();

  const row = page.locator('.switch-row', { hasText: 'Packing List' });
  const appeared = await row
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  reporter.step('installed skill (Packing List) appears in the Assistant dashboard skill list', appeared);
  if (!appeared) throw new Error('Packing List never appeared in the dashboard skill list (W06 gap not fixed)');
  await reporter.shot(page, 'dashboard-before-enable');

  const toggle = row.locator('button.switch');
  await toggle.waitFor({ state: 'visible', timeout: 5_000 });
  const startsOff = (await toggle.getAttribute('aria-checked')) === 'false';
  reporter.step('freshly-installed skill starts NOT enabled', startsOff);

  // ── W06 check #2: it can actually be enabled from the dashboard ────────────
  await toggle.click();
  const enabledAfterToggle = await waitForAriaChecked(toggle, true);
  await reporter.shot(page, 'dashboard-after-enable');
  reporter.step('clicking the dashboard toggle enables the installed skill', enabledAfterToggle);
  if (!enabledAfterToggle) throw new Error('toggling the installed skill in the dashboard did not enable it');
}
