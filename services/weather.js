import { cacheGet, cacheSet, ageInSeconds } from "../lib/cache.js";
import { fetchJson } from "../lib/request.js";

const DEFAULT_LOCATION = {
  label: "Chicago, IL",
  lat: 41.8781,
  lon: -87.6298,
  timezone: "America/Chicago"
};
const CACHE_TTL_SECONDS = 10 * 60;

function clean(value, max = 80) {
  return String(value || "").trim().slice(0, max);
}

function validCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

async function geocode(city) {
  const params = new URLSearchParams({
    name: city,
    count: "1",
    language: "en",
    format: "json"
  });
  const data = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?${params}`, {}, 3500);
  const result = data?.results?.[0];
  if (!result) throw new Error(`City not found: ${city}`);
  return {
    label: [result.name, result.admin1, result.country].filter(Boolean).join(", "),
    lat: result.latitude,
    lon: result.longitude,
    timezone: result.timezone || DEFAULT_LOCATION.timezone
  };
}

function trimHourly(hourly, currentTime, count = 24) {
  if (!Array.isArray(hourly?.time)) return hourly || null;
  const start = Math.max(0, hourly.time.findIndex((time) => time >= currentTime));
  return Object.fromEntries(Object.entries(hourly).map(([key, value]) => [
    key,
    Array.isArray(value) ? value.slice(start, start + count) : value
  ]));
}

export async function getWeather(query = {}) {
  const city = clean(query.city);
  const lat = validCoordinate(query.lat, -90, 90);
  const lon = validCoordinate(query.lon, -180, 180);
  const timezone = clean(query.tz) || DEFAULT_LOCATION.timezone;
  const cacheKey = `altay-dashboard:weather:${city || `${lat ?? DEFAULT_LOCATION.lat},${lon ?? DEFAULT_LOCATION.lon}`}`;
  const cached = await cacheGet(cacheKey);

  if (cached && ageInSeconds(cached) < CACHE_TTL_SECONDS && query.fresh !== "1") {
    return cached;
  }

  let location = DEFAULT_LOCATION;
  if (lat != null && lon != null) {
    location = { label: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon, timezone };
  } else if (city) {
    location = await geocode(city);
  }

  const params = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    timezone: location.timezone,
    current: [
      "temperature_2m", "apparent_temperature", "relative_humidity_2m",
      "precipitation", "weather_code", "wind_speed_10m",
      "wind_direction_10m", "pressure_msl", "is_day"
    ].join(","),
    hourly: [
      "temperature_2m", "precipitation_probability", "weather_code", "wind_speed_10m"
    ].join(","),
    daily: [
      "weather_code", "temperature_2m_max", "temperature_2m_min",
      "precipitation_probability_max", "sunrise", "sunset"
    ].join(","),
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    forecast_days: "7"
  });

  try {
    const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`, {}, 5000);
    if (!data?.current || !data?.daily) throw new Error("Weather response was incomplete");
    const payload = {
      updated_iso: new Date().toISOString(),
      source: "Open-Meteo",
      location,
      current: data.current,
      hourly: trimHourly(data.hourly, data.current.time),
      daily: data.daily
    };
    await cacheSet(cacheKey, payload, 24 * 60 * 60);
    return payload;
  } catch (error) {
    if (cached) return { ...cached, stale: true, error: error.message };
    throw error;
  }
}
