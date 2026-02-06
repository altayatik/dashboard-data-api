// api/weather.js (UPDATED)
// - Adds ?city= support (geocoding via Open-Meteo)
// - Returns richer current + hourly while preserving the existing shape

const DEFAULT_LAT = 41.8781;
const DEFAULT_LON = -87.6298;
const DEFAULT_TZ  = "America/Chicago";

async function j(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0,200)}`);
  try { return JSON.parse(t); }
  catch { throw new Error(`Bad JSON: ${t.slice(0,200)}`); }
}

async function geocodeCity(name) {
  const qs = new URLSearchParams({
    name,
    count: "1",
    language: "en",
    format: "json"
  });
  const d = await j(`https://geocoding-api.open-meteo.com/v1/search?${qs.toString()}`);
  const r = d?.results?.[0];
  if (!r) return null;

  return {
    name: r.name,
    admin1: r.admin1,
    country: r.country,
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone || DEFAULT_TZ
  };
}

function clampStr(s, max = 80) {
  if (!s) return "";
  const v = String(s).trim();
  return v.length > max ? v.slice(0, max) : v;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const city = clampStr(url.searchParams.get("city") || "");
    const latQ = url.searchParams.get("lat");
    const lonQ = url.searchParams.get("lon");
    const tzQ  = clampStr(url.searchParams.get("tz") || "");

    let lat = DEFAULT_LAT;
    let lon = DEFAULT_LON;
    let tz  = DEFAULT_TZ;

    let locationLabel = "Default";

    // Priority:
    // 1) explicit lat/lon
    // 2) city geocode
    if (latQ && lonQ) {
      const latN = Number(latQ);
      const lonN = Number(lonQ);
      if (Number.isFinite(latN) && Number.isFinite(lonN)) {
        lat = latN;
        lon = lonN;
        tz = tzQ || DEFAULT_TZ;
        locationLabel = `(${lat.toFixed(4)}, ${lon.toFixed(4)})`;
      }
    } else if (city) {
      const g = await geocodeCity(city);
      if (!g) {
        res.status(400).send(`// Error: City not found: ${city}`);
        return;
      }
      lat = g.lat;
      lon = g.lon;
      tz = g.timezone || DEFAULT_TZ;
      locationLabel = [g.name, g.admin1, g.country].filter(Boolean).join(", ");
    }

    const qs = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      timezone: tz,

      // richer current
      current: [
        "temperature_2m",
        "apparent_temperature",
        "relative_humidity_2m",
        "precipitation",
        "weather_code",
        "wind_speed_10m",
        "wind_direction_10m",
        "pressure_msl"
      ].join(","),

      // keep daily for dashboard + detail
      daily: [
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
        "sunrise",
        "sunset"
      ].join(","),

      // add hourly for detail page (keep it lightweight)
      hourly: [
        "temperature_2m",
        "precipitation_probability",
        "weather_code",
        "wind_speed_10m"
      ].join(","),

      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
      precipitation_unit: "inch"
    });

    const d = await j(`https://api.open-meteo.com/v1/forecast?${qs.toString()}`);
    if (!d?.current || !d?.daily) throw new Error(`Bad weather: ${JSON.stringify(d).slice(0,200)}`);

    const now = new Date().toISOString();

    const weatherObj = {
      updated_iso: now,
      location: {
        label: locationLabel,
        lat,
        lon,
        timezone: tz,
        city: city || null
      },
      current: d.current,
      daily: d.daily,
      hourly: d.hourly || null
    };

    const banner = `// AUTO-GENERATED. DO NOT EDIT.\n`;
    const js = banner + `window.DASH_DATA = window.DASH_DATA || {}; window.DASH_DATA.weather = ${JSON.stringify(weatherObj)};`;

    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "s-maxage=900"); // 15 min
    res.send(js);

  } catch (err) {
    res.status(500).send(`// Error: ${err.message}`);
  }
}
