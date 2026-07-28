// api/commute.js
// JSON endpoint: /api/commute?from=...&to=...
// Uses TomTom Search (fuzzy) + TomTom Routing (traffic=true)
// Caches per (from,to) pair in Vercel KV.
// Includes CORS headers so local dev (127.0.0.1) can fetch.

import crypto from "crypto";
import { cacheGet, cacheSet, ageInSeconds } from "../lib/cache.js";
import { fetchJson } from "../lib/request.js";
import { handleOptions, sendError, setCors } from "../lib/http.js";

const TOMTOM_KEY = process.env.TOMTOM_API_KEY || process.env.TOMTOM_KEY;
const TTL_SEC = 300; // 5 minutes

// Bias center (downtown Chicago)
const CHI_BIAS = { lat: 41.881832, lon: -87.623177 };

function clampLen(s, max) {
  const v = String(s ?? "").trim();
  return v.length > max ? v.slice(0, max) : v;
}

function cacheKey(from, to) {
  const raw = `${from}||${to}`.toLowerCase();
  const hash = crypto.createHash("sha1").update(raw).digest("hex");
  return `dash_commute_v3_${hash}`;
}

// Heuristic: If the user didn't include an obvious locality, assume Chicago.
function normalizeQueryToChicago(q) {
  const s = String(q || "").trim();
  if (!s) return s;

  const lower = s.toLowerCase();

  const hasChicago = lower.includes("chicago");
  const hasIL = /\bil\b/.test(lower) || lower.includes("illinois");
  const hasZip = /\b\d{5}(-\d{4})?\b/.test(lower);
  const hasComma = s.includes(",");
  const hasStateAbbrev =
    /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/i.test(
      s
    );

  if (hasChicago || hasIL || hasZip || (hasComma && hasStateAbbrev)) return s;
  return `${s}, Chicago, IL`;
}

async function searchOne(query) {
  const qs = new URLSearchParams({
    key: TOMTOM_KEY,
    limit: "5",
    countrySet: "US",
    language: "en-US",
    lat: String(CHI_BIAS.lat),
    lon: String(CHI_BIAS.lon)
  });

  const url = `https://api.tomtom.com/search/2/search/${encodeURIComponent(
    query
  )}.json?${qs.toString()}`;

  const data = await fetchJson(url, {}, 4500);

  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) throw new Error(`Search failed for "${query}"`);

  const r = results[0];

  const lat = Number(r?.position?.lat);
  const lon = Number(r?.position?.lon);
  const label =
    r?.address?.freeformAddress ||
    r?.poi?.name ||
    r?.address?.municipality ||
    query;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`Search failed for "${query}" (missing lat/lon)`);
  }

  return { label, lat, lon };
}

async function tomtomRoute(fromPos, toPos) {
  const loc = `${fromPos.lat},${fromPos.lon}:${toPos.lat},${toPos.lon}`;

  const qs = new URLSearchParams({
    key: TOMTOM_KEY,
    traffic: "true",
    computeTravelTimeFor: "all",
    routeRepresentation: "summaryOnly",
    routeType: "fastest"
  });

  const url = `https://api.tomtom.com/routing/1/calculateRoute/${encodeURIComponent(
    loc
  )}/json?${qs.toString()}`;

  const data = await fetchJson(url, {}, 4500);

  const s = data?.routes?.[0]?.summary;

  const travelSec = Number(s?.travelTimeInSeconds);
  const noTrafficSec = Number(s?.noTrafficTravelTimeInSeconds);
  const distanceM = Number(s?.lengthInMeters);

  if (!Number.isFinite(travelSec) || !Number.isFinite(noTrafficSec) || noTrafficSec <= 0) {
    throw new Error(
      "Routing response missing travelTimeInSeconds / noTrafficTravelTimeInSeconds"
    );
  }

  const delaySec = Math.max(0, travelSec - noTrafficSec);

  return {
    travel_time_sec: travelSec,
    traffic_delay_sec: delaySec,
    distance_m: Number.isFinite(distanceM) ? distanceM : null,
    ratio: travelSec / noTrafficSec
  };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") return sendError(req, res, 405, "Method not allowed");

  try {
    if (!TOMTOM_KEY) return sendError(req, res, 503, "Traffic data is not configured");

    const fromRaw = clampLen(req.query.from, 160);
    const toRaw = clampLen(req.query.to, 160);
    if (!fromRaw || !toRaw) {
      return sendError(req, res, 400, "Provide both from and to query parameters");
    }

    const key = cacheKey(fromRaw, toRaw);
    const cached = await cacheGet(key);
    const fresh = cached && ageInSeconds(cached) < TTL_SEC;

    if (cached && fresh) {
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
      return res.status(200).json(cached);
    }

    const fromQ = normalizeQueryToChicago(fromRaw);
    const toQ = normalizeQueryToChicago(toRaw);

    const [fromPos, toPos] = await Promise.all([searchOne(fromQ), searchOne(toQ)]);
    const route = await tomtomRoute(fromPos, toPos);

    const out = {
      updated_iso: new Date().toISOString(),
      from: fromPos,
      to: toPos,
      route
    };

    await cacheSet(key, out, 24 * 60 * 60);
    setCors(req, res);
    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
    return res.status(200).json(out);
  } catch (err) {
    console.error("commute api error:", err);
    return sendError(req, res, 502, err?.message || "Commute unavailable");
  }
}
