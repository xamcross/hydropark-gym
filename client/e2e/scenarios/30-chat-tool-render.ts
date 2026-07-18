import type { Page } from 'playwright';
import type { Reporter } from '../src/report.js';

export async function chatToolRender({ page, reporter }: { page: Page; reporter: Reporter }): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  // ASSISTANT is the default tab already. The free "Kitchen Timer & Units" skill
  // toggle ("Free skill · tap to enable") must be clicked before the mock engine's
  // scripted carbonara turn will run any tools (client/src-tauri/src/inference.rs
  // mod mock: `script_turns` returns a base-agent-only reply when `!skill_enabled`).
  const kitchenSwitch = page.locator('.switch-row', { hasText: 'Kitchen Timer & Units' }).getByRole('switch');
  await kitchenSwitch.waitFor({ state: 'visible', timeout: 20_000 });
  await kitchenSwitch.click();
  reporter.step('enabled "Kitchen Timer & Units" skill', true);

  const input = page.getByPlaceholder(/Ask the agent/i);
  await input.waitFor({ state: 'visible', timeout: 20_000 });
  // The exact prompt the mock's scripted engine matches on `msg.contains("carbonara")`
  // (client/src-tauri/src/inference.rs mod mock `script_turns`), which drives a
  // list_manage call followed by a start_timer call — the plan's placeholder
  // prompt ("set a 9 minute pasta timer") does not match any scripted branch.
  await input.fill('help me cook carbonara for 4');
  await page.getByRole('button', { name: /Send/i }).click();
  // Tidy tool line must appear…
  await page.getByText(/Setting a timer/i).waitFor({ state: 'visible', timeout: 20_000 });
  reporter.step('tidy tool line rendered', true);
  // …and NO raw tool JSON may leak into the transcript.
  const transcript = await page.locator('section').innerText().catch(() => page.locator('body').innerText());
  const leaked = /"duration_sec"|"timer_id"|start_timer:\s*\{/.test(transcript);
  reporter.step('no raw tool JSON leaked', !leaked, leaked ? 'raw JSON found in transcript' : undefined);
  await reporter.shot(page, 'chat');
  if (leaked) throw new Error('raw tool-result JSON leaked into chat');
}
