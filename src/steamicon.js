// ---------------------------------------------------------------------------
// Real item icons straight from Steam's economy CDN.
//
// We ask Steam's market search endpoint for the item, read `icon_url` out of
// the asset description and build the CDN link. Cached in memory (24h) and
// fetched serially with spacing, exactly like the price-history scraper, so we
// stay well under Steam's rate limits. If Steam says no, the frontend keeps
// using its bundled image — icons are a nicety, never a hard dependency.
// ---------------------------------------------------------------------------

const ENABLED = process.env.STEAM_ICONS !== "0";
const TTL = 24 * 60 * 60 * 1000;
const SPACING_MS = 4000;
const CDN = "https://community.cloudflare.steamstatic.com/economy/image";

const cache = new Map(); // hash -> { at, url }
let chain = Promise.resolve();

export function getIconCached(hash) {
  const hit = cache.get(hash);
  return hit && Date.now() - hit.at < TTL ? hit.url : null;
}

export function warmIcons(hashes) {
  if (!ENABLED) return;
  for (const h of hashes) {
    chain = chain
      .then(() => fetchIcon(h))
      .then(() => new Promise((r) => setTimeout(r, SPACING_MS)));
  }
}

async function fetchIcon(hash) {
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < TTL) return hit.url;
  try {
    const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=1&query=${encodeURIComponent(hash)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) { console.warn(`[icons] ${res.status} for ${hash}`); return null; }
    const j = await res.json();
    const hit0 = (j.results || []).find((r) => r.hash_name === hash) || (j.results || [])[0];
    const icon = hit0?.asset_description?.icon_url;
    if (!icon) { console.warn(`[icons] no icon_url for ${hash}`); return null; }
    const full = `${CDN}/${icon}/128fx128f`;
    cache.set(hash, { at: Date.now(), url: full });
    console.log(`[icons] ${hash} ✓`);
    return full;
  } catch (e) {
    console.warn("[icons] error:", e.message);
    return null;
  }
}
