// Built-in public live streams per place, used when the user hasn't set their own
// stream list. Video IDs (not channel links) because one channel (NK-Nett) runs
// several streams, and a channel link only ever shows one of them.

export const STREAM_PRESETS = [
  {
    place: 'Bodø', lat: 67.28, lon: 14.40, radiusKm: 30,
    streams: [
      { name: 'Molostua', youtube: 'https://www.youtube.com/watch?v=ZbKYp5ulmCM' },
      { name: 'Linken', youtube: 'https://www.youtube.com/watch?v=d12QYCsY8r4' },
      { name: 'Golfklubb', youtube: 'https://www.youtube.com/watch?v=oRrwwg3Je5E' },
    ],
  },
];

function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function presetFor(loc) {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;
  return STREAM_PRESETS.find((p) => distanceKm(p, loc) <= p.radiusKm) || null;
}
