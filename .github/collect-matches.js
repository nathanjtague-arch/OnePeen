/**
 * Meta Master: match collector.
 *
 * For every player marked tracked=true in Supabase, opens their match history the
 * way a person would (search by name, View Matches, Load More, expand rows), reads
 * the table, and saves each game to Supabase. Nothing is written to the public repo.
 *
 * Secrets (GitHub Actions): CARDKAIZOKU_COOKIES, SUPABASE_URL, SUPABASE_SERVICE_KEY.
 * They are only read from the environment, never printed.
 *
 * Modes: incremental (default; stops once it reaches games it already has)
 *        full (MODE=full; keeps pressing Load More to the very start)
 *        A player with no games stored yet is always collected in full.
 * Polite by design: one player at a time, pauses between page loads.
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/tmp/node_modules/playwright');

const COOKIE_STR = process.env.CARDKAIZOKU_COOKIES || '';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const MODE = (process.env.MODE || 'incremental').toLowerCase();
const ONLY = (process.env.ONLY_PLAYER || '').trim();           // optional: just one player
const DRY_RUN = process.env.DRY_RUN === '1';                    // read + report, write nothing
const MAX_LOAD_MORE = parseInt(process.env.MAX_LOAD_MORE || '120', 10);
const PAUSE_MS = 1200;

if (!DRY_RUN && (!SB_URL || !SB_KEY)) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set.'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => (s || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

function parseCookies(str) {
  if (!str) return [];
  return str.split(';').map(c => { const eq = c.indexOf('='); if (eq === -1) return null;
    return { name: c.slice(0, eq).trim(), value: c.slice(eq + 1).trim(), domain: '.cardkaizoku.com', path: '/' }; }).filter(Boolean);
}

// ── Supabase (REST) ────────────────────────────────────────────────
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

// ── Reading one player's history ───────────────────────────────────
// The page shows times as the viewer's local time; the browser is pinned to UTC so
// every player is read the same way and the same game gets the same key from both sides.
function toIso(dmy, hm) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dmy), t = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m || !t) return null;
  return `${m[3]}-${m[2]}-${m[1]}T${t[1].padStart(2, '0')}:${t[2]}:00Z`;
}
const code = s => (/\[([A-Z0-9]+-\d+)\]/.exec(s || '') || [])[1] || null;

async function openHistory(page, name) {
  const seen = [];
  const onResp = r => { const u = r.url(); if (/\.(png|webp|jpe?g|svg|css|woff2?|ico)(\?|$)|cdn-cgi|google|doubleclick|adsbygoogle|gstatic/i.test(u)) return;
    seen.push(`${r.request().method()} ${r.status()} ${u.replace(/(playerId|deviceId|token|key)=[^&]*/gi, '$1=X').replace(/^https?:\/\//, '').slice(0, 110)}`); };
  page.on('response', onResp);
  const onReq = r => { const u = r.url(); if (/api\.cardkaizoku|auth\.cardkaizoku/i.test(u)) seen.push(`REQ ${r.method()} ${u.replace(/^https?:\/\//, '').slice(0, 90)}`); };
  const onFail = r => { const u = r.url(); if (!/adsafe|2mdn|google|doubleclick|adsbygoogle|gstatic|cdn-cgi/i.test(u)) seen.push(`FAIL ${u.replace(/^https?:\/\//, '').slice(0, 90)} ${r.failure()?.errorText || ''}`); };
  const errs = [];
  const onCons = m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); };
  const onPageErr = e => errs.push('pageerror: ' + String(e.message).slice(0, 160));
  page.on('request', onReq); page.on('requestfailed', onFail); page.on('console', onCons); page.on('pageerror', onPageErr);
  await page.goto('https://www.cardkaizoku.com/matchhistory', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input', { timeout: 30000 });
  const input = page.locator('main input').first();
  await input.fill(name);
  await input.press('Enter');
  const view = page.getByText('View Matches', { exact: false }).first();
  await view.waitFor({ timeout: 30000 });
  // The search can show several people with a similar name; only continue if the heading is an exact match.
  const heads = await page.locator('main h2, main h3').allInnerTexts();
  if (!heads.map(clean).includes(name)) throw new Error(`Exact player "${name}" not found (saw: ${heads.map(clean).join(' | ').slice(0, 120)})`);
  console.log('  search ok, opening matches…');
  await view.click();
  try {
    await page.waitForSelector('tr.match-summary-row', { timeout: 45000 });
  } catch (e) {
    // Say what the page actually showed, so a failure is diagnosable from the log (no secrets, ids redacted).
    const u = page.url().replace(/(playerId|deviceId)=[^&]*/g, '$1=X');
    const txt = clean(await page.evaluate(() => (document.querySelector('main') || document.body).innerText).catch(() => '')).slice(0, 700);
    const tables = await page.locator('table').count().catch(() => -1);
    const trs = await page.evaluate(() => [...document.querySelectorAll('tr')].slice(0, 6).map(r => (r.className || 'tr') + ':' + r.innerText.replace(/\s+/g, ' ').slice(0, 60))).catch(() => []);
    const tail = clean(await page.evaluate(() => (document.querySelector('main') || document.body).innerText).catch(() => '')).slice(-600);
    page.off('response', onResp);
    console.log('  requests seen: ' + JSON.stringify(seen.filter(x => !/adsafe|2mdn|google|doubleclick/i.test(x)).slice(-30)));
    console.log('  page errors: ' + JSON.stringify(errs.slice(0, 8)));
    const cookieNames = (await page.context().cookies()).map(c => c.name).join(',');
    console.log('  cookie names in browser: ' + cookieNames);
    if (seen.some(x => / 401 auth\.cardkaizoku\.com\/verify/.test(x))) throw new Error('LOGIN EXPIRED: Kaizoku rejected the saved login (401). Refresh the CARDKAIZOKU_COOKIES secret with fresh auth_token and cf_clearance values from a logged-in browser.');
    throw new Error(`Match table did not appear. url=${u} tables=${tables} trs=${JSON.stringify(trs)} tail="${tail}"`);
  }
}

