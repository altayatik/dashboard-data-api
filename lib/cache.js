import { Redis } from "@upstash/redis";
import { withDeadline } from "./request.js";

let client;

function getClient() {
  if (client !== undefined) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

export async function cacheGet(key, timeoutMs = 700) {
  const kv = getClient();
  if (!kv) return null;
  try {
    return await withDeadline(kv.get(key), timeoutMs, "Cache read");
  } catch (error) {
    console.warn(`Cache read failed for ${key}:`, error?.message || error);
    return null;
  }
}

export async function cacheSet(key, value, ttlSeconds, timeoutMs = 700) {
  const kv = getClient();
  if (!kv) return false;
  try {
    await withDeadline(
      ttlSeconds ? kv.set(key, value, { ex: ttlSeconds }) : kv.set(key, value),
      timeoutMs,
      "Cache write"
    );
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
