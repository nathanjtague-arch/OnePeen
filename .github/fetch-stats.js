const { chromium } = require('/tmp/node_modules/playwright');
const fs   = require('fs');
const path = require('path');

const WORKSPACE    = process.env.GITHUB_WORKSPACE;
const COOKIE_STR   = process.env.CARDKAIZOKU_COOKIES || '';

// All five dataset variants to fetch
const DATASETS = [
  { id: 'op16',     prefix: 'stats_op16_'    },
  { id: 'west_p',   prefix: 'stats_west_p_'  },
  { id: 'west',     prefix: 'stats_west_'    },
  { id: 'exreg_p',  prefix: 'stats_exreg_p_' },
  { id: 'exreg',    prefix: 'stats_exreg_'   },
];

function parseCookies(str) {
  if (!str) return [];
  return str.split(';').map(c => {
    const eq = c.indexOf('=');
    if (eq === -1) return null;
    return { name: c.slice(0,eq).trim(), value: c.slice(eq+1).trim(), domain: '.cardkaizoku.com', path: '/' };
  }).filter(Boolean);
}

// Try recent dates × version numbers for a given prefix via ctx.request (uses auth cookies)
async function fetchByPrefix(ctx, prefix) {
  for (let i = 0; i <= 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    for (const v of [8, 9, 7, 10, 6, 5]) {
      const url = `https://cdn.cardkaizoku.com/stats/${prefix}${ds}.json?v=${v}`;
      try {
        const resp = await ctx.request.get(url, { timeout: 10000 });
        if (resp.ok()) {
          const text = await resp.text();
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return { text, parsed, url };
          }
        }
      } catch {}
    }
  }
  return null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  });

  const cookies = parseCookies(COOKIE_STR);
  if (cookies.length > 0) {
    await ctx.addCookies(cookies);
    console.log(`Injected ${cookies.length} cookies`);
  } else {
    console.log('WARNING: No CARDKAIZOKU_COOKIES secret found — data will not load');
  }

  // Navigate to matchups once so the site recognises the session
  const page = await ctx.newPage();
  try {
    console.log('Warming session via cardkaizoku.com/matchups...');
    await page.goto('https://www.cardkaizoku.com/matchups', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    console.log('Session ready');
  } catch(e) {
    console.log('Navigation warning (continuing anyway): ' + e.message);
  }

  // Create output dirs
  const statsDir = path.join(WORKSPACE, 'data', 'stats');
  const cardsDir = path.join(WORKSPACE, 'data', 'cards');
  fs.mkdirSync(statsDir, { recursive: true });
  fs.mkdirSync(cardsDir, { recursive: true });

  // ── Fetch all five dataset variants ──────────────────────────────
  let primaryLeaders = null; // used for card image download

  for (const ds of DATASETS) {
    process.stdout.write(`Fetching ${ds.id} (${ds.prefix})... `);
    const result = await fetchByPrefix(ctx, ds.prefix);
    if (result) {
      const outPath = path.join(statsDir, `${ds.id}.json`);
      fs.writeFileSync(outPath, result.text);
      console.log(`✓ ${result.url} (${result.text.length} bytes)`);
      // Use first successful dataset (op16 or west_p) for card images
      if (!primaryLeaders) primaryLeaders = result.parsed;
      // Keep backward-compatible stats.json as the west_p file (the original default)
      if (ds.id === 'west_p') {
        fs.writeFileSync(path.join(WORKSPACE, 'data', 'stats.json'), result.text);
      }
    } else {
      console.log(`✗ not found (may need Patreon access or data not yet published)`);
    }
  }

  // ── Download card images ─────────────────────────────────────────
  if (primaryLeaders) {
    const sorted = [...primaryLeaders]
      .sort((a, b) => (b.play_rate || 0) - (a.play_rate || 0))
      .slice(0, 50);

    console.log(`\nDownloading images for top ${sorted.length} leaders...`);
    let downloaded = 0, skipped = 0, failed = 0;

    for (const entry of sorted) {
      const id = entry.leader;
      if (!id) continue;
      const outPath = path.join(cardsDir, `${id}.png`);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) { skipped++; continue; }
      const set = id.split('-')[0];
      try {
        const resp = await ctx.request.get(`https://cdn.cardkaizoku.com/cards_en/${set}/${id}.png`);
        if (resp.ok()) { fs.writeFileSync(outPath, await resp.body()); downloaded++; }
        else failed++;
      } catch { failed++; }
    }
    console.log(`Images: ${downloaded} downloaded, ${skipped} already cached, ${failed} failed`);
  }

  await browser.close();
  console.log('\nDone.');
})();
