// Pure-Node static launch checks. No dependencies. Run: node landing-gym/test/check.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const index = read('index.html');
const appjs = read('app.js');

// Task 1 — canonical + OG at the production root.
ok(/<link rel="canonical" href="https:\/\/hydropark\.app\/">/.test(index),
   'index.html canonical must be https://hydropark.app/ (root)');
ok(index.includes('<meta property="og:url" content="https://hydropark.app/">'),
   'index.html must set og:url to the root');

// Task 2 — the five top features are advertised.
for (const phrase of ['offline', 'free local', 'skills', '$5', 'Windows']) {
  ok(index.toLowerCase().includes(phrase.toLowerCase()),
     `index.html must advertise the top feature phrase: "${phrase}"`);
}

// Task 3 — downloads point at GitHub Releases; checkout stays gated.
ok(appjs.includes('github.com/xamcross/hydropark-gym/releases'),
   'app.js download URLs must target github.com/xamcross/hydropark-gym/releases');
ok(!/DOWNLOAD_URL\s*=\s*'[^']*REPLACE_ME/.test(appjs),
   'app.js DOWNLOAD_URL must no longer be a REPLACE_ME placeholder');
ok(/CHECKOUT_URL\s*=\s*'[^']*REPLACE_ME/.test(appjs),
   'app.js CHECKOUT_URL must STAY a REPLACE_ME gate (checkout not live)');

// Task 4 — Cloudflare Web Analytics; Plausible loader gone.
ok(index.includes('static.cloudflareinsights.com/beacon.min.js'),
   'index.html must load the Cloudflare Web Analytics beacon');
ok(!index.includes('plausible.io/js/'),
   'index.html must not load the Plausible script');
ok(index.includes('window.dataLayer'),
   'keep the dataLayer/plausible shim so track() never throws');

// Task 5 — manifest + social card.
ok(index.includes('rel="manifest"'), 'index.html must link a web manifest');
let manifest;
try { manifest = JSON.parse(read('site.webmanifest')); } catch { ok(false, 'site.webmanifest must be valid JSON'); }
ok(manifest && manifest.name && manifest.theme_color, 'site.webmanifest needs name + theme_color');
ok(read('og-image.svg').includes('<svg'), 'og-image.svg must be an SVG');

// Task 6 — robots + sitemap.
const robots = read('robots.txt');
ok(/Sitemap:\s*https:\/\/hydropark\.app\/sitemap\.xml/.test(robots), 'robots.txt must reference the sitemap URL');
ok(/User-agent:\s*\*/.test(robots), 'robots.txt must have a User-agent: * group');
const sitemap = read('sitemap.xml');
for (const loc of ['https://hydropark.app/', 'https://hydropark.app/privacy', 'https://hydropark.app/terms']) {
  ok(sitemap.includes('<loc>' + loc + '</loc>'), `sitemap.xml must list ${loc}`);
}

// Task 7 — JSON-LD blocks parse and cover the required @types.
const ldBlocks = [...index.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map((m) => { try { return JSON.parse(m[1]); } catch { ok(false, 'a JSON-LD block did not parse'); return null; } })
  .filter(Boolean);
const types = new Set(ldBlocks.map((b) => b['@type']));
for (const t of ['SoftwareApplication', 'Organization', 'FAQPage', 'BreadcrumbList']) {
  ok(types.has(t), `index.html must include ${t} JSON-LD`);
}
const appLd = ldBlocks.find((b) => b['@type'] === 'SoftwareApplication');
ok(appLd && /Windows|macOS/.test(appLd.operatingSystem || ''), 'SoftwareApplication must state the OS');

// Task 8 — llms.txt.
const llms = read('llms.txt');
ok(/^#\s*Hydropark/m.test(llms), 'llms.txt must have a "# Hydropark" heading');
ok(/offline/i.test(llms) && /\$5/.test(llms), 'llms.txt must state the offline + $5 facts');
ok(llms.includes('https://hydropark.app/'), 'llms.txt must link the site');

// Task 9 — Pages _headers/_redirects.
const headers = read('_headers');
ok(/Content-Security-Policy:/.test(headers), '_headers must set a CSP');
ok(headers.includes('fonts.gstatic.com') && headers.includes('static.cloudflareinsights.com'),
   'CSP must allow Google Fonts + the Cloudflare beacon');
ok(/Strict-Transport-Security:/.test(headers), '_headers must set HSTS');
const redirects = read('_redirects');
ok(/\/gym\s+\/\s+301/.test(redirects), '_redirects must 301 /gym -> /');

// run
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('check.mjs: all assertions passed');
