// Deposits, withdrawals and the liquidity vault.
// All flows are real code, env-gated until launch:
//   deposits    — active when RPC_URL + DEPOSIT_MASTER_SEED are set
//   withdrawals — requests always recorded; auto-payout when TREASURY_SECRET is set
//   vault       — accepts deposits only when VAULT_OPEN=1
import { pool, ensureUser } from "./db.js";
import { connection, depositsEnabled, depositAddress, incomingUsdcTransfers, USDC_MINT, USDC_DECIMALS, sweepDepositToTreasury, usdcBalanceOf, solBalanceOf, treasuryPubkey } from "./solana.js";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, createTransferInstruction } from "@solana/spl-token";
import { randomUUID } from "crypto";
import bs58 from "bs58";

const MIN_WITHDRAW = Number(process.env.MIN_WITHDRAW || 5);
const MAX_AUTO_WITHDRAW = Number(process.env.MAX_AUTO_WITHDRAW || 100); // above this stays pending for manual approval
const MAX_DEPOSIT_PER_USER = Number(process.env.MAX_DEPOSIT_PER_USER || 500);
// withdrawal rate limits (drain protection)
const MAX_WITHDRAW_PER_USER_DAY = Number(process.env.MAX_WITHDRAW_PER_USER_DAY || 500);   // per-user 24h cap
const MAX_WITHDRAW_HOUSE_HOUR   = Number(process.env.MAX_WITHDRAW_HOUSE_HOUR || 1000);    // house-wide 1h cap on auto-payouts
const MAX_WITHDRAWS_PER_USER_DAY = Number(process.env.MAX_WITHDRAWS_PER_USER_DAY || 10);  // count cap per user per 24h
export const VAULT_OPEN = process.env.VAULT_OPEN === "1";

