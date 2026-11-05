// Fabricated but plausible data for development and demos: a stormy spell with
// snow showers, gusty wind and a strong aurora forecast. Deterministic per hour,
// so scrubbing and reloading give the same picture.

import { HOUR, MIN } from '../time.js';

function noise(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
function smooth(t, period, seed) {
  const k = t / period, i = Math.floor(k), f = k - i;
  const u = f * f * (3 - 2 * f);
  return noise(i + seed) * (1 - u) + noise(i + 1 + seed) * u;
}

export function mockData(now) {
  const h0 = Math.floor(now / HOUR) * HOUR;
  const instants = [], precip = [];
  for (let t = h0 - 80 * HOUR; t <= h0 + 270 * HOUR; t += HOUR) {
    const hr = t / HOUR;
    const daily = Math.sin(((hr % 24) - 9) / 24 * 2 * Math.PI);
    const temp = -3 + 3 * daily + 6 * (smooth(hr, 40, 1) - 0.5);
    const cloud = Math.min(100, Math.max(0, 120 * smooth(hr, 9, 2) - 10));
    const wind = 2 + 16 * smooth(hr, 14, 3) ** 1.5;
    instants.push({
      t, temp, rh: 60 + 35 * smooth(hr, 7, 4), wind, gust: wind * (1.4 + 0.4 * noise(hr)),
      dir: (200 + 140 * smooth(hr, 30, 5)) % 360, cloud,
    });
    const wet = Math.max(0, smooth(hr, 6, 6) - 0.45) * 8 * (cloud / 100);
    const amount = Math.round(wet * 10) / 10;
    precip.push({ from: t, to: t + HOUR, amount, max: amount > 0 ? Math.round(amount * (1.4 + noise(hr + 9)) * 10) / 10 : 0 });
  }
  const steps = [];
  for (let i = 0; i < 24; i++) {
    const t = Math.floor(now / (5 * MIN)) * 5 * MIN + i * 5 * MIN;
    steps.push({ t, rate: i < 5 ? 0 : 0.6 + 1.5 * smooth(i, 6, 7) });
  }
  const kp = [];
  for (let t = Math.floor(h0 / (3 * HOUR)) * 3 * HOUR - 72 * HOUR; t < h0 + 96 * HOUR; t += 3 * HOUR) {
    const k = Math.min(9, Math.max(0, 1 + 6.5 * smooth(t / HOUR, 20, 8) ** 1.3));
    kp.push({ from: t, to: t + 3 * HOUR, kp: Math.round(k * 3) / 3, kind: t + 3 * HOUR < now ? 'observed' : 'predicted' });
  }
  return { instants, precip, nowcast: { temp: -2, steps, stepMs: 5 * MIN }, kp };
}
