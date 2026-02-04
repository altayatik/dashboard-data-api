// api/markets.js
import { createClient } from '@vercel/kv';

const KEY = process.env.TWELVEDATA_API_KEY;
if (!KEY) throw new Error("Missing TWELVEDATA_API_KEY");

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const CACHE_KEY = 'last_valid_markets_data';

async function j(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0,200)}`);
  try { return JSON.parse(t); } catch { throw new Error(`Bad JSON: ${t.slice(0,200)}`); }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function quote(sym) {
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(KEY)}`;
  const d = await j(url);
  if (d?.status === "error" || (d?.code && d?.message)) throw new Error(`TwelveData ${sym}: ${d.message}`);
  const p = num(d.close ?? d.price);
  if (p == null) throw new Error(`Bad price for ${sym}: ${JSON.stringify(d).slice(0,200)}`);
  return {
    price: p,
    change: num(d.change),
    percent_change: num(d.percent_change)
  };
}

export default async function handler(req, res) {
  try {
    
const now = new Date();
const TZ = "America/Chicago";

// IMPORTANT: never round-trip a locale string back into `new Date(...)`.
// That drops the timezone and causes the "09:00" style mismatches you're seeing.
const wkHourParts = Object.fromEntries(
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    hour12: false
  }).formatToParts(now).map(p => [p.type, p.value])
);

const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const dayOfWeek = dowMap[wkHourParts.weekday];
const hour = Number(wkHourParts.hour);

const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
const isMarketHours = isWeekday && hour >= 9 && hour < 17;

const formatLocal = (d) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    dateStyle: "short",
    timeStyle: "short",
    hour12: false
  }).format(d);

const formatClock = (d) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(d);

    let marketsObj;

    if (isMarketHours) {
      // ── Fetch fresh during market hours ───────────────────────────────
      console.log(`Market open (${formatClock(now)}) → fetching SPY/IAU`);

      const [spy, iau] = await Promise.all([quote("SPY"), quote("IAU")]);

      marketsObj = {
        updated_iso: now.toISOString(),
        updated_local: formatLocal(now),
        in_hours: true,
        symbols: {
          SPY: spy,
          IAU: iau
        }
      };

      // Store in KV (fire-and-forget – don't block response)
      kv.set(CACHE_KEY, marketsObj)
        .catch(err => console.error("KV cache save failed:", err));
    } else {
      // ── Outside hours → return last known good data ───────────────────
      console.log(`Outside market hours → serving cached data`);

      const cached = await kv.get(CACHE_KEY);

      if (cached) {
        marketsObj = {
          ...cached,
          in_hours: false,
          current_fetch_iso: now.toISOString(),
          current_fetch_local: formatLocal(now)
        };
      } else {
        // No cache yet (first run or cache expired/cleared)
        marketsObj = {
          updated_iso: null,
          in_hours: false,
          error: "No previous market data cached",
          symbols: { SPY: null, IAU: null }
        };
      }
    }

    const banner = `// AUTO-GENERATED. DO NOT EDIT.\n`;
    const js = banner + `window.DASH_DATA = window.DASH_DATA || {}; window.DASH_DATA.markets = ${JSON.stringify(marketsObj)};\n`;

    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60'); // 5 min + some stale tolerance
    res.send(js);
  } catch (err) {
    console.error("Markets handler error:", err);
    res.status(500).send(`// Error: ${err.message || 'Unknown error'}`);
  }
}