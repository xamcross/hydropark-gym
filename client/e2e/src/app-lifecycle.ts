import { spawn, execSync } from 'node:child_process';
import { rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP_DATA = join(process.env.APPDATA ?? '', 'app.hydropark.phase0');
const TAURI_DIR = join(process.cwd(), '..', 'src-tauri');

export async function stopApp(): Promise<void> {
  try { execSync('powershell -NoProfile -Command "Get-Process hydropark -ErrorAction SilentlyContinue | Stop-Process -Force"'); } catch { /* none running */ }
  await new Promise((r) => setTimeout(r, 800));
}

export async function resetStore(): Promise<void> {
  await stopApp();
  if (!existsSync(APP_DATA)) return;
  for (const f of readdirSync(APP_DATA, { withFileTypes: true }).filter((d) => d.name.startsWith('hydropark.db'))) {
    try { rmSync(join(APP_DATA, f.name), { force: true }); } catch { /* ignore */ }
  }
}

export async function launchApp(): Promise<void> {
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222', HYDROPARK_APP_VERSION: '1.0.0' };
  const child = spawn('cargo', ['run', '--bin', 'hydropark', '--no-default-features', '--features', 'mock-inference'],
    { cwd: TAURI_DIR, env, detached: true, stdio: 'ignore', shell: true });
  child.unref();
}

export async function waitForCdp(timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:9222/json/version');
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('waitForCdp: WebView2 CDP endpoint never came up (build/launch failed?)');
}
