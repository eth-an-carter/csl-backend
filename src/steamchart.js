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

// ---------------------------------------------------------------------------
// Currency guard. We ask Steam for currency=1 (USD), but an AUTHENTICATED
// session can silently ignore that and return prices in the COOKIE ACCOUNT'S
// OWN Steam Wallet currency instead (e.g. KZT/Tenge). Rather than require
// changing that account's wallet currency (needs a Steam Support ticket or a
// purchase), we detect the actual currency from Steam's own price_prefix /
// price_suffix and convert every price to USD ourselves, using a live FX
// rate. Cached for a day — these don't need to be exact to the minute.
const FX_TTL = 24 * 60 * 60 * 1000;
const fxCache = new Map(); // currency code -> { at, rate } (units of that currency per 1 USD)

// Steam's price_suffix/price_prefix -> ISO currency code, for the currencies
// we've actually seen. Extend this if another account/currency shows up.
const CURRENCY_SYMBOLS = {
  "₸": "KZT", "KZT": "KZT", "тг.": "KZT", "тг": "KZT",
  "₴": "UAH", "₽": "RUB", "R$": "BRL", "₺": "TRY",
  "Rp": "IDR", "₫": "VND", "₹": "INR", "₩": "KRW",
};

function detectCurrency(prefix, suffix) {
  if (prefix === "$" && !suffix) return "USD";
  const combined = `${prefix}${suffix}`.trim();
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (combined.includes(sym)) return code;
  }
  return null; // unrecognized — safest to refuse rather than guess
}

