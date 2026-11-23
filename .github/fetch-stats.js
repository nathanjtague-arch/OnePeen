// Uses Playwright purely as a Cloudflare-friendly HTTP client.
// CDN is publicly accessible but Cloudflare blocks non-browser TLS fingerprints.
// We navigate Chromium directly to each CDN URL.
//
// ── HOW DATASETS WORK NOW (rewritten Nov 2026) ───────────────────────────
// This file used to carry a hand-typed list of cardkaizoku period slugs
// ("op17", "op17_lw", ...). That broke the moment cardkaizoku restructured
// its dropdown (Standard disappeared, OP17 froze into a Snapshot, OP18 and
// EB05 appeared), because nobody told the list.
//
// Now the site tells US. Every run we:
//   1. DISCOVER  — open cardkaizoku's ranking page, read every option in the
//                  period dropdown, click each one, and record the exact
//                  CDN URL the page itself requests for it.
//   2. MANIFEST  — write that to data/datasets.json. The app builds its
//                  dropdown from this file, so it can never list something
//                  that doesn't exist, and new periods appear on their own.
//   3. FETCH     — download each dataset from the URL the site gave us.
//   4. HISTORY   — keep a tiny daily snapshot of each live dataset so Meta
//                  Trends can compare "now" vs "a week ago" from OUR data,
//                  no matter how cardkaizoku names things.
//
// If discovery fails (their page changes shape), the previous manifest is
// kept, a pattern-probe fallback tries the known slug conventions, and a
// loud warning is raised. data/discovery-log.json records exactly what was
// seen on every run, so a failure can be diagnosed from the repo alone.

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/tmp/node_modules/playwright');
const fs   = require('fs');
const path = require('path');

const WORKSPACE  = process.env.GITHUB_WORKSPACE;
const COOKIE_STR = process.env.CARDKAIZOKU_COOKIES || '';
const RANKING_URL = process.env.CK_RANKING_URL || 'https://www.cardkaizoku.com/ranking';
const SKIP_IMAGES = process.env.SKIP_IMAGES === '1';

const STALE_HOURS   = 48;  // warn if a dataset hasn't refreshed in this long
const HISTORY_DAYS  = 35;  // daily trend snapshots kept per dataset
const MIN_DISCOVERED = 3;  // fewer labels than this = discovery is not trusted

function parseCookies(str) {
  if (!str) return [];
  return str.split(';').map(c => {
    const eq = c.indexOf('=');
    if (eq === -1) return null;
    return { name: c.slice(0,eq).trim(), value: c.slice(eq+1).trim(), domain: '.cardkaizoku.com', path: '/' };
  }).filter(Boolean);
}

// LA timezone date (YYYYMMDD).
// The previous version converted time zones twice, which on a UTC runner made
// it return the PREVIOUS day between midnight and 8am Los Angeles time — so the
// freshest file could be skipped for part of every day. This version asks Intl
// for the LA calendar date directly, then steps back whole days.
const LA_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
function laDate(offset = 0) {
  const [y, m, d] = LA_FMT.format(new Date()).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - offset * 86400000);
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
}
// Dates to try for any dated file: the real LA today, yesterday, and the day
// before (that third one also covers every date the old buggy formula produced).
const tryDates = () => [laDate(0), laDate(1), laDate(2)];

// Sample of fetch attempts (URL + HTTP status) kept for data/discovery-log.json,
// so a failure can be diagnosed (404 = wrong name, 403 = blocked) from the repo alone.
const FETCH_LOG = [];
function noteFetch(url, status) { if (FETCH_LOG.length < 80) FETCH_LOG.push({ url: url.slice(0, 200), status }); }

// Navigate browser directly to a CDN JSON URL and read the response body
async function browserFetch(page, url) {
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    noteFetch(url, res ? res.status() : 'no response');
    if (!res || !res.ok()) {
      console.log(`  HTTP ${res?.status()} — ${url}`);
      return null;
    }
    const text = await page.evaluate(() => document.body.innerText);
    const data = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) return null;
    return { text: JSON.stringify(data), data, url };
  } catch(e) {
    noteFetch(url, 'error: ' + e.message.split('\n')[0].slice(0, 80));
    console.log(`  Error: ${e.message}`);
    return null;
  }
}

