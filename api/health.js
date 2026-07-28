import { setCors } from "../lib/http.js";

export default function handler(req, res) {
  setCors(req, res);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    service: "altay-dashboard-data-api",
    timestamp: new Date().toISOString(),
    configured: {
      weather: true,
      markets: Boolean(process.env.TWELVEDATA_API_KEY),
      traffic: Boolean(process.env.TOMTOM_API_KEY || process.env.TOMTOM_KEY),
      cache: Boolean(
        (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
        (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)
      )
    }
  });
}
