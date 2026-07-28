import crypto from "crypto";
import express from "express";
import cors from "cors";
import { MARKETS } from "./markets.js";
import { mockTick } from "./lisskins.js";
import { seedCandles, pushTick, getCandles, getLastCandle, CANDLE_TF_SEC } from "./candles.js";
import { refreshOracle, pushMockSpot, markOf as oracleMark, markAgeOf as oracleMarkAge, isStale as oracleStale, seedMark, oracleSnapshot, oracleSources, circuitBreakerInfo } from "./oracle.js";
import { csfloatDiag } from "./csfloat.js";
import { fetchDailyHistory, historyEnabled } from "./history.js";
import { fetchSteamHistory, getSteamHistoryCached, getSteamIconCached, steamChartEnabled, warmSteamHistory, logSteamAuthStatus } from "./steamchart.js";
import { fetchInventory } from "./inventory.js";
import { pool, initDb, dbReady, getAccount, loadPriceSamples, savePriceSample, prunePriceSamples, saveDailyClose, loadDailyCloses } from "./db.js";
import { requireAuth, authEnabled } from "./auth.js";
import { openPosition, closePosition, liquidationSweep, limitOrderSweep, createLimitOrder, cancelLimitOrder, MAX_LEVERAGE, MAX_COLLATERAL_PER_POSITION, TAKER_FEE, LIQ_BURN_SHARE } from "./engine.js";
import { initSettlementTables, getDepositInfo, scanDeposits, requestWithdrawal, listWithdrawals, listPendingWithdrawals, rejectWithdrawal, retryWithdrawalPayout, vaultStats, vaultDeposit, sweepAllDeposits, depositAddressesWithBalances } from "./settlement.js";
import { depositsEnabled, hotWalletConfigured, hotWalletAddress, hotWalletBalance, logChainStatus } from "./chain.js";

const PORT = process.env.PORT || 8080;
const MOCK = process.env.MOCK !== "0"; // legacy flag
// SOURCE: "mock" (default) | "skinport" (free, no key) | "lisskins" (needs key)
const SOURCE = process.env.SOURCE || (MOCK ? "mock" : "lisskins");
const IS_MOCK = SOURCE === "mock";
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || (SOURCE === "mock" ? 1500 : SOURCE === "skinport" ? 300000 : 20000));
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const FUNDING_INTERVAL_SEC = Number(process.env.FUNDING_INTERVAL_SEC || 3600); // 1h

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "64kb" })); // cap request bodies

// --- lightweight in-memory rate limiter (per IP, sliding window) -------------
// Protects write/auth endpoints from spam without an external dependency.
// Not a substitute for a real gateway limiter at scale, but enough for beta.
const rlBuckets = new Map(); // key -> [timestamps]
function rateLimit({ windowMs = 60_000, max = 60 } = {}) {
  return (req, res, next) => {
    const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const arr = (rlBuckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: "rate_limited", retryAfterMs: windowMs - (now - arr[0]) });
    arr.push(now);
    rlBuckets.set(key, arr);
    next();
  };
}
// periodic cleanup so the map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rlBuckets) {
    const keep = arr.filter((t) => now - t < 120_000);
    if (keep.length) rlBuckets.set(k, keep); else rlBuckets.delete(k);
  }
}, 120_000).unref?.();

// ---- in-memory state -------------------------------------------------------
const state = new Map(); // key -> { key,name,image,price,prevClose,funding,updatedAt }
const ring = new Map(); // key -> [{t,price}] samples ~5min apart, spanning 24h+
const ownDaily = new Map(); // key -> [{time,open,high,low,close}] CSL's own real daily closes, never pruned
for (const m of MARKETS) {
  state.set(m.key, {
    key: m.key,
    name: m.name,
    wear: m.wear,
    image: m.image,
    price: m.seed,
    prevClose: m.seed,
    funding: (Math.random() * 2 - 1) * 0.0001, // per-hour funding rate, ~±0.01%
    updatedAt: Date.now(),
  });
  ring.set(m.key, []);
  seedCandles(m.key, m.seed);
  seedMark(m.key, m.seed);
}

