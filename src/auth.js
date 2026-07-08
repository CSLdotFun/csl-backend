// Privy token verification. The frontend sends the user's Privy access token
// as Authorization: Bearer <token>; we verify it and attach req.privyId.
import { PrivyClient } from "@privy-io/server-auth";

const APP_ID = process.env.PRIVY_APP_ID || "cmr6oo33w00w00cjxl9thvmh3";
const APP_SECRET = process.env.PRIVY_APP_SECRET || "";

const privy = APP_SECRET ? new PrivyClient(APP_ID, APP_SECRET) : null;

export function authEnabled() { return Boolean(privy); }

export async function requireAuth(req, res, next) {
  if (!privy) return res.status(503).json({ error: "auth_not_configured" });
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no_token" });
  try {
    const claims = await privy.verifyAuthToken(token);
    req.privyId = claims.userId;
    next();
  } catch {
    res.status(401).json({ error: "bad_token" });
  }
}
