const { chromium } = require('/tmp/node_modules/playwright');
const fs   = require('fs');
const path = require('path');

const OUT = path.join(process.env.GITHUB_WORKSPACE, 'data', 'stats.json');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  let captured = null;

  // Intercept CDN responses BEFORE navigating — grab the stats JSON the page fetches itself
  page.on('response', async response => {
    const url = response.url();
    if (!url.includes('cdn.cardkaizoku.com')) return;
    if (!url.includes('stats_op16_') || !url.includes('.json')) return;
    try {
      const text = await response.text();
      JSON.parse(text); // validate it's real JSON
      captured = text;
      console.log('Intercepted: ' + url + ' (' + text.length + ' bytes)');
    } catch(e) {
      console.log('Skipping non-JSON from ' + url);
    }
  });

  try {
    console.log('Loading cardkaizoku.com/matchups...');
    await page.goto('https://www.cardkaizoku.com/matchups', {
      waitUntil: 'networkidle',
      timeout: 60000
    });
    await page.waitForTimeout(3000);

    if (!captured) {
      console.log('No stats on matchups page, trying /ranking...');
      await page.goto('https://www.cardkaizoku.com/ranking', {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      await page.waitForTimeout(2000);
    }

    if (captured) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, captured);
      console.log('Saved to data/stats.json');
    } else {
      console.log('No stats data intercepted');
    }

  } catch(e) {
    console.error('Browser error: ' + e.message);
  } finally {
    await browser.close();
  }
})();