function sampleRing(key, price) {
  const arr = ring.get(key);
  const now = Date.now();
  if (!arr.length || now - arr[arr.length - 1].t >= 5 * 60 * 1000) {
    arr.push({ t: now, price });
    // mirror to Postgres so a redeploy doesn't reset every 24h % to 0.00
    savePriceSample(key, now, price).catch(() => {});
  }
  // keep ~26h of 5-min samples
  while (arr.length > 320) arr.shift();

  // CSL's own daily close — never pruned, grows forever. This is what gets
  // spliced onto the tail of a skin's history once it outgrows Steam's $1800
  // cap (see /api/history/:key). Upserts today's bucket on every tick, so the
  // row finalizes into a real close once the day rolls over.
  const day = Math.floor(now / 86400000) * 86400000;
  const daySec = Math.floor(day / 1000);
  const own = ownDaily.get(key) || [];
  const last = own[own.length - 1];
  if (last && last.time === daySec) {
    last.high = Math.max(last.high, price); last.low = Math.min(last.low, price); last.close = price;
  } else {
    own.push({ time: daySec, open: price, high: price, low: price, close: price });
    ownDaily.set(key, own);
  }
  saveDailyClose(key, daySec, price).catch(() => {});
}

// Rehydrate the ring from the DB on boot, then prune the old rows hourly.
async function restoreRings() {
  if (!dbReady()) return;
  try {
    const saved = await loadPriceSamples();
    let n = 0;
    for (const [key, arr] of saved) {
      if (ring.has(key)) { ring.set(key, arr); n += arr.length; }
    }
    console.log(`[24h] restored ${n} price samples from db`);
    const daily = await loadDailyCloses();
    let dn = 0;
    for (const [key, arr] of daily) { ownDaily.set(key, arr); dn += arr.length; }
    console.log(`[history] restored ${dn} own daily closes from db (${daily.size} markets)`);
    setInterval(() => prunePriceSamples().catch(() => {}), 60 * 60 * 1000);
  } catch (e) {
    console.warn("[24h] restore failed:", e.message);
  }
}
function safeIcon(hash) { try { return getSteamIconCached(hash) || null; } catch { return null; } }

// No skin realistically moves more than this in 24h — a computed change past
// this is treated as a bad/stale reference (e.g. a DB sample from before a
// manual seed-price correction), not a real move, and we fall through instead
// of displaying it.
const CHANGE24H_MAX = 45;

function change24hOf(key, price) {
  const arr = ring.get(key);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  // 1) a real sample from ~24h ago (the ring is persisted, so this survives deploys)
  if (arr && arr.length) {
    let ref = null;
    for (const s of arr) { if (s.t <= cutoff) ref = s; else break; }
    if (ref && ref.price > 0) {
      const chg = ((price - ref.price) / ref.price) * 100;
      if (Math.abs(chg) <= CHANGE24H_MAX) return chg;
      // implausible vs. this reference (stale/glitched sample) — don't trust it,
      // fall through to the Steam-history method below instead.
    }
  }
  // 2) cold ring (fresh deploy, DB empty): day-over-day from the Steam daily
  //    series. It is a RATIO of two consecutive closes, so the basis cancels —
  //    but only if both closes are sane. We take the last two candles whose
  //    ratio is within a believable daily band; a raw cents/glitch row is
  //    skipped rather than printing -99%.
  const m = MARKETS.find((x) => x.key === key);
  const hist = m && getSteamHistoryCached(m.hash);
  if (hist && hist.length >= 2) {
    for (let i = hist.length - 1; i >= 1; i--) {
      const last = hist[i]?.close, prev = hist[i - 1]?.close;
      if (prev > 0 && last > 0) {
        const chg = ((last - prev) / prev) * 100;
        if (Math.abs(chg) <= CHANGE24H_MAX) return chg; // believable daily move
      }
    }
  }
  // 3) nothing reliable to compare against — same sanity check applies
  if (arr && arr.length && arr[0].price > 0) {
    const chg = ((price - arr[0].price) / arr[0].price) * 100;
    if (Math.abs(chg) <= CHANGE24H_MAX) return chg;
  }
  return 0;
}

// next funding timestamp (aligned to interval)
function nextFundingTs() {
  const now = Math.floor(Date.now() / 1000);
  return (Math.floor(now / FUNDING_INTERVAL_SEC) + 1) * FUNDING_INTERVAL_SEC;
}

// ---- SSE subscribers -------------------------------------------------------
const clients = new Set();
function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

