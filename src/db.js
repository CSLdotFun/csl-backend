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
  `);
  console.log("[db] schema ready");
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
  const history = (await pool.query(`SELECT * FROM trades WHERE privy_id=$1 ORDER BY closed_at DESC LIMIT 50`, [privyId])).rows;
  return { ...u, positions, history };
}
