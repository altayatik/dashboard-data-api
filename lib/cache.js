import { fetchWithTimeout } from "./request.js";

function credentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function command(parts, timeoutMs) {
  const config = credentials();
  if (!config) return null;
  const response = await fetchWithTimeout(`${config.url}/${parts.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${config.token}` }
  }, timeoutMs);
  if (!response.ok) throw new Error(`Cache HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error);
  return payload?.result ?? null;
}

export async function cacheGet(key, timeoutMs = 700) {
  try {
    const result = await command(["get", key], timeoutMs);
    if (typeof result !== "string") return result;
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  } catch (error) {
    console.warn(`Cache read failed for ${key}:`, error?.message || error);
    return null;
  }
}

export async function cacheSet(key, value, ttlSeconds, timeoutMs = 700) {
  try {
    const parts = ["set", key, JSON.stringify(value)];
    if (ttlSeconds) parts.push("ex", String(ttlSeconds));
    if (await command(parts, timeoutMs) == null && !credentials()) return false;
    return true;
  } catch (error) {
    console.warn(`Cache write failed for ${key}:`, error?.message || error);
    return false;
  }
}

export function ageInSeconds(value) {
  const timestamp = Date.parse(value?.updated_iso || value?.cached_at || "");
  return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 1000) : Infinity;
}