// ---- price refresh loop ----------------------------------------------------
async function tick() {
  const updates = [];
  if (IS_MOCK) {
    // synthetic spot → oracle TWAP → mark (same machinery as live)
    for (const m of MARKETS) {
      const s = state.get(m.key);
      const spot = mockTick(s.price, m.seed, 0.004);
      const mark = pushMockSpot(m.key, spot);
      s.price = mark;              // display + charts follow the mark
      s.updatedAt = Date.now();
      pushTick(m.key, mark);
      sampleRing(m.key, mark);
      updates.push({ key: m.key, price: mark, candle: getLastCandle(m.key) });
    }
  } else {
    // multi-source median + TWAP; positions/PnL/liquidations use the mark
    const oracleUpdates = await refreshOracle(MARKETS.map((m) => ({ key: m.key, hash: m.hash })));
    if (!oracleUpdates.length) return;
    for (const u of oracleUpdates) {
      const s = state.get(u.key);
      if (!s) continue;
      s.price = u.mark;           // display the smoothed mark, not raw spot
      s.spot = u.spot;
      s.sources = u.sources;
      s.updatedAt = Date.now();
      pushTick(u.key, u.mark);
      sampleRing(u.key, u.mark);
      updates.push({ key: u.key, price: u.mark, candle: getLastCandle(u.key) });
    }
  }
  if (updates.length) broadcast({ type: "prices", updates, t: Date.now() });
}

// slowly drift funding rates
setInterval(() => {
  for (const s of state.values()) {
    s.funding = clamp(s.funding + (Math.random() * 2 - 1) * 0.00002, -0.0008, 0.0008);
  }
}, 15000);

// daily prevClose snapshot for 24h change
setInterval(() => {
  for (const s of state.values()) s.prevClose = s.price;
}, 24 * 60 * 60 * 1000);

const markOf = (key) => oracleMark(key) ?? state.get(key)?.price;
const fundingOf = (key) => state.get(key)?.funding ?? 0;
const markAgeOf = (key) => oracleMarkAge(key);

// --- admin guard: header X-Admin-Token must equal ADMIN_TOKEN env ---
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: "admin_disabled" });
  if (!safeEqual(req.get("X-Admin-Token") || "", ADMIN_TOKEN)) return res.status(403).json({ error: "forbidden" });
  next();
}

// ---- routes ----------------------------------------------------------------
app.get("/health", (_req, res) =>
  res.json({ ok: true, source: SOURCE, mock: IS_MOCK, markets: MARKETS.length, tf: CANDLE_TF_SEC, accounts: dbReady() && authEnabled() })
);

app.get("/api/markets", (_req, res) => {
  const list = MARKETS.map((m) => {
    const s = state.get(m.key);
    const change = change24hOf(m.key, s.price);
    return {
      key: m.key, name: m.name, image: m.image, price: s.price,
      wear: s.wear, icon: safeIcon(m.hash), change24h: change, funding: s.funding, updatedAt: s.updatedAt,
      circuitBreaker: circuitBreakerInfo(m.key),
    };
  });
  res.json({ mock: IS_MOCK, source: SOURCE, tf: CANDLE_TF_SEC, nextFunding: nextFundingTs(), markets: list });
});

app.get("/api/markets/:key", (req, res) => {
  const s = state.get(req.params.key);
  if (!s) return res.status(404).json({ error: "not_found" });
  res.json(s);
});

app.get("/api/candles/:key", (req, res) => {
  const s = state.get(req.params.key);
  if (!s) return res.status(404).json({ error: "not_found" });
  res.json({ key: req.params.key, tf: CANDLE_TF_SEC, candles: getCandles(req.params.key) });
});

