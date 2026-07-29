// Robinhood Chain settlement layer (EVM L2, Arbitrum Orbit, chainId 4663).
// Deterministic per-user deposit addresses derived from a master seed, and
// USDG (ERC-20) transfer scanning. Env-gated:
//   RPC_URL              — Robinhood Chain RPC
//   DEPOSIT_MASTER_SEED  — long random string; deposit keys derive from it
//   USDG_ADDRESS         — USDG ERC-20 contract address
//
// Treasury is split COLD / HOT on purpose — the server never holds a key
// that can move the bulk of user funds:
//   TREASURY_ADDRESS     — COLD. Where every deposit sweep lands. Should be a
//                          multisig (e.g. Gnosis Safe) or hardware-wallet
//                          address. The server never needs its private key —
//                          it only ever sends TO this address, never from it.
//   HOT_WALLET_PRIVKEY   — HOT. A separate, small operational wallet used
//                          ONLY to pay out auto-approved withdrawals
//                          (see MAX_AUTO_WITHDRAW / MAX_WITHDRAW_HOUSE_HOUR
//                          in settlement.js). Fund it manually, periodically,
//                          from the cold wallet — a compromised server key
//                          then caps the blast radius at whatever's sitting
//                          in this one wallet, not the whole treasury.
import { createPublicClient, createWalletClient, http, getAddress, parseAbiItem, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { createHash } from "crypto";

export const CHAIN_ID = 4663;
export const USDG_ADDRESS = process.env.USDG_ADDRESS || "";
export const USDG_DECIMALS = 6;

const RPC_URL = process.env.RPC_URL || "";
const MASTER = process.env.DEPOSIT_MASTER_SEED || "";

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

export const publicClient = RPC_URL ? createPublicClient({ chain, transport: http(RPC_URL) }) : null;
export function depositsEnabled() { return Boolean(publicClient && MASTER && USDG_ADDRESS); }

// Call once at boot — a missing RPC_URL (or seed/USDG address) silently
// disables ALL deposit scanning and withdrawal payouts forever, with zero
// runtime logging. This makes that impossible to miss.
export function logChainStatus() {
  const missing = [];
  if (!RPC_URL) missing.push("RPC_URL");
  if (!MASTER) missing.push("DEPOSIT_MASTER_SEED");
  if (!USDG_ADDRESS) missing.push("USDG_ADDRESS");
  if (missing.length) {
    console.warn(`[chain] DEPOSITS DISABLED — missing env: ${missing.join(", ")}. No deposits will ever be credited and withdrawals cannot be paid until these are set.`);
  } else {
    console.log(`[chain] deposits enabled — RPC_URL set, USDG=${USDG_ADDRESS}`);
  }
}

const ERC20_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ERC20_ABI = [
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function transfer(address to, uint256 amount) returns (bool)"),
];

// Deterministic deposit account for a user: keccak256(master:account) -> privkey.
// The address is what the user funds; the key lets the treasury sweep it.
export function depositAccount(accountId) {
  const seed = createHash("sha256").update(`${MASTER}:${accountId}`).digest("hex");
  const pk = ("0x" + seed).slice(0, 66);
  return privateKeyToAccount(pk);
}
export function depositAddress(accountId) {
  return depositAccount(accountId).address;
}

// Current USDG balance of an address.
export async function usdgBalanceOf(address) {
  if (!publicClient || !USDG_ADDRESS) return 0;
  try {
    const raw = await publicClient.readContract({ address: getAddress(USDG_ADDRESS), abi: ERC20_ABI, functionName: "balanceOf", args: [getAddress(address)] });
    return Number(formatUnits(raw, USDG_DECIMALS));
  } catch { return 0; }
}

// Incoming USDG transfers to `address`, idempotent by tx hash+logIndex. Scans
// Transfer logs where `to` == address, newest first. `fromBlock` bounds the scan.
// Only returns transfers at least CONFIRMATIONS blocks behind the chain tip —
// a reorg at the very tip (rare but possible before an L2 batch posts to L1)
// must not be able to un-happen a deposit we've already credited to a balance.
const CONFIRMATIONS = Number(process.env.DEPOSIT_CONFIRMATIONS || 12);
export const DEPOSIT_CONFIRMATIONS = CONFIRMATIONS;
export async function incomingUsdgTransfers(address, { fromBlock, toBlock } = {}) {
  if (!publicClient || !USDG_ADDRESS) return null; // not configured — caller must not treat this as "scanned, nothing found"
  try {
    let safeTip = toBlock != null ? BigInt(toBlock) : null;
    if (safeTip == null) {
      const latest = await publicClient.getBlockNumber();
      safeTip = latest > BigInt(CONFIRMATIONS) ? latest - BigInt(CONFIRMATIONS) : 0n;
    }
    const start = fromBlock != null ? BigInt(fromBlock) : (safeTip > 50000n ? safeTip - 50000n : 0n);
    const logs = await publicClient.getLogs({
      address: getAddress(USDG_ADDRESS),
      event: ERC20_TRANSFER,
      args: { to: getAddress(address) },
      fromBlock: start,
      toBlock: safeTip, // <- confirmation buffer, not the raw chain tip
    });
    return logs.map((l) => ({
      sig: `${l.transactionHash}:${l.logIndex}`,
      amount: Number(formatUnits(l.args.value, USDG_DECIMALS)),
      block: Number(l.blockNumber),
      from: l.args.from,
    })).reverse();
  } catch (e) {
    console.warn("[chain] scan error:", e.message);
    return null; // <- FAILURE, distinct from "genuinely no transfers" ([])
  }
}

// Sweep a user's deposit address into the treasury (moves USDG out).
export async function sweepDepositToTreasury(accountId) {
  if (!publicClient || !process.env.TREASURY_ADDRESS) return null;
  const acct = depositAccount(accountId);
  const bal = await usdgBalanceOf(acct.address);
  if (bal <= 0) return null;
  const wallet = createWalletClient({ account: acct, chain, transport: http(RPC_URL) });
  const hash = await wallet.writeContract({
    address: getAddress(USDG_ADDRESS), abi: ERC20_ABI, functionName: "transfer",
    args: [getAddress(process.env.TREASURY_ADDRESS), parseUnits(String(bal), USDG_DECIMALS)],
  });
  return { hash, amount: bal };
}

// Pay a withdrawal from the HOT wallet (small operational balance, NOT the
// cold treasury). This is what a compromised server key can drain, at most.
export async function payWithdrawal(toAddress, amount) {
  if (!publicClient || !process.env.HOT_WALLET_PRIVKEY) throw new Error("hot_wallet_not_configured");
  const hot = privateKeyToAccount(process.env.HOT_WALLET_PRIVKEY);
  const wallet = createWalletClient({ account: hot, chain, transport: http(RPC_URL) });
  return wallet.writeContract({
    address: getAddress(USDG_ADDRESS), abi: ERC20_ABI, functionName: "transfer",
    args: [getAddress(toAddress), parseUnits(String(amount), USDG_DECIMALS)],
  });
}

export function hotWalletConfigured() { return Boolean(process.env.HOT_WALLET_PRIVKEY); }
export function hotWalletAddress() {
  return process.env.HOT_WALLET_PRIVKEY ? privateKeyToAccount(process.env.HOT_WALLET_PRIVKEY).address : null;
}

// One-off: move USDG from the COLD treasury into the HOT wallet with an
// explicit, small gas limit — MetaMask's own gas estimation on Robinhood
// Chain was producing a limit above the network's per-tx cap ("exceeds
// maximum per-tx gas limit"), so we set it ourselves instead of guessing.
// Needs TREASURY_PRIVKEY set TEMPORARILY (this is the one moment the server
// touches the cold key) — remove the env var again right after using this.
export async function fundHotWalletFromTreasury(amount) {
  if (!publicClient || !process.env.TREASURY_PRIVKEY) throw new Error("treasury_privkey_not_set");
  if (!hotWalletConfigured()) throw new Error("hot_wallet_not_configured");
  const treasury = privateKeyToAccount(process.env.TREASURY_PRIVKEY);
  const treasuryBal = await usdgBalanceOf(treasury.address);
  if (treasuryBal < amount) throw new Error(`treasury_insufficient: has $${treasuryBal}, requested $${amount}`);
  const wallet = createWalletClient({ account: treasury, chain, transport: http(RPC_URL) });
  const hash = await wallet.writeContract({
    address: getAddress(USDG_ADDRESS), abi: ERC20_ABI, functionName: "transfer",
    args: [getAddress(hotWalletAddress()), parseUnits(String(amount), USDG_DECIMALS)],
    gas: 150000n, // explicit — a plain ERC-20 transfer needs ~60-80k; this leaves headroom without tripping the network's cap
  });
  // don't report success until the chain actually confirms it — a reverted
  // tx (e.g. this exact insufficient-balance case) still returns a hash
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transfer_reverted: ${hash}`);
  return hash;
}
// Current USDG balance actually sitting in the hot wallet — checked before
// every auto-payout attempt so we never try to send more than it holds, and
// so we can warn Chase to top it up from cold storage before it runs dry.
export async function hotWalletBalance() {
  const addr = hotWalletAddress();
  if (!addr) return 0;
  return usdgBalanceOf(addr);
}

export function isValidAddress(a) { return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a); }
export function treasuryAddress() { return process.env.TREASURY_ADDRESS || null; }
