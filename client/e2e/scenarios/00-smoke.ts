import type { Page } from 'playwright';
import type { Reporter } from '../src/report.js';

export async function smoke({ page, reporter }: { page: Page; reporter: Reporter }): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  // ASSISTANT is the default tab (live-app fact, not the plan's original guess);
  // the marketplace catalog only renders after navigating to the MARKETPLACE tab.
  await page.getByRole('button', { name: 'Marketplace' }).click();
  const packing = page.getByText('Packing List', { exact: false }).first();
  await packing.waitFor({ state: 'visible', timeout: 30_000 });
  reporter.step('marketplace catalog renders (Packing List visible)', true);
  await reporter.shot(page, 'marketplace');
}