// Rebase a candle series onto OUR price basis. Steam Market runs ~2x above
// third-party spot (Skinport/CSFloat), so raw Steam history ends at ~$12k while
// our mark says ~$6.3k — the chart showed a cliff where the live price attached.
// We keep the REAL shape of the history and scale the level so the last close
// equals the current mark: an index rebase, clearly labelled in the response.
function medianOf(nums) {
  const a = nums.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Rebase a candle series onto OUR price basis. Anchoring on a single last close
// is fragile — one bad row (a cents value, a Steam glitch) throws the whole
// scale off and the chart flies to millions. Instead we anchor on the MEDIAN of
// the last ~20 closes, then drop any candle that is still absurd versus that
// median (>8x or <1/8x) so a stray print can't stretch the axis.
function rebaseToMark(candles, mk) {
  if (!mk || !Array.isArray(candles) || !candles.length) return candles;
  const tail = candles.slice(-20).map((c) => c.close);
  const anchor = medianOf(tail);
  if (!anchor || anchor <= 0) return candles;
  const f = mk / anchor;
  const r2 = (n) => Math.round(n * f * 100) / 100;
  const out = [];
  for (const c of candles) {
    const rc = { time: c.time, open: r2(c.open), high: r2(c.high), low: r2(c.low), close: r2(c.close) };
    // clamp: reject candles that land absurdly far from the current mark
    if (rc.close > mk * 8 || rc.close < mk / 8) continue;
    // guard against a single spiky high/low blowing the axis
    rc.high = Math.min(rc.high, mk * 8);
    rc.low = Math.max(rc.low, mk / 8);
    out.push(rc);
  }
  return out.length ? out : candles.map((c) => ({ time: c.time, open: r2(c.open), high: r2(c.high), low: r2(c.low), close: r2(c.close) }));
}

// Public burn stats: what the burn engine owes, what it has already destroyed.
app.get("/api/burn", async (_req, res) => {
  if (!dbReady()) return res.json({ enabled: false });
  try {
    const q = await pool.query(
      `SELECT
         COALESCE(SUM(amount_usd) FILTER (WHERE burned_sig IS NOT NULL), 0) AS burned,
         COALESCE(SUM(amount_usd) FILTER (WHERE burned_sig IS NULL), 0)     AS pending,
         COUNT(*) FILTER (WHERE burned_sig IS NOT NULL)                     AS burns
       FROM burn_ledger`
    );
    const r = q.rows[0] || {};
    res.json({
      enabled: true,
      burnShare: LIQ_BURN_SHARE,
      burnedUsd: Number(r.burned) || 0,
      pendingUsd: Number(r.pending) || 0,
      burnCount: Number(r.burns) || 0,
    });
  } catch (e) {
    res.status(500).json({ error: "burn_stats_failed" });
  }
});

// Daily history for long-range charts. real:true only with STEAMWEBAPI_KEY.
// Only trust Steam history when the skin ACTUALLY trades on Steam near its true
// price. Steam caps listings at ~$1800, so a Dragon Lore (~$6k) or a Howl
// (~$4.3k) shows an OLD, low history from before it hit the ceiling — rebasing
// that onto $6k invents a decade of fake movement. We compare Steam's recent
// real level to our mark: if they're within range, the history is genuine and
// we serve it; if Steam is a fraction of the mark, the skin has outgrown Steam
// and we decline (real:false) so the terminal shows a short live window instead.
const STEAM_TRUST_RATIO = Number(process.env.STEAM_TRUST_RATIO || 2.5);

function steamHistoryIsGenuine(candles, mk) {
  if (!Array.isArray(candles) || candles.length < 10 || !mk || mk <= 0) return false;
  const recent = candles.slice(-30).map((c) => c.close).filter((n) => n > 0).sort((a, b) => a - b);
  if (!recent.length) return false;
  const level = recent[Math.floor(recent.length / 2)]; // median of the last ~30 real closes
  const ratio = mk > level ? mk / level : level / mk;
  return ratio <= STEAM_TRUST_RATIO;
}

// Steam Community Market refuses to list anything above ~$1800 — so once a
// skin's real value crosses that line, it simply stops trading on Steam and
// the history is either dead or (worse) shows old low prices from before it
// hit the ceiling. That EARLY segment (while it was still under the cap) is
// 100% genuine and needs no rebasing — we just cut the series off right at
// the cap instead of throwing all of it away.
const STEAM_LISTING_CAP = Number(process.env.STEAM_LISTING_CAP || 1800);
const STEAM_CAP_SAFETY = 0.95; // stay a bit under the hard cap, fees etc.

function realPreCapSegment(candles) {
  if (!Array.isArray(candles) || !candles.length) return { pre: [], stats: null };
  const cap = STEAM_LISTING_CAP * STEAM_CAP_SAFETY;

  // Raw stats for diagnostics — lets us see in the logs exactly what the
  // series looks like instead of guessing blind.
  const closes = candles.map((c) => c.close);
  const stats = {
    cap,
    first: candles[0].close,
    last: candles[candles.length - 1].close,
    min: Math.min(...closes),
    max: Math.max(...closes),
    underCapCount: closes.filter((c) => c <= cap).length,
    total: candles.length,
  };

  // A forward scan that cuts at the first "sustained" breach is fragile: a
  // hyped, brand-new ultra-rare drop (Dragon Lore, Howl...) can have a
  // speculative bubble that itself lasts weeks — long enough to look
  // "sustained" — before crashing back down to a genuine, much lower, settled
  // price for years. Cutting there would throw away most of the real history.
  //
  // Instead: smooth the series with a rolling median (kills single-day noise
  // in EITHER direction — an early bubble or a late fluke dip) and find the
  // LAST point where the smoothed price was still at/under the cap. Everything
  // up to there is genuine settled history; everything after is where it
  // permanently outgrew Steam.
  const WINDOW = 15;
  const half = Math.floor(WINDOW / 2);
  let lastUnderIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(candles.length, i + half + 1);
    const window = closes.slice(lo, hi).slice().sort((a, b) => a - b);
    const med = window[Math.floor(window.length / 2)];
    if (med <= cap) lastUnderIdx = i;
  }
  const pre = lastUnderIdx === -1 ? [] : candles.slice(0, lastUnderIdx + 1);
  return { pre, stats };
}

