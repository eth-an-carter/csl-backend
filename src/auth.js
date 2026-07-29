// Real wallet authentication for Robinhood Chain, replacing the old
// "trust whatever address is in the x-wallet header" scheme.
//
// Flow:
//   1. GET  /api/auth/nonce?address=0x...   -> { nonce, message }
//   2. Wallet signs `message` (plain personal_sign, no extension needed)
//   3. POST /api/auth/verify { address, signature } -> { token }
//   4. Every authenticated request sends `Authorization: Bearer <token>`
//
// The token is a compact HMAC-signed structure (header.payload.sig, base64url)
// — no external JWT library needed, but the shape is JWT-equivalent. It proves
// the server itself issued it (via SESSION_SECRET) AFTER a real signature
// check, so nothing downstream needs to touch viem/signatures again.
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { verifyMessage } from "viem";

export function authEnabled() { return true; }

function isAddress(a) { return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a); }

const SESSION_SECRET = process.env.SESSION_SECRET || process.env.ADMIN_TOKEN || "";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes to actually sign

if (!SESSION_SECRET) {
  console.warn("[auth] SESSION_SECRET is not set — falling back to ADMIN_TOKEN, or auth tokens are unsigned. Set SESSION_SECRET explicitly.");
}

// address (lowercased) -> { nonce, expiresAt }. In-memory is fine: nonces are
// single-use and short-lived, and this runs on one instance.
const nonces = new Map();

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }
function sign(data) { return b64url(createHmac("sha256", SESSION_SECRET).update(data).digest()); }

export function issueNonce(address) {
  const addr = address.toLowerCase();
  const nonce = randomBytes(16).toString("hex");
  nonces.set(addr, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
  const message =
    `csl.fun wants you to sign in with your Robinhood Chain account:\n${address}\n\n` +
    `This confirms you control this wallet. No transaction, no gas, no on-chain action.\n\n` +
    `Nonce: ${nonce}`;
  return { nonce, message };
}

export async function verifySignatureAndIssueToken(address, signature) {
  if (!isAddress(address)) return { error: "bad_address" };
  const addr = address.toLowerCase();
  const rec = nonces.get(addr);
  if (!rec) return { error: "no_nonce" }; // must call /api/auth/nonce first
  if (Date.now() > rec.expiresAt) { nonces.delete(addr); return { error: "nonce_expired" }; }

  const message =
    `csl.fun wants you to sign in with your Robinhood Chain account:\n${address}\n\n` +
    `This confirms you control this wallet. No transaction, no gas, no on-chain action.\n\n` +
    `Nonce: ${rec.nonce}`;

  let ok = false;
  try {
    ok = await verifyMessage({ address, message, signature });
  } catch (e) {
    return { error: "verify_failed", message: e.message };
  }
  if (!ok) return { error: "bad_signature" };

  nonces.delete(addr); // one-time use — can't replay this signature to mint another token
  const payload = { addr, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS };
  const body = b64url(JSON.stringify(payload));
  const token = `${body}.${sign(body)}`;
  return { ok: true, token, address: addr };
}

function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = sign(body);
  // constant-time compare — this is exactly the kind of check that must not
  // short-circuit on the first mismatched byte
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (!payload?.addr || !payload?.exp || Date.now() > payload.exp) return null;
  return payload;
}

export async function requireAuth(req, res, next) {
  const auth = req.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: "unauthorized" });
  req.account = payload.addr;   // canonical account id = lowercased, SIGNATURE-VERIFIED wallet address
  req.privyId = payload.addr;   // back-compat: existing code keys accounts by this
  next();
}
