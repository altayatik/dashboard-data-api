const KEY = process.env.TWELVEDATA_API_KEY;
if (!KEY) throw new Error("Missing TWELVEDATA_API_KEY");

async function j(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0,200)}`);
  try { return JSON.parse(t); } catch { throw new Error(`Bad JSON: ${t.slice(0,200)}`); }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function quote(sym) {
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(KEY)}`;
  const d = await j(url);
  if (d?.status === "error" || (d?.code && d?.message)) throw new Error(`TwelveData ${sym}: ${d.message}`);
  const p = num(d.close ?? d.price);
  if (p == null) throw new Error(`Bad price for ${sym}: ${JSON.stringify(d).slice(0,200)}`);
  return { price: p, change: num(d.change), percent_change: num(d.percent_change) };
}

export default async function handler(req, res) {
  try {
    const [spy, iau] = await Promise.all([quote("SPY"), quote("IAU")]);
    const now = new Date().toISOString();
    const marketsObj = { updated_iso: now, symbols: { SPY: spy, IAU: iau } };

    const banner = `// AUTO-GENERATED. DO NOT EDIT.\n`;
    const js = banner + `window.DASH_DATA = window.DASH_DATA || {}; window.DASH_DATA.markets = ${JSON.stringify(marketsObj)};`;

    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 's-maxage=900'); // Cache for 15 min at edge (adjust as needed)
    res.send(js);
  } catch (err) {
    res.status(500).send(`// Error: ${err.message}`);
  }
}