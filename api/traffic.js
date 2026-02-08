// api/traffic.js
// Embedded JS endpoint: sets window.DASH_DATA.traffic
// Uses TomTom Routing API (traffic-aware travel time) + Vercel KV cache.
// Adds CORS headers (harmless for <script> usage, helpful if you ever fetch it).

import { createClient } from "@vercel/kv";

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const TOMTOM_KEY = process.env.TOMTOM_API_KEY || process.env.TOMTOM_KEY;

const CACHE_KEY = "dash_traffic_snapshot_v1";
const SNAP_TTL_SEC = 300;

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Vary", "Origin");
}

function statusFromRatio(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return "Light";
  if (ratio < 1.20) return "Light";
  if (ratio < 1.50) return "Medium";
  if (ratio < 2.00) return "Heavy";
  return "Severe";
}

function getRoutes() {
  const raw = process.env.TRAFFIC_ROUTES_JSON;

  if (raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("TRAFFIC_ROUTES_JSON must be a non-empty JSON array");
    }
    return parsed;
  }

  return [
    { id: "I90_94", label: "I-90/94", origin: [41.971, -87.761], destination: [41.883, -87.632] },
    { id: "I290",   label: "I-290",   origin: [41.886, -87.798], destination: [41.883, -87.632] },
    { id: "I55",    label: "I-55",    origin: [41.705, -87.681], destination: [41.883, -87.632] }
  ];
}

async function tomtomRoute(origin, destination) {
  const loc = `${origin[0]},${origin[1]}:${destination[0]},${destination[1]}`;

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
    throw new Error(`TomTom HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 250)}`);
  }

  const s = data?.routes?.[0]?.summary;
  const trafficSec = Number(s?.travelTimeInSeconds);
  const noTrafficSec = Number(s?.noTrafficTravelTimeInSeconds);

  if (!Number.isFinite(trafficSec) || !Number.isFinite(noTrafficSec) || noTrafficSec <= 0) {
    throw new Error("TomTom response missing travelTimeInSeconds / noTrafficTravelTimeInSeconds");
  }

  const ratio = trafficSec / noTrafficSec;
  const delayMin = Math.max(0, Math.round((trafficSec - noTrafficSec) / 60));

  return { ratio, delay_min: delayMin };
}

function sendEmbedded(res, obj) {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  res.send(`window.DASH_DATA=window.DASH_DATA||{};window.DASH_DATA.traffic=${JSON.stringify(obj)};`);
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    if (!TOMTOM_KEY) {
      return res.status(500).send("// Error: Missing TOMTOM_API_KEY (or TOMTOM_KEY) env var");
    }
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return res.status(500).send("// Error: Missing KV_REST_API_URL / KV_REST_API_TOKEN env vars");
    }

    const cached = await kv.get(CACHE_KEY);
    const cachedAt = cached?.updated_iso ? Date.parse(cached.updated_iso) : 0;
    const cacheFresh = cachedAt && ((Date.now() - cachedAt) / 1000) < SNAP_TTL_SEC;

    if (cached && cacheFresh) {
      return sendEmbedded(res, cached);
    }

    const routes = getRoutes();

    const results = await Promise.all(
      routes.slice(0, 3).map(async (rt) => {
        const m = await tomtomRoute(rt.origin, rt.destination);
        return {
          id: rt.id,
          label: rt.label,
          status: statusFromRatio(m.ratio),
          delay_min: m.delay_min
        };
      })
    );

    const out = { updated_iso: new Date().toISOString(), routes: results };
    kv.set(CACHE_KEY, out).catch(() => {});
    return sendEmbedded(res, out);

  } catch (err) {
    console.error("traffic api error:", err);
    res.status(500).send(`// Error: ${err?.message || "Unknown error"}`);
  }
}
