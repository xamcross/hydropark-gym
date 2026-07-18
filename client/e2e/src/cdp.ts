import { chromium, type Browser, type Page } from 'playwright';

const DEFAULT_CDP = 'http://127.0.0.1:9222';

function isAppPage(url: string): boolean {
  return (
    url.includes('localhost:4200') ||
    url.startsWith('http://tauri.localhost') ||
    url.startsWith('https://tauri.localhost')
  );
}

/**
 * Connect Playwright to the running Tauri app's WebView2 over CDP and return the
 * Hydropark webview page. The app must have been launched with
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.
 * Throws a clear error if no app page is found within `timeoutMs` (default 20s).
 */
export async function attachToApp(
  opts: { cdpUrl?: string; timeoutMs?: number } = {},
): Promise<{ browser: Browser; page: Page }> {
  const cdpUrl = opts.cdpUrl ?? DEFAULT_CDP;
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          if (isAppPage(page.url())) return { browser, page };
        }
      }
      await browser.close();
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `attachToApp: no Hydropark webview page at ${cdpUrl} within timeout. Last error: ${String(lastErr)}`,
  );
}
