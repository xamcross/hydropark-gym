// Post-deploy launch verification against the LIVE site (HTTP-level, no browser).
// Run once Cloudflare Pages + the custom domain are live:
//   node landing-gym/test/verify-launch.mjs                     (defaults to https://hydropark.app)
//   node landing-gym/test/verify-launch.mjs https://<preview>.pages.dev
// Exit 0 = all checks pass; non-zero prints the failures.

const BASE = (process.argv[2] || 'https://hydropark.app').replace(/\/$/, '');
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

async function head(path, opts = {}) {
  try { return await fetch(BASE + path, { redirect: 'manual', ...opts }); }
  catch (e) { fails.push(`${path} → fetch error: ${e.message}`); return null; }
}

// 1. Core pages + SEO files return 200.
for (const p of ['/', '/robots.txt', '/sitemap.xml', '/llms.txt', '/site.webmanifest', '/privacy', '/terms']) {
  const r = await head(p, { redirect: 'follow' });
  ok(r && r.status === 200, `${p} should be 200 (got ${r ? r.status : 'no response'})`);
}

// 2. HSTS on the apex.
const root = await head('/', { redirect: 'follow' });
ok(root && /max-age=\d+/.test(root.headers.get('strict-transport-security') || ''),
   'apex should send a Strict-Transport-Security header');

// 3. /gym 301 → / (old canonical preserved).
const gym = await head('/gym');
ok(gym && [301, 308].includes(gym.status), `/gym should 301→/ (got ${gym ? gym.status : 'none'})`);
ok(gym && /\/$|hydropark\.app\/?$/.test(gym.headers.get('location') || ''),
   `/gym should redirect to / (location: ${gym ? gym.headers.get('location') : 'none'})`);

// 4. Canonical + JSON-LD in the homepage HTML.
if (root && root.status === 200) {
  const html = await root.text();
  ok(/<link rel="canonical" href="https:\/\/hydropark\.app\/">/.test(html),
     'homepage canonical should be https://hydropark.app/');
  ok(/"@type":\s*"SoftwareApplication"/.test(html), 'homepage should carry SoftwareApplication JSON-LD');
  ok(/"@type":\s*"FAQPage"/.test(html), 'homepage should carry FAQPage JSON-LD');
  ok(!html.includes('CF_BEACON_TOKEN'), 'Cloudflare beacon token must be set (no CF_BEACON_TOKEN placeholder)');
}

// 5. www → apex redirect (best-effort; only meaningful once www is bound).
try {
  const www = await fetch('https://www.hydropark.app/', { redirect: 'manual' });
  ok([301, 308].includes(www.status), `www should redirect to apex (got ${www.status})`);
} catch { /* www not resolvable yet — skip, not a hard fail pre-DNS */ }

if (fails.length) { console.error(`LAUNCH VERIFY (${BASE}) — FAIL:\n- ` + fails.join('\n- ')); process.exit(1); }
console.log(`launch-verify (${BASE}): all checks passed`);
