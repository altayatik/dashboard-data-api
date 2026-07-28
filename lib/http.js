export function setCors(req, res) {
  const allowedOrigin = process.env.DASHBOARD_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
  res.setHeader("Vary", "Origin, Accept");
}

export function handleOptions(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

function requestUrl(req) {
  return new URL(req.url || "/", "http://dashboard.local");
}

export function wantsScript(req) {
  const url = requestUrl(req);
  if (url.searchParams.get("format") === "script") return true;
  if (url.searchParams.get("format") === "json") return false;
  return !String(req.headers?.accept || "").includes("application/json");
}

export function sendData(req, res, key, value, cacheControl = "s-maxage=120, stale-while-revalidate=600") {
  setCors(req, res);
  res.setHeader("Cache-Control", cacheControl);
  if (wantsScript(req)) {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    return res.status(200).send(
      `window.DASH_DATA=window.DASH_DATA||{};window.DASH_DATA.${key}=${JSON.stringify(value)};`
    );
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json(value);
}

export function sendError(req, res, status, message, extra = {}) {
  setCors(req, res);
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({
    error: message,
    ...extra,
    timestamp: new Date().toISOString()
  });
}
