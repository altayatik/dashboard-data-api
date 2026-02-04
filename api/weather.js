const LAT = 41.8781;
const LON = -87.6298;
const TZ = "America/Chicago";

async function j(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0,200)}`);
  try { return JSON.parse(t); } catch { throw new Error(`Bad JSON: ${t.slice(0,200)}`); }
}

export default async function handler(req, res) {
  try {
    const qs = new URLSearchParams({
      latitude: String(LAT),
      longitude: String(LON),
      timezone: TZ,
      current: "temperature_2m,weather_code",
      daily: "weather_code,temperature_2m_max,temperature_2m_min",
      temperature_unit: "fahrenheit"
    });
    const d = await j(`https://api.open-meteo.com/v1/forecast?${qs.toString()}`);
    if (!d?.current || !d?.daily) throw new Error(`Bad weather: ${JSON.stringify(d).slice(0,200)}`);

    const now = new Date().toISOString();
    const weatherObj = { updated_iso: now, current: d.current, daily: d.daily };

    const banner = `// AUTO-GENERATED. DO NOT EDIT.\n`;
    const js = banner + `window.DASH_DATA = window.DASH_DATA || {}; window.DASH_DATA.weather = ${JSON.stringify(weatherObj)};`;

    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 's-maxage=900'); // Cache for 15 min
    res.send(js);
  } catch (err) {
    res.status(500).send(`// Error: ${err.message}`);
  }
}