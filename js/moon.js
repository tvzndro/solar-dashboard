// Moon position, phase and per-day rise/set, computed locally.
// Low-precision lunar model (as used by SunCalc): good to a few minutes for rise/set.

import { MIN } from './time.js';

const RAD = Math.PI / 180;
const E = 23.4397 * RAD; // obliquity of the ecliptic

const days = (ms) => ms / 86_400_000 + 2440587.5 - 2451545.0;
const ra = (l, b) => Math.atan2(Math.sin(l) * Math.cos(E) - Math.tan(b) * Math.sin(E), Math.cos(l));
const dec = (l, b) => Math.asin(Math.sin(b) * Math.cos(E) + Math.cos(b) * Math.sin(E) * Math.sin(l));

function sunCoords(d) {
  const M = (357.5291 + 0.98560028 * d) * RAD;
  const C = (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * RAD;
  const L = M + C + 102.9372 * RAD + Math.PI;
  return { ra: ra(L, 0), dec: dec(L, 0) };
}

function moonCoords(d) {
  const L = (218.316 + 13.176396 * d) * RAD;
  const M = (134.963 + 13.064993 * d) * RAD;
  const F = (93.272 + 13.229350 * d) * RAD;
  const l = L + 6.289 * RAD * Math.sin(M);
  const b = 5.128 * RAD * Math.sin(F);
  return { ra: ra(l, b), dec: dec(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

function refraction(h) {
  const x = Math.max(h, 0);
  return 0.0002967 / Math.tan(x + 0.00312536 / (x + 0.08901179));
}

/** Apparent elevation (incl. refraction) and azimuth (clockwise from north), degrees. */
export function moonPosition(ms, lat, lon) {
  const d = days(ms);
  const c = moonCoords(d);
  const phi = lat * RAD;
  const H = (280.16 + 360.9856235 * d) * RAD + lon * RAD - c.ra;
  let h = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
  h += refraction(h);
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi));
  return { elevation: h / RAD, azimuth: ((az / RAD) + 180 + 360) % 360 };
}

/** fraction: 0..1 lit; phase: 0 new → 0.25 first quarter → 0.5 full → 0.75 last quarter. */
export function moonIllumination(ms) {
  const d = days(ms);
  const s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  const fraction = (1 + Math.cos(inc)) / 2;
  const phase = 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / Math.PI;
  return { fraction, phase, waxing: phase < 0.5 };
}

const PHASE_KEYS = ['new', 'waxingCrescent', 'firstQuarter', 'waxingGibbous', 'full', 'waningGibbous', 'lastQuarter', 'waningCrescent'];
export function phaseKey(phase) {
  const p = ((phase % 1) + 1) % 1;
  const near = (x) => Math.abs(p - x) < 0.034 || Math.abs(p - x - 1) < 0.034;
  if (near(0)) return 'new';
  if (near(0.25)) return 'firstQuarter';
  if (near(0.5)) return 'full';
  if (near(0.75)) return 'lastQuarter';
  return PHASE_KEYS[p < 0.25 ? 1 : p < 0.5 ? 3 : p < 0.75 ? 5 : 7];
}

const MOON_HORIZON = 0.133; // upper limb on the horizon (semi-diameter, refraction already applied)

export function moonDay(start, end, lat, lon, stepMin = 4) {
  const samples = [];
  for (let t = start; t <= end; t += stepMin * MIN) samples.push({ t, elev: moonPosition(t, lat, lon).elevation });
  if (samples[samples.length - 1].t < end) samples.push({ t: end, elev: moonPosition(end, lat, lon).elevation });
  const rises = [], sets = [];
  let maxElev = -90, minElev = 90;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    maxElev = Math.max(maxElev, a.elev, b.elev); minElev = Math.min(minElev, a.elev, b.elev);
    const cross = () => a.t + (b.t - a.t) * (MOON_HORIZON - a.elev) / (b.elev - a.elev);
    if (a.elev < MOON_HORIZON && b.elev >= MOON_HORIZON) rises.push(cross());
    if (a.elev >= MOON_HORIZON && b.elev < MOON_HORIZON) sets.push(cross());
  }
  let always = null;
  if (!rises.length && !sets.length) always = maxElev < MOON_HORIZON ? 'down' : 'up';
  return { samples, rise: rises[0] ?? null, set: sets[0] ?? null, maxElev, minElev, always };
}

/**
 * SVG path (centred on 0,0, radius r) of the lit part of the moon.
 * Northern-hemisphere view: waxing is lit on the right; mirrored in the south.
 */
export function litPath(r, { fraction, waxing }, southern = false) {
  const litRight = waxing !== southern;
  const rx = Math.abs(1 - 2 * fraction) * r;
  const crescent = fraction < 0.5;
  const s1 = litRight ? 1 : 0;                       // outer limb: top → bottom on the lit side
  const viaRight = crescent ? litRight : !litRight;   // terminator: bottom → top
  const s2 = viaRight ? 0 : 1;
  return `M0 ${-r} A${r} ${r} 0 0 ${s1} 0 ${r} A${rx.toFixed(3)} ${r} 0 0 ${s2} 0 ${-r} Z`;
}