export async function initSettlementTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id        text PRIMARY KEY,
      privy_id  text NOT NULL,
      amount    double precision NOT NULL,
      address   text NOT NULL,
      sig       text,
      slot      bigint,
      credited_at bigint NOT NULL
    );
    -- one credit per on-chain signature (idempotency guard)
    CREATE UNIQUE INDEX IF NOT EXISTS deposits_sig_uidx ON deposits(sig) WHERE sig IS NOT NULL;
    CREATE INDEX IF NOT EXISTS deposits_user_idx ON deposits(privy_id);
    CREATE TABLE IF NOT EXISTS withdrawals (
      id        text PRIMARY KEY,
      privy_id  text NOT NULL,
      amount    double precision NOT NULL,
      address   text NOT NULL,
      status    text NOT NULL DEFAULT 'pending', -- pending | sent | rejected
      sig       text,
      created_at bigint NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault_deposits (
      id        text PRIMARY KEY,
      privy_id  text NOT NULL,
      amount    double precision NOT NULL,
      created_at bigint NOT NULL
    );
  `);
}

// ---- deposits ---------------------------------------------------------------
export async function getDepositInfo(privyId) {
  if (!depositsEnabled()) return { enabled: false };
  await ensureUser(privyId);
  return { enabled: true, address: depositAddress(privyId), maxPerUser: MAX_DEPOSIT_PER_USER };
}

// Credit incoming USDC per on-chain signature. Idempotent: each signature is
// credited at most once (unique index on deposits.sig). Safe across restarts,
// DB retries, and double-scans. Respects the per-user deposit cap.
export async function scanDeposits() {
  if (!depositsEnabled()) return;
  const users = (await pool.query(`SELECT privy_id FROM users`)).rows;
  for (const { privy_id } of users) {
    try {
      const addr = depositAddress(privy_id);

      // walk recent signatures; stop early at the last one we already credited
      const lastSig = (await pool.query(
        `SELECT sig FROM deposits WHERE privy_id=$1 AND sig IS NOT NULL ORDER BY credited_at DESC LIMIT 1`,
        [privy_id]
      )).rows[0]?.sig || undefined;

      const transfers = await incomingUsdcTransfers(addr, { limit: 25, until: lastSig });
      if (!transfers.length) continue;

      // oldest → newest so credits apply in chain order
      for (const t of transfers.reverse()) {
        if (t.amount < 0.01) continue;

        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          // how much has this user already been credited (for the cap)
          const credited = Number((await client.query(
            `SELECT coalesce(sum(amount),0) s FROM deposits WHERE privy_id=$1`, [privy_id]
          )).rows[0].s);
          const room = Math.max(0, MAX_DEPOSIT_PER_USER - credited);
          const allowed = Math.floor(Math.min(t.amount, room) * 100) / 100;

          if (allowed < 0.01) {
            // over cap: still record the signature (amount 0) so we never re-scan it,
            // and the excess sits on the deposit address for manual handling.
            await client.query(
              `INSERT INTO deposits (id, privy_id, amount, address, sig, slot, credited_at)
               VALUES ($1,$2,0,$3,$4,$5,$6) ON CONFLICT (sig) DO NOTHING`,
              [randomUUID(), privy_id, addr, t.sig, t.slot, Date.now()]
            );
            await client.query("COMMIT");
            console.warn(`[deposits] ${privy_id} over cap; sig ${t.sig} recorded, ${t.amount} USDC left on address`);
            continue;
          }

          // idempotent insert: if this sig was already credited, INSERT does nothing
          const ins = await client.query(
            `INSERT INTO deposits (id, privy_id, amount, address, sig, slot, credited_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (sig) DO NOTHING RETURNING id`,
            [randomUUID(), privy_id, allowed, addr, t.sig, t.slot, Date.now()]
          );
          if (ins.rowCount === 0) { await client.query("ROLLBACK"); continue; } // already credited

          await client.query(`UPDATE users SET balance=balance+$2 WHERE privy_id=$1`, [privy_id, allowed]);
          await client.query("COMMIT");
          console.log(`[deposits] +${allowed} USDC to ${privy_id} (sig ${t.sig})`);
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          // unique-violation means concurrent scan already credited it — safe to ignore
          if (e.code !== "23505") console.warn("[deposits] credit error:", e.message);
        } finally {
          client.release();
        }
      }
    } catch (e) {
      console.warn("[deposits] scan error:", e.message);
    }
  }
}

// ---- withdrawals --------------------------------------------------------------
function treasuryKeypair() {
  const sec = process.env.TREASURY_SECRET || "";
  if (!sec) return null;
  try { return Keypair.fromSecretKey(bs58.decode(sec)); } catch { return null; }
}

export async function requestWithdrawal(privyId, amount, address) {
  amount = Math.floor(Number(amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount < MIN_WITHDRAW) return { error: "min_withdraw", min: MIN_WITHDRAW };
  let dest;
  try { dest = new PublicKey(String(address)); } catch { return { error: "bad_address" }; }

  const dayAgo = Date.now() - 86_400_000;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = (await client.query(`SELECT balance FROM users WHERE privy_id=$1 FOR UPDATE`, [privyId])).rows[0];
    if (!u || u.balance < amount) { await client.query("ROLLBACK"); return { error: "insufficient_balance" }; }

    // per-user 24h amount + count caps (exclude rejected)
    const dayAgg = (await client.query(
      `SELECT coalesce(sum(amount),0) sum, count(*)::int n
         FROM withdrawals WHERE privy_id=$1 AND created_at > $2 AND status <> 'rejected'`,
      [privyId, dayAgo]
    )).rows[0];
    if (Number(dayAgg.sum) + amount > MAX_WITHDRAW_PER_USER_DAY) {
      await client.query("ROLLBACK");
      return { error: "daily_limit", limit: MAX_WITHDRAW_PER_USER_DAY, used: Number(dayAgg.sum) };
    }
    if (dayAgg.n >= MAX_WITHDRAWS_PER_USER_DAY) {
      await client.query("ROLLBACK");
      return { error: "daily_count_limit", limit: MAX_WITHDRAWS_PER_USER_DAY };
    }

    const id = randomUUID();
    await client.query(`UPDATE users SET balance=balance-$2 WHERE privy_id=$1`, [privyId, amount]);
    await client.query(
      `INSERT INTO withdrawals (id, privy_id, amount, address, status, created_at) VALUES ($1,$2,$3,$4,'pending',$5)`,
      [id, privyId, amount, dest.toBase58(), Date.now()]
    );
    await client.query("COMMIT");

    // auto-payout small withdrawals when the treasury key is configured AND
    // the house-wide hourly auto-payout budget still has room (drain protection)
    const treasury = treasuryKeypair();
    const hourAgo = Date.now() - 3_600_000;
    const houseHour = Number((await pool.query(
      `SELECT coalesce(sum(amount),0) s FROM withdrawals WHERE status='sent' AND created_at > $1`, [hourAgo]
    )).rows[0].s);
    const houseRoom = MAX_WITHDRAW_HOUSE_HOUR - houseHour;

    if (treasury && connection && amount <= MAX_AUTO_WITHDRAW && amount <= houseRoom) {
      // mark 'processing' FIRST so a crash mid-send never lets a retry pay twice.
      // Only a confirmed on-chain tx flips it to 'sent'; failures go back to 'pending'.
      const claim = await pool.query(
        `UPDATE withdrawals SET status='processing' WHERE id=$1 AND status='pending' RETURNING id`, [id]
      );
      if (claim.rowCount === 0) return { ok: true, status: "pending" }; // someone else grabbed it
      try {
        const fromAta = await getOrCreateAssociatedTokenAccount(connection, treasury, USDC_MINT, treasury.publicKey);
        const toAta = await getOrCreateAssociatedTokenAccount(connection, treasury, USDC_MINT, dest);
        const ix = createTransferInstruction(fromAta.address, toAta.address, treasury.publicKey, BigInt(Math.round(amount * 10 ** USDC_DECIMALS)));
        const tx = new Transaction().add(ix);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = treasury.publicKey;
        const sig = await connection.sendTransaction(tx, [treasury], { maxRetries: 3 });
        // wait for on-chain confirmation before declaring success
        const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        if (conf.value?.err) throw new Error("tx failed on-chain: " + JSON.stringify(conf.value.err));
        await pool.query(`UPDATE withdrawals SET status='sent', sig=$2 WHERE id=$1`, [id, sig]);
        return { ok: true, status: "sent", sig };
      } catch (e) {
        // roll the request back to pending for manual handling; balance stays debited
        // (funds are NOT lost — admin can reject to refund, or retry the payout)
        await pool.query(`UPDATE withdrawals SET status='pending' WHERE id=$1`, [id]).catch(() => {});
        console.warn("[withdraw] auto-payout failed, left pending:", e.message);
      }
    }
    return { ok: true, status: "pending" };
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[withdraw]", e.message);
    return { error: "internal" };
  } finally { client.release(); }
}

// Admin: reject a pending withdrawal and refund the user's balance.
export async function rejectWithdrawal(id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const w = (await client.query(`SELECT privy_id, amount, status FROM withdrawals WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!w) { await client.query("ROLLBACK"); return { error: "not_found" }; }
    if (w.status !== "pending") { await client.query("ROLLBACK"); return { error: "not_pending", status: w.status }; }
    await client.query(`UPDATE withdrawals SET status='rejected' WHERE id=$1`, [id]);
    await client.query(`UPDATE users SET balance=balance+$2 WHERE privy_id=$1`, [w.privy_id, w.amount]);
    await client.query("COMMIT");
    return { ok: true, refunded: w.amount };
  } catch (e) {
    await client.query("ROLLBACK");
    return { error: "internal" };
  } finally { client.release(); }
}

