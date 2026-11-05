// Unit conversion and locale-aware formatting. Internal units are always
// °C, m/s, mm (water), cm (snow), degrees.

import { t, locale } from './i18n.js';
import { HOUR, MIN } from './time.js';

let units = 'metric';
let tz = 'UTC';
export function setUnits(u) { units = u === 'imperial' ? 'imperial' : 'metric'; }
export function setTimeZone(z) { tz = z; }
export function timeZone() { return tz; }

const nfCache = new Map();
export function num(v, digits = 0) {
  const key = locale() + digits;
  let f = nfCache.get(key);
  if (!f) { f = new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }); nfCache.set(key, f); }
  // Avoid "-0".
  const r = Number(v.toFixed(digits));
  return f.format(r === 0 ? 0 : r);
}

export const temp = (c) => (units === 'imperial' ? `${num(c * 9 / 5 + 32)} °F` : `${num(c)} °C`);
export const tempPrecise = (c) => (units === 'imperial' ? `${num(c * 9 / 5 + 32)} °F` : `${num(c, 1)} °C`);
export const tempShort = (c) => `${num(units === 'imperial' ? c * 9 / 5 + 32 : c)}°`;
export const speed = (ms) => (units === 'imperial' ? `${num(ms * 2.23694)} mph` : `${num(ms, ms < 10 ? 1 : 0)} m/s`);
export function precip(mm, digits) {
  if (units === 'imperial') return `${num(mm / 25.4, digits ?? 2)} in`;
  return `${num(mm, digits ?? 1)} mm`;
}
export function snow(cm) {
  if (units === 'imperial') return `${num(cm / 2.54, 1)} in`;
  return `${num(cm, cm < 10 ? 1 : 0)} cm`;
}
/** Water level, cm relative to mean sea level, signed. */
export function tideLevel(cm, signed = true) {
  const v = units === 'imperial' ? `${num(Math.abs(cm) / 30.48, 1)} ft` : `${num(Math.abs(cm))} cm`;
  return (signed ? (cm > 0.5 ? '+' : cm < -0.5 ? '−' : '') : '') + v;
}
export const pct = (p) => `${num(p)} %`;
export const deg = (d, digits = 0) => `${num(d, digits)}°`;

export function clock(ms) {
  return new Intl.DateTimeFormat(locale(), { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}
export function longDate(ms) {
  return new Intl.DateTimeFormat(locale(), { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(ms);
}
export function shortDay(ms) {
  return new Intl.DateTimeFormat(locale(), { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(ms);
}

export function duration(ms) {
  const totalMin = Math.round(ms / MIN);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  const hu = locale().startsWith('nb') ? 't' : 'h';
  if (h === 0) return `${m} min`;
  return m ? `${h} ${hu} ${m} min` : `${h} ${hu}`;
}

/** Short relative duration for "in 25 min" style text. */
export function relMinutes(ms) {
  const m = Math.max(0, Math.round(ms / MIN / 5) * 5);
  if (m < 60) return `${Math.max(m, 5)} min`;
  return duration(Math.round(ms / (15 * MIN)) * 15 * MIN);
}

export function relHours(deltaMs) {
  const abs = Math.abs(deltaMs);
  const days = abs / (24 * HOUR);
  if (days >= 1.5) {
    const s = `${num(Math.round(days * 2) / 2, Number.isInteger(Math.round(days * 2) / 2) ? 0 : 1)} d`;
    return deltaMs < 0 ? t('hoursAgo', s) : t('hoursAhead', s);
  }
  const s = abs < HOUR ? `${Math.round(abs / MIN)} min` : duration(Math.round(abs / (5 * MIN)) * 5 * MIN);
  return deltaMs < 0 ? t('hoursAgo', s) : t('hoursAhead', s);
}

export function compass(dirDeg) {
  const names = t('compass');
  return names[Math.round(((dirDeg % 360) + 360) % 360 / 22.5) % 16];
}
