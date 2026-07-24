// Rendered smoke test. Requires the client/e2e Playwright install (Chromium).
// Run: node landing-gym/test/smoke.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import pkg from '../../client/e2e/node_modules/playwright/index.js';
const { chromium } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  try {
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const fails = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
const page = await ctx.newPage();
const errors = [];
// Ignore network resource-load failures (external Google Fonts / analytics beacon
// can't load in a sandbox) — those aren't page bugs. Real JS errors arrive via
// pageerror below, and any same-origin script failure is caught by the assertions.
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !/Failed to load resource/i.test(t) && !/googleapis|gstatic|cloudflareinsights|beacon/i.test(t)) errors.push(t);
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800); // let app.js run its OS-detect relabel

const canonical = await page.getAttribute('link[rel=canonical]', 'href');
if (canonical !== 'https://hydropark.app/') fails.push(`canonical=${canonical}`);
const hero = await page.locator('[data-track="download"][data-loc="hero"]').first().textContent();
if (!/Windows/i.test(hero || '')) fails.push(`hero download label not Windows-detected: "${hero}"`);
for (const f of ['/robots.txt', '/sitemap.xml', '/llms.txt', '/site.webmanifest']) {
  const r = await page.request.get(base + f);
  if (r.status() !== 200) fails.push(`${f} -> ${r.status()}`);
}
if (errors.length) fails.push('console errors: ' + errors.join(' | '));

await browser.close();
server.close();
if (fails.length) { console.error('SMOKE FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('smoke.mjs: passed');
