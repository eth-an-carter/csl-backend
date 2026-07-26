// ---------------------------------------------------------------------------
// Price oracle: turns several noisy marketplace feeds into one robust mark.
//
// Pipeline per skin, per refresh:
//   1. pull spot price from every configured source in parallel
//   2. drop sources that deviate too far from the group median (outlier guard)
//   3. take the median of what's left  → this refresh's "spot"
//   4. feed spot into a time-weighted moving average (TWAP) → the "mark"
//
// Positions, PnL and liquidations use the MARK (smoothed), never the raw spot.
// This makes single-venue manipulation ineffective: to move the mark you must
// move the median of multiple markets AND hold it across the TWAP window.
//
// Everything is defensive — if only one source answers we still work (just with
// less manipulation resistance); if none answer we keep the last mark and flag
// the price as stale so the engine's stale-price guard skips liquidations.
// ---------------------------------------------------------------------------

import { fetchSkinportPrices } from "./skinport.js";
import { fetchLivePrices } from "./lisskins.js";
import { fetchCsfloatPrices, csfloatEnabled } from "./csfloat.js";

// deviation beyond which a single source is treated as an outlier and dropped
const OUTLIER_DEV = Number(process.env.ORACLE_OUTLIER_DEV || 0.08); // 8%
// EMA time-constant in ms — how quickly the mark absorbs a sustained spot move.
// mark += (1 - e^(-dt/tau)) * (spot - mark). Longer = smoother/harder to shove.
const EMA_TAU_MS = Number(process.env.ORACLE_TWAP_WINDOW_MS || 60_000);
// a mark older than this is considered stale (engine skips liquidations on it)
export const MARK_STALE_MS = Number(process.env.ORACLE_MARK_STALE_MS || 360_000); // > Skinport 300s poll
// minimum sources that must agree for a fresh spot to be accepted
const MIN_SOURCES = Number(process.env.ORACLE_MIN_SOURCES || 1);

// which feeds to consult. Skinport is free/keyless; lis-skins needs a key and
// simply returns null (ignored) until configured. Add more here later.
function activeSources() {
  const list = [{ name: "skinport", fn: fetchSkinportPrices }];
  if (csfloatEnabled()) list.push({ name: "csfloat", fn: fetchCsfloatPrices });
  if (process.env.LIS_SKINS_API_KEY) list.push({ name: "lisskins", fn: fetchLivePrices });
  return list;
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// per-skin oracle state: { spot, mark, updatedAt, sources, live }
// live=false until the first real (non-seed) price lands; the first live spot
// SNAPS the mark (seeds are placeholders, never traded against).
const book = new Map();

// per-source health for diagnostics: name -> { ok, items, at, error }
const srcStatus = new Map();
export function oracleSources() {
  const out = {};
  for (const [k, v] of srcStatus) out[k] = v;
  return out;
}

export function markOf(key) { return book.get(key)?.mark; }
export function spotOf(key) { return book.get(key)?.spot; }
export function markAgeOf(key) {
  const s = book.get(key);
  return s?.updatedAt ? Date.now() - s.updatedAt : Infinity;
}
export function isStale(key) { return markAgeOf(key) > MARK_STALE_MS; }
export function oracleSnapshot(key) {
  const s = book.get(key);
  if (!s) return null;
  return { spot: s.spot, mark: s.mark, sources: s.sources, ageMs: markAgeOf(key), stale: isStale(key) };
}

// seed a starting mark (e.g. from candle history) before the first live pull
export function seedMark(key, price) {
  if (!Number.isFinite(price) || price <= 0) return;
  if (book.has(key)) return;
  book.set(key, { spot: price, mark: price, updatedAt: Date.now(), sources: 0, live: false });
}

// Pull all sources once, return { hash: [price, price, ...] } (per-source spots).
async function pullAll(hashes) {
  const sources = activeSources();
  const results = await Promise.allSettled(sources.map((s) => s.fn(hashes)));
  const perHash = new Map(hashes.map((h) => [h, []]));
  results.forEach((r, i) => {
    const name = sources[i].name;
    if (r.status !== "fulfilled") {
      srcStatus.set(name, { ok: false, items: 0, at: Date.now(), error: String(r.reason?.message || r.reason || "rejected") });
      return;
    }
    if (!r.value) {
      srcStatus.set(name, { ok: false, items: 0, at: Date.now(), error: "no_data" });
      return;
    }
    let n = 0;
    for (const [hash, price] of Object.entries(r.value)) {
      if (perHash.has(hash) && Number.isFinite(price) && price > 0) { perHash.get(hash).push(price); n++; }
    }
    srcStatus.set(name, { ok: true, items: n, at: Date.now(), error: null });
  });
  return perHash;
}

// Robust combine: drop outliers vs the median, then re-median the survivors.
function robustSpot(prices) {
  const med = median(prices);
  if (med == null) return null;
  const kept = prices.filter((p) => Math.abs(p - med) / med <= OUTLIER_DEV);
  const finalPrices = kept.length ? kept : prices; // if everything is "far", keep all
  return { spot: median(finalPrices), used: finalPrices.length };
}

// Refresh every skin's mark from live sources. `markets` is [{ key, hash }].
// Returns updates [{ key, spot, mark }] for the ones that changed.
export async function refreshOracle(markets) {
  const hashes = markets.map((m) => m.hash);
  const perHash = await pullAll(hashes);
  const now = Date.now();
  const updates = [];

  for (const m of markets) {
    const prices = perHash.get(m.hash) || [];
    if (prices.length < MIN_SOURCES) continue; // not enough data this round → keep prior mark

    const rs = robustSpot(prices);
    if (!rs || rs.spot == null) continue;

    let st = book.get(m.key);
    if (!st) { st = { spot: rs.spot, mark: rs.spot, updatedAt: now, sources: rs.used, live: true }; book.set(m.key, st); }

    if (!st.live) {
      // first REAL price after boot: snap the mark, discard the seed entirely
      st.mark = rs.spot;
      st.live = true;
    } else {
      // EMA toward the new robust spot, weighted by elapsed time
      const dt = Math.max(1, now - st.updatedAt);
      const alpha = 1 - Math.exp(-dt / EMA_TAU_MS);
      st.mark = st.mark + alpha * (rs.spot - st.mark);
    }
    st.spot = rs.spot;
    st.mark = Math.round(st.mark * 100) / 100;
    st.sources = rs.used;
    st.updatedAt = now;
    checkCircuitBreaker(m.key, st.mark, now);

    updates.push({ key: m.key, spot: st.spot, mark: st.mark, sources: rs.used });
  }
  return updates;
}

// ---------------------------------------------------------------------------
// Circuit breaker. The median/outlier guard above protects against a single
// source disagreeing with the others — but several of these markets only
// have ONE active source configured (Skinport), so there's nothing to
// disagree with. A thin orderbook on an expensive skin (Dragon Lore etc.) can
// still move the real, multi-source-agreed mark fast and hard. This tracks
// each key's mark over a short rolling window and trips if it moves further
// than a sane skin ever should in that time — independent of the TWAP
// smoothing above, which dampens the SPEED of the move but not the fact that
// it happened.
const CB_WINDOW_MS = Number(process.env.CIRCUIT_BREAKER_WINDOW_MS || 5 * 60_000); // 5 min
const CB_MAX_MOVE = Number(process.env.CIRCUIT_BREAKER_MAX_MOVE || 0.15); // 15% within the window
const CB_COOLDOWN_MS = Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS || 10 * 60_000); // 10 min once tripped
const markHistory = new Map(); // key -> [{t, mark}] within CB_WINDOW_MS
const tripped = new Map(); // key -> trippedAt

