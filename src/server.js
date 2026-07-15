import crypto from "crypto";
import express from "express";
import cors from "cors";
import { MARKETS } from "./markets.js";
import { mockTick } from "./lisskins.js";
import { seedCandles, pushTick, getCandles, getLastCandle, CANDLE_TF_SEC } from "./candles.js";
import { refreshOracle, pushMockSpot, markOf as oracleMark, markAgeOf as oracleMarkAge, isStale as oracleStale, seedMark, oracleSnapshot, oracleSources } from "./oracle.js";
import { csfloatDiag } from "./csfloat.js";
import { fetchDailyHistory, historyEnabled } from "./history.js";
import { fetchSteamHistory, getSteamHistoryCached, getSteamIconCached, steamChartEnabled, warmSteamHistory } from "./steamchart.js";
import { fetchInventory } from "./inventory.js";
import { pool, initDb, dbReady, getAccount, loadPriceSamples, savePriceSample, prunePriceSamples } from "./db.js";
import { requireAuth, authEnabled } from "./auth.js";
import { openPosition, closePosition, liquidationSweep, MAX_LEVERAGE, MAX_COLLATERAL_PER_POSITION, TAKER_FEE, LIQ_BURN_SHARE } from "./engine.js";
import { initSettlementTables, getDepositInfo, scanDeposits, requestWithdrawal, listWithdrawals, listPendingWithdrawals, rejectWithdrawal, vaultStats, vaultDeposit, sweepAllDeposits, depositAddressesWithBalances } from "./settlement.js";
import { depositsEnabled } from "./solana.js";

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
    setInterval(() => prunePriceSamples().catch(() => {}), 60 * 60 * 1000);
  } catch (e) {
    console.warn("[24h] restore failed:", e.message);
  }
}
function safeIcon(hash) { try { return getSteamIconCached(hash) || null; } catch { return null; } }

function change24hOf(key, price) {
  const arr = ring.get(key);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  // 1) a real sample from ~24h ago (the ring is persisted, so this survives deploys)
  if (arr && arr.length) {
    let ref = null;
    for (const s of arr) { if (s.t <= cutoff) ref = s; else break; }
    if (ref && ref.price) return ((price - ref.price) / ref.price) * 100;
  }
  // 2) cold ring (fresh deploy, DB empty): fall back to yesterday's close from
  //    the Steam daily series — a ratio, so the price basis cancels out. Beats
  //    printing a flat +0.00% on every market for the first day.
  const m = MARKETS.find((x) => x.key === key);
  const hist = m && getSteamHistoryCached(m.hash);
  if (hist && hist.length >= 2) {
    const prev = hist[hist.length - 2]?.close;
    const last = hist[hist.length - 1]?.close;
    if (prev > 0 && last > 0) return ((last - prev) / prev) * 100;
  }
  // 3) nothing to compare against yet
  if (arr && arr.length && arr[0].price) return ((price - arr[0].price) / arr[0].price) * 100;
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
function rebaseToMark(candles, mk) {
  if (!mk || !Array.isArray(candles) || !candles.length) return candles;
  const last = candles[candles.length - 1]?.close;
  if (!last || last <= 0) return candles;
  const f = mk / last;
  if (Math.abs(f - 1) < 0.02) return candles; // already on our basis
  const r2 = (n) => Math.round(n * f * 100) / 100;
  return candles.map((c) => ({ time: c.time, open: r2(c.open), high: r2(c.high), low: r2(c.low), close: r2(c.close) }));
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
app.get("/api/history/:key", async (req, res) => {
  const m = MARKETS.find((x) => x.key === req.params.key);
  if (!m) return res.status(404).json({ error: "not_found" });
  const mk = markOf(m.key);
  // 1) Steam Market full history (cached; kick off fetch if cold)
  if (steamChartEnabled()) {
    const cached = getSteamHistoryCached(m.hash);
    if (cached && cached.length)
      return res.json({ key: m.key, real: true, source: "steam", basis: "csl-mark", tf: 86400, candles: rebaseToMark(cached, mk) });
    fetchSteamHistory(m.hash); // warm in background; don't block the request
  }
  // 2) steamwebapi (if key set)
  if (historyEnabled()) {
    const candles = await fetchDailyHistory(m.hash);
    if (candles && candles.length)
      return res.json({ key: m.key, real: true, source: "steamwebapi", basis: "csl-mark", tf: 86400, candles: rebaseToMark(candles, mk) });
  }
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
// admin: list deposit addresses holding USDC + sweep them to treasury
app.get("/api/admin/deposits/balances", requireAdmin, async (_req, res) => {
  res.json(await depositAddressesWithBalances());
});
app.post("/api/admin/deposits/sweep", requireAdmin, async (_req, res) => {
  res.json(await sweepAllDeposits());
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
  initDb()
    .then(() => { if (process.env.DATABASE_URL) return initSettlementTables(); })
    .then(() => restoreRings())   // table exists by now — rehydrate the 24h ring
    .catch((e) => console.error("[db] init:", e.message));
  if (process.env.DATABASE_URL) {
    setInterval(() => scanDeposits().catch((e) => console.error("[deposits]", e.message)), 30000);
    setInterval(() => liquidationSweep(markOf, fundingOf, markAgeOf).catch((e) => console.error("[engine] sweep:", e.message)), 5000);
  }
});

// guard: never let an unhandled rejection kill the container
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message || e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.message || e));

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
