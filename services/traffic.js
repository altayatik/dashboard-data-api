import { cacheGet, cacheSet, ageInSeconds } from "../lib/cache.js";
import { fetchJson } from "../lib/request.js";

const CACHE_KEY = "altay-dashboard:traffic:v3";
const LEGACY_CACHE_KEY = "dash_traffic_snapshot_v1";
const CACHE_TTL_SECONDS = 5 * 60;
const TRAVEL_MIDWEST_URL = "https://travelmidwest.com/lmiga/chicagoQuickTraffic.json";
const ROUTES = [
  { id: "I90_94", label: "I-90/94", report: "kennedy", phrase: "inbound kennedy from o'hare to i-290", origin: [41.971, -87.761], destination: [41.883, -87.632] },
  { id: "I290", label: "I-290", report: "eisenhower", phrase: "inbound i-290 from thorndale", origin: [41.886, -87.798], destination: [41.883, -87.632] },
  { id: "I55", label: "I-55", report: "stevenson", phrase: "inbound stevenson from i-355", origin: [41.705, -87.681], destination: [41.883, -87.632] }
];

function trafficLevel(ratio) {
  if (ratio < 1.2) return "Light";
  if (ratio < 1.5) return "Medium";
  if (ratio < 2) return "Heavy";
  return "Severe";
}

function speedLevel(speed) {
  if (speed >= 45) return "Light";
  if (speed >= 30) return "Medium";
  if (speed >= 20) return "Heavy";
  return "Severe";
}

async function routeSignal(route, key) {
  const locations = `${route.origin.join(",")}:${route.destination.join(",")}`;
  const params = new URLSearchParams({
    key,
    traffic: "true",
    computeTravelTimeFor: "all",
    routeRepresentation: "summaryOnly",
    routeType: "fastest"
  });
  const data = await fetchJson(
    `https://api.tomtom.com/routing/1/calculateRoute/${encodeURIComponent(locations)}/json?${params}`,
    {},
    4300
  );
  const summary = data?.routes?.[0]?.summary;
  const travel = Number(summary?.travelTimeInSeconds);
  const baseline = Number(summary?.noTrafficTravelTimeInSeconds);
  if (!Number.isFinite(travel) || !Number.isFinite(baseline) || baseline <= 0) {
    throw new Error(`Traffic response incomplete for ${route.label}`);
  }
  const ratio = travel / baseline;
  return {
    id: route.id,
    label: route.label,
    status: trafficLevel(ratio),
    ratio,
    delay_min: Math.max(0, Math.round((travel - baseline) / 60))
  };
}

function laneRow(rows, phrase, direction) {
  const row = rows.find((item) => String(item?.description || "").toLowerCase().includes(phrase));
  const active = Number(row?.travelTime) > 0 || Number(row?.speed) > 0;
  return row ? {
    direction,
    active,
    description: row.description || null,
    travel_time_min: Number(row.travelTime) || null,
    speed_mph: Number(row.speed) || null
  } : null;
}

function travelMidwestRoute(data, route) {
  const reports = Array.isArray(data?.[1]) ? data[1] : [];
  const report = reports.find((item) => String(item?.caption || "").toLowerCase().includes(route.report));
  const row = report?.rows?.find((item) => String(item?.description || "").toLowerCase().includes(route.phrase));
  const travel = Number(row?.travelTime);
  const speed = Number(row?.speed);
  if (!row || !Number.isFinite(travel) || !Number.isFinite(speed)) return null;
  return {
    id: route.id,
    label: route.label,
    status: speedLevel(speed),
    travel_time_min: Math.abs(travel),
    speed_mph: speed,
    delay_min: null
  };
}

function reversibleSignal(data) {
  if (!Array.isArray(data)) throw new Error("Travel Midwest response incomplete");
  const reports = Array.isArray(data[1]) ? data[1] : [];
  const kennedy = reports.find((report) => String(report?.caption || "").toLowerCase().includes("kennedy"));
  const rows = Array.isArray(kennedy?.rows) ? kennedy.rows : [];
  const inbound = laneRow(rows, "inbound kennedy reversibles", "Inbound");
  const outbound = laneRow(rows, "outbound kennedy reversibles", "Outbound");
  const active = [inbound, outbound].find((row) => row?.active);
  return {
    label: active?.direction || "Closed",
    direction: active?.direction?.toLowerCase() || "closed",
    source: "Travel Midwest",
    inbound,
    outbound
  };
}

export async function getTraffic(query = {}) {
  const [currentCache, legacyCache] = await Promise.all([
    cacheGet(CACHE_KEY),
    cacheGet(LEGACY_CACHE_KEY)
  ]);
  const cached = currentCache || legacyCache;
  if (cached && ageInSeconds(cached) < CACHE_TTL_SECONDS && query.fresh !== "1") return cached;
  const key = process.env.TOMTOM_API_KEY || process.env.TOMTOM_KEY;

  try {
    const travelMidwest = await fetchJson(TRAVEL_MIDWEST_URL, {}, 5000);
    const laneResult = reversibleSignal(travelMidwest);
    const routeResults = key
      ? await Promise.allSettled(ROUTES.map((route) => routeSignal(route, key)))
      : ROUTES.map((route) => ({ status: "fulfilled", value: travelMidwestRoute(travelMidwest, route) }));
    const routes = routeResults.map((result, index) => {
      if (result.status === "fulfilled" && result.value) return result.value;
      const publicRoute = travelMidwestRoute(travelMidwest, ROUTES[index]);
      if (publicRoute) return publicRoute;
      return cached?.routes?.find((route) => route.id === ROUTES[index].id) || null;
    }).filter(Boolean);
    if (!routes.length) throw new Error("No traffic routes available");
    const reversible = laneResult || cached?.routes?.find((route) => route.id === "I90_94")?.reversible_lanes || null;
    const payload = {
      updated_iso: new Date().toISOString(),
      source: key ? "TomTom + Travel Midwest" : "Travel Midwest",
      partial: routes.length !== ROUTES.length || !laneResult,
      routes: routes.map((route) => route.id === "I90_94" ? { ...route, reversible_lanes: reversible } : route)
    };
    await cacheSet(CACHE_KEY, payload, 24 * 60 * 60);
    return payload;
  } catch (error) {
    if (cached) return { ...cached, stale: true, error: error.message };
    throw error;
  }
}
