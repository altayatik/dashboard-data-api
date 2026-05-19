// api/markets.js
import { createClient } from "@vercel/kv";

const KEY = process.env.TWELVEDATA_API_KEY;
if (!KEY) throw new Error("Missing TWELVEDATA_API_KEY");

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const CACHE_KEY = "last_valid_markets_data";
const TZ = "America/Chicago";
const UPSTREAM_TIMEOUT_MS = 4500;

// History cache freshness (controls upstream API usage)
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const HISTORY_KEY = (sym) => `hist_5d_${sym}`;

async function j(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`Timed out fetching ${new URL(url).hostname}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
  try { return JSON.parse(t); }
  catch { throw new Error(`Bad JSON: ${t.slice(0, 200)}`); }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function quote(sym) {
  const url =
    `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}` +
    `&apikey=${encodeURIComponent(KEY)}`;

  const d = await j(url);
  if (d?.status === "error" || (d?.code && d?.message)) {
    throw new Error(`TwelveData quote ${sym}: ${d.message}`);
  }

  const p = num(d.close ?? d.price);
  if (p == null) throw new Error(`Bad price for ${sym}: ${JSON.stringify(d).slice(0, 200)}`);

  return {
    price: p,
    change: num(d.change),
    percent_change: num(d.percent_change)
  };
}

// TwelveData daily time series (newest-first)
async function timeSeriesDaily(sym, outputsize = 12) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}` +
    `&interval=1day&outputsize=${outputsize}&apikey=${encodeURIComponent(KEY)}`;

  const d = await j(url);
  if (d?.status === "error" || (d?.code && d?.message)) {
    throw new Error(`TwelveData series ${sym}: ${d.message}`);
  }

  const vals = Array.isArray(d.values) ? d.values : [];
  const cleaned = vals
    .map(v => ({ date: v.datetime, close: num(v.close) }))
    .filter(v => v.date && v.close != null);

  return cleaned;
}

// Return exactly last N trading closes (oldest-first for charting)
function lastNTradingDays(valuesNewestFirst, n = 5) {
  return valuesNewestFirst.slice(0, n).reverse();
}

async function getOrRefreshHistory(sym, nowIso) {
  const key = HISTORY_KEY(sym);
  let cached = null;
  try {
    cached = await kv.get(key);
  } catch (err) {
    console.error(`KV history read failed for ${sym}:`, err);
  }

  const cachedAt = cached?.cached_at ? Date.parse(cached.cached_at) : 0;
  const ageOk = cachedAt && (Date.now() - cachedAt) < HISTORY_TTL_MS;

  if (cached && ageOk && Array.isArray(cached.series) && cached.series.length) {
    return cached.series;
  }

  // Fetch fresh and cache
  const raw = await timeSeriesDaily(sym, 12);
  const series = lastNTradingDays(raw, 5);

  kv.set(key, { cached_at: nowIso, series }).catch(err =>
    console.error(`KV history save failed for ${sym}:`, err)
  );

  return series;
}

function emptySymbol(priceObj = null) {
  return priceObj || { price: null, change: null, percent_change: null };
}

async function getCachedSnapshot() {
  try {
    return await kv.get(CACHE_KEY);
  } catch (err) {
    console.error("KV market snapshot read failed:", err);
    return null;
  }
}

async function settleObject(keys, fn, fallbackForKey) {
  const settled = await Promise.allSettled(keys.map((key) => fn(key)));
  return Object.fromEntries(keys.map((key, i) => {
    const result = settled[i];
    if (result.status === "fulfilled") return [key, result.value];
    console.error(`Markets ${key} failed:`, result.reason);
    return [key, fallbackForKey(key, result.reason)];
  }));
}

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

function marketHoursNow(now) {
  // IMPORTANT: Never parse locale strings back into Date; use formatToParts
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
  return isWeekday && hour >= 9 && hour < 17;
}

function sendMarkets(res, marketsObj, cacheControl = "s-maxage=900, stale-while-revalidate=3600") {
  const banner = `// AUTO-GENERATED. DO NOT EDIT.\n`;
  const js =
    banner +
    `window.DASH_DATA = window.DASH_DATA || {}; window.DASH_DATA.markets = ${JSON.stringify(marketsObj)};\n`;

  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", cacheControl);
  res.send(js);
}

export default async function handler(req, res) {
  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const isMarketHours = marketHoursNow(now);

    const syms = ["SPY", "QQQ", "IAU", "SLV"];
    const cached = await getCachedSnapshot();

    let marketsObj;

    if (cached && req.query?.fresh !== "1") {
      return sendMarkets(res, {
        ...cached,
        in_hours: isMarketHours,
        current_fetch_iso: nowIso,
        current_fetch_local: formatLocal(now),
        stale: true
      });
    }

    if (isMarketHours) {
      // Fetch fresh quotes during market hours
      console.log(`Market open (${formatClock(now)}) → fetching ${syms.join("/")}`);

      const symbols = await settleObject(
        syms,
        quote,
        (sym) => emptySymbol(cached?.symbols?.[sym])
      );

      // History is KV-cached and cheap to request (refresh <= every 6h per symbol)
      const history = await settleObject(
        syms,
        (sym) => getOrRefreshHistory(sym, nowIso),
        (sym) => cached?.history?.[sym] || []
      );

      marketsObj = {
        updated_iso: nowIso,
        updated_local: formatLocal(now),
        in_hours: true,
        symbols,
        history,
        history_cached_at: nowIso
      };

      // Store in KV (fire-and-forget)
      kv.set(CACHE_KEY, marketsObj).catch(err =>
        console.error("KV cache save failed:", err)
      );
    } else {
      // Outside hours → serve last cached snapshot
      console.log("Outside market hours → serving cached data");

      if (cached) {
        // Ensure history exists (backfill if older cache didn't have it)
        let history = cached.history;
        if (!history || !history.SPY || !history.IAU) {
          history = await settleObject(
            syms,
            (sym) => getOrRefreshHistory(sym, nowIso),
            (sym) => cached?.history?.[sym] || []
          );
        }

        marketsObj = {
          ...cached,
          in_hours: false,
          current_fetch_iso: nowIso,
          current_fetch_local: formatLocal(now),
          history
        };
      } else {
        // No cache yet
        const history = await settleObject(
          syms,
          (sym) => getOrRefreshHistory(sym, nowIso),
          () => []
        );

        marketsObj = {
          updated_iso: null,
          in_hours: false,
          error: "No previous market data cached",
          symbols: { SPY: null, QQQ: null, IAU: null, SLV: null },
          history
        };
      }
    }

    return sendMarkets(res, marketsObj);
  } catch (err) {
    console.error("Markets handler error:", err);
    const fallback = {
      updated_iso: null,
      current_fetch_iso: new Date().toISOString(),
      in_hours: false,
      stale: true,
      error: err.message || "Unknown error",
      symbols: {
        SPY: emptySymbol(),
        QQQ: emptySymbol(),
        IAU: emptySymbol(),
        SLV: emptySymbol()
      },
      history: {
        SPY: [],
        QQQ: [],
        IAU: [],
        SLV: []
      }
    };
    return sendMarkets(res, fallback, "s-maxage=60, stale-while-revalidate=300");
  }
}
