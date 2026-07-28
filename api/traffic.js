import { getTraffic } from "../services/traffic.js";
import { handleOptions, sendData, sendError } from "../lib/http.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") return sendError(req, res, 405, "Method not allowed");
  try {
    const query = Object.fromEntries(new URL(req.url, "http://dashboard.local").searchParams);
    const traffic = await getTraffic(query);
    return sendData(req, res, "traffic", traffic, "s-maxage=120, stale-while-revalidate=900");
  } catch (error) {
    return sendError(req, res, 502, error.message || "Traffic unavailable");
  }
}
