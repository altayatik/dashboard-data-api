import { getWeather } from "../services/weather.js";
import { getMarkets } from "../services/markets.js";
import { getTraffic } from "../services/traffic.js";
import { handleOptions, sendError, setCors } from "../lib/http.js";
import { withDeadline } from "../lib/request.js";

function settledValue(result) {
  return result.status === "fulfilled" ? result.value : null;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") return sendError(req, res, 405, "Method not allowed");
  try {
    const query = Object.fromEntries(new URL(req.url, "http://dashboard.local").searchParams);
    const results = await Promise.allSettled([
      withDeadline(getWeather(query), 6200, "Weather"),
      withDeadline(getMarkets(query), 5200, "Markets"),
      withDeadline(getTraffic(query), 6200, "Traffic")
    ]);
    const payload = {
      updated_iso: new Date().toISOString(),
      weather: settledValue(results[0]),
      markets: settledValue(results[1]),
      traffic: settledValue(results[2]),
      partial: results.some((result) => result.status === "rejected"),
      errors: results.map((result) => result.status === "rejected" ? result.reason?.message || "Unavailable" : null)
    };
    if (!payload.weather && !payload.markets && !payload.traffic) {
      return sendError(req, res, 503, "All dashboard sources are temporarily unavailable");
    }
    setCors(req, res);
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json(payload);
  } catch (error) {
    return sendError(req, res, 500, error.message || "Dashboard unavailable");
  }
}