// ── Downloading data files ───────────────────────────────────────────────
// Cardkaizoku's CDN answers 403 to a browser that simply navigates to a data
// file (no referrer / site headers), yet serves the very same URL to the site's
// own page. So files are requested from INSIDE a loaded cardkaizoku page via
// fetch(), exactly as the site does — from the site's own origin (so it carries their referrer), and replaying
// any extra request headers the page itself was seen sending (values are only
// held in memory; never written to disk or the log). Plain navigation remains
// as a fallback.
let sitePage = null;          // a loaded cardkaizoku page we fetch from
let navPage  = null;          // plain page used for navigation fallback and images
let siteHeaders = {};         // extra headers the site's own data requests carried
const SKIP_HEADERS = /^(host|user-agent|accept.*|sec-.*|referer|origin|cookie|connection|content-.*|cache-control|pragma|priority|upgrade-insecure-requests|if-.*|range|dnt|te|:.*)$/i;
function captureHeaders(h) {
  const keep = {};
  for (const [k, v] of Object.entries(h || {})) if (!SKIP_HEADERS.test(k)) keep[k] = v;
  return keep;
}
async function dataFetch(url) {
  if (sitePage) {
    try {
      const r = await sitePage.evaluate(async ({ url, headers }) => {
        try {
          // No credentials: a CDN that answers "any site may read this" (ACAO: *) makes the
          // browser REFUSE a credentialed request ("Failed to fetch"), while a plain
          // request — what the site itself sends — works.
          const res = await fetch(url, { headers });
          return { status: res.status, text: await res.text() };
        } catch (e) { return { status: 'error: ' + e.message, text: '' }; }
      }, { url, headers: siteHeaders });
      noteFetch(url, `${r.status} (in-page)`);
      if (r.status === 200) {
        try {
          const data = JSON.parse(r.text);
          if (Array.isArray(data) && data.length) return { text: JSON.stringify(data), data, url };
        } catch {}
      } else console.log(`  in-page HTTP ${r.status} — ${url}`);
    } catch (e) { noteFetch(url, 'evaluate error: ' + e.message.split('\n')[0].slice(0, 60)); }
  }
  return browserFetch(navPage, url);
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

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

// ── Reading cardkaizoku's own naming ─────────────────────────────────────
// A stats request looks like  <base>stats_<slug>_<YYYYMMDD>.json?v=8
// (some periods may be undated or carry a different ?v= — we copy whatever
// the site actually used instead of assuming).
// Dated files come in two forms: a plain day (…_20261121) and, since Nov 2026,
// a build timestamp (…_20261122T001506) that is fresher than that day's file. Both
// are treated as the file's "date"; the slug is everything before it.
// The file prefix is captured too, not assumed: it was "stats_" until Nov 2026,
// when cardkaizoku renamed it to "ranking_" (and made ?v= a date instead of 8),
// which silently 403'd every download. Following whatever prefix the page uses
// means the next rename is picked up automatically. Other known file types
// (hands, decklist, ...) are excluded so they're never mistaken for rankings.
const STATS_URL_RE = /^(https?:\/\/[^/]*(?:cardkaizoku|localhost|127\.0\.0\.1)[^/]*\/(?:[^?#]*\/)?)(?!hands_|decklist_|matchuptech_|curve_|ranking_hands|image_|card_data|manifest)([a-z]+)_([^/?#]+?)(?:_(\d{8}(?:T\d{6})?))?\.json(\?[^#]*)?$/i;
function parseStatsUrl(url) {
  const m = STATS_URL_RE.exec(url);
  if (!m) return null;
  if (!/\/stats\/$/i.test(m[1])) return null;     // ranking files live under /stats/
  return { base: m[1], filePrefix: m[2].toLowerCase(), slug: m[3], date: m[4] || null, query: m[5] || '' };
}

// Turn a dropdown label into structured facts. Handles both the current
// style ("OP18 · Last Week · All Lobbies") and the older one
// ("Standard Last Week (All Lobbies)").
function describeLabel(label) {
  const lobby = /top\s*\d+\s*%/i.test(label) ? 'top'
              : /private/i.test(label)       ? 'private'
              : 'all';
  const kind  = /snapshot|full format/i.test(label) ? 'snapshot'
              : /last week/i.test(label)            ? 'last-week'
              : /yesterday/i.test(label)            ? 'yesterday'
              : 'live';
  // key = the label with the lobby part removed, so "All Lobbies" and
  // "Private" versions of the same period share a key (that's how a public
  // dataset finds its private sibling for Opening Hand data).
  const key = label
    .replace(/\s*\((all|private)\s+lobbies\)/gi, '')
    .split('·').map(s => s.trim())
    .filter(s => s && !/^(all lobbies|private( lobbies)?|top\s*\d+\s*%)$/i.test(s))
    .join(' · ')
    .replace(/^top\s*\d+\s*%\s*/i, '')
    .trim();
  let display = key.replace(/^\[snapshot\]\s*/i, '').trim();
  if (/^\[snapshot\]/i.test(key) && !/snapshot/i.test(display)) display += ' (Snapshot)';
  const setMatch = /\b(OP|EB|ST|PRB)\s*-?(\d+)\b/i.exec(label);
  return { lobby, kind, key, display, set: setMatch ? (setMatch[1] + setMatch[2]).toUpperCase() : null, setNum: setMatch && /^op$/i.test(setMatch[1]) ? parseInt(setMatch[2], 10) : null };
}

function idFromSlug(slug) { return slug.toLowerCase().replace(/[^a-z0-9_]+/g, '_'); }

function entryFromObservation(label, obs) {
  const d = describeLabel(label);
  return {
    id: idFromSlug(obs.slug),
    label: d.display,
    key: d.key,
    cardkaizokuLabel: label,
    kind: d.kind,
    lobby: d.lobby,
    internal: d.lobby === 'private',     // private lobbies: fetched for Opening Hands only, never shown in the dropdown
    frozen: d.kind === 'snapshot',
    set: d.set,
    setNum: d.setNum,
    filePrefix: obs.filePrefix || 'stats',
    slug: obs.slug,
    period: obs.slug,                    // kept under the old name too — the app's CDN fallback reads `period`
    prefix: `stats_${obs.slug}_`,
    urlBase: obs.base,
    query: obs.query,
    dated: !!obs.date,
    lastDate: obs.date || null,
  };
}

// Candidate URLs for one file type of one dataset, most likely first.
function candidateUrls(entry, type) {
  const fp = entry.filePrefix || 'stats';
  // Ranking files use the discovered prefix. Other types (hands, decklist) have
  // not been observed being renamed, so try their plain name first, then the
  // ranking-style prefixed name as a fallback.
  // For ranking data there are two files per dataset: the FULL "stats_<slug>"
  // (with matchups and first/second-player rates — what the app needs) and the
  // slim "<prefix>_<slug>" the site's own ranking page loads. Full first.
  const files = type === 'stats' ? [...new Set([`stats_${entry.slug}`, `${fp}_${entry.slug}`])]
                                 : [`${type}_${entry.slug}`, `${fp}_${type}_${entry.slug}`];
  // A date-style cache-buster (?v=20261120) follows the date of the file requested.
  const q = d => (entry.query || '').replace(/(v=)\d{8}/, `$1${String(d).slice(0, 8)}`);
  const urls = [];
  for (const file of files) {
    if (!entry.dated) { urls.push(`${entry.urlBase}${file}.json${entry.query}`); continue; }
    const dates = [...new Set([entry.lastDate, ...tryDates()].filter(Boolean))];
    dates.forEach(d => urls.push(`${entry.urlBase}${file}_${d}.json${q(d)}`));
  }
  return urls;
}
function dateFromUrl(url) { const m = /_(\d{8})(?:T\d{6})?\.json/i.exec(url); return m ? m[1] : null; }

// ── Discovery: ask the site what it offers ───────────────────────────────
const LABEL_LINE_RE = /(\bOP\d+|\bEB\d+|\bEGB|\bST\d+|\bPRB\d+|Snapshot|Last Week|Yesterday|Standard|Extra Reg|Spoiler)/i;
function pickLabels(bodyText) {
  const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
  return [...new Set(lines.filter(l =>
    l.length < 80 &&
    !l.includes('\t') &&                                   // ranking-table rows are tab-separated; labels never are
    !/^\[[A-Z]{1,4}\d+-\d+\]/.test(l) &&                    // a leader row such as "[ST38-001] Mr.0 (Crocodile) ..."
    !/\d\.\d+\s*%/.test(l) &&                              // win-rate figures like 36.58% (labels only ever say "Top 20%")
    LABEL_LINE_RE.test(l) &&
    /Lobbies|Private|·|\(/.test(l) &&                       // must look like a period, not a heading
    !(l === l.toUpperCase() && !/\d/.test(l))               // drop ALL-CAPS group headings such as "SNAPSHOT"
  ))];
}

let workingOpener = null;   // remembered across calls so we stop paying timeouts for strategies that don't apply
async function openDropdown(page) {
  const bodyLabels = async () => pickLabels(await page.evaluate(() => document.body.innerText));
  // Already open? Do NOT click again — on most dropdowns a second click closes it.
  let labels = await bodyLabels();
  if (labels.length >= MIN_DISCOVERED) return labels;

  const strategies = [
    () => page.locator('select').first().click({ timeout: 1500 }),
    () => page.locator('[role="combobox"]').first().click({ timeout: 1500 }),
    () => page.locator('[aria-haspopup]').first().click({ timeout: 1500 }),
    () => page.locator('button, div').filter({ hasText: /Last Week|Snapshot|Lobbies|Standard/i }).first().click({ timeout: 1500 }),
  ];
  const order = workingOpener == null ? strategies.map((_, i) => i)
                                      : [workingOpener, ...strategies.map((_, i) => i).filter(i => i !== workingOpener)];
  for (const i of order) {
    try {
      await strategies[i]();
      await page.waitForTimeout(600);
      labels = await bodyLabels();
      if (labels.length >= MIN_DISCOVERED) { workingOpener = i; return labels; }
    } catch {}
  }
  return labels;
}

const norm = t => (t || '').replace(/\s+/g, ' ').trim();
async function chooseLabel(page, label) {
  // (a) native <select>: its options exist as text but can't be "clicked", so use selectOption.
  const sel = await page.evaluate(lbl => {
    const n = t => (t || '').replace(/\s+/g, ' ').trim();
    const selects = [...document.querySelectorAll('select')];
    for (let i = 0; i < selects.length; i++) {
      const o = [...selects[i].options].find(o => n(o.textContent) === lbl);
      if (o) return { index: i, value: o.value };
    }
    return null;
  }, norm(label));
  if (sel) { await page.locator('select').nth(sel.index).selectOption({ value: sel.value }, { timeout: 4000 }); return 'select'; }
  // (b) custom dropdown: find the deepest visible element whose text is exactly the label and click it with a real mouse event.
  const box = await page.evaluate(lbl => {
    const n = t => (t || '').replace(/\s+/g, ' ').trim();
    const visible = [...document.querySelectorAll('body *')].filter(e => e.getClientRects().length);
    const matches = visible.filter(e => n(e.innerText) === lbl);
    const deepest = matches.filter(e => ![...e.children].some(c => matches.includes(c)));
    const el = deepest[deepest.length - 1];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, norm(label));
  if (!box) throw new Error('no visible element with that text');
  await page.mouse.click(box.x, box.y);
  return 'click';
}

// When one click triggers several stats requests, prefer the one whose slug
// matches the label's hints (…_lw for Last Week, …_p for Private).
function scoreSlug(label, slug) {
  const s = slug.toLowerCase(); let score = 0;
  const d = describeLabel(label);
  if (d.kind === 'last-week') score += /(^|_)lw($|_)/.test(s) ? 2 : -1;
  if (d.kind === 'snapshot')  score += /snap|final|full/.test(s) ? 2 : 0;
  score += d.lobby === 'private' ? (/(^|_)p$/.test(s) ? 2 : -1) : (/(^|_)p$/.test(s) ? -2 : 0);
  if (d.set && s.includes(d.set.toLowerCase())) score += 1;
  return score;
}

async function discoverDatasets(ctx, log) {
  const seen = [];
  const pageReqs = [];
  let headersCaptured = false;
  const onReq = req => {
    const u = req.url();
    const p = parseStatsUrl(u);
    if (p) {
      seen.push({ url: u, ...p });
      if (!headersCaptured) {
        headersCaptured = true;
        req.allHeaders().then(h => { siteHeaders = captureHeaders(h); log.replayHeaderNames = Object.keys(siteHeaders); }).catch(() => {});
      }
    }
    const rt = req.resourceType();
    if ((rt === 'fetch' || rt === 'xhr' || /\.json(\?|$)/i.test(u)) && pageReqs.length < 60) pageReqs.push(`${rt} ${u.slice(0, 180)}`);
  };
  const onResp = resp => {
    if (parseStatsUrl(resp.url())) { log.pageResponses = log.pageResponses || []; if (log.pageResponses.length < 40) log.pageResponses.push({ url: resp.url().split('/stats/')[1], status: resp.status() }); }
  };
  ctx.on('request', onReq);
  ctx.on('response', onResp);
  const page = await ctx.newPage();
  const result = { labels: [], observed: new Map() };
  try {
    await page.goto(RANKING_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2500);
    const initial = seen.slice();
    log.initialRequests = initial.map(s => s.url);
    log.pageRequests = pageReqs;       // every fetch/xhr/json request the page made (diagnostic)

    const labels = await openDropdown(page);
    result.labels = labels;
    log.labels = labels;
    if (labels.length < MIN_DISCOVERED) { log.note = 'dropdown labels not found'; return result; }

    // Top-N% variants aren't used anywhere; skip clicking them.
    const toClick = labels.filter(l => describeLabel(l).lobby !== 'top');
    const t0 = Date.now();
    for (const label of toClick) {
      if (Date.now() - t0 > 150000) { log.note = 'discovery time budget hit'; break; }
      const entry = { label, requests: [] };
      log.clicks = log.clicks || []; log.clicks.push(entry);
      try {
        await openDropdown(page);
        const before = seen.length;
        entry.how = await chooseLabel(page, label);
        await page.waitForTimeout(3200);
        const fresh = seen.slice(before);
        entry.requests = fresh.map(f => f.url);
        if (!fresh.length) { entry.result = 'no request observed'; continue; }
        // Different slugs: the one whose wording fits the label. Same slug (several
        // dated versions of one dataset): the newest date / timestamp.
        const best = [...fresh].sort((a, b) => (scoreSlug(label, b.slug) - scoreSlug(label, a.slug)) || String(b.date || '').localeCompare(String(a.date || '')))[0];
        const newest = fresh.filter(f => f.slug === best.slug).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
        result.observed.set(label, newest);
        entry.result = `slug=${best.slug} newest=${newest.date || 'undated'}`;
      } catch (e) { entry.result = `click failed: ${e.message.split('\n')[0]}`; }
    }

    // A label we couldn't observe might simply be the page's default (already
    // loaded before we clicked anything). If exactly one label and one initial
    // request are left over, they belong together.
    const unresolved = toClick.filter(l => !result.observed.has(l));
    const usedSlugs = new Set([...result.observed.values()].map(o => o.slug));
    const spare = [...new Map(initial.filter(i => !usedSlugs.has(i.slug)).map(i => [i.slug, i])).values()];
    if (unresolved.length >= 1 && spare.length === 1) {
      // Pick the unresolved label whose wording best fits the spare slug, but only
      // if it clearly beats the runner-up — otherwise leave it unresolved and say so.
      const ranked = unresolved.map(l => ({ l, sc: scoreSlug(l, spare[0].slug) })).sort((a, b) => b.sc - a.sc);
      if (ranked[0].sc >= 2 && (ranked.length === 1 || ranked[0].sc > ranked[1].sc)) {
        result.observed.set(ranked[0].l, spare[0]);
        log.defaultAssignment = { label: ranked[0].l, slug: spare[0].slug };
      } else log.defaultAssignment = { ambiguous: ranked.map(r => `${r.l} (${r.sc})`), slug: spare[0].slug };
    }

    // Two different labels must never share a slug — if they do, a click didn't
    // really change the request and we can't tell which is which. Drop both.
    const bySlug = new Map();
    for (const [label, o] of result.observed) bySlug.set(o.slug, [...(bySlug.get(o.slug) || []), label]);
    for (const [slug, ls] of bySlug) if (ls.length > 1) {
      log.collisions = log.collisions || []; log.collisions.push({ slug, labels: ls });
      ls.forEach(l => result.observed.delete(l));
    }
  } catch (e) {
    log.error = e.message;
    console.log(`::warning::Could not read cardkaizoku's dropdown this run (${e.message}).`);
  } finally {
    ctx.off('request', onReq);
    ctx.off('response', onResp);
    log.pageRequests = pageReqs;
    await page.close().catch(() => {});
  }
  return result;
}

// Fallback when discovery yields nothing: try the slug conventions we have
// actually seen (opN, opN_lw, opN_p, opN_lw_p) for the newest few sets.
async function probeKnownPatterns(page, hintSet, log) {
  const found = [];
  const sets = [hintSet + 1, hintSet, hintSet - 1];
  const variants = [
    { suffix: '',      label: n => `OP${n} · Current · All Lobbies` },
    { suffix: '_lw',   label: n => `OP${n} · Last Week · All Lobbies` },
    { suffix: '_p',    label: n => `OP${n} · Current · Private Lobbies` },
    { suffix: '_lw_p', label: n => `OP${n} · Last Week · Private Lobbies` },
  ];
  log.probed = [];
  for (const n of sets) for (const v of variants) {
    const slug = `op${n}${v.suffix}`;
    for (const d of tryDates()) {
      for (const [pre, q] of [['ranking', `v=${d}`], ['stats', 'v=8']]) {
        const url = `https://cdn.cardkaizoku.com/stats/${pre}_${slug}_${d}.json?${q}`;
        const r = await dataFetch(url);
        if (r) { found.push({ label: v.label(n), obs: parseStatsUrl(url) }); log.probed.push(`${pre}_${slug}`); break; }
      }
      if (log.probed.includes(`ranking_${slug}`) || log.probed.includes(`stats_${slug}`)) break;
    }
  }
  return found;
}

// ── Exploration (diagnostic) ─────────────────────────────────────────────
// The ranking files no longer contain matchup or first/second-player data, so
// that must come from another file. These two helpers record, in
// data/discovery-log.json, where the site gets it: which data files each of its
// pages (and a click on a leader row) request, and whether a set of plausible
// file names exist. Best-effort and time-limited; never fails the run.
async function exploreSite(ctx, log) {
  const page = await ctx.newPage();
  const found = {}; let current = 'ranking page';
  const onReq = req => {
    const u = req.url();
    if (!/cdn\.cardkaizoku\.com|localhost/.test(u)) return;
    if (/\.(png|webp|jpe?g|svg|gif|mp4|css|js|woff2?)(\?|$)|image_manifest|\/manifest\.json|card_data|navmerch|latest_video/i.test(u)) return;
    (found[current] = found[current] || []);
    if (found[current].length < 25) found[current].push(u.replace(/^https?:\/\/[^/]+\//, '').slice(0, 160));
  };
  ctx.on('request', onReq);
  const origin = new URL(RANKING_URL).origin;
  const t0 = Date.now();
  try {
    await page.goto(RANKING_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2500);
    const links = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => h && h.startsWith('/') && !h.startsWith('//') && h.length < 60))].slice(0, 40));
    log.siteLinks = links;
    current = 'click on a leader row';
    try { await page.locator('tr, [role="row"]').nth(1).click({ timeout: 3000 }); await page.waitForTimeout(3000); }
    catch (e) { (found[current] = found[current] || []).push('click failed: ' + e.message.split('\n')[0].slice(0, 80)); }
    for (const href of links.slice(0, 14)) {
      if (Date.now() - t0 > 90000) break;
      if (href === '/' || /^\/ranking\/?$/.test(href)) continue;
      current = `page ${href}`;
      try { await page.goto(origin + href, { waitUntil: 'networkidle', timeout: 20000 }); await page.waitForTimeout(2500); } catch {}
    }
  } catch (e) { log.exploreError = e.message.split('\n')[0].slice(0, 120); }
  finally { ctx.off('request', onReq); await page.close().catch(() => {}); }
  log.exploreRequests = found;
}

async function probeFileTypes(entries, log) {
  if (!sitePage) return;
  const e = entries.find(x => !x.internal && x.dated && x.lastDate) || entries.find(x => x.dated && x.lastDate);
  if (!e) return;
  const names = ['matchups', 'matchup', 'matchup_matrix', 'matrix', 'matchup_stats', 'mu', 'vs', 'versus', 'winrates',
                 'details', 'detail', 'ranking_matchups', 'ranking_matchup', 'ranking_detail', 'ranking_details',
                 'firstsecond', 'first_second', 'turn_order', 'leader', 'leaders', 'stats', 'ranking'];
  const q = (e.query || '').replace(/(v=)\d{8}/, `$1${String(e.lastDate).slice(0, 8)}`);
  log.typeProbe = { using: `${e.slug}_${e.lastDate}`, results: {} };
  for (const n of names) {
    for (const slug of [e.slug, `${e.slug}_p`]) {
      const url = `${e.urlBase}${n}_${slug}_${e.lastDate}.json${q}`;
      try {
        const r = await sitePage.evaluate(async ({ url, headers }) => {
          try { const res = await fetch(url, { headers }); const t = res.status === 200 ? await res.text() : ''; return { status: res.status, len: t.length, head: t.slice(0, 160) }; }
          catch (err) { return { status: 'error' }; }
        }, { url, headers: siteHeaders });
        if (r.status === 200) log.typeProbe.results[`${n}_${slug}`] = r;
        else if (slug === e.slug) log.typeProbe.results[n] = r.status;
      } catch {}
    }
  }
}

// ── Manifest ─────────────────────────────────────────────────────────────
function chooseDefault(entries) {
  const pub = entries.filter(e => !e.internal);
  if (!pub.length) return null;
  const score = e => (e.frozen ? 0 : 1000) + (e.kind === 'last-week' ? 100 : 0) + (e.setNum || 0);
  return [...pub].sort((a, b) => score(b) - score(a))[0].id;
}

function buildManifest(observed, previous, discoveryTrusted, siteLabels = []) {
  const fresh = [];
  for (const [label, obs] of observed) {
    const e = entryFromObservation(label, obs);
    if (e.lobby === 'top') continue;
    fresh.push(e);
  }
  let entries = fresh;
  if (!discoveryTrusted && previous?.datasets?.length) {
    // Couldn't read the site this run — keep what we knew rather than blank the dropdown.
    entries = previous.datasets;
  } else if (previous?.datasets?.length) {
    const prevById = new Map(previous.datasets.map(p => [p.id, p]));
    // Carry over lastDate for entries we already knew, so a frozen snapshot
    // keeps pointing at the right file.
    entries.forEach(e => { const p = prevById.get(e.id); if (p && !e.lastDate) e.lastDate = p.lastDate || null; });
    // A label that is STILL on the site but whose click didn't yield a URL this
    // run (a flaky click) keeps its previous entry, rather than vanishing from
    // the dropdown for a run.
    const freshIds = new Set(entries.map(e => e.id));
    const freshLabels = new Set(entries.map(e => e.cardkaizokuLabel));
    previous.datasets.forEach(p => {
      if (!freshIds.has(p.id) && !freshLabels.has(p.cardkaizokuLabel) && siteLabels.includes(p.cardkaizokuLabel)) entries.push(p);
    });
  }
  // Safety net: never two entries for the same cardkaizoku label.
  const seenLabels = new Set(); entries = entries.filter(e => !seenLabels.has(e.cardkaizokuLabel) && seenLabels.add(e.cardkaizokuLabel));
  // De-duplicate ids defensively.
  const seenIds = new Set(); entries = entries.filter(e => !seenIds.has(e.id) && seenIds.add(e.id));
  // Link each public dataset to its private sibling (same period, private lobbies) for Opening Hands.
  const privByKey = new Map(entries.filter(e => e.internal).map(e => [e.key, e.id]));
  entries.forEach(e => { if (!e.internal) e.handsId = privByKey.get(e.key) || null; });
  return { generatedAt: new Date().toISOString(), defaultId: chooseDefault(entries), datasets: entries };
}

// ── History (for Meta Trends) ────────────────────────────────────────────
const SLIM_KEYS = ['leader', 'leaderName', 'weighted_win_rate', 'raw_win_rate', 'play_rate', 'number_of_matches', 'first_win_rate', 'second_win_rate'];
function archiveHistory(historyDir, id, rows, dataDate) {
  fs.mkdirSync(historyDir, { recursive: true });
  const file = path.join(historyDir, `${id}.json`);
  const hist = readJson(file, { snapshots: [] });
  const slim = rows.map(r => { const o = {}; SLIM_KEYS.forEach(k => { if (r[k] != null) o[k] = r[k]; }); return o; });
  const snap = { date: dataDate, rows: slim };
  const same = hist.snapshots.find(s => s.date === dataDate);
  if (same) same.rows = slim; else hist.snapshots.push(snap);
  // Skip storing a snapshot that is identical to the previous one (frozen data).
  hist.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  const deduped = [];
  for (const s of hist.snapshots) {
    const last = deduped[deduped.length - 1];
    if (last && JSON.stringify(last.rows) === JSON.stringify(s.rows)) continue;
    deduped.push(s);
  }
  hist.snapshots = deduped.slice(-HISTORY_DAYS);
  fs.writeFileSync(file, JSON.stringify(hist));
}

(async () => {
  const today = laDate(0);
  console.log(`Dates tried: ${tryDates().join(', ')} (LA timezone)\n`);

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

  const dataDir    = path.join(WORKSPACE, 'data');
  const statsDir   = path.join(dataDir, 'stats');
  const cardsDir   = path.join(dataDir, 'cards');
  const historyDir = path.join(dataDir, 'history');
  fs.mkdirSync(statsDir, { recursive: true });
  fs.mkdirSync(cardsDir, { recursive: true });

  const MANIFEST_PATH = path.join(dataDir, 'datasets.json');
  const STATUS_PATH   = path.join(dataDir, 'dataset-status.json');
  const PERIODS_PATH  = path.join(dataDir, 'cardkaizoku-periods.json');
  const LOG_PATH      = path.join(dataDir, 'discovery-log.json');

  const previousManifest = readJson(MANIFEST_PATH, null);
  let datasetStatus = readJson(STATUS_PATH, {});

  // ── 1. Discover ────────────────────────────────────────────────────
  console.log('Discovering datasets from cardkaizoku\'s own dropdown...');
  const dlog = { at: new Date().toISOString() };
  const disc = await discoverDatasets(ctx, dlog);
  const trusted = disc.labels.length >= MIN_DISCOVERED && disc.observed.size >= 1;

  const page = await ctx.newPage();
  navPage = page;
  sitePage = await ctx.newPage();
  try {
    await sitePage.goto(RANKING_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await sitePage.waitForTimeout(3000);   // let the site's own verification finish before we fetch from it
  } catch (e) { dlog.sitePageError = e.message.split('\n')[0]; }
  let observed = disc.observed;
  if (!trusted) {
    console.log('::warning::Dropdown discovery did not produce a usable list — falling back to previous manifest, plus a probe of known slug patterns.');
    const hintSet = Math.max(18, ...((previousManifest?.datasets || []).map(d => d.setNum || 0)));
    const probed = await probeKnownPatterns(page, hintSet, dlog);
    observed = new Map(probed.map(p => [p.label, p.obs]));
    dlog.usedProbe = true;
  }

  // ── Label drift reporting (replaces the old standalone dropdown monitor) ──
  if (disc.labels.length) {
    const prevLabels = readJson(PERIODS_PATH, []);
    const added = disc.labels.filter(l => !prevLabels.includes(l));
    const removed = prevLabels.filter(l => !disc.labels.includes(l));
    console.log('\nCardkaizoku dropdown currently shows:');
    disc.labels.forEach(l => console.log(`  - ${l}`));
    if (added.length)   console.log(`::warning::New period label(s) on cardkaizoku since last check: ${added.join(' | ')}`);
    if (removed.length) console.log(`::warning::Period label(s) that disappeared from cardkaizoku since last check: ${removed.join(' | ')}`);
    fs.writeFileSync(PERIODS_PATH, JSON.stringify(disc.labels.slice().sort(), null, 2));
  }
  const unmapped = disc.labels.filter(l => describeLabel(l).lobby !== 'top' && !disc.observed.has(l));
  if (unmapped.length) console.log(`::warning::Could not work out the data URL for: ${unmapped.join(' | ')}`);

  // ── 2. Manifest ────────────────────────────────────────────────────
  const manifest = buildManifest(observed, previousManifest, trusted || observed.size > 0, disc.labels);
  if (!manifest.datasets.length) {
    console.log('::warning::No datasets known at all (discovery failed and there is no previous manifest). Leaving existing data untouched.');
    dlog.finalNote = 'no datasets';
    dlog.fetchSample = FETCH_LOG;
    fs.writeFileSync(LOG_PATH, JSON.stringify(dlog, null, 2));
    await browser.close();
    process.exit(0);
  }
  console.log(`\nManifest: ${manifest.datasets.length} datasets, default = ${manifest.defaultId}`);

  // ── 3. Fetch ───────────────────────────────────────────────────────
  const publicLeaders = new Map();   // leader id -> true, for portrait downloads
  for (const ds of manifest.datasets) {
    const ageHours = datasetStatus[ds.id]?.lastSuccessAt ? (Date.now() - new Date(datasetStatus[ds.id].lastSuccessAt).getTime()) / 3.6e6 : Infinity;
    if (ds.frozen && !ds.dated && fs.existsSync(path.join(statsDir, `${ds.id}.json`)) && ageHours < 168) {
      // A snapshot shouldn't change — skip re-downloading it every 6 hours,
      // but re-check weekly in case cardkaizoku ever corrects one.
      process.stdout.write(`${ds.id}... (frozen snapshot, checked within the last week)\n`);
      try { JSON.parse(fs.readFileSync(path.join(statsDir, `${ds.id}.json`), 'utf8')).forEach(r => r.leader && !ds.internal && publicLeaders.set(r.leader, true)); } catch {}
      continue;
    }
    process.stdout.write(`${ds.id}... `);
    let result = null;
    for (const url of candidateUrls(ds, 'stats')) {
      result = await dataFetch(url);
      if (result) break;
    }
    const now = new Date().toISOString();
    const prev = datasetStatus[ds.id] || {};
    if (result) {
      const dataDate = dateFromUrl(result.url) || today;
      ds.lastDate = dateFromUrl(result.url) || ds.lastDate;
      fs.writeFileSync(path.join(statsDir, `${ds.id}.json`), result.text);
      console.log(`✓  (${result.data.length} leaders, data dated ${dataDate})`);
      if (!ds.internal) {
        result.data.forEach(r => r.leader && publicLeaders.set(r.leader, true));
        archiveHistory(historyDir, ds.id, result.data, dataDate);
      }
      // Legacy single-file copy of the default dataset (older app builds read it).
      if (ds.id === manifest.defaultId) fs.writeFileSync(path.join(dataDir, 'stats.json'), result.text);
      const full = /\/stats_/.test(result.url) || result.data.some(r => Array.isArray(r.matchups) && r.matchups.length);
      if (!full && !ds.internal) console.log(`::warning::Dataset "${ds.id}" only came from the summary-only file — no matchup or first/second-player data, so Deckbuster / Matchup Mastery will be limited for it.`);
      ds.hasMatchups = full;
      datasetStatus[ds.id] = { lastSuccessAt: now, lastAttemptAt: now, lastAttemptFailed: false, dataDate, source: full ? 'full' : 'summary-only' };
    } else {
      console.log('✗');
      datasetStatus[ds.id] = { ...prev, lastSuccessAt: prev.lastSuccessAt || null, lastAttemptAt: now, lastAttemptFailed: true };
      const last = prev.lastSuccessAt ? new Date(prev.lastSuccessAt) : null;
      const hoursSince = last ? (Date.now() - last.getTime()) / 3.6e6 : Infinity;
      if (hoursSince > STALE_HOURS) {
        console.log(`::warning::Dataset "${ds.id}" (${ds.cardkaizokuLabel}) has not updated successfully in ${last ? hoursSince.toFixed(0)+'h' : 'ever'} — its URL may have changed.`);
      }
    }
  }
  // Forget status for datasets cardkaizoku no longer offers.
  const liveIds = new Set(manifest.datasets.map(d => d.id));
  Object.keys(datasetStatus).forEach(k => { if (!liveIds.has(k)) delete datasetStatus[k]; });

  // Datasets that have left cardkaizoku's dropdown for good: remove their files so the repo doesn't keep growing.
  if (trusted && previousManifest?.datasets) {
    const keep = new Set(manifest.datasets.map(d => d.id));
    const retired = previousManifest.datasets.map(d => d.id).filter(id => !keep.has(id));
    for (const id of retired) {
      for (const f of [`stats/${id}.json`, `stats/hands_${id}.json`, `stats/decklist_${id}.json`, `history/${id}.json`]) {
        try { fs.unlinkSync(path.join(dataDir, f)); } catch {}
      }
    }
    if (retired.length) { console.log(`Retired datasets cleaned up: ${retired.join(', ')}`); dlog.retired = retired; }
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(STATUS_PATH, JSON.stringify(datasetStatus, null, 2));
  dlog.manifestIds = manifest.datasets.map(d => d.id);
  dlog.fetchSample = FETCH_LOG;
  fs.writeFileSync(LOG_PATH, JSON.stringify(dlog, null, 2));
  // Only if a dataset fell back to summary-only data: record where the site gets matchup data (see exploreSite).
  const summaryOnly = manifest.datasets.filter(d => !d.internal && datasetStatus[d.id]?.source === 'summary-only').map(d => d.id);
  dlog.summaryOnlyDatasets = summaryOnly;
  if (summaryOnly.length) try { await probeFileTypes(manifest.datasets, dlog); await exploreSite(ctx, dlog); } catch (e) { dlog.exploreError = e.message.split('\n')[0].slice(0, 120); }
  fs.writeFileSync(LOG_PATH, JSON.stringify(dlog, null, 2));

  // ── Opening-hand + decklist data (private lobbies, internal only) ──
  // Only hands + decklist: the app never reads the other file types
  // cardkaizoku publishes (matchuptech / curve), and they were ~17MB each
  // committed to the repo every run, so they are no longer downloaded.
  const handsIds = new Set(manifest.datasets.filter(d => !d.internal && d.handsId).map(d => d.handsId));
  for (const type of ['hands', 'decklist']) {
    console.log(`\n${type} data:`);
    for (const ds of manifest.datasets.filter(d => d.internal && handsIds.has(d.id))) {
      const out = path.join(statsDir, `${type}_${ds.id}.json`);
      if (ds.frozen && !ds.dated && fs.existsSync(out) && (Date.now() - fs.statSync(out).mtimeMs) / 3.6e6 < 168) { console.log(`  ${ds.id}... (frozen, checked within the last week)`); continue; }
      process.stdout.write(`  ${ds.id}... `);
      let result = null;
      for (const url of candidateUrls(ds, type)) { result = await dataFetch(url); if (result) break; }
      if (result) { fs.writeFileSync(out, result.text); console.log(`✓  (${Math.round(result.text.length/1024)}kB)`); }
      else console.log('✗');
    }
  }

  // ── Leader portrait images ──
  if (!SKIP_IMAGES && publicLeaders.size) {
    const leaderIds = [...publicLeaders.keys()];
    console.log(`\nDownloading leader portraits for all ${leaderIds.length} decks...`);
    let downloaded = 0, skipped = 0, failed = 0;

    for (const id of leaderIds) {
      const outPath = path.join(cardsDir, `${id}.png`);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) { skipped++; continue; }
      const set = id.split('-')[0];
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
  const charIds = new Set();
  for (const f of fs.readdirSync(statsDir).filter(f => /^hands_.*\.json$/.test(f))) {
    try {
      JSON.parse(fs.readFileSync(path.join(statsDir, f), 'utf8'))
        .forEach(entry => (entry.common_cards || []).forEach(card => { if (card.card) charIds.add(card.card); }));
    } catch {}
  }

  const charIdList = SKIP_IMAGES ? [] : [...charIds];
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
