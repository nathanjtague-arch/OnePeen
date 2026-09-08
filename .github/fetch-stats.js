// Uses Playwright purely as a Cloudflare-friendly HTTP client.
// CDN is publicly accessible but Cloudflare blocks non-browser TLS fingerprints.
// We navigate Chromium directly to each CDN URL — no cardkaizoku.com interaction needed.

const { chromium } = require('/tmp/node_modules/playwright');
const fs   = require('fs');
const path = require('path');

const WORKSPACE  = process.env.GITHUB_WORKSPACE;
const COOKIE_STR = process.env.CARDKAIZOKU_COOKIES || '';

const DATASETS = [
  // Real slugs confirmed 2026-09-08 by watching cardkaizoku's own Network
  // tab, one period at a time. The old assumption (a stable "west" label
  // for Standard) was wrong — cardkaizoku now names the current-set slug
  // after the literal set number, so "Standard" = whatever OP is current.
  // This will need updating again once OP18 (or later) becomes current —
  // that's exactly the kind of drift the dropdown monitor below exists to
  // catch automatically rather than this going stale silently again.
  //
  // west_p / lw_p (Private Lobbies) are kept even though they're not
  // offered anywhere in the app's dropdowns — small, unrepresentative
  // sample, not something anyone should pick as their main view. They're
  // still fetched because Opening Hand Analysis has no All-Lobbies
  // equivalent to fall back to.
  { id: 'west_p',    period: 'op17_p'     }, // Standard, Private Lobbies — internal only, feeds Opening Hand Analysis
  { id: 'lw_p',      period: 'op17_lw_p'  }, // Standard Last Week, Private Lobbies — internal only, feeds Opening Hand Analysis
  { id: 'west',      period: 'op17'       }, // Standard
  { id: 'lw',        period: 'op17_lw'    }, // Standard Last Week
  { id: 'op17_lw',   period: 'op17_lw'    }, // OP17 Last Week — currently identical to 'lw' above; will diverge once a new set releases
  { id: 'exreg',     period: 'east_lw'    }, // Extra Reg Last Week
  { id: 'op16_lw',   period: 'op16_lw'    }, // OP16 Final Week — real slug not yet confirmed, likely renamed to something like "op16_5" or "op165"; still 404ing until confirmed
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

// ── Cardkaizoku dropdown monitor ─────────────────────────────────
// Detects when cardkaizoku adds, removes, or renames a period on their own
// site, by diffing their dropdown's text against what was seen last run —
// catching drift (like "OP16 Final Week" quietly becoming "OP16.5 Final
// Week Snapshot") as an explicit change, before it just shows up as an
// unexplained 404 with no story behind it.
//
// This is genuinely best-effort: their page is a client-rendered SPA with
// markup this script has never actually seen rendered, so it tries a
// handful of common patterns to open the dropdown, in order, and gives up
// gracefully — logging what it found (or that it found nothing) — rather
// than ever failing the whole workflow over a monitoring step.
async function checkCardkaizokuDropdown(ctx) {
  const page = await ctx.newPage();
  const snapshotPath = path.join(WORKSPACE, 'data', 'cardkaizoku-periods.json');
  try {
    await page.goto('https://www.cardkaizoku.com/ranking', { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(2500); // let the SPA hydrate before touching anything

    const openStrategies = [
      () => page.locator('select').first().click({ timeout: 3000 }),
      () => page.locator('[role="combobox"]').first().click({ timeout: 3000 }),
      () => page.locator('button, div').filter({ hasText: /Standard|Last Week|Lobbies/i }).first().click({ timeout: 3000 }),
    ];
    for (const strategy of openStrategies) {
      try { await strategy(); await page.waitForTimeout(500); break; } catch {}
    }

    const bodyText = await page.evaluate(() => document.body.innerText);
    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
    const periodPattern = /(Standard|Extra Reg|OP\d+(\.\d+)?\s*(Final|Last)|Last Week|Yesterday|Snapshot)/i;
    const found = [...new Set(lines.filter(l => periodPattern.test(l) && l.length < 60))].sort();

    if (!found.length) {
      console.log('::warning::Cardkaizoku dropdown check found no recognizable period labels this run (best-effort check — their page markup may not match what this script expects). Worth a manual look at https://www.cardkaizoku.com/ranking.');
      return;
    }

    console.log('\nCardkaizoku dropdown currently shows:');
    found.forEach(f => console.log(`  - ${f}`));

    let previous = [];
    try { previous = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); } catch {}
    const added = found.filter(f => !previous.includes(f));
    const removed = previous.filter(f => !found.includes(f));
    if (added.length) console.log(`::warning::New period label(s) on cardkaizoku since last check: ${added.join(' | ')}`);
    if (removed.length) console.log(`::warning::Period label(s) that disappeared from cardkaizoku since last check: ${removed.join(' | ')}`);
    fs.writeFileSync(snapshotPath, JSON.stringify(found, null, 2));
  } catch (e) {
    console.log(`::warning::Could not check cardkaizoku's dropdown this run (${e.message}). Not fatal — this is monitoring only.`);
  } finally {
    await page.close().catch(() => {});
  }
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

  // ── Dataset freshness tracking ───────────────────────────────────
  // Loaded once here, updated per-dataset below, written out at the end.
  // This is what lets the app show real "updated Xh ago" text per dataset
  // instead of a static hand-written label — and what lets this workflow
  // loudly flag a dataset that's quietly stopped updating, instead of that
  // only being noticed by chance months later.
  const STATUS_PATH = path.join(WORKSPACE, 'data', 'dataset-status.json');
  const STALE_HOURS = 48; // ~8 missed runs at the current 6-hour cadence
  let datasetStatus = {};
  try { datasetStatus = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); } catch {}

  const page = await ctx.newPage();
  let primaryData = null;

  // ── Stats datasets ────────────────────────────────────────────────
  for (const ds of DATASETS) {
    process.stdout.write(`${ds.id}... `);
    const url1 = `https://cdn.cardkaizoku.com/stats/stats_${ds.period}_${today}.json?v=8`;
    const url2 = `https://cdn.cardkaizoku.com/stats/stats_${ds.period}_${yesterday}.json?v=8`;
    const result = await browserFetch(page, url1) || await browserFetch(page, url2);
    const now = new Date().toISOString();
    const prev = datasetStatus[ds.id] || {};
    if (result) {
      fs.writeFileSync(path.join(statsDir, `${ds.id}.json`), result.text);
      console.log(`✓  (${result.data.length} leaders)`);
      // Prefer 'west' (All Lobbies) as the source for which leaders to
      // download portraits for — west_p gets processed first in this loop,
      // but we don't want the private-lobby roster driving that list.
      if (!primaryData || ds.id === 'west') primaryData = result.data;
      if (ds.id === 'west') fs.writeFileSync(path.join(WORKSPACE, 'data', 'stats.json'), result.text);
      datasetStatus[ds.id] = { lastSuccessAt: now, lastAttemptAt: now, lastAttemptFailed: false };
    } else {
      console.log('✗');
      datasetStatus[ds.id] = { lastSuccessAt: prev.lastSuccessAt || null, lastAttemptAt: now, lastAttemptFailed: true };
      // Loud, not silent: a dataset with no successful fetch in STALE_HOURS
      // (or one that's never succeeded at all) gets a GitHub Actions warning
      // annotation, which shows up directly in the workflow run summary.
      const last = prev.lastSuccessAt ? new Date(prev.lastSuccessAt) : null;
      const hoursSince = last ? (Date.now() - last.getTime()) / 3.6e6 : Infinity;
      if (hoursSince > STALE_HOURS) {
        console.log(`::warning::Dataset "${ds.id}" has not updated successfully in ${last ? hoursSince.toFixed(0)+'h' : 'ever'} — check whether cardkaizoku renamed or removed this period.`);
      }
    }
  }

  try { fs.writeFileSync(STATUS_PATH, JSON.stringify(datasetStatus, null, 2)); } catch(e) { console.log(`Could not write dataset-status.json: ${e.message}`); }


  // ── Hands, Decklist, Matchuptech data ────────────────────────────
  // Fetch these extra file types for each primary dataset
  const EXTRA_TYPES = [
    { type: 'hands',      datasets: ['west_p', 'lw_p'] },
    { type: 'decklist',   datasets: ['west_p', 'lw_p'] },
    { type: 'matchuptech',datasets: ['west_p', 'lw_p'] },
  ];

  for (const { type, datasets } of EXTRA_TYPES) {
    console.log(`\n${type} data:`);
    for (const id of datasets) {
      const ds = DATASETS.find(d => d.id === id);
      if (!ds) { console.log(`  ${id}... ✗ (unknown dataset id — skipped)`); continue; }
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
    const leaders = [...primaryData].sort((a,b) => (b.play_rate||0)-(a.play_rate||0)); // no limit — cache all leaders
    console.log(`\nDownloading leader portraits for all ${leaders.length} decks...`);
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
        for (let attempt = 0; attempt < 2 && !saved; attempt++) {
          try {
            const res = await page.goto(imgUrl, { waitUntil: 'load', timeout: 12000 });
            if (res && res.ok()) {
              const buf = await res.body();
              if (buf && buf.length > 500) { fs.writeFileSync(outPath, buf); downloaded++; saved = true; break; }
            }
          } catch {}
        }
        if (saved) break;
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

  // Dropdown monitor — reuses the same authenticated context, runs last so
  // it can't interfere with the actual data fetch above it.
  await checkCardkaizokuDropdown(ctx);

  await browser.close();

  // ── Character card images (Bandai/Limitless — no Cloudflare, plain Node fetch works) ──
  // Collect all character/event card IDs from hands data
  const charIds = new Set();
  for (const dsId of ['west_p', 'lw_p']) {
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
