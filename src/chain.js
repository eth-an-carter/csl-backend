// Robinhood Chain settlement layer (EVM L2, Arbitrum Orbit, chainId 4663).
// Deterministic per-user deposit addresses derived from a master seed, and
// USDG (ERC-20) transfer scanning. Env-gated:
//   RPC_URL              — Robinhood Chain RPC
//   DEPOSIT_MASTER_SEED  — long random string; deposit keys derive from it
//   USDG_ADDRESS         — USDG ERC-20 contract address
//   TREASURY_ADDRESS     — receives sweeps, pays withdrawals
//   TREASURY_PRIVKEY     — 0x… private key; only needed for auto-withdrawals
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
export async function incomingUsdgTransfers(address, { fromBlock } = {}) {
  if (!publicClient || !USDG_ADDRESS) return [];
  try {
    const latest = await publicClient.getBlockNumber();
    const safeTip = latest > BigInt(CONFIRMATIONS) ? latest - BigInt(CONFIRMATIONS) : 0n;
    const start = fromBlock != null ? BigInt(fromBlock) : (latest > 50000n ? latest - 50000n : 0n);
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
    return [];
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

// Pay a withdrawal from the treasury.
export async function payWithdrawal(toAddress, amount) {
  if (!publicClient || !process.env.TREASURY_PRIVKEY) throw new Error("treasury_not_configured");
  const treasury = privateKeyToAccount(process.env.TREASURY_PRIVKEY);
  const wallet = createWalletClient({ account: treasury, chain, transport: http(RPC_URL) });
  return wallet.writeContract({
    address: getAddress(USDG_ADDRESS), abi: ERC20_ABI, functionName: "transfer",
    args: [getAddress(toAddress), parseUnits(String(amount), USDG_DECIMALS)],
  });
}

export function isValidAddress(a) { return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a); }
export function treasuryAddress() { return process.env.TREASURY_ADDRESS || null; }
