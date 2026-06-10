// Uses Playwright purely as a Cloudflare-friendly HTTP client.
// CDN is publicly accessible but Cloudflare blocks non-browser TLS fingerprints.
// We navigate Chromium directly to each CDN URL — no cardkaizoku.com interaction needed.

const { chromium } = require('/tmp/node_modules/playwright');
const fs   = require('fs');
const path = require('path');

const WORKSPACE  = process.env.GITHUB_WORKSPACE;
const COOKIE_STR = process.env.CARDKAIZOKU_COOKIES || '';

const DATASETS = [
  { id: 'op16',    period: 'op16'    },
  { id: 'op16_lw', period: 'op16_lw' }, // OP16 last week — needed for Meta Trends
  { id: 'west_p',  period: 'west_p'  },
  { id: 'west',    period: 'west'    },
  { id: 'lw_p',    period: 'lw_p'    },
  { id: 'lw',      period: 'lw'      },
  { id: 'exreg_p', period: 'exreg_p' },
  { id: 'exreg',   period: 'exreg'   },
];

function parseCookies(str) {
  if (!str) return [];
  return str.split(';').map(c => {
    const eq = c.indexOf('=');
    if (eq === -1) return null;
    return { name: c.slice(0,eq).trim(), value: c.slice(eq+1).trim(), domain: '.cardkaizoku.com', path: '/' };
  }).filter(Boolean);
}

// LA timezone date (YYYYMMDD) — matches cardkaizoku's fetchFile.js
function laDate(offset = 0) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  d.setDate(d.getDate() - offset);
  const s = d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [m, dy, y] = s.split('/');
  return `${y}${m}${dy}`;
}

// Navigate browser directly to a CDN JSON URL and read the response body
async function browserFetch(page, url) {
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    if (!res || !res.ok()) {
      console.log(`  HTTP ${res?.status()} — ${url}`);
      return null;
    }
    const text = await page.evaluate(() => document.body.innerText);
    const data = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) return null;
    return { text: JSON.stringify(data), data, url };
  } catch(e) {
    console.log(`  Error: ${e.message}`);
    return null;
  }
}

// Plain Node.js fetch — works for Bandai/Limitless (no Cloudflare on those hosts)
async function nodeFetch(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 1000 ? buf : null;
  } catch { return null; }
}

