const { chromium } = require('/tmp/node_modules/playwright');
const fs   = require('fs');
const path = require('path');

const WORKSPACE  = process.env.GITHUB_WORKSPACE;
const COOKIE_STR = process.env.CARDKAIZOKU_COOKIES || '';

const DATASETS = [
  { id: 'op16',    prefix: 'stats_op16_'    },
  { id: 'west_p',  prefix: 'stats_west_p_'  },
  { id: 'west',    prefix: 'stats_west_'    },
  { id: 'exreg_p', prefix: 'stats_exreg_p_' },
  { id: 'exreg',   prefix: 'stats_exreg_'   },
];

function parseCookies(str) {
  if (!str) return [];
  return str.split(';').map(c => {
    const eq = c.indexOf('=');
    if (eq === -1) return null;
    return { name: c.slice(0,eq).trim(), value: c.slice(eq+1).trim(), domain: '.cardkaizoku.com', path: '/' };
  }).filter(Boolean);
}

// Fetch a URL from *inside* the page (looks like a real browser request to Cloudflare)
async function pageEvalFetch(page, url) {
  return page.evaluate(async (url) => {
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) return { ok: false, status: r.status };
      const text = await r.text();
      return { ok: true, text };
    } catch (e) { return { ok: false, error: e.message }; }
  }, url);
}

// Try recent dates × versions for a given prefix, all via page.evaluate
async function fetchDataset(page, prefix) {
  for (let i = 0; i <= 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    for (const v of [8, 9, 7, 10, 6, 5]) {
      const url = `https://cdn.cardkaizoku.com/stats/${prefix}${ds}.json?v=${v}`;
      try {
        const res = await pageEvalFetch(page, url);
        if (res.ok) {
          const parsed = JSON.parse(res.text);
          if (Array.isArray(parsed) && parsed.length > 0) return { text: res.text, parsed, url };
        }
      } catch {}
    }
  }
  return null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const cookies = parseCookies(COOKIE_STR);
  if (cookies.length > 0) {
    await ctx.addCookies(cookies);
    console.log(`Injected ${cookies.length} cookies`);
  } else {
    console.log('WARNING: No CARDKAIZOKU_COOKIES secret found');
  }

  const page = await ctx.newPage();

  // Navigate to cardkaizoku — all subsequent fetches go through this page context
  // which means Cloudflare sees requests coming from a real browser on their domain
  try {
    console.log('Loading cardkaizoku.com...');
    await page.goto('https://www.cardkaizoku.com/matchups', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    const url = page.url();
    if (url.includes('login') || url.includes('patreon')) {
      console.log('LOGIN WALL — cookies may have expired. Update CARDKAIZOKU_COOKIES secret.');
      await browser.close(); process.exit(1);
    }
    console.log('Page loaded — session active');
  } catch(e) {
    console.log('Navigation error: ' + e.message);
  }

  // Create output dirs
  const statsDir = path.join(WORKSPACE, 'data', 'stats');
  const cardsDir = path.join(WORKSPACE, 'data', 'cards');
  fs.mkdirSync(statsDir, { recursive: true });
  fs.mkdirSync(cardsDir, { recursive: true });

  // ── Fetch all five dataset variants via page context ──────────────
  let primaryLeaders = null;

  for (const ds of DATASETS) {
    process.stdout.write(`Fetching ${ds.id}... `);
    const result = await fetchDataset(page, ds.prefix);
    if (result) {
      fs.writeFileSync(path.join(statsDir, `${ds.id}.json`), result.text);
      console.log(`✓ ${result.url} (${result.text.length} bytes)`);
      if (!primaryLeaders) primaryLeaders = result.parsed;
      // Keep backward-compatible stats.json pointing at west_p (original default)
      if (ds.id === 'west_p') {
        fs.writeFileSync(path.join(WORKSPACE, 'data', 'stats.json'), result.text);
      }
    } else {
      console.log('✗ not found');
    }
  }

  // ── Download card images via page context ─────────────────────────
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
      const imgUrl = `https://cdn.cardkaizoku.com/cards_en/${set}/${id}.png`;
      // Fetch image as base64 string via page.evaluate (stays within browser context)
      try {
        const b64 = await page.evaluate(async (url) => {
          try {
            const r = await fetch(url, { credentials: 'include' });
            if (!r.ok) return null;
            const buf = await r.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = '';
            bytes.forEach(b => bin += String.fromCharCode(b));
            return btoa(bin);
          } catch { return null; }
        }, imgUrl);
        if (b64) { fs.writeFileSync(outPath, Buffer.from(b64, 'base64')); downloaded++; }
        else failed++;
      } catch { failed++; }
    }
    console.log(`Images: ${downloaded} downloaded, ${skipped} already cached, ${failed} failed`);
  }

  await browser.close();
  console.log('\nDone.');
})();
