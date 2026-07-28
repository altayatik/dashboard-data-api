import { getWeather } from "../services/weather.js";
import { handleOptions, sendData, sendError } from "../lib/http.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") return sendError(req, res, 405, "Method not allowed");
  try {
    const query = Object.fromEntries(new URL(req.url, "http://dashboard.local").searchParams);
    const weather = await getWeather(query);
    return sendData(req, res, "weather", weather, "s-maxage=300, stale-while-revalidate=1800");
  } catch (error) {
    return sendError(req, res, error.message?.startsWith("City not found") ? 400 : 502, error.message || "Weather unavailable");
  }
}
