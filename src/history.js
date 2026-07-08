// ---------------------------------------------------------------------------
// Daily price HISTORY adapter — real Steam Market history via steamwebapi.com.
// Free API key (no deposit): https://www.steamwebapi.com → dashboard → key.
// Returns up to ~365 days of real daily prices per market_hash_name.
//
// Env: STEAMWEBAPI_KEY. Without it, history stays unavailable and the API
// reports { real: false } so the frontend can label synthetic data honestly.
//
// NOTE: response field mapping is defensive (several known shapes). On first
// live run set LOG_RAW=1 once and check logs; adjust pick() keys if needed.
// ---------------------------------------------------------------------------

const KEY = process.env.STEAMWEBAPI_KEY || "";
const LOG_RAW = process.env.LOG_RAW === "1";
const cache = new Map(); // hash -> { at, candles }
const TTL = 6 * 60 * 60 * 1000; // 6h

export function historyEnabled() {
  return Boolean(KEY);
}

export async function fetchDailyHistory(hash) {
  if (!KEY) return null;
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < TTL) return hit.candles;
  try {
    const url = new URL("https://www.steamwebapi.com/steam/api/history");
    url.searchParams.set("key", KEY);
    url.searchParams.set("appid", "730");
    url.searchParams.set("market_hash_name", hash);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.warn(`[history] ${res.status} for ${hash}`);
      return null;
    }
    const json = await res.json();
    if (LOG_RAW) console.log("[history] raw:", JSON.stringify(json).slice(0, 500));

    // normalize: find an array of {date|time, price|median|avg} entries
    const arr = Array.isArray(json) ? json
      : json.history || json.prices || json.data || json.items || [];
    const out = [];
    for (const row of arr) {
      const dRaw = row.date ?? row.time ?? row.day ?? row.created ?? row[0];
      const pRaw = row.price ?? row.median_price ?? row.avg_price ?? row.value ?? row[1];
      const t = typeof dRaw === "number" ? (dRaw > 1e12 ? Math.floor(dRaw / 1000) : dRaw)
        : Math.floor(new Date(dRaw).getTime() / 1000);
      const price = Number(String(pRaw).replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(t) || !Number.isFinite(price) || price <= 0) continue;
      out.push({ t: Math.floor(t / 86400) * 86400, price });
    }
    if (!out.length) return null;
    out.sort((a, b) => a.t - b.t);

    // collapse to daily OHLC (steam history can have multiple points per day)
    const byDay = new Map();
    for (const { t, price } of out) {
      const c = byDay.get(t);
      if (!c) byDay.set(t, { time: t, open: price, high: price, low: price, close: price });
      else { c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; }
    }
    const candles = [...byDay.values()];
    cache.set(hash, { at: Date.now(), candles });
    return candles;
  } catch (e) {
    console.warn("[history] error:", e.message);
    return null;
  }
}