// Splice: [real Steam candles from before the skin crossed the cap] + [gap] +
// [CSL's own real daily closes, collected since launch]. Nothing here is
// rebased or invented — both segments are true dollar prices for their own
// era. The gap between them is real (Steam has no data there) and is
// reported explicitly so the frontend can draw it honestly instead of
// pretending the line is continuous.
function spliceHistory(steamCandles, ownCandles) {
  const { pre, stats } = realPreCapSegment(steamCandles);
  const own = Array.isArray(ownCandles) ? ownCandles : [];
  if (!pre.length && !own.length) return { result: null, stats };
  const candles = [...pre, ...own].sort((a, b) => a.time - b.time);
  const gap = pre.length && own.length ? { from: pre[pre.length - 1].time, to: own[0].time } : null;
  return { result: { candles, gap }, stats };
}

// Real intraday candles for sub-day timeframes (15m/1H/4H), built from the
// 5-min ring buffer we already keep (~26h deep). Previously every timeframe
// below 1W just re-showed the same DAILY bucketing — selecting 1H/4H did
// nothing. This buckets the actual 5-min ticks at the requested granularity.
const INTRADAY_BUCKET_SEC = { "15m": 900, "1H": 3600, "4H": 14400 };
app.get("/api/intraday/:key", (req, res) => {
  const m = MARKETS.find((x) => x.key === req.params.key);
  if (!m) return res.status(404).json({ error: "not_found" });
  const tf = String(req.query.tf || "1H");
  const bucketSec = INTRADAY_BUCKET_SEC[tf];
  if (!bucketSec) return res.status(400).json({ error: "bad_tf" });

  const samples = ring.get(m.key) || [];
  if (!samples.length) return res.json({ key: m.key, tf: bucketSec, candles: [] });

  const byBucket = new Map();
  for (const s of samples) {
    const bt = Math.floor(s.t / 1000 / bucketSec) * bucketSec;
    const c = byBucket.get(bt);
    if (!c) byBucket.set(bt, { time: bt, open: s.price, high: s.price, low: s.price, close: s.price });
    else { c.high = Math.max(c.high, s.price); c.low = Math.min(c.low, s.price); c.close = s.price; }
  }
  const candles = [...byBucket.values()].sort((a, b) => a.time - b.time);
  res.json({ key: m.key, tf: bucketSec, real: true, source: "intraday", candles });
});