(async () => {
  const today     = laDate(0);
  const yesterday = laDate(1);
  console.log(`Dates: today=${today}, yesterday=${yesterday} (LA timezone)\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const cookies = parseCookies(COOKIE_STR);
  if (cookies.length > 0) {
    await ctx.addCookies(cookies);
    console.log(`Injected ${cookies.length} cookies (cf_clearance passes Cloudflare)\n`);
  } else {
    console.log('No cookies — CDN requests may be challenged by Cloudflare\n');
  }

  const statsDir = path.join(WORKSPACE, 'data', 'stats');
  const cardsDir = path.join(WORKSPACE, 'data', 'cards');
  fs.mkdirSync(statsDir, { recursive: true });
  fs.mkdirSync(cardsDir, { recursive: true });

  const page = await ctx.newPage();
  let primaryData = null;

  // ── Stats datasets ────────────────────────────────────────────────
  for (const ds of DATASETS) {
    process.stdout.write(`${ds.id}... `);
    const url1 = `https://cdn.cardkaizoku.com/stats/stats_${ds.period}_${today}.json?v=8`;
    const url2 = `https://cdn.cardkaizoku.com/stats/stats_${ds.period}_${yesterday}.json?v=8`;
    const result = await browserFetch(page, url1) || await browserFetch(page, url2);
    if (result) {
      fs.writeFileSync(path.join(statsDir, `${ds.id}.json`), result.text);
      console.log(`✓  (${result.data.length} leaders)`);
      if (!primaryData) primaryData = result.data;
      if (ds.id === 'west_p') fs.writeFileSync(path.join(WORKSPACE, 'data', 'stats.json'), result.text);
    } else {
      console.log('✗');
    }
  }

  // ── Hands, Decklist, Matchuptech data ────────────────────────────
  // Fetch these extra file types for each primary dataset
  const EXTRA_TYPES = [
    { type: 'hands',      datasets: ['west_p', 'op16', 'lw_p'] },
    { type: 'decklist',   datasets: ['west_p', 'op16', 'lw_p'] },
    { type: 'matchuptech',datasets: ['west_p', 'op16', 'lw_p'] },
  ];

  for (const { type, datasets } of EXTRA_TYPES) {
    console.log(`\n${type} data:`);
    for (const id of datasets) {
      const ds = DATASETS.find(d => d.id === id);
      process.stdout.write(`  ${id}... `);
      const url1 = `https://cdn.cardkaizoku.com/stats/${type}_${ds.period}_${today}.json?v=8`;
      const url2 = `https://cdn.cardkaizoku.com/stats/${type}_${ds.period}_${yesterday}.json?v=8`;
      const result = await browserFetch(page, url1) || await browserFetch(page, url2);
      if (result) {
        fs.writeFileSync(path.join(statsDir, `${type}_${id}.json`), result.text);
        console.log(`✓  (${Math.round(result.text.length/1024)}kB)`);
      } else {
        console.log('✗');
      }
    }
  }

  // ── Curve data ────────────────────────────────────────────────────
  console.log('\nCurve data:');
  process.stdout.write('  curve/lw... ');
  const curve = await browserFetch(page, `https://cdn.cardkaizoku.com/stats/curve_lw_${today}.json?v=8`)
             || await browserFetch(page, `https://cdn.cardkaizoku.com/stats/curve_lw_${yesterday}.json?v=8`);
  if (curve) { fs.writeFileSync(path.join(statsDir, 'curve.json'), curve.text); console.log('✓'); }
  else console.log('✗');

  // ── Leader portrait images (via Playwright — needs cf_clearance for cardkaizoku CDN) ──
  if (primaryData) {
    const leaders = [...primaryData].sort((a,b) => (b.play_rate||0)-(a.play_rate||0)).slice(0, 60);
    console.log(`\nDownloading leader portraits for top ${leaders.length} decks...`);
    let downloaded = 0, skipped = 0, failed = 0;

    for (const entry of leaders) {
      const id = entry.leader;
      if (!id) continue;
      const outPath = path.join(cardsDir, `${id}.png`);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) { skipped++; continue; }
      const set = id.split('-')[0];
      // Try cardkaizoku CDN (via Playwright browser — passes Cloudflare)
      // then fall back to Bandai which works without auth
      const cdnUrls = [
        `https://cdn.cardkaizoku.com/cards_en/${set}/${id}.png`,
        `https://cdn.cardkaizoku.com/cards_en/${set}/${id}_sm.webp`,
      ];
      let saved = false;
      for (const imgUrl of cdnUrls) {
        try {
          const res = await page.goto(imgUrl, { waitUntil: 'load', timeout: 10000 });
          if (res && res.ok()) {
            const buf = await res.body();
            if (buf && buf.length > 500) { fs.writeFileSync(outPath, buf); downloaded++; saved = true; break; }
          }
        } catch {}
      }
      // CDN failed — try Bandai and Limitless via plain fetch (no Cloudflare)
      if (!saved) {
        const buf =
          await nodeFetch(`https://en.onepiece-cardgame.com/images/cardlist/card/${id}.png`) ||
          await nodeFetch(`https://limitlesstcg.nyc3.digitaloceanspaces.com/one-piece/${set}/${id}_op_en.webp`) ||
          await nodeFetch(`https://limitlesstcg.nyc3.digitaloceanspaces.com/one-piece/${set}/${id}_en.webp`);
        if (buf) { fs.writeFileSync(outPath, buf); downloaded++; saved = true; }
      }
      if (!saved) failed++;
    }
    console.log(`Leader images: ${downloaded} downloaded, ${skipped} cached, ${failed} failed`);
  }
  await browser.close();

  // ── Character card images (Bandai/Limitless — no Cloudflare, plain Node fetch works) ──
  // Collect all character/event card IDs from hands data
  const charIds = new Set();
  for (const dsId of ['west_p', 'op16', 'lw_p']) {
    const handsPath = path.join(statsDir, `hands_${dsId}.json`);
    if (fs.existsSync(handsPath)) {
      try {
        JSON.parse(fs.readFileSync(handsPath, 'utf8'))
          .forEach(entry => (entry.common_cards || []).forEach(card => {
            if (card.card) charIds.add(card.card);
          }));
      } catch {}
    }
  }

  const charIdList = [...charIds];
  console.log(`
Downloading ${charIdList.length} character card images (Bandai + Limitless)...`);
  let cDownloaded = 0, cSkipped = 0, cFailed = 0;

  for (const id of charIdList) {
    const outPath = path.join(cardsDir, `${id}.png`);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) { cSkipped++; continue; }
    const set = id.split('-')[0];
    const buf =
      await nodeFetch(`https://en.onepiece-cardgame.com/images/cardlist/card/${id}.png`) ||
      await nodeFetch(`https://limitlesstcg.nyc3.digitaloceanspaces.com/one-piece/${set}/${id}_op_en.webp`) ||
      await nodeFetch(`https://limitlesstcg.nyc3.digitaloceanspaces.com/one-piece/${set}/${id}_en.webp`);
    if (buf) { fs.writeFileSync(outPath, buf); cDownloaded++; }
    else cFailed++;
  }
  console.log(`Character images: ${cDownloaded} downloaded, ${cSkipped} cached, ${cFailed} not found`);

  console.log('Done.');
  process.exit(0);
})();
