// Camera catalogue (data/cameras.json, built by scripts/scrape-vindnaa.mjs):
// Norwegian webcams and YouTube live streams with positions and direct sources.

let promise = null;

export function loadCatalog() {
  promise ??= fetch('data/cameras.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return promise;
}

export function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const fold = (s) => String(s).toLocaleLowerCase('nb').normalize('NFKD').replace(/\p{M}/gu, '');

/**
 * Cameras near `loc` (within radiusKm), or — when `query` is given — matches by
 * name / municipality / region anywhere, nearest first.
 */
export function findCameras(catalog, loc, { radiusKm = 25, query = '' } = {}) {
  const q = fold(query.trim());
  const words = q ? q.split(/\s+/) : [];
  const out = [];
  for (const c of catalog?.cameras || []) {
    const d = loc ? distanceKm(loc, c) : null;
    if (words.length) {
      const hay = fold(`${c.name} ${c.municipality} ${c.region}`);
      if (!words.every((w) => hay.includes(w))) continue;
    } else if (d == null || d > radiusKm) continue;
    out.push({ ...c, distance: d });
  }
  return out.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
}
