import type { Page } from 'playwright';
import type { Reporter } from '../src/report.js';

/**
 * Drives the full first-run guided tour, including the hands-on "magic beat"
 * (prefilled carbonara prompt -> Send it -> mock scripts a timer -> auto-advance).
 *
 * Two real pitfalls handled here:
 *  1. Stop 2's title contains a CURLY apostrophe ("The agent's live workspace"
 *     with a U+2019, not a straight '). All text assertions below use
 *     case-insensitive regex substrings that avoid apostrophes entirely, so a
 *     straight-vs-curly mismatch can never fail the match.
 *  2. On a fresh profile the first-run ONBOARDING modal covers the topbar, so
 *     the "Tutorial" button isn't clickable yet. We dismiss onboarding first
 *     (its "Skip for now" control), which itself calls `complete()` ->
 *     `tour.start()` (non-forced) -- on a fresh store that AUTO-STARTS the
 *     tour. So after dismissing onboarding we check whether the tour tooltip
 *     is already open before deciding whether to click "Tutorial".
 */
export async function firstRunTour({ page, reporter }: { page: Page; reporter: Reporter }): Promise<void> {
  await page.waitForLoadState('domcontentloaded');

  // --- Pitfall 2a: dismiss the first-run onboarding modal if it's showing.
  const skipOnboarding = page.getByRole('button', { name: /Skip for now/i });
  const onboardingShowing = await skipOnboarding.isVisible().catch(() => false);
  if (onboardingShowing) {
    await skipOnboarding.click();
    await skipOnboarding.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  }
  reporter.step('onboarding dismissed (or was not showing)', true);

  // --- Pitfall 2b: dismissing onboarding may have already auto-started the
  // tour (non-forced `tour.start()` on a fresh, never-seen-tour profile). Only
  // reach for the "Tutorial" button if the tooltip isn't already open.
  const tooltip = page.locator('.tour-tooltip');
  const tourAlreadyOpen = await tooltip.isVisible().catch(() => false);
  if (!tourAlreadyOpen) {
    await page.getByRole('button', { name: 'Tutorial' }).click();
  }
  reporter.step(`tour reached via ${tourAlreadyOpen ? 'onboarding auto-start' : 'the Tutorial button'}`, true);

  // Step 1 (magic): title + step counter + prefilled carbonara prompt.
  // (No apostrophe in this copy, but still matched via case-insensitive regex for consistency.)
  await page.getByText(/Talk to your agent/i).waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByText(/Step 1 of 6/).waitFor({ state: 'visible', timeout: 5_000 });
  reporter.step('tour opened on step 1', true);

  const input = page.getByPlaceholder(/Ask the agent/i);
  await input.waitFor({ state: 'visible', timeout: 20_000 });
  const value = await input.inputValue();
  const prefilled = /carbonara/i.test(value);
  reporter.step('magic prompt prefilled into composer', prefilled, prefilled ? undefined : `composer was "${value}"`);
  if (!prefilled) throw new Error('magic beat did not prefill the carbonara prompt');

  // Fire the magic beat: enables the free skill, sends the prompt.
  await page.getByRole('button', { name: /Send it/i }).click();
  await reporter.shot(page, 'tour-magic-sent');

  // Auto-advance to step 2 once the agent's timer starts ticking (timer://tick).
  // "live workspace" dodges the curly apostrophe in "The agent's live workspace".
  await page.getByText(/live workspace/i).waitFor({ state: 'visible', timeout: 30_000 });
  reporter.step('magic beat drove the UI -> auto-advanced to step 2', true);
  await reporter.shot(page, 'tour-step2');

  // Walk the remaining steps with the primary button until the tour finishes.
  // (Step 3 "speed" self-skips if no tok/s reading is available -- the loop tolerates it.)
  for (let i = 0; i < 6; i++) {
    const finish = page.getByRole('button', { name: 'Finish' });
    if (await finish.isVisible().catch(() => false)) {
      await finish.click();
      break;
    }
    const next = page.getByRole('button', { name: 'Next' });
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await page.waitForTimeout(150);
      continue;
    }
    break;
  }

  // Tour closed: the tooltip dialog is gone.
  const gone = await page.locator('.tour-tooltip').count().then((c) => c === 0);
  reporter.step('tour completed and overlay dismissed', gone, gone ? undefined : 'overlay still present');
  await reporter.shot(page, 'tour-done');
  if (!gone) throw new Error('tour overlay did not dismiss after Finish');
}
