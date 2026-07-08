// Public Steam inventory proxy (CS2, app 730). No key required for public
// inventories. Rate-limited by Steam — cache per steamid for 10 min.
import { MARKETS } from "./markets.js";

const cache = new Map(); // steamid -> { at, data }
const TTL = 10 * 60 * 1000;

// base name (before wear suffix) -> market key, e.g. "AWP | Dragon Lore"
const baseToKey = new Map(MARKETS.map((m) => [m.hash.replace(/\s*\(.*\)$/, ""), m.key]));

export async function fetchInventory(steamid) {
  const hit = cache.get(steamid);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const url = `https://steamcommunity.com/inventory/${steamid}/730/2?l=english&count=500`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (res.status === 403) return { error: "private" };
  if (res.status === 429) return { error: "rate_limited" };
  if (!res.ok) return { error: `steam_${res.status}` };
  const json = await res.json();
  if (!json || !json.descriptions) return { error: "empty" };

  const items = [];
  for (const d of json.descriptions) {
    if (!d.marketable && !d.tradable) continue;
    const name = d.market_hash_name || d.name;
    if (!name) continue;
    const base = name.replace(/\s*\(.*\)$/, "").replace(/^(StatTrak™|Souvenir)\s+/, "");
    items.push({
      name,
      icon: d.icon_url ? `https://community.fastly.steamstatic.com/economy/image/${d.icon_url}/128fx96f` : null,
      type: d.type || "",
      cslKey: baseToKey.get(base) || null, // tradable on CSL?
    });
  }
  const data = { items };
  cache.set(steamid, { at: Date.now(), data });
  return data;
}
