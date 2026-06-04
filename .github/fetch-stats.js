const { chromium } = require('/tmp/node_modules/playwright');
const fs   = require('fs');
const path = require('path');

const OUT      = path.join(process.env.GITHUB_WORKSPACE, 'data', 'stats.json');
const COOKIE_STR = process.env.CARDKAIZOKU_COOKIES || '';

// Parse "name=value; name2=value2" into Playwright cookie objects
function parseCookies(str) {
  if (!str) return [];
  return str.split(';').map(c => {
    const eq = c.indexOf('=');
    if (eq === -1) return null;
    return {
      name:   c.slice(0, eq).trim(),
      value:  c.slice(eq + 1).trim(),
      domain: '.cardkaizoku.com',
      path:   '/',
    };
  }).filter(Boolean);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  });

  // Inject cookies properly rather than via header — more reliable
  const cookies = parseCookies(COOKIE_STR);
  if (cookies.length > 0) {
    await ctx.addCookies(cookies);
    console.log(`Injected ${cookies.length} cookies`);
  } else {
    console.log('WARNING: No CARDKAIZOKU_COOKIES secret found — may hit login wall');
  }

  const page = await ctx.newPage();
  let captured = null;

  try {
    // Wait specifically for the stats JSON response rather than page networkidle
    // This avoids timeout from background polling on the page
    const statsResponsePromise = page.waitForResponse(
      r => r.url().includes('cdn.cardkaizoku.com/stats/') && r.url().includes('.json'),
      { timeout: 45000 }
    );

    console.log('Navigating to cardkaizoku.com/matchups...');
    await page.goto('https://www.cardkaizoku.com/matchups', {
      waitUntil: 'domcontentloaded',   // less strict — doesn't wait for background requests
      timeout: 30000,
    });

    console.log('Waiting for stats JSON response...');
    try {
      const response = await statsResponsePromise;
      const text = await response.text();
      JSON.parse(text); // validate
      captured = text;
      console.log('✓ Captured: ' + response.url() + ' (' + text.length + ' bytes)');
    } catch (e) {
      console.log('Stats response not received on matchups page: ' + e.message);
    }

    // If matchups page didn't trigger the fetch, try ranking
    if (!captured) {
      console.log('Trying /ranking page...');
      const rankingStatsPromise = page.waitForResponse(
        r => r.url().includes('cdn.cardkaizoku.com/stats/') && r.url().includes('.json'),
        { timeout: 30000 }
      );
      try {
        await page.goto('https://www.cardkaizoku.com/ranking', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        const response = await rankingStatsPromise;
        const text = await response.text();
        JSON.parse(text);
        captured = text;
        console.log('✓ Captured from /ranking: ' + response.url());
      } catch (e) {
        console.log('/ranking attempt failed: ' + e.message);
      }
    }

    // Last resort: try fetching CDN directly from within the authenticated browser context
    if (!captured) {
      console.log('Attempting direct CDN fetch from browser context...');
      const today = new Date();
      for (let i = 0; i <= 7 && !captured; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const ds = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
        for (const prefix of ['stats_west_p_', 'stats_op16_']) {
          for (const v of [8, 9, 7, 10]) {
            const url = `https://cdn.cardkaizoku.com/stats/${prefix}${ds}.json?v=${v}`;
            const res = await page.evaluate(async (url) => {
              try {
                const r = await fetch(url, { credentials: 'include' });
                if (!r.ok) return { ok: false, status: r.status };
                const text = await r.text();
                return { ok: true, text };
              } catch(e) { return { ok: false, error: e.message }; }
            }, url);
            if (res.ok) {
              try { JSON.parse(res.text); captured = res.text; console.log('✓ Direct fetch: ' + url); break; } catch {}
            } else {
              console.log(`  ${url} → ${res.status || res.error}`);
            }
            if (captured) break;
          }
          if (captured) break;
        }
      }
    }

    if (captured) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, captured);
      console.log('Saved ' + captured.length + ' bytes to data/stats.json');
    } else {
      const currentUrl = page.url();
      console.log('Current URL: ' + currentUrl);
      if (currentUrl.includes('login') || currentUrl.includes('auth') || currentUrl.includes('patreon')) {
        console.log('LOGIN WALL — update CARDKAIZOKU_COOKIES secret with fresh cookies');
      } else {
        console.log('No stats data captured');
      }
    }

  } catch(e) {
    console.error('Fatal error: ' + e.message);
  } finally {
    await browser.close();
  }
})();
