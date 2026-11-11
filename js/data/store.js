// Holds fetched data, merges sources into one timeline, and answers
// "what is the value at time t, and where did it come from?".

import { HOUR, MIN } from '../time.js';
import { fetchMet, fetchNowcast, fetchOpenMeteo, fetchKp, fetchKp27, fetchKartverket, fetchMarine } from './fetchers.js';
import { mockData } from './mock.js';

const REFRESH = { met: 15 * MIN, openmeteo: 30 * MIN, nowcast: 5 * MIN, kp: 30 * MIN, kp27: 6 * HOUR, kartverket: 30 * MIN, marine: 3 * HOUR };
const RETRY = 2 * MIN;

/**
 * Probability that precipitation falls as snow (used as the snow fraction).
 * Jennings et al. 2018 (Nat. Commun. 9:1148), bivariate logistic model fitted to
 * 17.8 M Northern Hemisphere observations: humid air keeps precipitation liquid
 * to lower temperatures, dry air lets snow survive above 0 °C (evaporative cooling).
 * T in °C, RH in %. Without humidity, assume the moist air typical of precipitation.
 */
export function snowProbability(tempC, rh) {
  if (tempC == null) return 0;
  return 1 / (1 + Math.exp(-10.04 + 1.41 * tempC + 0.09 * (rh ?? 90)));
}

/**
 * Density of freshly fallen snow (kg/m³) from air temperature and 10 m wind:
 * Vionnet et al. 2012 (Crocus snow model), ρ = 109 + 6·T + 26·√U, kept within
 * 50–250. Wet near-0 °C snow and wind-packed snow are dense (shallow); cold calm
 * snow is light. 1 mm water → 100/ρ cm of snow (≈ 9 cm at 0 °C calm, 5 cm windy).
 */
export function newSnowDensity(tempC, wind) {
  return Math.min(250, Math.max(50, 109 + 6 * (tempC ?? 0) + 26 * Math.sqrt(Math.max(0, wind ?? 3))));
}

