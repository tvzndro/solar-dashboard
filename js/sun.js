// Solar position and per-day light phases, computed locally (no network).

import { MIN } from './time.js';

const RAD = Math.PI / 180;
export const HORIZON = -0.833; // apparent sunrise/sunset incl. refraction and disc radius

export const PHASES = ['night', 'astronomical', 'nautical', 'civil', 'day'];

export function phaseOf(elev) {
  if (elev >= HORIZON) return 'day';
  if (elev >= -6) return 'civil';
  if (elev >= -12) return 'nautical';
  if (elev >= -18) return 'astronomical';
  return 'night';
}

/** Sun elevation and azimuth (degrees, azimuth clockwise from north). */
export function sunPosition(ms, lat, lon) {
  const d = ms / 86_400_000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = (gmst * 15 + lon) * RAD - ra;
  const phi = lat * RAD;
  const elev = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { elevation: elev / RAD, azimuth: ((az / RAD) + 180 + 360) % 360 };
}

/**
 * Samples the sun across [start, end) and derives everything the UI needs:
 * elevation samples, phase segments, sunrise/sunset, day length, polar state.
 */
export function sunDay(start, end, lat, lon, stepMin = 2) {
  const step = stepMin * MIN;
  const samples = [];
  for (let t = start; t <= end; t += step) samples.push({ t, elev: sunPosition(t, lat, lon).elevation });
  if (samples[samples.length - 1].t < end) samples.push({ t: end, elev: sunPosition(end, lat, lon).elevation });

  // Phase segments with interpolated boundaries.
  const segments = [];
  let cur = { phase: phaseOf(samples[0].elev), from: start };
  const rises = [], sets = [];
  let dayMs = 0, maxElev = -90, minElev = 90, noon = start;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (b.elev > maxElev) { maxElev = b.elev; noon = b.t; }
    if (a.elev > maxElev) { maxElev = a.elev; noon = a.t; }
    minElev = Math.min(minElev, a.elev, b.elev);
    const cross = (lvl) => a.t + (b.t - a.t) * (lvl - a.elev) / (b.elev - a.elev);
    if (a.elev < HORIZON && b.elev >= HORIZON) rises.push(cross(HORIZON));
    if (a.elev >= HORIZON && b.elev < HORIZON) sets.push(cross(HORIZON));
    // Day length: time above the horizon (with partial steps interpolated).
    if (a.elev >= HORIZON && b.elev >= HORIZON) dayMs += b.t - a.t;
    else if (a.elev >= HORIZON) dayMs += cross(HORIZON) - a.t;
    else if (b.elev >= HORIZON) dayMs += b.t - cross(HORIZON);
    const p = phaseOf(b.elev);
    if (p !== cur.phase) {
      // Boundary level between the two phases.
      const lv = { day: HORIZON, civil: -6, nautical: -12, astronomical: -18, night: -90 };
      const hi = PHASES.indexOf(p) > PHASES.indexOf(cur.phase) ? p : cur.phase;
      const t = cross(lv[hi]);
      segments.push({ ...cur, to: t });
      cur = { phase: p, from: t };
    }
  }
  segments.push({ ...cur, to: end });

  let polar = null;
  if (!rises.length && !sets.length) polar = maxElev < HORIZON ? 'night' : 'midnightSun';
  return {
    samples, segments, maxElev, minElev, noon,
    sunrise: rises[0] ?? null, sunset: sets[sets.length - 1] ?? null,
    dayLength: dayMs, polar,
  };
}

export function elevationAt(day, t) {
  const s = day.samples;
  if (t <= s[0].t) return s[0].elev;
  if (t >= s[s.length - 1].t) return s[s.length - 1].elev;
  const i = Math.min(s.length - 1, Math.max(1, Math.ceil((t - s[0].t) / (s[1].t - s[0].t))));
  const a = s[i - 1], b = s[i];
  return a.elev + (b.elev - a.elev) * (t - a.t) / (b.t - a.t);
}