async function fxRateToUsd(code) {
  if (code === "USD") return 1;
  const hit = fxCache.get(code);
  if (hit && Date.now() - hit.at < FX_TTL) return hit.rate;
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${code}`);
    const data = await res.json();
    const perUsd = data?.rates?.USD; // "1 <code> = perUsd USD"
    if (Number.isFinite(perUsd) && perUsd > 0) {
      fxCache.set(code, { at: Date.now(), rate: perUsd });
      console.log(`[steamchart] FX: 1 ${code} = $${perUsd} (live rate cached 24h)`);
      return perUsd;
    }
  } catch (e) {
    console.warn(`[steamchart] FX fetch failed for ${code}:`, e.message);
  }
  return hit ? hit.rate : null; // stale-but-better-than-nothing, else give up
}

export function steamChartEnabled() {
  return ENABLED;
}

// Call once at boot — makes it obvious in Railway logs whether the cookie is
// actually loaded, without ever printing the value itself.
export function logSteamAuthStatus() {
  const cookie = process.env.STEAM_LOGIN_SECURE;
  if (!cookie) {
    console.warn("[steamchart] STEAM_LOGIN_SECURE is NOT set — Steam will serve the logged-out ~3-month window only, and any market whose price already exceeds $1800 throughout that window will show an EMPTY pre-cap history segment.");
  } else {
    console.log(`[steamchart] STEAM_LOGIN_SECURE is set (${cookie.length} chars) — expecting full history back to each item's release date. Watch the "[steamchart] <hash>: N daily candles (start → now)" log line per item: if "start" is only a few months ago instead of ~2013-2018, the cookie is being rejected (expired / wrong value) and Steam is silently falling back to the logged-out window.`);
  }
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
  const cookie = process.env.STEAM_LOGIN_SECURE;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `https://steamcommunity.com/market/listings/730/${encodeURIComponent(hash)}`,
  };
  if (cookie) headers.Cookie = `steamLoginSecure=${cookie}`;

  // 1) icon — cheap, from the item page (best-effort, never blocks history)
  let icon = cache.get(hash)?.icon || null;
  try {
    const pg = await fetch(`https://steamcommunity.com/market/listings/730/${encodeURIComponent(hash)}`, { headers });
    if (pg.ok) {
      const html = await pg.text();
      const im = html.match(/"icon_url":"([^"]+)"/);
      if (im) icon = `https://community.cloudflare.steamstatic.com/economy/image/${im[1]}/128fx128f`;
    }
  } catch { /* ignore icon failures */ }

  // 2) full price history — the dedicated JSON endpoint. A logged-in cookie
  //    gets EVERY sale since the item first listed; without one (or if the
  //    cookie is rejected) Steam still serves the last ~3 months anonymously.
  //    If the cookie fails, retry once without it — a short REAL window beats
  //    no window at all.
  async function tryFetch(withCookie) {
    const h = { ...headers };
    if (!withCookie) delete h.Cookie;
    const url = `https://steamcommunity.com/market/pricehistory/?appid=730&currency=1&market_hash_name=${encodeURIComponent(hash)}`;
    const res = await fetch(url, { headers: h });
    return { res, withCookie };
  }

  try {
    let { res, withCookie } = await tryFetch(Boolean(cookie));
    if (!res.ok && cookie) {
      console.warn(`[steamchart] pricehistory ${res.status} for ${hash} with cookie${res.status === 400 || res.status === 401 ? " (cookie missing/expired?)" : ""} — retrying anonymously (short window)`);
      ({ res, withCookie } = await tryFetch(false));
    }
    if (!res.ok) {
      console.warn(`[steamchart] pricehistory ${res.status} for ${hash} (anonymous too)`);
      if (icon) cache.set(hash, { at: Date.now(), candles: cache.get(hash)?.candles || [], icon });
      return cache.get(hash)?.candles || null;
    }
    if (!withCookie) console.log(`[steamchart] ${hash}: using anonymous ~3-month window (cookie unavailable/rejected)`);
    const data = await res.json();
    const raw = data && data.prices;
    if (!Array.isArray(raw) || !raw.length) {
      console.warn(`[steamchart] empty pricehistory for ${hash} (success=${data && data.success})`);
      if (icon) cache.set(hash, { at: Date.now(), candles: cache.get(hash)?.candles || [], icon });
      return null;
    }

    // We asked for currency=1 (USD), but an AUTHENTICATED session can make
    // Steam silently ignore that and return the logged-in account's OWN
    // wallet currency instead (this account's wallet is KZT/Tenge). Rather
    // than require changing the account's currency, detect what Steam
    // actually used via price_prefix/price_suffix and convert every price to
    // USD with a live FX rate. (The anonymous fallback is always USD, so this
    // only ever triggers on the cookie path.)
    const prefix = String(data.price_prefix || "").trim();
    const suffix = String(data.price_suffix || "").trim();
    const currency = detectCurrency(prefix, suffix);
    let fx = 1;
    if (currency === null) {
      console.warn(`[steamchart] UNRECOGNIZED CURRENCY for ${hash}: prefix="${prefix}" suffix="${suffix}" — add it to CURRENCY_SYMBOLS in steamchart.js. Discarding rather than guessing.`);
      if (icon) cache.set(hash, { at: Date.now(), candles: cache.get(hash)?.candles || [], icon });
      return cache.get(hash)?.candles || null;
    }
    if (currency !== "USD") {
      const rate = await fxRateToUsd(currency); // "1 <currency> = rate USD"
      if (!rate) {
        console.warn(`[steamchart] no FX rate available for ${currency} (${hash}) — discarding rather than guessing.`);
        if (icon) cache.set(hash, { at: Date.now(), candles: cache.get(hash)?.candles || [], icon });
        return cache.get(hash)?.candles || null;
      }
      fx = rate;
      console.log(`[steamchart] ${hash}: converting ${currency} → USD at 1 ${currency} = $${rate}`);
    }

    // entries: ["Aug 14 2013 01: +0", "4.203", "1"] -> daily OHLC (in USD, after fx)
    const byDay = new Map();
    for (const row of raw) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const dateStr = String(row[0]).slice(0, 11); // "Aug 14 2013"
      const t = Math.floor(Date.parse(dateStr + " UTC") / 1000);
      const priceRaw = Number(row[1]);
      if (!Number.isFinite(t) || !Number.isFinite(priceRaw) || priceRaw <= 0) continue;
      const price = priceRaw * fx;
      const day = Math.floor(t / 86400) * 86400;
      const c = byDay.get(day);
      if (!c) byDay.set(day, { time: day, open: price, high: price, low: price, close: price });
      else { c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; }
    }
    const candles = [...byDay.values()].sort((a, b) => a.time - b.time);
    if (!candles.length) return null;

    // Belt-and-braces: even with the currency guard above, double-check the
    // series itself isn't internally absurd (a real skin's price never swings
    // 1000x within its own history). Catches anything the prefix/suffix check
    // might miss.
    const allCloses = candles.map((c) => c.close).sort((a, b) => a - b);
    const seriesMin = allCloses[0], seriesMax = allCloses[allCloses.length - 1];
    if (seriesMax / seriesMin > 1000) {
      console.warn(`[steamchart] IMPLAUSIBLE PRICE SERIES for ${hash}: min=$${seriesMin} max=$${seriesMax} (${(seriesMax / seriesMin).toFixed(0)}x spread) — likely a currency/parsing problem, not a real skin price history. Discarding rather than serving garbage.`);
      if (icon) cache.set(hash, { at: Date.now(), candles: cache.get(hash)?.candles || [], icon });
      return cache.get(hash)?.candles || null;
    }
    cache.set(hash, { at: Date.now(), candles, icon });
    const lastDate = new Date(candles[candles.length - 1].time * 1000);
    const staleDays = Math.round((Date.now() - lastDate.getTime()) / 86400000);
    console.log(`[steamchart] ${hash}: ${candles.length} daily candles (${new Date(candles[0].time * 1000).toISOString().slice(0, 10)} \u2192 ${lastDate.toISOString().slice(0, 10)}, last candle is ${staleDays}d old)${icon ? " + icon" : ""}`);
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