export async function listPendingWithdrawals() {
  return (await pool.query(
    `SELECT id, privy_id, amount, address, created_at FROM withdrawals WHERE status='pending' ORDER BY created_at ASC LIMIT 100`
  )).rows;
}

export async function listWithdrawals(privyId) {
  return (await pool.query(`SELECT id, amount, address, status, sig, created_at FROM withdrawals WHERE privy_id=$1 ORDER BY created_at DESC LIMIT 20`, [privyId])).rows;
}

// ---- vault --------------------------------------------------------------------
export async function vaultStats() {
  const r = (await pool.query(`SELECT coalesce(sum(amount),0) tvl, count(distinct privy_id)::int depositors FROM vault_deposits`)).rows[0];
  return { open: VAULT_OPEN, tvl: Number(r.tvl), depositors: r.depositors };
}

export async function vaultDeposit(privyId, amount) {
  if (!VAULT_OPEN) return { error: "vault_closed" };
  amount = Math.floor(Number(amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return { error: "bad_amount" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = (await client.query(`SELECT balance FROM users WHERE privy_id=$1 FOR UPDATE`, [privyId])).rows[0];
    if (!u || u.balance < amount) { await client.query("ROLLBACK"); return { error: "insufficient_balance" }; }
    await client.query(`UPDATE users SET balance=balance-$2 WHERE privy_id=$1`, [privyId, amount]);
    await client.query(`INSERT INTO vault_deposits (id, privy_id, amount, created_at) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), privyId, amount, Date.now()]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    return { error: "internal" };
  } finally { client.release(); }
}

// ---- admin: sweep deposit addresses → treasury ------------------------------
// Lists every user's deposit address with its current USDC + SOL balance, so an
// admin can see what's sitting uncollected across deposit addresses.
export async function depositAddressesWithBalances() {
  if (!depositsEnabled()) return { enabled: false, addresses: [] };
  if (!treasuryPubkey()) return { enabled: true, treasury: null, error: "no_treasury", addresses: [] };
  const users = (await pool.query(`SELECT privy_id FROM users`)).rows;
  const out = [];
  let totalUsdc = 0;
  for (const { privy_id } of users) {
    const address = depositAddress(privy_id);
    let usdc = 0, sol = 0;
    try { usdc = await usdcBalanceOf(address); } catch {}
    try { sol = await solBalanceOf(address); } catch {}
    if (usdc > 0 || sol > 0) {
      out.push({ privyId: privy_id, address, usdc, sol, canSweep: usdc >= 0.5 && sol >= 0.001 });
      totalUsdc += usdc;
    }
  }
  out.sort((a, b) => b.usdc - a.usdc);
  return { enabled: true, treasury: treasuryPubkey().toBase58(), totalUsdc: Math.round(totalUsdc * 100) / 100, count: out.length, addresses: out };
}

// Sweeps every user's deposit address that has enough USDC (and SOL for the fee)
// into the treasury. Returns a per-address result list. Safe to re-run: already
// empty addresses are skipped, and each sweep waits for on-chain confirmation.
export async function sweepAllDeposits() {
  if (!depositsEnabled()) return { error: "deposits_disabled" };
  if (!treasuryPubkey()) return { error: "no_treasury" };
  const users = (await pool.query(`SELECT privy_id FROM users`)).rows;
  const results = [];
  let swept = 0, total = 0;
  for (const { privy_id } of users) {
    const r = await sweepDepositToTreasury(privy_id, { minSweep: 0.5 });
    if (r.ok) { swept++; total += r.amount; results.push({ privyId: privy_id, ok: true, amount: r.amount, sig: r.sig }); }
    else if (r.error !== "no_usdc" && r.error !== "below_min") {
      results.push({ privyId: privy_id, ok: false, error: r.error, ...(r.address ? { address: r.address } : {}) });
    }
  }
  return { ok: true, swept, totalUsdc: Math.round(total * 100) / 100, results };
}
