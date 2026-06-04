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

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const cookies = parseCookies(COOKIE_STR);
  if (cookies.length > 0) { await ctx.addCookies(cookies); console.log(`Injected ${cookies.length} cookies`); }
  else { console.log('WARNING: No CARDKAIZOKU_COOKIES secret found'); }

  const statsDir = path.join(WORKSPACE, 'data', 'stats');
  const cardsDir = path.join(WORKSPACE, 'data', 'cards');
  fs.mkdirSync(statsDir, { recursive: true });
  fs.mkdirSync(cardsDir, { recursive: true });

  const page = await ctx.newPage();
  const captured = new Map(); // id -> { text, parsed, url }

  // ── Listen to ALL stats JSON responses the page makes ────────────
  // Must be set up BEFORE navigation so we don't miss early responses
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('cdn.cardkaizoku.com/stats/') || !url.includes('.json')) return;
    for (const ds of DATASETS) {
      if (url.includes(ds.prefix) && !captured.has(ds.id)) {
        try {
          const text = await response.text();
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed) && parsed.length > 0) {
            captured.set(ds.id, { text, parsed, url });
            console.log(`  Intercepted ${ds.id}: ${url} (${text.length} bytes)`);
          }
        } catch {}
        break;
      }
    }
  });

  // ── Navigate and interact with the cardkaizoku UI ─────────────────
  async function tryPage(pageUrl) {
    try {
      console.log(`Navigating to ${pageUrl}...`);
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const currentUrl = page.url();
      if (currentUrl.includes('login') || currentUrl.includes('patreon')) {
        console.log('LOGIN WALL — update CARDKAIZOKU_COOKIES secret');
        return false;
      }
      await wait(4000); // let the JS app fetch its default dataset

      // Find all <select> elements — cardkaizoku uses a dropdown for dataset selection
      const selects = await page.$$('select');
      console.log(`  Found ${selects.length} select element(s) on page`);

      for (const sel of selects) {
        const opts = await sel.evaluate(el => Array.from(el.options).map((o,i) => ({ value: o.value, text: o.text, index: i })));
        console.log(`  Select options: ${opts.map(o => o.text).join(', ')}`);
        for (const opt of opts) {
          if (captured.size >= DATASETS.length) break;
          await sel.selectOption({ index: opt.index });
          await wait(3000); // wait for new dataset to load
        }
      }
      return true;
    } catch(e) {
      console.log(`  Error on ${pageUrl}: ${e.message}`);
      return false;
    }
  }

  console.log('\n── Fetching datasets via page interception ──');
  await tryPage('https://www.cardkaizoku.com/matchups');
  if (captured.size < DATASETS.length) await tryPage('https://www.cardkaizoku.com/ranking');

  console.log(`\nCaptured ${captured.size}/${DATASETS.length} datasets`);

  // ── Save all captured datasets ────────────────────────────────────
  let primaryLeaders = null;
  for (const ds of DATASETS) {
    if (captured.has(ds.id)) {
      const { text, parsed, url } = captured.get(ds.id);
      fs.writeFileSync(path.join(statsDir, `${ds.id}.json`), text);
      console.log(`✓ ${ds.id} saved (${text.length} bytes) — ${url}`);
      if (!primaryLeaders) primaryLeaders = parsed;
      if (ds.id === 'west_p') fs.writeFileSync(path.join(WORKSPACE, 'data', 'stats.json'), text);
    } else {
      console.log(`✗ ${ds.id} — not captured`);
    }
  }

  // ── Download card images ──────────────────────────────────────────
  if (primaryLeaders) {
    const sorted = [...primaryLeaders].sort((a,b) => (b.play_rate||0)-(a.play_rate||0)).slice(0, 50);
    console.log(`\nDownloading images for top ${sorted.length} leaders...`);
    let downloaded = 0, skipped = 0, failed = 0;

    for (const entry of sorted) {
      const id = entry.leader;
      if (!id) continue;
      const outPath = path.join(cardsDir, `${id}.png`);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) { skipped++; continue; }
      const set = id.split('-')[0];
      const imgUrl = `https://cdn.cardkaizoku.com/cards_en/${set}/${id}.png`;
      // Navigate to the image URL — Playwright can download it as a direct resource
      try {
        const resp = await page.goto(imgUrl, { waitUntil: 'load', timeout: 10000 });
        if (resp && resp.ok()) {
          const buf = await resp.body();
          if (buf && buf.length > 500) { fs.writeFileSync(outPath, buf); downloaded++; continue; }
        }
        failed++;
      } catch { failed++; }
    }
    console.log(`Images: ${downloaded} downloaded, ${skipped} already cached, ${failed} failed`);
  }

  await browser.close();
  console.log('\nDone.');
})();
