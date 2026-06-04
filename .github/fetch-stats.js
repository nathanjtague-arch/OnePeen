const { chromium } = require('/tmp/node_modules/playwright');
const fs   = require('fs');
const path = require('path');

const OUT        = path.join(process.env.GITHUB_WORKSPACE, 'data', 'stats.json');
const COOKIES    = process.env.CARDKAIZOKU_COOKIES || '';

// Generate dates from today back 7 days
function getDates() {
  const dates = [];
  for (let i = 0; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0,10).replace(/-/g,''));
  }
  return dates;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    extraHTTPHeaders: COOKIES ? { 'Cookie': COOKIES } : {},
  });
  const page = await ctx.newPage();
  let captured = null;

  // Intercept the stats JSON the page fetches naturally
  page.on('response', async response => {
    const url = response.url();
    if (!url.includes('cdn.cardkaizoku.com/stats/stats_west_p_')) return;
    if (!url.includes('.json')) return;
    try {
      const text = await response.text();
      JSON.parse(text);
      captured = text;
      console.log('Intercepted: ' + url + ' (' + text.length + ' bytes)');
    } catch(e) {
      console.log('Non-JSON from ' + url);
    }
  });

  try {
    // Visit the main site — auth cookie gets us past the login wall
    console.log('Loading cardkaizoku.com/matchups...');
    await page.goto('https://www.cardkaizoku.com/matchups', {
      waitUntil: 'networkidle',
      timeout: 60000
    });
    await page.waitForTimeout(3000);

    if (!captured) {
      console.log('Trying /ranking...');
      await page.goto('https://www.cardkaizoku.com/ranking', {
        waitUntil: 'networkidle',
        timeout: 45000
      });
      await page.waitForTimeout(2000);
    }

    // If still no data, try fetching CDN directly from browser context
    // (no auth needed on CDN itself — just needs legit browser headers)
    if (!captured) {
      console.log('Attempting direct CDN fetch from browser context...');
      for (const date of getDates()) {
        for (const v of [8,9,7,10,6]) {
          const url = `https://cdn.cardkaizoku.com/stats/stats_west_p_${date}.json?v=${v}`;
          const res = await page.evaluate(async (url) => {
            try {
              const r = await fetch(url, { credentials: 'include' });
              if (!r.ok) return { ok: false, status: r.status };
              const text = await r.text();
              return { ok: true, text };
            } catch(e) { return { ok: false, error: e.message }; }
          }, url);
          if (res.ok) {
            try {
              JSON.parse(res.text);
              captured = res.text;
              console.log('Direct fetch success: ' + url);
              break;
            } catch(e) {}
          } else {
            console.log('  ' + url + ' → ' + (res.status || res.error));
          }
        }
        if (captured) break;
      }
    }

    if (captured) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, captured);
      console.log('Saved ' + captured.length + ' bytes to data/stats.json');
    } else {
      const currentUrl = page.url();
      if (currentUrl.includes('login') || currentUrl.includes('auth') || currentUrl.includes('patreon')) {
        console.log('LOGIN WALL — CARDKAIZOKU_COOKIES secret is missing or expired. Refresh it from your browser.');
      } else {
        console.log('No stats data found. Page URL: ' + currentUrl);
      }
    }

  } catch(e) {
    console.error('Error: ' + e.message);
  } finally {
    await browser.close();
  }
})();