export class DataStore {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.sources = {};
    this.raw = {};
    this.timers = [];
    this.instants = [];
    this.precip = [];
    this.kp = [];
    this.nowcast = null;
    this.timezone = null;
    this.generation = 0;
  }

  start({ lat, lon, mock, now = Date.now }) {
    this.stop();
    this.jobs = null;
    this.inflight = new Set();
    const gen = ++this.generation;
    this.raw = {};
    this.sources = {};
    this.abort = new AbortController();
    if (mock) {
      const m = mockData(now());
      this.raw.mock = m;
      this.sources.mock = { status: 'ok', fetchedAt: Date.now(), url: null };
      this.#merge();
      // Keep the mock "now" moving.
      this.timers.push(setInterval(() => { this.raw.mock = mockData(now()); this.#merge(); }, 10 * MIN));
      return;
    }
    this.jobs = {
      met: () => fetchMet(lat, lon, this.abort.signal),
      openmeteo: () => fetchOpenMeteo(lat, lon, this.abort.signal),
      // MET's radar nowcast only covers the Nordics; elsewhere it fails without CORS
      // headers, so don't ask (Open-Meteo's 15-minutely data is used instead).
      ...(lat > 52.5 && lat < 75 && lon > -15 && lon < 37 ? { nowcast: () => fetchNowcast(lat, lon, this.abort.signal) } : {}),
      // Tides: Kartverket covers Norway (incl. Svalbard); Open-Meteo Marine is the global fallback.
      ...(lat > 57 && lat < 82 && lon > 2 && lon < 33 ? { kartverket: () => fetchKartverket(lat, lon, this.abort.signal, now()) } : {}),
      marine: () => fetchMarine(lat, lon, this.abort.signal),
      kp: () => fetchKp(this.abort.signal),
      kp27: () => fetchKp27(this.abort.signal),
    };
    for (const name of Object.keys(this.jobs)) this.#run(name, gen);
  }

  stop() {
    this.abort?.abort();
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
  }

  async #run(name, gen) {
    this.inflight ??= new Set();
    const key = `${gen}:${name}`;
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    try { await this.#fetch(name, gen); } finally { this.inflight.delete(key); }
  }

  async #fetch(name, gen) {
    const prev = this.sources[name];
    this.sources[name] = { ...prev, status: prev?.status === 'ok' ? 'ok' : 'loading', refreshing: true };
    this.onUpdate();
    let delay = REFRESH[name];
    try {
      const data = await this.jobs[name]();
      if (gen !== this.generation) return;
      this.raw[name] = data;
      this.sources[name] = { status: 'ok', fetchedAt: Date.now(), url: data.url, error: null };
    } catch (err) {
      if (gen !== this.generation || err.name === 'AbortError') return;
      this.sources[name] = { ...this.sources[name], status: this.raw[name] ? 'stale' : 'error', error: String(err.message || err), refreshing: false };
      delay = RETRY;
      console.warn(`[data] ${name} failed:`, err);
    }
    this.#merge();
    if (gen === this.generation) this.timers.push(setTimeout(() => this.#run(name, gen), delay));
  }

  /** Re-fetch everything now (e.g. after the tab wakes from sleep). */
  refreshAll() {
    if (!this.jobs) return;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const name of Object.keys(this.jobs)) this.#run(name, this.generation);
  }

  /** Combine sources: MET where it has hourly steps, Open-Meteo elsewhere (past days, far future). */
  #merge() {
    const { met, openmeteo: om, mock, nowcast, kp, kp27 } = this.raw;
    let instants = [], precip = [];
    if (mock) {
      instants = mock.instants.map((x) => ({ ...x, src: 'mock' }));
      precip = mock.precip.map((x) => ({ ...x, src: 'mock' }));
    } else {
      const metFrom = met?.start ?? Infinity;
      const metTo = met?.hourlyEnd ?? -Infinity;
      const inMet = (t) => t >= metFrom && t <= metTo;
      if (met) {
        instants.push(...met.instants.filter((x) => inMet(x.t)).map((x) => ({ ...x, src: 'met' })));
        precip.push(...met.precip.filter((x) => x.hourly).map((x) => ({ ...x, src: 'met' })));
      }
      if (om) {
        instants.push(...om.instants.filter((x) => !inMet(x.t)).map((x) => ({ ...x, src: 'openmeteo' })));
        precip.push(...om.precip.filter((x) => x.to <= metFrom || x.from >= metTo + HOUR).map((x) => ({ ...x, src: 'openmeteo' })));
      } else if (met) {
        // No Open-Meteo: fall back to MET's coarse 6-hourly tail.
        instants.push(...met.instants.filter((x) => x.t > metTo).map((x) => ({ ...x, src: 'met' })));
        precip.push(...met.precip.filter((x) => !x.hourly).map((x) => ({ ...x, src: 'met' })));
      }
    }
    instants.sort((a, b) => a.t - b.t);
    precip.sort((a, b) => a.from - b.from);
    this.instants = instants;
    // Snow estimate for each precipitation interval: water that falls as snow
    // (phase from temperature + humidity), turned into depth by fresh-snow density
    // (temperature + wind). Open-Meteo's own snowfall isn't used: in Norway its
    // default model (MET Nordic) reports 0 always, and ICON turns snow into rain
    // above 1.5 °C, so it only made figures inconsistent between places.
    for (const p of precip) {
      const w = this.instantAt((p.from + p.to) / 2);
      p.snowCm = p.amount * snowProbability(w?.temp, w?.rh) * 100 / newSnowDensity(w?.temp, w?.wind);
    }
    this.precip = precip;

    // Nowcast: MET radar nowcast if available, else Open-Meteo 15-minutely.
    if (mock) this.nowcast = { ...mock.nowcast, src: 'mock' };
    else if (nowcast) this.nowcast = { ...nowcast, src: 'nowcast' };
    else if (om?.nowcast) this.nowcast = { ...om.nowcast, src: 'openmeteo' };
    else this.nowcast = null;

    // Kp: 3-hourly observed/predicted, then the coarse daily outlook beyond it.
    if (mock) this.kp = mock.kp.map((b) => ({ ...b, src: 'mock' }));
    else {
      const blocks = (kp?.blocks || []).map((b) => ({ ...b, src: 'kp' }));
      const end = blocks.length ? blocks[blocks.length - 1].to : -Infinity;
      for (const b of kp27?.blocks || []) {
        if (b.to <= end) continue;
        blocks.push({ ...b, from: Math.max(b.from, end), src: 'kp27' });
      }
      this.kp = blocks;
    }
    // Tides: prefer Kartverket when it has data for this spot.
    const { kartverket: kv, marine } = this.raw;
    const pick = mock?.tide ? { ...mock.tide, src: 'mock' }
      : kv && !kv.none ? { ...kv, src: 'kartverket' }
      : marine && !marine.none ? { ...marine, src: 'marine' } : null;
    this.tide = pick;
    for (const [name, d] of [['kartverket', kv], ['marine', marine]]) {
      const s = this.sources[name];
      if (s && d) s.note = d.none ? d.none : pick?.src !== name ? 'notUsed' : null;
    }

    this.timezone = om?.timezone || this.timezone;
    this.onUpdate();
  }

  /** Interpolated instant values at t (null if outside data or across a big gap). */
  instantAt(t) {
    const a = this.instants;
    if (!a.length || t < a[0].t || t > a[a.length - 1].t) return null;
    let lo = 0, hi = a.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid].t <= t) lo = mid; else hi = mid; }
    const p = a[lo], q = a[hi];
    if (q.t - p.t > 7 * HOUR) return null;
    const f = q.t === p.t ? 0 : (t - p.t) / (q.t - p.t);
    const lerp = (x, y) => (x == null || y == null ? (f < 0.5 ? x : y) : x + (y - x) * f);
    let dd = ((q.dir - p.dir + 540) % 360) - 180;
    return {
      t, temp: lerp(p.temp, q.temp), rh: lerp(p.rh, q.rh), wind: lerp(p.wind, q.wind), gust: lerp(p.gust, q.gust),
      dir: (p.dir + dd * f + 360) % 360, cloud: lerp(p.cloud, q.cloud),
      src: f < 0.5 ? p.src : q.src, from: p.t, to: q.t,
    };
  }

  precipAt(t) {
    return this.precip.find((p) => t >= p.from && t < p.to) || null;
  }

  precipIn(from, to) { return this.precip.filter((p) => p.to > from && p.from < to); }

  kpAt(t) { return this.kp.find((b) => t >= b.from && t < b.to) || null; }

  kpIn(from, to) { return this.kp.filter((b) => b.to > from && b.from < to); }

  /** Snow (cm) in [from, to), pro-rating partially overlapping intervals. */
  snowBetween(from, to) {
    let sum = 0, covered = 0, srcs = new Set();
    for (const p of this.precipIn(from, to)) {
      const overlap = Math.min(p.to, to) - Math.max(p.from, from);
      sum += p.snowCm * overlap / (p.to - p.from);
      covered += overlap;
      srcs.add(p.src);
    }
    return { cm: sum, complete: covered >= (to - from) - MIN, srcs: [...srcs] };
  }

  /** Interpolated water level (cm vs mean sea level) at t, or null. */
  tideAt(t) {
    const a = this.tide?.points;
    if (!a?.length || t < a[0].t || t > a[a.length - 1].t) return null;
    let lo = 0, hi = a.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid].t <= t) lo = mid; else hi = mid; }
    const p = a[lo], q = a[hi];
    if (q.t - p.t > 3 * HOUR) return null;
    const f = q.t === p.t ? 0 : (t - p.t) / (q.t - p.t);
    return { t, level: p.level + (q.level - p.level) * f, tide: p.tide + (q.tide - p.tide) * f,
      kind: f < 0.5 ? p.kind : q.kind, rising: q.level > p.level, src: this.tide.src };
  }

  /** Next high and low tide after t. */
  nextTides(t) {
    const ex = this.tide?.extremes || [];
    return { high: ex.find((e) => e.t > t && e.type === 'high') || null, low: ex.find((e) => e.t > t && e.type === 'low') || null };
  }

  get loading() { return Object.values(this.sources).some((s) => s.status === 'loading'); }
}