async function readRows(page) {
  return page.evaluate(() => {
    const out = [];
    const trs = [...document.querySelectorAll('tbody tr')];
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i];
      if (!tr.classList.contains('match-summary-row')) continue;
      const q = s => tr.querySelector(s)?.textContent || '';
      const det = trs[i + 1] && trs[i + 1].classList.contains('match-details-row') ? trs[i + 1] : null;
      const facts = {};
      det?.querySelectorAll('.match-detail-fact').forEach(f => { facts[(f.querySelector('span')?.textContent || '').trim()] = (f.querySelector('strong')?.textContent || '').trim(); });
      out.push({
        day: q('.match-date-day'), time: q('.match-date-time'),
        myLeader: q('.match-player-leader-id-column'), oppLeader: q('.match-opponent-leader-id-column'),
        result: q('.match-result-column').trim(),
        lobby: tr.querySelector('.match-lobby-badge')?.classList.contains('is-private') ? 'private' : tr.querySelector('.match-lobby-badge') ? 'public' : null,
        detail: det ? {
          names: [...det.querySelectorAll('h4')].map(h => h.textContent),
          coin: det.querySelector('.coinflip-result-icon')?.getAttribute('aria-label') || '',
          turnOrder: facts['Turn Order'] || '', turns: facts['# Turns'] || '', mode: facts['Mode'] || '',
        } : null,
      });
    }
    return out;
  });
}

async function collectPlayer(page, name, knownLatest, full) {
  await openHistory(page, name);
  let loads = 0, lastCount = 0;
  while (loads < MAX_LOAD_MORE) {
    const count = await page.locator('tr.match-summary-row').count();
    // Incremental: once the oldest row on screen is older than what we already hold, stop.
    if (!full && knownLatest) {
      const rows = await readRows(page); const last = rows[rows.length - 1];
      const iso = last && toIso(last.day, last.time);
      if (iso && iso < knownLatest) break;
    }
    const more = page.getByRole('button', { name: /load more/i }).first();
    if (!(await more.count()) || !(await more.isVisible().catch(() => false))) break;
    await more.click(); loads++;
    await page.waitForFunction(n => document.querySelectorAll('tr.match-summary-row').length > n, count, { timeout: 30000 }).catch(() => {});
    await sleep(PAUSE_MS);
    if (await page.locator('tr.match-summary-row').count() === lastCount) break;
    lastCount = count;
  }
  // Open every row so the details (opponent name, coin flip, turn order) are present.
  const expand = page.getByRole('button', { name: /expand all/i }).first();
  if (await expand.count()) { await expand.click(); await sleep(2500); }
  let rows = await readRows(page);
  if (rows.some(r => !r.detail)) {                      // fallback: open any row that stayed closed
    const btns = page.locator('button[aria-label="Show match details"]'); const n = await btns.count();
    for (let i = 0; i < n; i++) { await btns.nth(0).click().catch(() => {}); await sleep(60); }
    await sleep(1500); rows = await readRows(page);
  }
  return rows;
}

