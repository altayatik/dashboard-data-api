import { cacheGet, cacheSet, ageInSeconds } from "../lib/cache.js";
import { fetchJson } from "../lib/request.js";

const SYMBOLS = ["SPY", "QQQ", "IAU", "SLV"];
const CACHE_KEY = "altay-dashboard:markets:v3";
const LEGACY_CACHE_KEY = "last_valid_markets_data";
const MARKET_TIMEZONE = "America/New_York";

function valueAsNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketIsOpen(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return !["Sat", "Sun"].includes(parts.weekday) && minutes >= 570 && minutes < 960;
}

async function fetchSeries(symbol, apiKey) {
  const params = new URLSearchParams({
    symbol,
    interval: "1day",
    outputsize: "8",
    apikey: apiKey
  });
  const data = await fetchJson(`https://api.twelvedata.com/time_series?${params}`, {}, 4300);
  if (data?.status === "error" || !Array.isArray(data?.values)) {
    throw new Error(`Market source rejected ${symbol}: ${data?.message || "No series"}`);
  }
  const history = data.values
    .map((point) => ({ date: point.datetime, close: valueAsNumber(point.close) }))
    .filter((point) => point.close != null)
    .slice(0, 6)
    .reverse();
  if (!history.length) throw new Error(`No market history for ${symbol}`);
  const price = history.at(-1).close;
  const previous = history.at(-2)?.close ?? price;
  return {
    price,
    change: price - previous,
    percent_change: previous ? ((price - previous) / previous) * 100 : 0,
    history
  };
}

export async function getMarkets(query = {}) {
  const [currentCache, legacyCache] = await Promise.all([
    cacheGet(CACHE_KEY),
    cacheGet(LEGACY_CACHE_KEY)
  ]);
  const cached = currentCache || legacyCache;
  const inHours = marketIsOpen();
  const maxAge = inHours ? 15 * 60 : 6 * 60 * 60;
  if (cached && ageInSeconds(cached) < maxAge && query.fresh !== "1") {
    return { ...cached, in_hours: inHours };
  }

  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    if (cached) return { ...cached, in_hours: inHours, stale: true, error: "Market API key unavailable" };
    throw new Error("Market data is not configured");
  }

  try {
    const results = await Promise.allSettled(SYMBOLS.map((symbol) => fetchSeries(symbol, apiKey)));
    const symbols = {};
    for (let index = 0; index < SYMBOLS.length; index += 1) {
      const symbol = SYMBOLS[index];
      const result = results[index];
      if (result.status === "fulfilled") symbols[symbol] = result.value;
      else if (cached?.symbols?.[symbol]) symbols[symbol] = cached.symbols[symbol];
    }
    if (!symbols.SPY) throw new Error("Primary market signal unavailable");
    const payload = {
      updated_iso: new Date().toISOString(),
      source: "Twelve Data",
      in_hours: inHours,
      partial: Object.keys(symbols).length !== SYMBOLS.length,
      symbols
    };
    await cacheSet(CACHE_KEY, payload, 7 * 24 * 60 * 60);
    return payload;
  } catch (error) {
    if (cached) return { ...cached, in_hours: inHours, stale: true, error: error.message };
    throw error;
  }
}