app.get("/api/history/:key", async (req, res) => {
  const m = MARKETS.find((x) => x.key === req.params.key);
  if (!m) return res.status(404).json({ error: "not_found" });
  const mk = markOf(m.key);
  const own = ownDaily.get(m.key) || [];
  // 1) steamwebapi.com — a proper paid/free-tier API, not tied to any personal
  //    Steam login. Preferred when configured: it can't expire like a cookie
  //    session can, and it isn't affected by the cookie account's own Steam
  //    Wallet currency. Set STEAMWEBAPI_KEY on Railway to enable.
  if (historyEnabled()) {
    const candles = await fetchDailyHistory(m.hash);
    if (candles && candles.length) {
      if (steamHistoryIsGenuine(candles, mk))
        return res.json({ key: m.key, real: true, source: "steamwebapi", basis: "csl-mark", tf: 86400, candles: rebaseToMark(candles, mk) });
      const { result: spliced } = spliceHistory(candles, own);
      if (spliced)
        return res.json({ key: m.key, real: true, source: "spliced", reason: "outgrew_steam", tf: 86400, ...spliced });
      return res.json({ key: m.key, real: false, reason: "outgrew_steam", tf: 86400, candles: [] });
    }
  }
  // 2) Steam Market full history via the cookie-authenticated scrape — backup
  //    when steamwebapi isn't configured, or came back empty. Served ONLY if
  //    the skin still trades on Steam near its true price (see
  //    steamHistoryIsGenuine).
  if (steamChartEnabled()) {
    const cached = getSteamHistoryCached(m.hash);
    if (cached && cached.length) {
      const recent30 = cached.slice(-30).map((c) => c.close).filter((n) => n > 0).sort((a, b) => a - b);
      const level = recent30.length ? recent30[Math.floor(recent30.length / 2)] : null;
      const genuine = steamHistoryIsGenuine(cached, mk);
      if (genuine) {
        const rebased = rebaseToMark(cached, mk);
        console.log(`[history] ${m.key}: GENUINE — mk=$${mk?.toFixed(2)} steamLevel=$${level?.toFixed(2)} ratio=${level ? (mk / level).toFixed(2) : "?"} steamCandles=${cached.length} → returning ${rebased.length} rebased candles`);
        return res.json({ key: m.key, real: true, source: "steam", basis: "csl-mark", tf: 86400, candles: rebased });
      }
      console.log(`[history] ${m.key}: NOT genuine — mk=$${mk?.toFixed(2)} steamLevel=$${level?.toFixed(2)} ratio=${level ? (mk / level).toFixed(2) : "?"} (threshold=${STEAM_TRUST_RATIO}) → falling to splice`);
      // outgrew Steam (DLore, Howl, knives): splice genuine pre-cap Steam
      // history onto our own real daily closes instead of discarding it all
      const { result: spliced, stats } = spliceHistory(cached, own);
      const preLen = spliced ? spliced.candles.length - own.length : 0;
      const preStart = preLen > 0 ? new Date(spliced.candles[0].time * 1000).toISOString().slice(0, 10) : null;
      const preEnd = preLen > 0 ? new Date(spliced.candles[preLen - 1].time * 1000).toISOString().slice(0, 10) : null;
      console.log(`[history] ${m.key}: outgrew Steam — pre-cap Steam segment=${preLen} candles${preLen ? ` (${preStart} → ${preEnd})` : ""}, own=${own.length} candles`
        + ` | raw stats: cap=$${stats.cap.toFixed(0)} first=$${stats.first.toFixed(0)} last=$${stats.last.toFixed(0)} min=$${stats.min.toFixed(0)} max=$${stats.max.toFixed(0)} underCap=${stats.underCapCount}/${stats.total}`
        + (preLen === 0 ? " (EMPTY pre-cap segment)" : ""));
      if (spliced)
        return res.json({ key: m.key, real: true, source: "spliced", reason: "outgrew_steam", tf: 86400, ...spliced });
      return res.json({ key: m.key, real: false, reason: "outgrew_steam", tf: 86400, candles: [] });
    }
    fetchSteamHistory(m.hash); // warm in background; don't block the request
  }
  // 3) no Steam data at all (cold cache / disabled) — still serve whatever
  //    real history CSL itself has collected, honestly labelled
  if (own.length) return res.json({ key: m.key, real: true, source: "csl", tf: 86400, candles: own });
  res.json({ key: m.key, real: false, tf: 86400, candles: [] });
});

// Public Steam inventory lookup (CS2). :steamid = SteamID64.
app.get("/api/inventory/:steamid", async (req, res) => {
  const id = String(req.params.steamid || "").trim();
  if (!/^\d{17}$/.test(id)) return res.status(400).json({ error: "bad_steamid" });
  try {
    const data = await fetchInventory(id);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "steam_unreachable" });
  }
});

// ---- authenticated account & trading ---------------------------------------
app.get("/api/account", requireAuth, async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: "db_not_configured" });
  try { res.json(await getAccount(req.privyId)); }
  catch (e) { console.error("[account]", e.message); res.status(500).json({ error: "internal" }); }
});

