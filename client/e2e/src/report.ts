import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';

export class Reporter {
  private steps: { name: string; ok: boolean; note?: string }[] = [];
  private shots: string[] = [];
  constructor(private runDir: string) { mkdirSync(runDir, { recursive: true }); }
  step(name: string, ok: boolean, note?: string) { this.steps.push({ name, ok, note }); }
  async shot(page: Page, name: string): Promise<string> {
    const file = join(this.runDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    this.shots.push(file);
    return file;
  }
  finish() {
    const passed = this.steps.filter((s) => s.ok).length;
    const failed = this.steps.length - passed;
    writeFileSync(join(this.runDir, 'report.json'), JSON.stringify({ steps: this.steps, shots: this.shots }, null, 2));
    const md = [`# ${this.runDir}`, '', ...this.steps.map((s) => `- ${s.ok ? '✅' : '❌'} ${s.name}${s.note ? ` — ${s.note}` : ''}`)].join('\n');
    writeFileSync(join(this.runDir, 'report.md'), md);
    return { passed, failed };
  }
}
