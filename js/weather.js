// Derived weather quantities.

import { snowProbability } from './data/store.js';

const BEAUFORT_UPPER = [0.5, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
export function beaufort(ms) {
  const i = BEAUFORT_UPPER.findIndex((u) => ms < u);
  return i === -1 ? 12 : i;
}

/** Feels-like temperature (°C): wind chill when cold, heat index when hot, Steadman apparent temperature between. */
export function feelsLike(tempC, windMs, rh) {
  const windChill = () => {
    const v = windMs * 3.6;
    if (v < 4.8) return tempC;
    const p = v ** 0.16;
    return 13.12 + 0.6215 * tempC - 11.37 * p + 0.3965 * tempC * p;
  };
  const steadman = () => {
    if (rh == null) return tempC;
    const e = (rh / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
    return tempC + 0.33 * e - 0.70 * windMs - 4.0;
  };
  const heatIndex = () => {
    if (rh == null) return tempC;
    const T = tempC * 9 / 5 + 32, R = rh;
    const hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T
      - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    return (hi - 32) * 5 / 9;
  };
  if (tempC <= 10) return windChill();
  if (tempC < 16) { const f = (tempC - 10) / 6; return windChill() * (1 - f) + steadman() * f; }
  if (tempC < 27) return steadman();
  return Math.max(heatIndex(), steadman());
}

export function precipType(tempC, rh) {
  const s = snowProbability(tempC ?? 5, rh);
  if (s >= 0.75) return 'snow';
  if (s > 0.25) return 'sleet';
  return 'rain';
}

export function intensity(rateMmH) {
  if (rateMmH < 1) return 'light';
  if (rateMmH < 4) return 'moderate';
  return 'heavy';
}

const WET = 0.1; // mm/h

/** Precipitation type named by a MET weather symbol ('lightsnowshowers_day' → 'snow'), or null. */
export function symbolType(code) {
  if (!code) return null;
  if (code.includes('sleet')) return 'sleet';
  if (code.includes('snow')) return 'snow';
  if (code.includes('rain')) return 'rain';
  return null;
}

/**
 * Short-term outlook from nowcast steps starting at `now`.
 * `typeAt(t)` may name the precipitation type forecast for time t (MET's weather
 * symbol); the most common one over the wet steps wins, else it is estimated from
 * temperature and humidity.
 * Returns { kind: 'start'|'stop'|'continues'|'dry', inMs, rate, type, horizonMs, steps }.
 */
export function shortTermOutlook(nowcast, now, tempC, rh, typeAt = () => null) {
  if (!nowcast?.steps?.length) return null;
  const steps = nowcast.steps.filter((s) => s.t + nowcast.stepMs > now);
  if (!steps.length) return null;
  const end = steps[steps.length - 1].t + nowcast.stepMs;
  const horizonMs = end - now;
  const temp = nowcast.temp ?? tempC;
  const typeOf = (sts) => {
    const votes = {};
    for (const s of sts) { const ty = typeAt(s.t + nowcast.stepMs / 2); if (ty) votes[ty] = (votes[ty] || 0) + s.rate; }
    const best = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
    return best || precipType(temp, rh);
  };
  const wetNow = steps[0].rate >= WET;
  if (wetNow) {
    const stop = steps.findIndex((s) => s.rate < WET);
    const wet = stop === -1 ? steps : steps.slice(0, stop);
    const peak = Math.max(...wet.map((s) => s.rate));
    if (stop === -1) return { kind: 'continues', inMs: horizonMs, rate: peak, type: typeOf(wet), horizonMs, steps };
    return { kind: 'stop', inMs: Math.max(0, steps[stop].t - now), rate: peak, type: typeOf(wet), horizonMs, steps };
  }
  const start = steps.findIndex((s) => s.rate >= WET);
  if (start === -1) return { kind: 'dry', inMs: horizonMs, horizonMs, steps };
  const after = steps.slice(start);
  const stopAfter = after.findIndex((s) => s.rate < WET);
  const wet = stopAfter === -1 ? after : after.slice(0, stopAfter);
  return { kind: 'start', inMs: steps[start].t - now, rate: Math.max(...wet.map((s) => s.rate)), type: typeOf(wet), horizonMs, steps };
}

/** Rough Kp typically needed for overhead/visible aurora at a geographic latitude (Northern Europe-tuned). */
export function kpNeeded(lat) {
  const a = Math.abs(lat);
  return Math.max(1, Math.min(9, Math.round((66.5 - a) / 1.8 + 1)));
}

export function auroraChance(kp, lat, elev, cloud) {
  if (kp == null) return null;
  const margin = kp - kpNeeded(lat);
  let level = margin >= 2 ? 'high' : margin >= 1 ? 'good' : margin >= 0 ? 'fair' : margin >= -1 ? 'low' : 'none';
  return { level, dark: elev < -6, cloudy: cloud != null && cloud > 75 };
}
