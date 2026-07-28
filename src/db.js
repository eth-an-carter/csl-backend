// Postgres layer. Auto-creates schema on boot. If DATABASE_URL is missing,
// db.ready() is false and account endpoints return 503 — price feed still works.
import pg from "pg";

const url = process.env.DATABASE_URL || "";
export const pool = url ? new pg.Pool({ connectionString: url, max: 5 }) : null;

export function dbReady() { return Boolean(pool); }

export async function initDb() {
  if (!pool) { console.warn("[db] DATABASE_URL not set — accounts disabled"); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      privy_id   text PRIMARY KEY,
      balance    double precision NOT NULL DEFAULT 0,
      volume     double precision NOT NULL DEFAULT 0,
      realized   double precision NOT NULL DEFAULT 0,
      trades     integer NOT NULL DEFAULT 0,
      created_at bigint NOT NULL
    );
    CREATE TABLE IF NOT EXISTS positions (
      id         text PRIMARY KEY,
      privy_id   text NOT NULL REFERENCES users(privy_id),
      key        text NOT NULL,
      name       text NOT NULL,
      image      text NOT NULL,
      side       text NOT NULL,
      entry      double precision NOT NULL,
      collateral double precision NOT NULL,
      leverage   integer NOT NULL,
      notional   double precision NOT NULL,
      units      double precision NOT NULL,
      liq        double precision NOT NULL,
      opened_at  bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS positions_key_idx ON positions(key);
    CREATE INDEX IF NOT EXISTS positions_user_idx ON positions(privy_id);
    CREATE TABLE IF NOT EXISTS trades (
      id        text PRIMARY KEY,
      privy_id  text NOT NULL,
      key       text NOT NULL,
      name      text NOT NULL,
      image     text NOT NULL,
      side      text NOT NULL,
      leverage  integer NOT NULL,
      entry     double precision NOT NULL,
      exit      double precision NOT NULL,
      pnl       double precision NOT NULL,
      reason    text NOT NULL DEFAULT 'close',
      closed_at bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trades_user_idx ON trades(privy_id);
    -- rolling price samples (~5 min apart) so the 24h change survives restarts
    CREATE TABLE IF NOT EXISTS price_samples (
      key   text NOT NULL,
      t     bigint NOT NULL,
      price double precision NOT NULL,
      PRIMARY KEY (key, t)
    );
    CREATE INDEX IF NOT EXISTS price_samples_key_t_idx ON price_samples(key, t DESC);
    -- CSL's OWN daily close history. Never pruned — this is real, grows forever,
    -- and is what we splice onto the tail of a skin's Steam history once that
    -- skin has outgrown Steam's $1800 listing cap (see steamHistoryIsGenuine).
    CREATE TABLE IF NOT EXISTS daily_closes (
      key   text NOT NULL,
      day   bigint NOT NULL,   -- unix seconds, start of UTC day
      close double precision NOT NULL,
      PRIMARY KEY (key, day)
    );
    CREATE INDEX IF NOT EXISTS daily_closes_key_day_idx ON daily_closes(key, day ASC);
    -- every dollar owed to the burn engine, recorded as it is earned
    CREATE TABLE IF NOT EXISTS burn_ledger (
      id         text PRIMARY KEY,
      source     text NOT NULL,              -- 'liquidation' | 'fee'
      market_key text,
      amount_usd double precision NOT NULL,
      burned_sig text,                       -- set once the on-chain burn lands
      created_at bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS burn_ledger_open_idx ON burn_ledger(burned_sig) WHERE burned_sig IS NULL;
    -- Bad debt: a liquidation that filled with the price already past zero-
    -- equity, so the trader's collateral didn't cover the full loss. The
    -- house (vault) absorbs the shortfall by simply receiving less than it
    -- theoretically should — this table is the only record that it happened,
    -- so it can be monitored instead of silently eating into solvency.
    CREATE TABLE IF NOT EXISTS bad_debt_ledger (
      id          text PRIMARY KEY,
      position_id text,
      market_key  text,
      amount_usd  double precision NOT NULL,
      created_at  bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bad_debt_ledger_time_idx ON bad_debt_ledger(created_at DESC);
    -- Insurance fund: a slice of every taker fee is set aside here first, and
    -- bad debt draws from THIS before it ever touches the vault. Balance is
    -- just sum(contribution) - sum(payout) over this ledger — no separate
    -- balance column to drift out of sync.
    CREATE TABLE IF NOT EXISTS insurance_fund_ledger (
      id          text PRIMARY KEY,
      type        text NOT NULL,        -- 'contribution' | 'payout'
      amount_usd  double precision NOT NULL,
      position_id text,
      market_key  text,
      created_at  bigint NOT NULL
    );
    CREATE INDEX IF NOT EXISTS insurance_fund_ledger_time_idx ON insurance_fund_ledger(created_at DESC);
    -- persisted cursor(s) for anything that scans the chain incrementally.
    -- Without this, the deposit scanner had no memory of where it left off:
    -- it always looked at "latest - 50000 blocks", a ROLLING window that
    -- silently drops a deposit forever once enough time passes for its block
    -- to fall out the back of that window — even though it was never
    -- actually scanned successfully in the first place (e.g. an RPC 429).
    CREATE TABLE IF NOT EXISTS scan_state (
      key   text PRIMARY KEY,
      value bigint NOT NULL
    );
    -- pending limit orders: sit here until the mark crosses the limit price,
    -- then get filled through the same openPosition() path a market order uses
    CREATE TABLE IF NOT EXISTS limit_orders (
      id          text PRIMARY KEY,
      privy_id    text NOT NULL,
      key         text NOT NULL,
      side        text NOT NULL,          -- 'long' | 'short'
      leverage    integer NOT NULL,
      collateral  double precision NOT NULL,
      limit_price double precision NOT NULL,
      status      text NOT NULL DEFAULT 'open', -- open | filled | cancelled
      created_at  bigint NOT NULL,
      filled_at   bigint,
      position_id text
    );
    CREATE INDEX IF NOT EXISTS limit_orders_open_idx ON limit_orders(key) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS limit_orders_user_idx ON limit_orders(privy_id);
  `);
  console.log("[db] schema ready");
}

/* ---- 24h price ring, persisted ------------------------------------------- */

// Load the last ~26h of samples for every market on boot.
export async function loadPriceSamples() {
  if (!pool) return new Map();
  const cutoff = Date.now() - 26 * 60 * 60 * 1000;
  const rows = (await pool.query(
    `SELECT key, t, price FROM price_samples WHERE t >= $1 ORDER BY t ASC`, [cutoff]
  )).rows;
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.key)) m.set(r.key, []);
    m.get(r.key).push({ t: Number(r.t), price: Number(r.price) });
  }
  return m;
}

export async function savePriceSample(key, t, price) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO price_samples (key, t, price) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [key, t, price]
  );
}

// Drop anything older than 26h so the table stays tiny.
export async function prunePriceSamples() {
  if (!pool) return;
  await pool.query(`DELETE FROM price_samples WHERE t < $1`, [Date.now() - 26 * 60 * 60 * 1000]);
}

/* ---- CSL's own daily close history — never pruned, grows forever --------- */

// Upsert today's running close (called on every price sample). The row for
// "day" keeps overwriting until the day rolls over, at which point it's a
// locked-in real daily close — same idea as a candle finalizing at the end
// of its bucket.
export async function saveDailyClose(key, day, close) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO daily_closes (key, day, close) VALUES ($1, $2, $3)
     ON CONFLICT (key, day) DO UPDATE SET close = EXCLUDED.close`,
    [key, day, close]
  );
}

// All CSL-native daily closes for every market, oldest first per key.
export async function loadDailyCloses() {
  if (!pool) return new Map();
  const rows = (await pool.query(`SELECT key, day, close FROM daily_closes ORDER BY key, day ASC`)).rows;
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.key)) m.set(r.key, []);
    m.get(r.key).push({ time: Number(r.day), open: Number(r.close), high: Number(r.close), low: Number(r.close), close: Number(r.close) });
  }
  return m;
}

