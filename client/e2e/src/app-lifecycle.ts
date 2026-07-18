import { spawn, execSync } from 'node:child_process';
import { rmSync, readdirSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

const APP_DATA = join(process.env.APPDATA ?? '', 'app.hydropark.phase0');
const TAURI_DIR = join(process.cwd(), '..', 'src-tauri');
const APP_BIN = join(TAURI_DIR, 'target', 'debug', 'hydropark.exe');
const ARTIFACTS_DIR = join(process.cwd(), 'artifacts');
const APP_STDERR_LOG = join(ARTIFACTS_DIR, 'app-stderr.log');

/**
 * Build the mock-inference binary ONCE (no llama/native toolchain needed).
 * Call before any scenario so `launchApp` can exec the prebuilt binary directly
 * — which avoids the `cargo run` build-lock contention that made relaunch between
 * scenarios hang (a lingering `cargo` from the previous scenario held `target/`).
 */
export function buildApp(): void {
  execSync('cargo build --bin hydropark --no-default-features --features mock-inference', {
    cwd: TAURI_DIR,
    stdio: 'inherit',
  });
}

export async function stopApp(): Promise<void> {
  try {
    execSync('powershell -NoProfile -Command "Get-Process hydropark -ErrorAction SilentlyContinue | Stop-Process -Force"');
  } catch {
    /* none running */
  }
  // Wait for the CDP port to be released so the next launch can bind :9222.
  for (let i = 0; i < 20; i++) {
    try {
      execSync(
        'powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"',
      );
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export async function resetStore(): Promise<void> {
  await stopApp();
  if (!existsSync(APP_DATA)) return;
  for (const f of readdirSync(APP_DATA, { withFileTypes: true }).filter((d) => d.name.startsWith('hydropark.db'))) {
    try {
      rmSync(join(APP_DATA, f.name), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Launch the PREBUILT mock binary directly (no `cargo run`). Inherits
 * `process.env` — which must carry `HYDROPARK_PACKAGE_SIGNING_KEYS` (set by
 * `e2e-up.ps1` via `Get-HpPackageKeys`) or the real fail-closed installer rejects
 * every skill. The binary was built without `custom-protocol`, so it loads the
 * frontend from the running ng dev server on :4200.
 */
export async function launchApp(): Promise<void> {
  if (!existsSync(APP_BIN)) throw new Error(`launchApp: ${APP_BIN} missing — call buildApp() first`);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
    HYDROPARK_APP_VERSION: '1.0.0',
  };
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  // Capture the app's stderr (Rust `eprintln!`/panic output) into a single
  // append-mode log shared across scenarios/relaunches, so a Rust-side error —
  // e.g. a `[diag]` line or a panic — is readable after the fact instead of
  // vanishing with `stdio: 'ignore'`.
  const stderrFd = openSync(APP_STDERR_LOG, 'a');
  const child = spawn(APP_BIN, [], { cwd: TAURI_DIR, env, detached: true, stdio: ['ignore', 'ignore', stderrFd] });
  child.unref();
}

export async function waitForCdp(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:9222/json/version');
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('waitForCdp: WebView2 CDP endpoint never came up (launch failed?)');
}