app.post("/api/trade/open", rateLimit({ max: 30 }), requireAuth, async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: "db_not_configured" });
  const { key, side, collateral, leverage } = req.body || {};
  const m = MARKETS.find((x) => x.key === key);
  if (!m) return res.status(400).json({ error: "bad_market" });
  const r = await openPosition(req.privyId, m, markOf(key), { side, collateral, leverage }, markAgeOf(key));
  res.status(r.error ? 400 : 200).json(r);
});

app.post("/api/trade/close", rateLimit({ max: 30 }), requireAuth, async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: "db_not_configured" });
  const r = await closePosition(req.privyId, String(req.body?.id || ""), markOf, fundingOf);
  res.status(r.error ? 400 : 200).json(r);
});

app.post("/api/trade/limit", rateLimit({ max: 30 }), requireAuth, async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: "db_not_configured" });
  const { key, side, collateral, leverage, limitPrice } = req.body || {};
  const m = MARKETS.find((x) => x.key === key);
  if (!m) return res.status(400).json({ error: "bad_market" });
  const r = await createLimitOrder(req.privyId, m, { side, collateral, leverage, limitPrice });
  res.status(r.error ? 400 : 200).json(r);
});

app.delete("/api/trade/limit/:id", rateLimit({ max: 30 }), requireAuth, async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: "db_not_configured" });
  const r = await cancelLimitOrder(req.privyId, String(req.params.id || ""));
  res.status(r.error ? 400 : 200).json(r);
});

// ---- settlement: deposits / withdrawals / vault -----------------------------
app.get("/api/deposit", requireAuth, async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: "db_not_configured" });
  res.json(await getDepositInfo(req.privyId));
});

app.post("/api/withdraw", rateLimit({ max: 10 }), requireAuth, async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: "db_not_configured" });
  const { amount, address } = req.body || {};
  const r = await requestWithdrawal(req.privyId, amount, address);
  res.status(r.error ? 400 : 200).json(r);
});

app.get("/api/withdrawals", requireAuth, async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: "db_not_configured" });
  res.json({ withdrawals: await listWithdrawals(req.privyId) });
});

app.get("/api/vault", async (_req, res) => {
  if (!dbReady()) return res.json({ open: false, tvl: 0, depositors: 0 });
  res.json(await vaultStats());
});

app.post("/api/vault/deposit", rateLimit({ max: 20 }), requireAuth, async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: "db_not_configured" });
  const r = await vaultDeposit(req.privyId, req.body?.amount);
  res.status(r.error ? 400 : 200).json(r);
});

// public engine config (real params, no secrets)
// --- admin: pending withdrawals over the auto-payout cap ---
app.get("/api/admin/withdrawals/pending", requireAdmin, async (_req, res) => {
  res.json({ pending: await listPendingWithdrawals() });
});
app.post("/api/admin/withdrawals/:id/reject", requireAdmin, async (req, res) => {
  res.json(await rejectWithdrawal(String(req.params.id)));
});
app.post("/api/admin/withdrawals/:id/retry", requireAdmin, async (req, res) => {
  const r = await retryWithdrawalPayout(String(req.params.id));
  res.status(r.error ? 400 : 200).json(r);
});
// admin: list deposit addresses holding USDG + sweep them to treasury
app.get("/api/admin/deposits/balances", requireAdmin, async (_req, res) => {
  res.json(await depositAddressesWithBalances());
});
app.post("/api/admin/deposits/sweep", requireAdmin, async (_req, res) => {
  res.json(await sweepAllDeposits());
});
// Hot wallet monitor — the operational wallet that actually pays out
// auto-approved withdrawals. Cold treasury balance isn't exposed here on
// purpose: check that directly in your wallet/multisig, not through the app.
app.get("/api/admin/hot-wallet", requireAdmin, async (_req, res) => {
  try {
    res.json({
      configured: hotWalletConfigured(),
      address: hotWalletAddress(),
      balance: hotWalletConfigured() ? await hotWalletBalance() : 0,
    });
  } catch (e) {
    console.error("[hot-wallet]", e.message);
    res.status(500).json({ error: "hot_wallet_error", message: e.message });
  }
});
// Insurance fund monitor — funded by INSURANCE_FUND_SHARE of every taker fee,
// this is what actually absorbs bad debt now, before it ever hits the vault.
app.get("/api/admin/insurance-fund", requireAdmin, async (_req, res) => {
  const bal = (await pool.query(
    `SELECT coalesce(sum(case when type='contribution' then amount_usd else -amount_usd end),0) balance,
            coalesce(sum(case when type='contribution' then amount_usd else 0 end),0) total_contributed,
            coalesce(sum(case when type='payout' then amount_usd else 0 end),0) total_paid_out
     FROM insurance_fund_ledger`
  )).rows[0];
  res.json({
    balance: Number(bal.balance),
    totalContributed: Number(bal.total_contributed),
    totalPaidOut: Number(bal.total_paid_out),
  });
});
// Bad debt monitor — total shortfall the vault has absorbed from
// liquidations that filled past zero-equity (price gapped through the liq
// price faster than the sweep could catch it). Watch this: steady growth
// means the circuit breaker / liq-sweep frequency need tightening, not that
// it's "just a rounding error".
app.get("/api/admin/bad-debt", requireAdmin, async (req, res) => {
  const days = Math.min(365, Number(req.query.days) || 30);
  const since = Date.now() - days * 86400000;
  const total = (await pool.query(
    `SELECT coalesce(sum(amount_usd),0) total, count(*)::int n FROM bad_debt_ledger WHERE created_at > $1`, [since]
  )).rows[0];
  const byMarket = (await pool.query(
    `SELECT market_key, sum(amount_usd) total, count(*)::int n FROM bad_debt_ledger WHERE created_at > $1 GROUP BY market_key ORDER BY total DESC`, [since]
  )).rows;
  const recent = (await pool.query(
    `SELECT * FROM bad_debt_ledger ORDER BY created_at DESC LIMIT 50`
  )).rows;
  res.json({ windowDays: days, totalUsd: Number(total.total), count: total.n, byMarket, recent });
});

