// ---------------------------------------------------------------------------
// Steam Market FULL price history — parses the public `line1` series embedded
// in every item's market listing page (real median prices back to release).
//
// No key needed. Unofficial: Steam rate-limits aggressively, so we fetch each
// item at most once per 12h, sequentially with spacing, and cache in memory.
// Enabled by default; disable with STEAM_CHART=0.
//
// LOGGED-OUT Steam only embeds ~3 months of the graph. Set STEAM_LOGIN_SECURE
// (the `steamLoginSecure` cookie of any logged-in Steam account) and Steam
// returns the FULL history — every sale since the skin first listed.
// ---------------------------------------------------------------------------

const ENABLED = process.env.STEAM_CHART !== "0";
const TTL = 12 * 60 * 60 * 1000; // 12h cache
const SPACING_MS = 6000; // pause between fetches to stay under rate limits
const cache = new Map(); // hash -> { at, candles }
let chain = Promise.resolve(); // serialize all Steam fetches

export function steamChartEnabled() {
  return ENABLED;
}

export function getSteamHistoryCached(hash) {
  const hit = cache.get(hash);
  return hit && Date.now() - hit.at < TTL ? hit.candles : null;
}

// The item's REAL Steam icon, scraped from the very page we already load for
// price history — keyed by the exact market_hash_name, so a Howl can never end
// up wearing a Redline's picture.
export function getSteamIconCached(hash) {
  const hit = cache.get(hash);
  return hit && Date.now() - hit.at < TTL ? hit.icon || null : null;
}

export function fetchSteamHistory(hash) {
  if (!ENABLED) return Promise.resolve(null);
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.candles);
  // serialize: one Steam request at a time, spaced out
  chain = chain.then(() => doFetch(hash)).then(async (r) => {
    await new Promise((res) => setTimeout(res, SPACING_MS));
    return r;
  });
  return chain;
}

async function doFetch(hash) {
  try {
    const url = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(hash)}`;
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (process.env.STEAM_LOGIN_SECURE) headers.Cookie = `steamLoginSecure=${process.env.STEAM_LOGIN_SECURE}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[steamchart] ${res.status} for ${hash}`);
      return cache.get(hash)?.candles || null; // keep stale cache on failure
    }
    const html = await res.text();
    // the item's own icon, straight out of the page's asset description
    let icon = null;
    const im = html.match(/"icon_url":"([^"]+)"/);
    if (im) icon = `https://community.cloudflare.steamstatic.com/economy/image/${im[1]}/128fx128f`;

    const m = html.match(/var line1\s*=\s*(\[\[.*?\]\]);/s);
    if (!m) {
      console.warn(`[steamchart] no line1 for ${hash}`);
      if (icon) cache.set(hash, { at: Date.now(), candles: cache.get(hash)?.candles || [], icon });
      return null;
    }
    let raw;
    try { raw = JSON.parse(m[1]); } catch { return null; }

    // entries: ["Aug 14 2013 01: +0", 4.203, "1"] -> daily OHLC
    const byDay = new Map();
    for (const row of raw) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const dateStr = String(row[0]).slice(0, 11); // "Aug 14 2013"
      const t = Math.floor(Date.parse(dateStr + " UTC") / 1000);
      const price = Number(row[1]);
      if (!Number.isFinite(t) || !Number.isFinite(price) || price <= 0) continue;
      const day = Math.floor(t / 86400) * 86400;
      const c = byDay.get(day);
      if (!c) byDay.set(day, { time: day, open: price, high: price, low: price, close: price });
      else { c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; }
    }
    const candles = [...byDay.values()].sort((a, b) => a.time - b.time);
    if (!candles.length) return null;
    cache.set(hash, { at: Date.now(), candles, icon });
    console.log(`[steamchart] ${hash}: ${candles.length} daily candles (${new Date(candles[0].time * 1000).toISOString().slice(0, 10)} → now)${icon ? " + icon" : ""}`);
    return candles;
  } catch (e) {
    console.warn("[steamchart] error:", e.message);
    return cache.get(hash)?.candles || null;
  }
}

// Warm the cache for all markets on boot (slow drip, one every SPACING_MS).
export function warmSteamHistory(hashes) {
  if (!ENABLED) return;
  for (const h of hashes) fetchSteamHistory(h);
}
