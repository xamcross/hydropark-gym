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

/** Poll an `aria-disabled` attribute until it matches `expected`, or time out. */
async function waitForAriaDisabled(locator: Locator, expected: boolean, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await locator.getAttribute('aria-disabled');
    if ((val === 'true') === expected) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Paid-enable / dashboard-lock bug fix verification (systematic-debugging task).
 *
 * Root cause: TWO parallel ownership models for `cooking-assistant` that never
 * reconciled — the Marketplace read the P1 acquire entitlement (checkout ->
 * settle -> license -> install) and showed "owned", while the Assistant
 * dashboard toggle and the Composed agent read the SEPARATE P0 receipt-unlock
 * gate (`UnlockService` / the Rust `cooking_assistant::gate()`), which a
 * marketplace purchase never used to flip. The dashboard toggle stayed
 * "Locked — unlock for $5" forever and the skill could never join the
 * composed agent.
 *
 * This scenario extends `20-paid-buy.ts`'s buy flow (same steps, duplicated
 * here so this scenario is self-contained and gets its own fresh store/app —
 * the same convention `40-installed-visible.ts` uses for `10-free-install.ts`'s
 * flow) and then drives the part that actually exercises the fix: after the
 * purchase settles, the Assistant-dashboard toggle must NOT be locked, must be
 * clickable to enable, and the skill must then actually appear in the
 * Composed agent panel (its tools show up in `.ch-tools`).
 */
export async function paidEnable({ page, reporter }: { page: Page; reporter: Reporter }): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  // ── buy Cooking Assistant via the Marketplace (mirrors 20-paid-buy.ts) ─────
  await page.getByRole('button', { name: 'Marketplace' }).click();
  await page.getByText('Cooking Assistant', { exact: false }).first().click();
  const buyBtn = page.getByRole('button', { name: /Buy/ });
  await buyBtn.waitFor({ state: 'visible', timeout: 20_000 });
  await buyBtn.click();
  const installConfirmBtn = page.getByRole('button', { name: 'Install', exact: true });
  await installConfirmBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await installConfirmBtn.click();
  const continueDevice = page.getByRole('button', { name: /continue on this device/i });
  const deviceDialogShown = await continueDevice
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (deviceDialogShown) await continueDevice.click();

  const errorBanner = page.locator('p.own-error[role="alert"]');
  const ownedCta = page.getByRole('button', { name: /Active|Enable/ });
  const outcome = await Promise.race([
    ownedCta.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'owned' as const),
    errorBanner.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'error' as const),
  ]).catch(() => 'timeout' as const);
  if (outcome === 'error') {
    reporter.step('buy Cooking Assistant (prerequisite)', false, `error banner: ${await errorBanner.innerText()}`);
    throw new Error('buy failed before the paid-enable/dashboard-lock check could run');
  }
  reporter.step('buy Cooking Assistant (prerequisite)', outcome === 'owned');
  if (outcome !== 'owned') throw new Error('paid buy did not reach the owned/installed state');

  // ── the actual bug check: the Assistant dashboard toggle must NOT be locked ─
  await page.getByRole('button', { name: 'Assistant' }).click();

  const paidRow = page.locator('.switch-row.paid-row');
  await paidRow.waitFor({ state: 'visible', timeout: 15_000 });
  const toggle = paidRow.locator('button.switch');
  await toggle.waitFor({ state: 'visible', timeout: 5_000 });

  const unlockedInTime = await waitForAriaDisabled(toggle, false);
  await reporter.shot(page, 'dashboard-after-buy');
  reporter.step(
    'Cooking Assistant dashboard toggle is NOT locked after a completed purchase (the bug)',
    unlockedInTime,
    unlockedInTime ? undefined : 'toggle still reports aria-disabled="true" (still "Locked — unlock for $5")'
  );
  if (!unlockedInTime) throw new Error('dashboard toggle stayed locked after a completed marketplace purchase');

  // The "Locked — unlock for $5 to enable" copy must be gone too (not just aria-disabled).
  const lockedText = paidRow.locator('.locked-text');
  const lockedTextGone = await lockedText
    .waitFor({ state: 'hidden', timeout: 2_000 })
    .then(() => true)
    .catch(async () => (await lockedText.count()) === 0);
  reporter.step('"Locked — unlock for $5" copy no longer shown', lockedTextGone);

  // ── click to enable it from the dashboard ───────────────────────────────────
  await toggle.click();
  const enabledAfterToggle = await waitForAriaChecked(toggle, true);
  await reporter.shot(page, 'dashboard-after-enable');
  reporter.step('clicking the dashboard toggle enables Cooking Assistant', enabledAfterToggle);
  if (!enabledAfterToggle) throw new Error('toggling Cooking Assistant in the dashboard did not enable it');

  // ── and it must actually join the Composed agent ────────────────────────────
  const composedHost = page.locator('.composed-host');
  await composedHost.waitFor({ state: 'visible', timeout: 5_000 });
  const idle = composedHost.locator('.ch-idle');
  const composedInTime = await idle
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  reporter.step('Composed agent leaves the "no skills enabled" idle state', composedInTime);

  const tools = composedHost.locator('.ch-tools .ch-tool');
  const toolsAppeared = await tools
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const toolNames = toolsAppeared ? await tools.allTextContents() : [];
  const hasExpectedTool = toolNames.some((t) => /start_timer|convert_units|list_manage/.test(t));
  await reporter.shot(page, 'composed-agent-after-enable');
  reporter.step(
    "Composed agent's tool set includes Cooking Assistant's tools (start_timer/convert_units/list_manage)",
    toolsAppeared && hasExpectedTool,
    toolsAppeared ? `tools seen: ${toolNames.join(', ')}` : 'no .ch-tool elements appeared'
  );
  if (!toolsAppeared || !hasExpectedTool) {
    throw new Error('Cooking Assistant did not join the Composed agent after being enabled from the dashboard');
  }
}
