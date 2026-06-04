// Pure Node.js — no Playwright, no cookies, no browser.
// The cardkaizoku CDN is publicly accessible. Auth is UI-only on their site.
// URL pattern: https://cdn.cardkaizoku.com/stats/{type}_{period}_{YYYYMMDD}.json?v=8

const fs   = require('fs');
const path = require('path');

const WORKSPACE = process.env.GITHUB_WORKSPACE;

// All known datasets — all publicly accessible
const DATASETS = [
  { id: 'op16',    period: 'op16'    },
  { id: 'west_p',  period: 'west_p'  },
  { id: 'west',    period: 'west'    },
  { id: 'lw_p',    period: 'lw_p'   },
  { id: 'lw',      period: 'lw'      },
  { id: 'exreg_p', period: 'exreg_p' },
  { id: 'exreg',   period: 'exreg'   },
];

// Exact date format used by cardkaizoku's fetchFile.js — LA timezone, YYYYMMDD
function laDate(offsetDays = 0) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  d.setDate(d.getDate() - offsetDays);
  const str = d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [month, day, year] = str.split('/');
  return `${year}${month}${day}`;
}

async function fetchJSON(type, period, date) {
  const url = `https://cdn.cardkaizoku.com/stats/${type}_${period}_${date}.json?v=8`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const text = await res.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) return null;
    return { text, data, url };
  } catch { return null; }
}

async function fetchBinary(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

(async () => {
  const statsDir = path.join(WORKSPACE, 'data', 'stats');
  const cardsDir = path.join(WORKSPACE, 'data', 'cards');
  fs.mkdirSync(statsDir, { recursive: true });
  fs.mkdirSync(cardsDir, { recursive: true });

  const today    = laDate(0);
  const yesterday = laDate(1);
  console.log(`Dates: today=${today}, yesterday=${yesterday} (LA timezone)\n`);

  // ── Fetch all stats datasets ──────────────────────────────────────
  let primaryData = null;

  for (const ds of DATASETS) {
    process.stdout.write(`${ds.id}... `);
    const result = await fetchJSON('stats', ds.period, today)
                || await fetchJSON('stats', ds.period, yesterday);
    if (result) {
      fs.writeFileSync(path.join(statsDir, `${ds.id}.json`), result.text);
      console.log(`✓  ${result.url}`);
      if (!primaryData) primaryData = result.data;
      if (ds.id === 'west_p') fs.writeFileSync(path.join(WORKSPACE, 'data', 'stats.json'), result.text);
    } else {
      console.log('✗  not found');
    }
  }

  // ── Fetch hands data (Patreon feature on their site, public on CDN) ──
  console.log('\nFetching hands data...');
  for (const ds of DATASETS.filter(d => ['west_p', 'op16', 'lw_p'].includes(d.id))) {
    process.stdout.write(`  hands/${ds.id}... `);
    const result = await fetchJSON('hands', ds.period, today)
                || await fetchJSON('hands', ds.period, yesterday);
    if (result) {
      fs.writeFileSync(path.join(statsDir, `hands_${ds.id}.json`), result.text);
      console.log(`✓`);
    } else {
      console.log('✗');
    }
  }

  // ── Fetch curve data (always uses 'lw' period per their source code) ─
  console.log('\nFetching curve data...');
  const curve = await fetchJSON('curve', 'lw', today)
             || await fetchJSON('curve', 'lw', yesterday);
  if (curve) {
    fs.writeFileSync(path.join(statsDir, 'curve.json'), curve.text);
    console.log('  curve/lw ✓');
  }

  // ── Download card images ──────────────────────────────────────────
  if (primaryData) {
    const sorted = [...primaryData].sort((a,b) => (b.play_rate||0)-(a.play_rate||0)).slice(0, 60);
    console.log(`\nDownloading images for top ${sorted.length} leaders...`);
    let downloaded = 0, skipped = 0, failed = 0;

    for (const entry of sorted) {
      const id = entry.leader;
      if (!id) continue;
      const outPath = path.join(cardsDir, `${id}.png`);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) { skipped++; continue; }
      const set = id.split('-')[0];
      const buf = await fetchBinary(`https://cdn.cardkaizoku.com/cards_en/${set}/${id}.png`);
      if (buf && buf.length > 500) { fs.writeFileSync(outPath, buf); downloaded++; }
      else failed++;
    }
    console.log(`Images: ${downloaded} downloaded, ${skipped} cached, ${failed} failed`);
  }

  console.log('\nDone.');
})();
