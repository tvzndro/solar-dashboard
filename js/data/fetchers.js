// Network fetchers. Each returns data normalised to internal units:
//   instants: { t, temp, rh, wind, gust, dir, cloud }         (°C, %, m/s, m/s, deg, %)
//   precip:   { from, to, amount, max?, snow? }              (mm water; snow in cm if the source gives it)
//   nowcast:  { t, rate, snow? }                              (mm/h, interval starting at t)
//   kp:       { from, to, kp, kind: 'observed'|'predicted'|'outlook27' }
//
// NOTE (Firefox): never set custom headers (e.g. User-Agent) on api.met.no
// requests. Firefox would then send a CORS preflight, which MET answers without
// Access-Control-Allow-* headers, and the request is blocked. Plain fetch(url) only.

import { HOUR, MIN } from '../time.js';

const coord = (v) => Math.round(v * 10000) / 10000; // MET wants ≤ 4 decimals

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function metUrl(lat, lon) {
  return `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${coord(lat)}&lon=${coord(lon)}`;
}

export async function fetchMet(lat, lon, signal) {
  const url = metUrl(lat, lon);
  const json = await getJson(url, signal);
  const instants = [], precip = [];
  let hourlyEnd = null;
  for (const ts of json.properties.timeseries) {
    const t = Date.parse(ts.time);
    const d = ts.data.instant.details;
    instants.push({
      t, temp: d.air_temperature, rh: d.relative_humidity, wind: d.wind_speed,
      gust: d.wind_speed_of_gust ?? null, dir: d.wind_from_direction, cloud: d.cloud_area_fraction,
      hourly: !!ts.data.next_1_hours,
    });
    const n1 = ts.data.next_1_hours?.details, n6 = ts.data.next_6_hours?.details;
    if (n1) {
      precip.push({ from: t, to: t + HOUR, amount: n1.precipitation_amount ?? 0, max: n1.precipitation_amount_max ?? null, hourly: true });
      hourlyEnd = t;
    } else if (n6) {
      precip.push({ from: t, to: t + 6 * HOUR, amount: n6.precipitation_amount ?? 0, max: n6.precipitation_amount_max ?? null, hourly: false });
    }
  }
  return { url, instants, precip, start: instants[0]?.t ?? null, hourlyEnd, updatedAt: Date.parse(json.properties.meta.updated_at) };
}

export function nowcastUrl(lat, lon) {
  return `https://api.met.no/weatherapi/nowcast/2.0/complete?lat=${coord(lat)}&lon=${coord(lon)}`;
}

export async function fetchNowcast(lat, lon, signal) {
  const url = nowcastUrl(lat, lon);
  const json = await getJson(url, signal);
  if (json.properties.meta.radar_coverage && json.properties.meta.radar_coverage !== 'ok') {
    throw new Error(`radar coverage: ${json.properties.meta.radar_coverage}`);
  }
  const series = json.properties.timeseries;
  const temp = series[0]?.data.instant.details.air_temperature ?? null;
  const steps = series.map((ts) => ({ t: Date.parse(ts.time), rate: ts.data.instant.details.precipitation_rate ?? 0 }));
  return { url, temp, steps, stepMs: 5 * MIN };
}

export function openMeteoUrl(lat, lon) {
  const hourly = 'temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,snowfall';
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${hourly}`
    + '&minutely_15=precipitation,snowfall&forecast_minutely_15=12&past_minutely_15=1'
    + '&past_days=3&forecast_days=12&timezone=auto&timeformat=unixtime&wind_speed_unit=ms';
}

export async function fetchOpenMeteo(lat, lon, signal) {
  const url = openMeteoUrl(lat, lon);
  const json = await getJson(url, signal);
  const h = json.hourly;
  const instants = [], precip = [];
  for (let i = 0; i < h.time.length; i++) {
    const t = h.time[i] * 1000;
    if (h.temperature_2m[i] == null) continue;
    instants.push({
      t, temp: h.temperature_2m[i], rh: h.relative_humidity_2m[i], wind: h.wind_speed_10m[i],
      gust: h.wind_gusts_10m[i], dir: h.wind_direction_10m[i], cloud: h.cloud_cover[i],
    });
    // Open-Meteo hourly precipitation is the sum over the *preceding* hour.
    if (h.precipitation[i] != null) precip.push({ from: t - HOUR, to: t, amount: h.precipitation[i], snow: h.snowfall[i] ?? null });
  }
  let nowcast = null;
  const m = json.minutely_15;
  if (m?.time?.length) {
    nowcast = {
      url, temp: null, stepMs: 15 * MIN,
      // Also "preceding 15 minutes": shift to interval start, convert to mm/h.
      steps: m.time.map((tt, i) => ({ t: tt * 1000 - 15 * MIN, rate: (m.precipitation[i] ?? 0) * 4, snow: (m.snowfall[i] ?? 0) > 0 })),
    };
  }
  return { url, instants, precip, nowcast, timezone: json.timezone };
}

export const KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';
export const KP27_URL = 'https://services.swpc.noaa.gov/text/27-day-outlook.txt';

const utc = (s) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');

export async function fetchKp(signal) {
  const json = await getJson(KP_URL, signal);
  // Format has been both an array of objects and a header row + arrays; accept either.
  let rows = json;
  if (Array.isArray(json[0])) {
    const [head, ...rest] = json;
    rows = rest.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
  }
  const blocks = rows.map((r) => {
    const from = utc(r.time_tag);
    const kind = r.observed === 'observed' || r.observed === 'estimated' ? 'observed' : 'predicted';
    return { from, to: from + 3 * HOUR, kp: Number(r.kp), kind };
  }).filter((b) => Number.isFinite(b.kp) && Number.isFinite(b.from));
  return { url: KP_URL, blocks };
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

export async function fetchKp27(signal) {
  const res = await fetch(KP27_URL, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const blocks = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d{4})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+\d+\s+\d+\s+(\d+)/);
    if (!m) continue;
    const from = Date.UTC(+m[1], MONTHS[m[2]], +m[3]);
    blocks.push({ from, to: from + 24 * HOUR, kp: +m[4], kind: 'outlook27' });
  }
  return { url: KP27_URL, blocks };
}

export async function geocode(query, lang, signal) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=${lang}&format=json`;
  const json = await getJson(url, signal);
  return (json.results || []).map((r) => ({
    name: r.name, lat: r.latitude, lon: r.longitude, timezone: r.timezone,
    detail: [r.admin1, r.country].filter(Boolean).join(', '),
  }));
}

