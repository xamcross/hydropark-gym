import { spawn, execSync } from 'node:child_process';
import { rmSync, readdirSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

const APP_DATA = join(process.env.APPDATA ?? '', 'app.hydropark.phase0');
const TAURI_DIR = join(process.cwd(), '..', 'src-tauri');
const APP_BIN = join(TAURI_DIR, 'target', 'debug', 'hydropark.exe');
const ARTIFACTS_DIR = join(process.cwd(), 'artifacts');
const APP_STDERR_LOG = join(ARTIFACTS_DIR, 'app-stderr.log');

/**
 * A WebView2 profile owned by the harness alone (under target/, so it is
 * git-ignored and `cargo clean` sweeps it).
 *
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is honoured only when the browser
 * process for a user-data folder is CREATED. Apps sharing a folder share one
 * browser process — so with the Tauri default folder, a developer's client
 * (deploy/local-native/client.ps1) already running means our app silently joins
 * ITS debug-less browser process and :9222 never opens. Our own folder keeps the
 * two independent, which is what lets stopApp() kill by PID instead of by name.
 */
const WEBVIEW_PROFILE = join(TAURI_DIR, 'target', 'e2e-webview2');

/** PID of the app this harness spawned — see stopApp(). */
let appPid: number | null = null;

function ps(script: string): string {
  try {
    return execSync(`powershell -NoProfile -Command "${script}"`).toString();
  } catch {
    return '';
  }
}

function cdpPortFree(): boolean {
  try {
    execSync(
      'powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"',
    );
    return true;
  } catch {
    return false;
  }
}

async function waitForCdpPortFree(): Promise<boolean> {
  // The listener is a WebView2 CHILD of the app, so the port frees a beat after
  // the parent dies (measured ~1s).
  for (let i = 0; i < 20; i++) {
    if (cdpPortFree()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * Reclaim :9222 from an app orphaned by an earlier run that died before its
 * stopApp(). Only this harness passes --remote-debugging-port, so whatever holds
 * the port is by construction one of OUR apps — but resolve it by PID (via the
 * listener's hydropark parent) rather than killing every hydropark by name.
 */
function reclaimCdpPort(): void {
  ps(
    [
      '$c = Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue;',
      'if ($c) {',
      "  $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c[0].OwningProcess);",
      "  if ($p.Name -ne 'hydropark.exe') { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId) };",
      "  if ($p -and $p.Name -eq 'hydropark.exe') { Stop-Process -Id $p.ProcessId -Force }",
      '}',
    ].join(' '),
  );
}

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

/**
 * Stop the app THIS harness launched — and nothing else. Matching by image name
 * would also force-kill a developer's real-inference client, which the harness
 * never started; the `-eq hydropark` guard additionally covers PID reuse.
 */
export async function stopApp(): Promise<void> {
  if (appPid !== null) {
    ps(`Get-Process -Id ${appPid} -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'hydropark' } | Stop-Process -Force`);
    appPid = null;
  }
  if (await waitForCdpPortFree()) return;
  reclaimCdpPort();
  if (await waitForCdpPortFree()) return;
  console.warn('[e2e] :9222 is still held — the next attach may reach a stale app');
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
    WEBVIEW2_USER_DATA_FOLDER: WEBVIEW_PROFILE,
    HYDROPARK_APP_VERSION: '1.0.0',
  };
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  // Capture the app's stderr (Rust `eprintln!`/panic output) into a single
  // append-mode log shared across scenarios/relaunches, so a Rust-side error —
  // e.g. a `[diag]` line or a panic — is readable after the fact instead of
  // vanishing with `stdio: 'ignore'`.
  const stderrFd = openSync(APP_STDERR_LOG, 'a');
  const child = spawn(APP_BIN, [], { cwd: TAURI_DIR, env, detached: true, stdio: ['ignore', 'ignore', stderrFd] });
  appPid = child.pid ?? null;
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
