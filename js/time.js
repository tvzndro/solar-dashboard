// Time-zone helpers. All instants are epoch milliseconds; "local" means the
// configured location's IANA time zone, not necessarily the browser's.

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const dtfCache = new Map();
function partsFormatter(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function zonedParts(tz, ms) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = +p.value;
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

export function tzOffset(tz, ms) {
  const p = zonedParts(tz, ms);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Local wall-clock time in `tz` → epoch ms. Month is 1-based; overflow is normalised. */
export function zonedToUtc(tz, y, m, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffset(tz, guess);
  t = guess - tzOffset(tz, t);
  return t;
}

/** Start of the local day containing `ms`, shifted by `offsetDays`. */
export function dayStart(tz, ms, offsetDays = 0) {
  const p = zonedParts(tz, ms);
  return zonedToUtc(tz, p.y, p.m, p.d + offsetDays);
}

/** [start, end) of the local day `offsetDays` from the day containing `ms`. */
export function dayRange(tz, ms, offsetDays = 0) {
  const p = zonedParts(tz, ms);
  return [zonedToUtc(tz, p.y, p.m, p.d + offsetDays), zonedToUtc(tz, p.y, p.m, p.d + offsetDays + 1)];
}

export function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
