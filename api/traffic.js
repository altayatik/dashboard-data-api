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
const UPSTREAM_TIMEOUT_MS = 4500;
const TRAVEL_MIDWEST_QUICK_TRAFFIC_URL = "https://travelmidwest.com/lmiga/chicagoQuickTraffic.json";

async function withTimeout(promise, ms, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promise(controller.signal);
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`${label} timed out`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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

function isActiveReversibleRow(row) {
  return Number(row?.travelTime) > 0 || Number(row?.speed) > 0;
}

function normalizeReversibleStatus(row, direction) {
  if (!row) return null;
  return {
    direction,
    description: row.description || null,
    travel_time_min: Number(row.travelTime) > 0 ? Number(row.travelTime) : null,
    speed_mph: Number(row.speed) > 0 ? Number(row.speed) : null,
    active: isActiveReversibleRow(row)
  };
}

async function getKennedyReversibleLanes() {
  const resp = await withTimeout(
    (signal) => fetch(TRAVEL_MIDWEST_QUICK_TRAFFIC_URL, { signal }),
    UPSTREAM_TIMEOUT_MS,
    "Travel Midwest"
  );
  const data = await resp.json().catch(() => null);

  if (!resp.ok || !Array.isArray(data)) {
    throw new Error(`Travel Midwest HTTP ${resp.status}`);
  }

  const meta = data[0] || {};
  const reports = Array.isArray(data[1]) ? data[1] : [];
  const kennedy = reports.find((report) =>
    String(report?.caption || "").toLowerCase().includes("kennedy")
  );
  const rows = Array.isArray(kennedy?.rows) ? kennedy.rows : [];

  const inboundRow = rows.find((row) =>
    String(row?.description || "").toLowerCase().includes("inbound kennedy reversibles")
  );
  const outboundRow = rows.find((row) =>
    String(row?.description || "").toLowerCase().includes("outbound kennedy reversibles")
  );

  const inbound = normalizeReversibleStatus(inboundRow, "Inbound");
  const outbound = normalizeReversibleStatus(outboundRow, "Outbound");
  const active = [inbound, outbound].find((row) => row?.active);

  return {
    label: active?.direction || "Closed",
    direction: active?.direction?.toLowerCase() || "closed",
    source: "Travel Midwest",
    source_updated: meta.oldest || null,
    age_min: Number.isFinite(Number(meta.ageInMinutes)) ? Number(meta.ageInMinutes) : null,
    inbound,
    outbound
  };
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

  const resp = await withTimeout(
    (signal) => fetch(url, { signal }),
    UPSTREAM_TIMEOUT_MS,
    "TomTom"
  );
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

    let cached = null;
    try {
      cached = await kv.get(CACHE_KEY);
    } catch (err) {
      console.error("traffic cache read failed:", err);
    }
    const cachedAt = cached?.updated_iso ? Date.parse(cached.updated_iso) : 0;
    const cacheFresh = cachedAt && ((Date.now() - cachedAt) / 1000) < SNAP_TTL_SEC;

    if (cached && cacheFresh) {
      return sendEmbedded(res, cached);
    }

    const routes = getRoutes();
    let reversibleLanes = null;
    try {
      reversibleLanes = await getKennedyReversibleLanes();
    } catch (err) {
      console.error("Kennedy reversible lanes failed:", err);
      reversibleLanes = cached?.routes?.find((rt) => rt.id === "I90_94")?.reversible_lanes || {
        label: "Unknown",
        direction: "unknown",
        source: "Travel Midwest",
        error: err?.message || "Unknown error"
      };
    }

    const results = await Promise.all(
      routes.slice(0, 3).map(async (rt) => {
        const m = await tomtomRoute(rt.origin, rt.destination);
        return {
          id: rt.id,
          label: rt.label,
          status: statusFromRatio(m.ratio),
          delay_min: m.delay_min,
          ...(rt.id === "I90_94" && reversibleLanes ? { reversible_lanes: reversibleLanes } : {})
        };
      })
    );

    const out = { updated_iso: new Date().toISOString(), routes: results };
    kv.set(CACHE_KEY, out).catch(() => {});
    return sendEmbedded(res, out);

  } catch (err) {
    console.error("traffic api error:", err);
    try {
      const stale = await kv.get(CACHE_KEY);
      if (stale) {
        return sendEmbedded(res, {
          ...stale,
          stale: true,
          error: err?.message || "Unknown error"
        });
      }
    } catch {}

    return sendEmbedded(res, {
      updated_iso: new Date().toISOString(),
      stale: true,
      error: err?.message || "Unknown error",
      routes: []
    });
  }
}
