import { buildApp } from './app-lifecycle.js';
import { runScenario } from './scenario.js';
import { smoke } from '../scenarios/00-smoke.js';
import { freeInstall } from '../scenarios/10-free-install.js';
import { paidBuy } from '../scenarios/20-paid-buy.js';
import { chatToolRender } from '../scenarios/30-chat-tool-render.js';

const scenarios: { name: string; fn: Parameters<typeof runScenario>[1]; fresh: boolean }[] = [
  { name: 'smoke', fn: smoke, fresh: true },
  { name: 'free-install', fn: freeInstall, fresh: true },
  { name: 'paid-buy', fn: paidBuy, fresh: true },
  { name: 'chat-tool-render', fn: chatToolRender, fresh: true },
];

console.log('=== building mock-inference binary (once) ===');
buildApp();

let failed = 0;
for (const s of scenarios) {
  const ok = await runScenario(s.name, s.fn, { freshStore: s.fresh });
  if (!ok) failed++;
}
console.log(`\n=== E2E complete: ${scenarios.length - failed}/${scenarios.length} passed ===`);
process.exit(failed === 0 ? 0 : 1);
