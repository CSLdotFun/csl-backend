// Solana settlement layer. Deterministic per-user deposit addresses derived
// from a master seed (GitSafe-style vaults). Everything is env-gated:
//   RPC_URL             — Solana RPC (Helius)
//   DEPOSIT_MASTER_SEED — long random string; deposit keys derive from it
//   TREASURY_ADDRESS    — treasury pubkey (receives sweeps, pays withdrawals)
//   TREASURY_SECRET     — base58 secret key; only needed for auto-withdrawals
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { createHash } from "crypto";

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDC_DECIMALS = 6;

const RPC_URL = process.env.RPC_URL || "";
const MASTER = process.env.DEPOSIT_MASTER_SEED || "";

export const connection = RPC_URL ? new Connection(RPC_URL, "confirmed") : null;
export function depositsEnabled() { return Boolean(connection && MASTER); }

// Deterministic deposit keypair for a user: sha256(master:privyId) -> ed25519 seed
export function depositKeypair(privyId) {
  const seed = createHash("sha256").update(`${MASTER}:${privyId}`).digest();
  return Keypair.fromSeed(seed.subarray(0, 32));
}

export function depositAddress(privyId) {
  return depositKeypair(privyId).publicKey.toBase58();
}

// Total USDC ever received on a user's deposit address (current token balance;
// sweeping is done manually via the admin flow so balance == uncredited+credited-held).
export async function usdcBalanceOf(ownerPubkey) {
  const owner = new PublicKey(ownerPubkey);
  const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
  try {
    const bal = await connection.getTokenAccountBalance(ata);
    return Number(bal.value.amount) / 10 ** USDC_DECIMALS;
  } catch {
    return 0; // ATA doesn't exist yet
  }
}

// ---- tx-based deposit detection ---------------------------------------------
// Instead of a balance diff, we walk the address's transaction signatures and
// return each incoming USDC transfer exactly once (idempotent, keyed by sig).
// The caller is responsible for skipping signatures it has already credited.
//
// Returns: [{ sig, amount, slot, blockTime }] newest→oldest, only USDC credits
// that increased THIS owner's USDC ATA balance.
export async function incomingUsdcTransfers(ownerPubkey, { limit = 25, until } = {}) {
  if (!connection) return [];
  const owner = new PublicKey(ownerPubkey);
  let ata;
  try {
    ata = await getAssociatedTokenAddress(USDC_MINT, owner);
  } catch {
    return [];
  }
  const ataStr = ata.toBase58();

  // signatures touching the ATA (deposits land on the token account)
  let sigs;
  try {
    sigs = await connection.getSignaturesForAddress(ata, { limit, until }, "confirmed");
  } catch {
    // ATA may not exist yet → no deposits
    return [];
  }
  if (!sigs || !sigs.length) return [];

  const out = [];
  for (const s of sigs) {
    if (s.err) continue; // failed tx never moved funds
    let tx;
    try {
      tx = await connection.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    } catch {
      continue;
    }
    if (!tx || tx.meta?.err) continue;

    // Compute the net USDC change for our ATA using pre/post token balances.
    const pre = (tx.meta?.preTokenBalances || []).find(
      (b) => b.mint === USDC_MINT.toBase58() && b.owner === owner.toBase58()
    );
    const post = (tx.meta?.postTokenBalances || []).find(
      (b) => b.mint === USDC_MINT.toBase58() && b.owner === owner.toBase58()
    );
    const preAmt = pre ? Number(pre.uiTokenAmount.amount) : 0;
    const postAmt = post ? Number(post.uiTokenAmount.amount) : 0;
    const delta = (postAmt - preAmt) / 10 ** USDC_DECIMALS;

    if (delta > 0) {
      out.push({
        sig: s.signature,
        amount: Math.floor(delta * 1e6) / 1e6,
        slot: s.slot,
        blockTime: s.blockTime || null,
        ata: ataStr,
      });
    }
  }
  return out; // newest → oldest
}

// ---- sweep deposits to treasury --------------------------------------------
// USDC sent to a user's deposit address must be moved to the treasury, otherwise
// obligations (credited balances) grow while real funds sit scattered across
// deposit addresses. This sweeps one deposit address' full USDC balance to the
// treasury. The deposit keypair (derived from the master seed) signs & fee-pays,
// so the deposit address needs a little SOL for rent/fees (see sweepNeedsSol).
import { getOrCreateAssociatedTokenAccount, createTransferInstruction } from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";

const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || "";

export function treasuryPubkey() {
  try { return TREASURY_ADDRESS ? new PublicKey(TREASURY_ADDRESS) : null; } catch { return null; }
}

// how much SOL a deposit address holds (to know if it can pay its own sweep fee)
export async function solBalanceOf(pubkey) {
  if (!connection) return 0;
  try { return (await connection.getBalance(new PublicKey(pubkey))) / 1e9; } catch { return 0; }
}

// Sweep a single user's deposit-address USDC → treasury.
// Returns { ok, sig, amount } or { error }.
export async function sweepDepositToTreasury(privyId, { minSweep = 0.5 } = {}) {
  if (!connection) return { error: "no_connection" };
  const treasury = treasuryPubkey();
  if (!treasury) return { error: "no_treasury" };
  const kp = depositKeypair(privyId);

  // USDC balance on the deposit address
  const ataAddr = await getAssociatedTokenAddress(USDC_MINT, kp.publicKey);
  let uiAmount = 0, rawAmount = 0n;
  try {
    const bal = await connection.getTokenAccountBalance(ataAddr);
    uiAmount = Number(bal.value.amount) / 10 ** USDC_DECIMALS;
    rawAmount = BigInt(bal.value.amount);
  } catch { return { error: "no_usdc" }; }
  if (uiAmount < minSweep) return { error: "below_min", amount: uiAmount };

  // deposit address needs a little SOL to pay the tx fee (+ possibly create the
  // treasury ATA the first time). If it has none, the caller must fund it.
  const sol = await solBalanceOf(kp.publicKey.toBase58());
  if (sol < 0.001) return { error: "needs_sol", have: sol, address: kp.publicKey.toBase58() };

  try {
    const toAta = await getOrCreateAssociatedTokenAccount(connection, kp, USDC_MINT, treasury);
    const ix = createTransferInstruction(ataAddr, toAta.address, kp.publicKey, rawAmount);
    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = kp.publicKey;
    const sig = await connection.sendTransaction(tx, [kp], { maxRetries: 3 });
    const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value?.err) throw new Error("sweep tx failed: " + JSON.stringify(conf.value.err));
    return { ok: true, sig, amount: uiAmount };
  } catch (e) {
    return { error: "sweep_failed", message: e.message };
  }
}
