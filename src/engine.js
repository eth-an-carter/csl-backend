// Server-side trading engine. Same maths the terminal used client-side,
// now authoritative: balances and positions live in Postgres.
//
// Risk caps (env-tunable) protect the treasury while the house is the
// counterparty. Defaults are deliberately conservative for early beta.
import { randomUUID } from "crypto";
import { pool, ensureUser } from "./db.js";

export const MAINT_MARGIN = 0.005;
// 0.15% of notional. Priced to fund the burn: 10% of every liquidated collateral
// is destroyed rather than kept by the vault, and the fee stream is what keeps
// the vault whole across that leak. Cheap next to the 5–10% spread a skin
// marketplace charges to move the item itself.
export const TAKER_FEE = Number(process.env.TAKER_FEE || 0.0015);

// Share of a liquidated position's collateral that is burned instead of paid to
// the vault. Applies to the CSL burn engine; the remainder backs the vault.
export const LIQ_BURN_SHARE = Number(process.env.LIQ_BURN_SHARE || 0.10);
export const MAX_LEVERAGE = Number(process.env.MAX_LEVERAGE || 20);
export const MIN_COLLATERAL = Number(process.env.MIN_COLLATERAL || 1);          // no dust positions
export const MAX_COLLATERAL_PER_POSITION = Number(process.env.MAX_COLLATERAL_PER_POSITION || 250);
export const MAX_POSITIONS_PER_USER = Number(process.env.MAX_POSITIONS_PER_USER || 10);
export const MAX_OI_PER_MARKET = Number(process.env.MAX_OI_PER_MARKET || 10000); // notional cap per market
export const MAX_TOTAL_OI = Number(process.env.MAX_TOTAL_OI || 50000);          // house-wide notional cap
export const LIQ_BUFFER = Number(process.env.LIQ_BUFFER || 0.004);              // close 0.4% before zero to limit bad debt
export const PRICE_MAX_AGE_MS = Number(process.env.PRICE_MAX_AGE_MS || 360000); // > Skinport 300s poll (ignore marks older than 6min)

export function liqPrice(entry, side, lev) {
  // trigger the liquidation LIQ_BUFFER earlier than the theoretical zero-equity
  // point. On a gap the fill still lands near here, capping bad debt to roughly
  // the buffer instead of letting the position run arbitrarily negative.
  const m = 1 / lev - MAINT_MARGIN - LIQ_BUFFER;
  return side === "long" ? entry * (1 - m) : entry * (1 + m);
}

function fundingPnl(pos, rate, now) {
  const hours = (now - Number(pos.opened_at)) / 3_600_000;
  return pos.notional * rate * hours * (pos.side === "long" ? 1 : -1);
}

export function positionPnl(pos, mark, rate, now = Date.now()) {
  const pricePnl = pos.units * (mark - pos.entry) * (pos.side === "long" ? 1 : -1);
  return Math.max(-pos.collateral, pricePnl - fundingPnl(pos, rate, now));
}

