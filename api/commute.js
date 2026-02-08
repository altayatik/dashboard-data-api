// api/commute.js
// JSON endpoint: /api/commute?from=...&to=...
// Uses TomTom Geocoding (Search API) + TomTom Routing (traffic=true)
// Caches per (from,to) pair in Vercel KV.

import { createClient } from "@vercel/kv";
import crypto from "crypto";

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const TOMTOM_KEY = process.env.TOMTOM_API_KEY || process.env.TOMTOM_KEY;
const TTL_SEC = 300; // 5 minutes

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
  // Stable + safe key length for KV
  const raw = `${from}||${to}`.toLowerCase();
  const hash = crypto.createHash("sha1").update(raw).digest("hex");
  return `dash_commute_v1_${hash}`;
}

async function geocodeOne(query) {
  // TomTom Geocoding API:
  // https://api.tomtom.com/search/2/geocode/{query}.json?key=...
  const qs = new URLSearchParams({
    key: TOMTOM_KEY,
    limit: "1",
    countrySet: "US"
  });

  const url = `https://api.tomtom.com/search/2/geocode/${encodeURIComponent(query)}.json?${qs.toString()}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`TomTom geocode HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 250)}`);
  }

  const r = data?.results?.[0];
  const lat = Number(r?.position?.lat);
  const lon = Number(r?.position?.lon);
  const label = r?.address?.freeformAddress || r?.address?.municipality || query;

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

    // Geocode in parallel
    const [fromPos, toPos] = await Promise.all([
      geocodeOne(fromRaw),
      geocodeOne(toRaw)
    ]);

    const route = await tomtomRoute(fromPos, toPos);

    const out = {
      updated_iso: new Date().toISOString(),
      from: fromPos,
      to: toPos,
      route
    };

    // Best-effort cache (KV doesn't enforce TTL server-side via REST in all clients;
    // we still include updated_iso freshness check above.)
    kv.set(key, out).catch(() => {});

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
    return res.status(200).json(out);

  } catch (err) {
    console.error("commute api error:", err);
    return serverError(res, err?.message || "Unknown error");
  }
}