// --- oracle transparency: spot vs mark vs sources per market ---
app.get("/api/oracle", (_req, res) => {
  const out = {};
  for (const m of MARKETS) {
    const snap = oracleSnapshot(m.key);
    if (snap) out[m.key] = snap;
  }
  res.json({ markets: out, sources: oracleSources(), csfloat: csfloatDiag(), t: Date.now() });
});
app.get("/api/oracle/:key", (req, res) => {
  const snap = oracleSnapshot(String(req.params.key));
  if (!snap) return res.status(404).json({ error: "unknown_market" });
  res.json(snap);
});

app.get("/api/config", (_req, res) => res.json({
  maxLeverage: MAX_LEVERAGE,
  maxCollateralPerPosition: MAX_COLLATERAL_PER_POSITION,
  takerFee: TAKER_FEE,
  liqBurnShare: LIQ_BURN_SHARE,
  accounts: dbReady() && authEnabled(),
  deposits: dbReady() && depositsEnabled(),
  oracle: { multiSource: !IS_MOCK, source: SOURCE },
}));

// Server-Sent Events stream of live price ticks
app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: "snapshot", nextFunding: nextFundingTs(), markets: [...state.values()], t: Date.now() })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

// Bind the port FIRST so Railway's health check sees a live server immediately,
// then start the price loop, history warm-up and DB init in the background.
// (If any of these throws, the server still answers /health.)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`CSL backend on :${PORT} — source=${SOURCE} poll=${POLL_MS}ms tf=${CANDLE_TF_SEC}s markets=${MARKETS.length}`);

  // background startup — wrapped so a failure never crashes the process
  try { tick(); } catch (e) { console.error("[startup] tick:", e.message); }
  setInterval(tick, POLL_MS);
  try { warmSteamHistory(MARKETS.map((m) => m.hash)); } catch (e) { console.error("[startup] steam:", e.message); }
  try { logSteamAuthStatus(); } catch (e) { /* diagnostic only */ }
  try { logChainStatus(); } catch (e) { /* diagnostic only */ }
  initDb()
    .then(() => { if (process.env.DATABASE_URL) return initSettlementTables(); })
    .then(() => restoreRings())   // table exists by now — rehydrate the 24h ring
    .catch((e) => console.error("[db] init:", e.message));
  if (process.env.DATABASE_URL) {
    setInterval(() => scanDeposits().catch((e) => console.error("[deposits]", e.message)), 30000);
    setInterval(() => liquidationSweep(markOf, fundingOf, markAgeOf).catch((e) => console.error("[engine] sweep:", e.message)), 5000);
    setInterval(() => limitOrderSweep(markOf, markAgeOf, MARKETS).catch((e) => console.error("[engine] limit sweep:", e.message)), 5000);
  }
});

// guard: never let an unhandled rejection kill the container
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message || e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.message || e));

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