export async function openPosition(privyId, market, mark, { side, collateral, leverage }, markAgeMs = 0) {
  collateral = Number(collateral); leverage = Math.floor(Number(leverage));
  if (!["long", "short"].includes(side)) return { error: "bad_side" };
  if (!Number.isFinite(collateral) || collateral <= 0) return { error: "bad_collateral" };
  if (collateral < MIN_COLLATERAL) return { error: "min_collateral", min: MIN_COLLATERAL };
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) return { error: "bad_leverage", max: MAX_LEVERAGE };
  if (collateral > MAX_COLLATERAL_PER_POSITION) return { error: "collateral_cap", max: MAX_COLLATERAL_PER_POSITION };
  if (!Number.isFinite(mark) || mark <= 0) return { error: "no_price" };
  // never open against a stale mark — same guard the liquidation sweep uses
  if (markAgeMs > PRICE_MAX_AGE_MS) return { error: "stale_price" };

  const notional = collateral * leverage;
  const fee = notional * TAKER_FEE;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureUser(privyId);
    const u = (await client.query(`SELECT balance FROM users WHERE privy_id=$1 FOR UPDATE`, [privyId])).rows[0];
    if (!u || u.balance < collateral + fee) { await client.query("ROLLBACK"); return { error: "insufficient_balance" }; }

    const cnt = (await client.query(`SELECT count(*)::int c FROM positions WHERE privy_id=$1`, [privyId])).rows[0].c;
    if (cnt >= MAX_POSITIONS_PER_USER) { await client.query("ROLLBACK"); return { error: "positions_cap", max: MAX_POSITIONS_PER_USER }; }

    const oi = (await client.query(`SELECT coalesce(sum(notional),0) s FROM positions WHERE key=$1`, [market.key])).rows[0].s;
    if (Number(oi) + notional > MAX_OI_PER_MARKET) { await client.query("ROLLBACK"); return { error: "market_oi_cap" }; }

    const totalOi = (await client.query(`SELECT coalesce(sum(notional),0) s FROM positions`)).rows[0].s;
    if (Number(totalOi) + notional > MAX_TOTAL_OI) { await client.query("ROLLBACK"); return { error: "house_oi_cap" }; }

    const pos = {
      id: randomUUID(), key: market.key, name: market.name, image: market.image,
      side, entry: mark, collateral, leverage, notional,
      units: notional / mark, liq: liqPrice(mark, side, leverage), opened_at: Date.now(),
    };
    await client.query(`UPDATE users SET balance=balance-$2, volume=volume+$3, trades=trades+1 WHERE privy_id=$1`,
      [privyId, collateral + fee, notional]);
    await client.query(
      `INSERT INTO positions (id,privy_id,key,name,image,side,entry,collateral,leverage,notional,units,liq,opened_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [pos.id, privyId, pos.key, pos.name, pos.image, pos.side, pos.entry, pos.collateral, pos.leverage, pos.notional, pos.units, pos.liq, pos.opened_at]
    );
    await client.query("COMMIT");
    return { ok: true, position: pos, fee };
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[engine] open error:", e.message);
    return { error: "internal" };
  } finally { client.release(); }
}

export async function closePosition(privyId, id, markOf, fundingOf, reason = "close") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pos = (await client.query(`SELECT * FROM positions WHERE id=$1 AND privy_id=$2 FOR UPDATE`, [id, privyId])).rows[0];
    if (!pos) { await client.query("ROLLBACK"); return { error: "not_found" }; }
    const mark = markOf(pos.key);
    if (!Number.isFinite(mark) || mark <= 0) { await client.query("ROLLBACK"); return { error: "no_price" }; }
    const pnl = positionPnl(pos, mark, fundingOf(pos.key));
    const ret = Math.max(0, pos.collateral + pnl);
    await client.query(`DELETE FROM positions WHERE id=$1`, [id]);
    await client.query(`UPDATE users SET balance=balance+$2, realized=realized+$3 WHERE privy_id=$1`, [privyId, ret, pnl]);
    await client.query(
      `INSERT INTO trades (id,privy_id,key,name,image,side,leverage,entry,exit,pnl,reason,closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [pos.id, privyId, pos.key, pos.name, pos.image, pos.side, pos.leverage, pos.entry, mark, pnl, reason, Date.now()]
    );
    await client.query("COMMIT");
    return { ok: true, pnl, exit: mark };
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[engine] close error:", e.message);
    return { error: "internal" };
  } finally { client.release(); }
}

// Liquidation sweep: close every position whose liq price is crossed.
// markAgeOf(key) returns ms since the mark was last updated; stale marks are
// skipped so a frozen oracle can't trigger wrong liquidations.
export async function liquidationSweep(markOf, fundingOf, markAgeOf = () => 0) {
  const rows = (await pool.query(`SELECT * FROM positions`)).rows;
  for (const pos of rows) {
    const mark = markOf(pos.key);
    if (!Number.isFinite(mark) || mark <= 0) continue;
    if (markAgeOf(pos.key) > PRICE_MAX_AGE_MS) continue; // stale price → don't liquidate on it
    const hit = pos.side === "long" ? mark <= pos.liq : mark >= pos.liq;
    if (hit) {
      const r = await closePosition(pos.privy_id, pos.id, markOf, fundingOf, "liquidation");
      if (r.ok) {
        // bad debt = how far past zero-equity the fill landed (house eats this)
        const badDebt = r.pnl < -pos.collateral ? (-pos.collateral - r.pnl) : 0;
        // what the trader actually forfeited (their loss, capped at the collateral),
        // and the slice of it earmarked for the burn instead of the vault
        const seized = Math.min(Number(pos.collateral), Math.max(0, -r.pnl));
        const burnable = seized * LIQ_BURN_SHARE;
        try {
          await pool.query(
            `INSERT INTO burn_ledger (id, source, market_key, amount_usd, created_at)
             VALUES ($1, 'liquidation', $2, $3, $4)`,
            [randomUUID(), pos.key, Number(burnable.toFixed(6)), Date.now()]
          );
        } catch (e) { /* ledger is best-effort — never block a liquidation */ }
        console.log(`[engine] liquidated ${pos.id} (${pos.key} ${pos.side} ${pos.leverage}x) pnl=${r.pnl.toFixed(2)} burn=${burnable.toFixed(2)}${badDebt > 0 ? ` BAD_DEBT=${badDebt.toFixed(2)}` : ""}`);
      }
    }
  }
}