function toGame(me, r) {
  const opp = clean(r.detail?.names?.[1] || ''); const iso = toIso(r.day, r.time);
  const myLeader = code(r.myLeader), oppLeader = code(r.oppLeader);
  if (!opp || !iso || !myLeader || !oppLeader || !/^(won|lost)$/i.test(r.result)) return null;
  const iWon = /won/i.test(r.result);
  const meFirst = /1st/i.test(r.detail.turnOrder) ? true : /2nd/i.test(r.detail.turnOrder) ? false : null;
  const meCoin = /won/i.test(r.detail.coin) ? true : /lost/i.test(r.detail.coin) ? false : null;
  const meIsP1 = me < opp;                                 // fixed order so both players' views give one identical row
  const mine = meIsP1 ? 1 : 2, theirs = meIsP1 ? 2 : 1;
  const p1 = meIsP1 ? { n: me, l: myLeader } : { n: opp, l: oppLeader };
  const p2 = meIsP1 ? { n: opp, l: oppLeader } : { n: me, l: myLeader };
  return {
    game_key: `${iso}|${p1.n}|${p2.n}`, played_at: iso,
    p1_name: p1.n, p1_leader: p1.l, p2_name: p2.n, p2_leader: p2.l,
    winner: iWon ? mine : theirs, lobby: r.lobby,
    first_player: meFirst === null ? null : (meFirst ? mine : theirs),
    coin_winner: meCoin === null ? null : (meCoin ? mine : theirs),
    turns: parseInt(r.detail.turns, 10) || null, region: r.detail.mode || null,
  };
}

(async () => {
  let players;
  if (ONLY) players = [{ name: ONLY }];
  else players = await sb('players?tracked=eq.true&select=name&order=name');
  console.log(`Players to collect: ${players.map(p => p.name).join(', ')} (mode: ${MODE}${DRY_RUN ? ', dry run' : ''})`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    timezoneId: 'UTC', locale: 'en-GB',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const cookies = parseCookies(COOKIE_STR);
  if (cookies.length) await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  let failures = 0;

  for (const p of players) {
    const name = p.name;
    try {
      let knownLatest = null, haveAny = false;
      if (!DRY_RUN) {
        const latest = await sb(`games?or=(p1_name.eq.${encodeURIComponent(name)},p2_name.eq.${encodeURIComponent(name)})&select=played_at&order=played_at.desc&limit=1`);
        if (latest.length) { haveAny = true; knownLatest = new Date(new Date(latest[0].played_at).getTime() - 36e5).toISOString().replace('.000', ''); }
      }
      const full = MODE === 'full' || !haveAny;
      const rows = await collectPlayer(page, name, knownLatest, full);
      const games = rows.map(r => toGame(name, r)).filter(Boolean);
      const skipped = rows.length - games.length;
      console.log(`${name}: read ${rows.length} rows -> ${games.length} games${skipped ? `, ${skipped} skipped (missing detail)` : ''} (${full ? 'full' : 'incremental'})`);
      if (skipped > rows.length * 0.3) throw new Error('Too many rows missing details; the page layout may have changed. Nothing written for this player.');
      if (DRY_RUN) { console.log('Sample:', JSON.stringify(games.slice(0, 2).map(g => ({ ...g, p1_name: '…', p2_name: '…', game_key: '…' })))); continue; }

      const names = [...new Set(games.flatMap(g => [g.p1_name, g.p2_name]))];
      for (let i = 0; i < names.length; i += 200)
        await sb('players?on_conflict=name', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: names.slice(i, i + 200).map(n => ({ name: n })) });
      for (let i = 0; i < games.length; i += 200)
        await sb('games?on_conflict=game_key', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: games.slice(i, i + 200) });
      await sb(`players?name=eq.${encodeURIComponent(name)}`, { method: 'PATCH', prefer: 'return=minimal', body: { last_scraped: new Date().toISOString() } });
      console.log(`${name}: saved.`);
    } catch (e) {
      failures++; console.error(`${name}: FAILED - ${String(e.message).slice(0, 300)}`);
    }
    await sleep(PAUSE_MS * 2);
  }
  await browser.close();
  if (failures === players.length && players.length) process.exit(1);
})();
