// Wallet-address auth for Robinhood Chain. The frontend sends the connected
// wallet address as the `x-wallet` header. We normalise it and attach it as
// req.account. (For production, upgrade to SIWE: have the wallet sign a nonce
// and verify the signature here — the shape below stays the same.)
export function authEnabled() { return true; }

function isAddress(a) { return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a); }

export async function requireAuth(req, res, next) {
  const w = (req.headers["x-wallet"] || "").toString().trim().toLowerCase();
  if (!isAddress(w)) return res.status(401).json({ error: "no_wallet" });
  req.account = w;          // canonical account id = lowercased wallet address
  req.privyId = w;          // back-compat: existing code keys accounts by this
  next();
}
