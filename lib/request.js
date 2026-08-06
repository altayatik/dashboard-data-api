export async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Timed out fetching ${new URL(url).hostname}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, options = {}, timeoutMs = 4500) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await response.text();
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}: ${text.slice(0, 180)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Upstream returned invalid JSON: ${text.slice(0, 120)}`);
  }
}

export async function fetchText(url, options = {}, timeoutMs = 4500) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await response.text();
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}: ${text.slice(0, 180)}`);
  return text;
}

export async function withDeadline(promise, timeoutMs, label = "Operation") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
