// api/commute.js
// JSON endpoint: /api/commute?from=...&to=...
// Uses TomTom Geocoding (Search API) + TomTom Routing (traffic=true)
// Caches per (from,to) pair in Vercel KV.
//
// IMPORTANT: Bias geocoding to Chicago to avoid wrong matches (e.g. Bethalto, IL).

import { createClient } from "@vercel/kv";
import crypto from "crypto";

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const TOMTOM_KEY = process.env.TOMTOM_API_KEY || process.env.TOMTOM_KEY;
const TTL_SEC = 300; // 5 minutes

// Default geocode bias (Chicago)
const CHI_BIAS = {
  lat: 41.881832,
  lon: -87.623177
};

// Rough Chicagoland bounding box (top-left, bottom-right)
// topLeft: (lat,lon) is NW corner
// btmRight: (lat,lon) is SE corner
const CHI_BBOX = {
  topLeft: { lat: 42.50, lon: -88.60 },
  btmRight: { lat: 41.30, lon: -87.10 }
};

function badRequest(res, msg) {
  res.status(400).json({ error: msg });
}

function serverError(res, msg) {
  res.status(500).json({ error: msg });
}

function clampLen(s, max) {
  const v = String(s ?? "").trim();
  return v.length > max ? v.slice(0, max) : v;
}

function cacheKey(from, to) {
  const raw = `${from}||${to}`.toLowerCase();
  const hash = crypto.createHash("sha1").update(raw).digest("hex");
  return `dash_commute_v2_${hash}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseOptionalBias(req) {
  // Optional: allow ?bias_lat=...&bias_lon=... or ?bbox=topLat,topLon,btmLat,btmLon
  const biasLat = num(req.query.bias_lat);
  const biasLon = num(req.query.bias_lon);

  let bias = { ...CHI_BIAS };
  if (biasLat != null && biasLon != null) {
    bias = { lat: biasLat, lon: biasLon };
  }

  let bbox = { ...CHI_BBOX };
  const bboxRaw = String(req.query.bbox ?? "").trim();
  if (bboxRaw) {
    const parts = bboxRaw.split(",").map(x => Number(x));
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      bbox = {
        topLeft: { lat: parts[0], lon: parts[1] },
        btmRight: { lat: parts[2], lon: parts[3] }
      };
    }
  }

  return { bias, bbox };
}

async function geocodeOne(query, bias, bbox) {
  // TomTom Geocoding API:
  // https://api.tomtom.com/search/2/geocode/{query}.json
  //
  // We bias towards Chicago:
  // - lat/lon: location bias
  // - topLeft/btmRight: bounding box
  //
  // NOTE: Parameter names differ across TomTom endpoints; on geocode this is supported.
  const qs = new URLSearchParams({
    key: TOMTOM_KEY,
    limit: "5",
    countrySet: "US",
    lat: String(bias.lat),
    lon: String(bias.lon),
    topLeft: `${bbox.topLeft.lat},${bbox.topLeft.lon}`,
    btmRight: `${bbox.btmRight.lat},${bbox.btmRight.lon}`
  });

  const url = `https://api.tomtom.com/search/2/geocode/${encodeURIComponent(query)}.json?${qs.toString()}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`TomTom geocode HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 250)}`);
  }

  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) throw new Error(`Geocode failed for "${query}"`);

  // Choose best result near the bias point (TomTom often sorts well already, but we'll be safe)
  // Use "score" if available; otherwise fallback to first.
  // Many TomTom responses include "score" (higher = better).
  let best = results[0];
  let bestScore = Number(best?.score ?? -Infinity);

  for (const r of results) {
    const s = Number(r?.score ?? -Infinity);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }

  const lat = Number(best?.position?.lat);
  const lon = Number(best?.position?.lon);
  const label =
    best?.address?.freeformAddress ||
    best?.address?.municipality ||
    query;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`Geocode failed for "${query}"`);
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

  const url = `https://api.tomtom.com/routing/1/calculateRoute/${encodeURIComponent(loc)}/json?${qs.toString()}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`TomTom routing HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 250)}`);
  }

  const s = data?.routes?.[0]?.summary;

  const travelSec = Number(s?.travelTimeInSeconds);
  const noTrafficSec = Number(s?.noTrafficTravelTimeInSeconds);
  const distanceM = Number(s?.lengthInMeters);

  if (!Number.isFinite(travelSec) || !Number.isFinite(noTrafficSec) || noTrafficSec <= 0) {
    throw new Error("Routing response missing travelTimeInSeconds / noTrafficTravelTimeInSeconds");
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
  try {
    if (!TOMTOM_KEY) return serverError(res, "Missing TOMTOM_API_KEY (or TOMTOM_KEY)");
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return serverError(res, "Missing KV_REST_API_URL / KV_REST_API_TOKEN");
    }

    const fromRaw = clampLen(req.query.from, 160);
    const toRaw = clampLen(req.query.to, 160);

    if (!fromRaw || !toRaw) {
      return badRequest(res, 'Provide query params: ?from="..."&to="..."');
    }

    const key = cacheKey(fromRaw, toRaw);
    const cached = await kv.get(key);

    const cachedAt = cached?.updated_iso ? Date.parse(cached.updated_iso) : 0;
    const fresh = cachedAt && ((Date.now() - cachedAt) / 1000) < TTL_SEC;

    if (cached && fresh) {
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
      return res.status(200).json(cached);
    }

    const { bias, bbox } = parseOptionalBias(req);

    const [fromPos, toPos] = await Promise.all([
      geocodeOne(fromRaw, bias, bbox),
      geocodeOne(toRaw, bias, bbox)
    ]);

    const route = await tomtomRoute(fromPos, toPos);

    const out = {
      updated_iso: new Date().toISOString(),
      from: fromPos,
      to: toPos,
      route
    };

    kv.set(key, out).catch(() => {});

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
    return res.status(200).json(out);

  } catch (err) {
    console.error("commute api error:", err);
    return serverError(res, err?.message || "Unknown error");
  }
}
