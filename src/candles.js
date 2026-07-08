// OHLC candle store. Keeps a rolling series per market, aggregating live ticks
// into fixed-interval candles. Seeds synthetic history so charts aren't empty.

const TF_SEC = Number(process.env.CANDLE_TF_SEC || 60); // candle interval (default 1m)
const MAX_CANDLES = 240;

const store = new Map(); // key -> [{ time, open, high, low, close }]  time = unix seconds

function bucket(tsSec) {
  return Math.floor(tsSec / TF_SEC) * TF_SEC;
}

// Seed ~MAX past candles ending at `price` via gentle random walk.
export function seedCandles(key, price) {
  const now = Math.floor(Date.now() / 1000);
  const start = bucket(now) - TF_SEC * (MAX_CANDLES - 1);
  const candles = [];
  let p = price * (0.94 + Math.random() * 0.12); // start a bit off, walk toward price
  for (let i = 0; i < MAX_CANDLES; i++) {
    const time = start + i * TF_SEC;
    const drift = (price - p) * 0.03;
    const o = p;
    const moves = 4;
    let hi = o, lo = o, c = o;
    for (let j = 0; j < moves; j++) {
      c = Math.max(price * 0.5, c + drift / moves + c * 0.004 * (Math.random() * 2 - 1));
      hi = Math.max(hi, c);
      lo = Math.min(lo, c);
    }
    candles.push({ time, open: r(o), high: r(hi), low: r(lo), close: r(c) });
    p = c;
  }
  store.set(key, candles);
}

// Fold a new price tick into the current candle (creating one on interval roll).
export function pushTick(key, price) {
  const now = Math.floor(Date.now() / 1000);
  const t = bucket(now);
  let arr = store.get(key);
  if (!arr) { seedCandles(key, price); arr = store.get(key); }
  const last = arr[arr.length - 1];
  if (last && last.time === t) {
    last.high = r(Math.max(last.high, price));
    last.low = r(Math.min(last.low, price));
    last.close = r(price);
  } else {
    arr.push({ time: t, open: r(price), high: r(price), low: r(price), close: r(price) });
    if (arr.length > MAX_CANDLES) arr.shift();
  }
}

export function getCandles(key) {
  return store.get(key) || [];
}

export function getLastCandle(key) {
  const arr = store.get(key);
  return arr && arr.length ? arr[arr.length - 1] : null;
}

export const CANDLE_TF_SEC = TF_SEC;

function r(n) {
  return Math.round(n * 100) / 100;
}
