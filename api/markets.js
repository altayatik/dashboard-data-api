import { getMarkets } from "../services/markets.js";
import { handleOptions, sendData, sendError } from "../lib/http.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") return sendError(req, res, 405, "Method not allowed");
  try {
    const query = Object.fromEntries(new URL(req.url, "http://dashboard.local").searchParams);
    const markets = await getMarkets(query);
    return sendData(req, res, "markets", markets, "s-maxage=300, stale-while-revalidate=21600");
  } catch (error) {
    return sendError(req, res, 502, error.message || "Markets unavailable");
  }
}