// Persisted scan cursor — see scan_state table comment for why this matters.
export async function getScanCursor(key) {
  const r = (await pool.query(`SELECT value FROM scan_state WHERE key=$1`, [key])).rows[0];
  return r ? Number(r.value) : null;
}
export async function setScanCursor(key, value) {
  await pool.query(
    `INSERT INTO scan_state (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [key, value]
  );
}

export async function ensureUser(privyId) {
  await pool.query(
    `INSERT INTO users (privy_id, created_at) VALUES ($1, $2) ON CONFLICT (privy_id) DO NOTHING`,
    [privyId, Date.now()]
  );
}

export async function getAccount(privyId) {
  await ensureUser(privyId);
  const u = (await pool.query(`SELECT balance, volume, realized, trades FROM users WHERE privy_id=$1`, [privyId])).rows[0];
  const positions = (await pool.query(`SELECT * FROM positions WHERE privy_id=$1 ORDER BY opened_at DESC`, [privyId])).rows;
  const history = (await pool.query(`SELECT * FROM trades WHERE privy_id=$1 ORDER BY closed_at DESC LIMIT 500`, [privyId])).rows;
  const openOrders = (await pool.query(`SELECT * FROM limit_orders WHERE privy_id=$1 AND status='open' ORDER BY created_at DESC`, [privyId])).rows;
  return { ...u, positions, history, openOrders };
}