function recordMarkHistory(key, mark, now) {
  const arr = markHistory.get(key) || [];
  arr.push({ t: now, mark });
  while (arr.length && now - arr[0].t > CB_WINDOW_MS) arr.shift();
  markHistory.set(key, arr);
  return arr;
}

function checkCircuitBreaker(key, mark, now) {
  const arr = recordMarkHistory(key, mark, now);
  if (arr.length < 2) return;
  const oldest = arr[0].mark;
  if (oldest <= 0) return;
  const move = Math.abs(mark - oldest) / oldest;
  if (move > CB_MAX_MOVE) {
    if (!tripped.has(key)) console.warn(`[circuit-breaker] ${key} tripped: ${(move * 100).toFixed(1)}% move in ${(CB_WINDOW_MS / 60000).toFixed(0)}min (mark $${oldest} -> $${mark}) — new positions blocked for ${(CB_COOLDOWN_MS / 60000).toFixed(0)}min`);
    tripped.set(key, now);
  }
}

// True while a market is in cooldown after an abnormally fast price move.
// Existing positions can still be closed/liquidated against the real mark —
// this only blocks NEW exposure being opened into a possibly-manipulated spike.
export function circuitBreakerTripped(key) {
  const at = tripped.get(key);
  if (!at) return false;
  if (Date.now() - at > CB_COOLDOWN_MS) { tripped.delete(key); return false; }
  return true;
}
export function circuitBreakerInfo(key) {
  const at = tripped.get(key);
  if (!at) return { tripped: false };
  const remainingMs = Math.max(0, CB_COOLDOWN_MS - (Date.now() - at));
  return { tripped: remainingMs > 0, remainingMs };
}

// For mock mode: push a synthetic spot straight through the TWAP so the same
// mark/stale machinery works without any live source.
export function pushMockSpot(key, spot) {
  const now = Date.now();
  let st = book.get(key);
  if (!st) { st = { spot, mark: spot, updatedAt: now, sources: 1, live: true }; book.set(key, st); }
  if (!st.live) { st.mark = spot; st.live = true; }
  else {
    const dt = Math.max(1, now - st.updatedAt);
    const alpha = 1 - Math.exp(-dt / EMA_TAU_MS);
    st.mark = st.mark + alpha * (spot - st.mark);
  }
  st.spot = spot;
  st.mark = Math.round(st.mark * 100) / 100;
  st.sources = 1;
  st.updatedAt = now;
  checkCircuitBreaker(key, st.mark, now);
  return st.mark;
}
