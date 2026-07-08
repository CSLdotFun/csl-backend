// ---------------------------------------------------------------------------
// CSFloat price adapter — second oracle source (public, no key for reads).
//
// Public listings endpoint (no auth needed to READ):
//   GET https://csfloat.com/api/v1/listings
//       ?market_hash_name=<hash>&sort_by=lowest_price&limit=1&type=buy_now
//   → { data: [ { price: <cents>, item: { market_hash_name, float_value, ... } } ] }
//
// price is in CENTS → divide by 100 for USD.
// We take the lowest buy_now listing = the floor, same semantics as Skinport's
// min_price, so the two are directly comparable for a median.
//
// CSFloat rate-limits (roughly N req / 5 min per endpoint). One request returns
// ONE skin, so a full pass over the market list is slow. Same strategy as the
// Steam adapter: refresh a few stale items per tick in the background, cache the
// rest, and never block the oracle. All CS2 skins trade here (incl. Dragon Lore,
// Howl) so unlike Steam there are no missing high-value items.
// ---------------------------------------------------------------------------

const ENABLED = process.env.CSFLOAT !== "0";
const KEY = process.env.CSFLOAT_API_KEY || ""; // optional; raises rate limits if set
const TTL_MS = Number(process.env.CSFLOAT_TTL_MS || 8 * 60 * 1000);    // 8 min per item
const SPACING_MS = Number(process.env.CSFLOAT_SPACING_MS || 2500);      // pause between calls
const TIMEOUT_MS = Number(process.env.CSFLOAT_TIMEOUT_MS || 8000);
const BATCH = Number(process.env.CSFLOAT_BATCH || 5);                   // items refreshed per tick

const cache = new Map();   // hash -> { at, price }
let chain = Promise.resolve();
let refreshing = false;
let lastError = null;      // last failure detail: "HTTP 403: <body head>" etc
let lastOkAt = 0;

export function csfloatDiag() {
  return { cached: cache.size, lastError, lastOkAt: lastOkAt || null };
}

export function csfloatEnabled() { return ENABLED; }

async function fetchOne(hash) {
  const url = `https://csfloat.com/api/v1/listings?limit=1&sort_by=lowest_price&type=buy_now&market_hash_name=${encodeURIComponent(hash)}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = {
      Authorization: KEY,
      "Content-Type": "application/json",
    };
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      let body = "";
      try { body = (await res.text()).slice(0, 140); } catch {}
      lastError = `HTTP ${res.status}: ${body}`;
      if (res.status === 429) console.warn("[csfloat] 429 rate-limited");
      else console.warn(`[csfloat] ${lastError}`);
      return null;
    }
    const j = await res.json();
    // response is either { data: [...] } or a bare array depending on params
    const rows = Array.isArray(j) ? j : (j?.data || []);
    if (!rows.length) { lastError = "empty_listings"; return null; }
    // rows are sorted lowest→highest; first is the floor
    const cents = Number(rows[0]?.price);
    if (!Number.isFinite(cents) || cents <= 0) { lastError = `bad_price_field: ${JSON.stringify(rows[0]).slice(0, 140)}`; return null; }
    lastOkAt = Date.now();
    return cents / 100;
  } catch (e) {
    lastError = `fetch_error: ${e.message}`;
    return null;
  } finally {
    clearTimeout(to);
  }
}

function scheduleRefresh(hashes, maxPerPass) {
  if (refreshing) return;
  refreshing = true;
  chain = chain.then(async () => {
    try {
      const now = Date.now();
      const stale = hashes
        .map((h) => ({ h, at: cache.get(h)?.at || 0 }))
        .filter((x) => now - x.at > TTL_MS)
        .sort((a, b) => a.at - b.at)
        .slice(0, maxPerPass)
        .map((x) => x.h);
      for (const h of stale) {
        const price = await fetchOne(h);
        if (price != null) cache.set(h, { at: Date.now(), price });
        else cache.set(h, { at: Date.now() - TTL_MS + 60_000, price: cache.get(h)?.price }); // retry ~1min
        await new Promise((r) => setTimeout(r, SPACING_MS));
      }
    } finally {
      refreshing = false;
    }
  });
}

// Oracle entry point. Shape matches Skinport: { hash: priceUSD }.
export async function fetchCsfloatPrices(hashes) {
  if (!ENABLED) return null;
  scheduleRefresh(hashes, BATCH);
  const out = {};
  for (const h of hashes) {
    const hit = cache.get(h);
    if (hit && hit.price != null) out[h] = hit.price;
  }
  return Object.keys(out).length ? out : null;
}
