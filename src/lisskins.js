// ---------------------------------------------------------------------------
// lis-skins price adapter.
//
// lis-skins exposes a Public User API (https://lis-skins-ru.stoplight.io).
// Auth: Bearer token from https://lis-skins.com/en/profile/api/
//
// This adapter is deliberately isolated: it fetches live prices for our curated
// market_hash_name list and normalises them to { [hash]: priceUSD }. If the
// live call fails (no key yet, wrong field mapping, network), it returns null
// and the poller keeps the previous / seed price — so the terminal never breaks.
//
// NOTE: field names in normalise() are set to the documented shape. On the first
// real 200 response, log a sample (LOG_RAW=1) and adjust the two marked lines.
// ---------------------------------------------------------------------------

const BASE = process.env.LIS_SKINS_BASE_URL || "https://api.lis-skins.com";
const KEY = process.env.LIS_SKINS_API_KEY || "";
const GAME = process.env.LIS_SKINS_GAME || "csgo";
const LOG_RAW = process.env.LOG_RAW === "1";

// Pull live prices for a set of market_hash_names.
// Returns { hash: priceUSD } or null on failure.
export async function fetchLivePrices(hashes) {
  if (!KEY) return null;
  try {
    const url = new URL(`${BASE}/v1/market/search`);
    url.searchParams.set("game", GAME);
    // lis-skins search accepts repeated names[]; we request our curated set.
    for (const h of hashes) url.searchParams.append("names[]", h);

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${KEY}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.warn(`[lisskins] ${res.status} ${res.statusText}`);
      return null;
    }
    const json = await res.json();
    if (LOG_RAW) console.log("[lisskins] raw:", JSON.stringify(json).slice(0, 600));

    // lis-skins returns items under `data` (array). Each item carries a name +
    // price. Normalise to the cheapest live listing per hash.
    const items = Array.isArray(json) ? json : json.data || json.items || [];
    const out = {};
    for (const it of items) {
      const hash = it.market_hash_name || it.name || it.hash;          // <-- adjust if needed
      const price = Number(it.price ?? it.min_price ?? it.usd_price);   // <-- adjust if needed
      if (!hash || !Number.isFinite(price)) continue;
      if (out[hash] == null || price < out[hash]) out[hash] = price;
    }
    return Object.keys(out).length ? out : null;
  } catch (e) {
    console.warn("[lisskins] error:", e.message);
    return null;
  }
}

// Mock random-walk tick — realistic live movement around a reference price.
// vol = per-tick volatility fraction (e.g. 0.004 = 0.4%).
//
// The old version pinned prices to `seed` with a strong 2%/tick pull, so every
// market's 24h change collapsed toward ~0% (nothing could wander far enough to
// register a real daily move). We now let price roam in a wider band around
// seed with much weaker reversion, so 24h changes look alive — some markets
// green, some red, a few running several percent — while still not drifting off
// to infinity. Bigger per-tick shock, softer pull, wider clamp.
export function mockTick(prev, seed, vol = 0.004) {
  const base = prev ?? seed;
  // weak mean-reversion (0.4%/tick) — enough to keep it near seed over the long
  // run, gentle enough to allow multi-percent daily swings.
  const drift = (seed - base) * 0.004;
  // ~2.5x the old shock so real daily movement accumulates.
  const shock = base * vol * 2.5 * (Math.random() * 2 - 1);
  // allow ±35% wandering from seed before the clamp bites (was -50% floor only).
  const lo = seed * 0.65, hi = seed * 1.35;
  const next = Math.min(hi, Math.max(lo, base + drift + shock));
  return Math.round(next * 100) / 100;
}