// ── Tides ────────────────────────────────────────────────────────────────
// Norwegian coast: Kartverket (official; observations, astronomical prediction,
// and weather-adjusted forecast, plus high/low table). Elsewhere: Open-Meteo
// Marine sea level (model, hourly). Levels are cm relative to mean sea level.

const fmtUtc = (ms) => new Date(ms).toISOString().slice(0, 16);

export function kartverketUrl(lat, lon, from, to, datatype) {
  return `https://vannstand.kartverket.no/tideapi.php?tide_request=locationdata&lat=${coord(lat)}&lon=${coord(lon)}`
    + `&fromtime=${fmtUtc(from)}&totime=${fmtUtc(to)}&datatype=${datatype}&refcode=msl&lang=en&interval=10&dst=0&tzone=0`;
}

async function getXml(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new DOMParser().parseFromString(await res.text(), 'text/xml');
}

export async function fetchKartverket(lat, lon, signal, now = Date.now()) {
  const from = now - 3 * 24 * HOUR, to = now + 11 * 24 * HOUR;
  const url = kartverketUrl(lat, lon, from, to, 'all');
  const [doc, tab] = await Promise.all([
    getXml(url, signal),
    getXml(kartverketUrl(lat, lon, from, to, 'tab'), signal),
  ]);
  const nodata = doc.querySelector('nodata');
  if (nodata) return { url, none: nodata.getAttribute('info') || 'no data' };
  const series = (type) => [...doc.querySelectorAll(`data[type="${type}"] waterlevel`)]
    .map((w) => ({ t: Date.parse(w.getAttribute('time')), level: +w.getAttribute('value') }));
  const pred = series('prediction'), obs = series('observation'), fc = series('forecast');
  const byT = (arr) => new Map(arr.map((p) => [p.t, p.level]));
  const obsM = byT(obs), fcM = byT(fc);
  // Actual water level: observation where measured, weather-adjusted forecast where available, else astronomical tide.
  const points = pred.map((p) => {
    if (obsM.has(p.t)) return { t: p.t, level: obsM.get(p.t), tide: p.level, kind: 'observed' };
    if (fcM.has(p.t)) return { t: p.t, level: fcM.get(p.t), tide: p.level, kind: 'forecast' };
    return { t: p.t, level: p.level, tide: p.level, kind: 'prediction' };
  });
  const extremes = [...tab.querySelectorAll('waterlevel')].map((w) => ({
    t: Date.parse(w.getAttribute('time')), level: +w.getAttribute('value'), type: w.getAttribute('flag'),
  }));
  const station = doc.querySelector('location')?.getAttribute('name') || null;
  return { url, station, points, extremes };
}

export function marineUrl(lat, lon) {
  return `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}`
    + '&hourly=sea_level_height_msl&past_days=3&forecast_days=11&timeformat=unixtime&cell_selection=sea';
}

export async function fetchMarine(lat, lon, signal) {
  const url = marineUrl(lat, lon);
  const json = await getJson(url, signal);
  const h = json.hourly || {};
  const points = (h.time || []).map((tt, i) => ({ t: tt * 1000, level: h.sea_level_height_msl[i] == null ? null : h.sea_level_height_msl[i] * 100 }))
    .filter((p) => p.level != null).map((p) => ({ ...p, tide: p.level, kind: 'model' }));
  if (points.length < 24) return { url, none: 'no sea level data here' };
  // High/low: local extrema refined with a parabola through the neighbours.
  const extremes = [];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1].level, b = points[i].level, c = points[i + 1].level;
    const isHigh = b > a && b >= c, isLow = b < a && b <= c;
    if (!isHigh && !isLow) continue;
    const denom = a - 2 * b + c;
    const off = denom ? 0.5 * (a - c) / denom : 0;
    extremes.push({ t: points[i].t + off * HOUR, level: b - 0.25 * (a - c) * off, type: isHigh ? 'high' : 'low' });
  }
  return { url, station: null, points, extremes };
}
