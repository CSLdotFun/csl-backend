// ---------------------------------------------------------------------------
// Skinport price adapter — FREE, no API key, no deposit.
//
// GET https://api.skinport.com/v1/items?app_id=730&currency=USD
//   - No authorization required.
//   - Response cached 5 min server-side → don't poll more than once / 5 min.
//   - Brotli (Accept-Encoding: br) recommended; Node's fetch decompresses it.
//
// Returns { [market_hash_name]: priceUSD } using the lowest current listing.
// ---------------------------------------------------------------------------

const URL = "https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0";

export async function fetchSkinportPrices(hashes) {
  try {
    const res = await fetch(URL, { headers: { "Accept-Encoding": "br", Accept: "application/json" } });
    if (!res.ok) {
      console.warn(`[skinport] ${res.status} ${res.statusText}`);
      return null;
    }
    const items = await res.json(); // array of { market_hash_name, min_price, suggested_price, ... }
    const want = new Set(hashes);
    const out = {};
    for (const it of items) {
      if (!want.has(it.market_hash_name)) continue;
      const price = Number(it.min_price ?? it.suggested_price ?? it.median_price);
      if (Number.isFinite(price) && price > 0) out[it.market_hash_name] = price;
    }
    return Object.keys(out).length ? out : null;
  } catch (e) {
    console.warn("[skinport] error:", e.message);
    return null;
  }
}
