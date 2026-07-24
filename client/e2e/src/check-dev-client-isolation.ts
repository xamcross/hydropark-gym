/**
 * CHECK: the harness must coexist with a developer's app, not trample it.
 *
 * `deploy/local-native/client.ps1` runs a real-inference `hydropark.exe` with no
 * remote-debugging port. Two invariants protect it, both of which have been
 * broken in the past:
 *
 *  1. `stopApp()` must kill only the app it launched. It used to match on image
 *     name (`Get-Process hydropark | Stop-Process -Force`), which force-killed a
 *     developer's running client mid-session.
 *  2. `launchApp()` must use its own WebView2 user-data folder. Apps sharing a
 *     folder share one browser process, and `--remote-debugging-port` is honoured
 *     only when that process is CREATED — so with the default folder a running
 *     dev client meant :9222 never opened and every scenario failed to attach.
 *
 * Run: `npm run check:isolation` (needs a built mock binary + ng on :4200).
 * Exit 0 = both hold. Exit 2 = inconclusive.
 */
import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { launchApp, stopApp, waitForCdp } from './app-lifecycle.js';

const TAURI_DIR = join(process.cwd(), '..', 'src-tauri');
const APP_BIN = join(TAURI_DIR, 'target', 'debug', 'hydropark.exe');

const alive = (pid: number): boolean => {
  try {
    execSync(`powershell -NoProfile -Command "if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`);
    return true;
  } catch {
    return false;
  }
};
const cdpPortHeld = (): boolean => {
  try {
    execSync('powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"');
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stand-in for the developer's client: same binary, deliberately NO debugging port.
const env = { ...process.env, HYDROPARK_APP_VERSION: '1.0.0' };
delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
delete env.WEBVIEW2_USER_DATA_FOLDER;
const decoy = spawn(APP_BIN, [], { cwd: TAURI_DIR, env, detached: true, stdio: 'ignore' });
decoy.unref();
const decoyPid = decoy.pid!;
console.log(`decoy dev-client pid = ${decoyPid}`);
await sleep(4_000);
if (!alive(decoyPid)) {
  console.log('INCONCLUSIVE: the decoy exited on its own — is the mock binary built?');
  process.exit(2);
}

const kill = (pid: number) => {
  try {
    execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`);
  } catch {
    /* already gone */
  }
};

let attached = false;
try {
  await launchApp();
  // Invariant 2: fails here (CDP never opens) if the harness shares the dev
  // client's WebView2 profile.
  await waitForCdp();
  attached = true;
} catch (e) {
  console.log(`  attach failed: ${String(e)}`);
}

if (attached) await stopApp();

// Invariant 1.
const decoySurvived = alive(decoyPid);
const portReleased = !cdpPortHeld();
kill(decoyPid);

console.log(`\n  attached to :9222 despite a dev client : ${attached}`);
console.log(`  dev client survived stopApp()         : ${decoySurvived}`);
console.log(`  :9222 released                        : ${portReleased}`);

if (attached && decoySurvived && portReleased) {
  console.log('\nPASS — harness and dev client are isolated.');
  process.exit(0);
}
console.log('\nFAIL — see the invariants in this file’s header.');
process.exit(1);
