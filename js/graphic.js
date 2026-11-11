// The day graphic: light-phase bands, sun path and disc, clouds hanging from
// the top, precipitation bars above it, aurora (Kp) rising from the bottom.
// Hover / drag scrubs; leaving returns to now.

import { zonedParts, zonedToUtc, MIN, HOUR } from './time.js';
import { elevationAt } from './sun.js';
import { moonPosition, moonIllumination, litPath } from './moon.js';
import { clock, temp as fmtTemp, tempShort } from './format.js';

const COLORS = {
  night: '#060608',
  astronomical: '#161a2e',
  nautical: '#1d2b52',
  civil: '#274b98',
  day: '#3a86ff',
  cloud: 'rgba(118,118,118,0.96)',
  precip: '#0a84c8',
  precipMax: 'rgba(110,185,235,0.75)', // stripes for the forecast "up to"
  kp: 'rgba(16,185,80,0.5)',
  kpRough: 'rgba(16,185,80,0.28)',
  frame: 'rgba(255,255,255,0.16)',
  horizon: 'rgba(255,255,255,0.32)',
  curve: 'rgba(255,255,255,0.5)',
  moonCurve: 'rgba(205,220,255,0.38)',
  moonLit: '#eef1f8',
  moonDark: 'rgba(28,32,48,0.75)',
  tide: '#c4a7ff',
  label: '#8a8a8a',
  warm: '#ff9a5c',
  cold: '#8fdcff',
};

const PRECIP_H = 40;
const PRECIP_FULL = 8; // mm/h that fills the precipitation strip
const LABEL_H = 26;
const PAD_X = 10;
const TOUCH_HOLD = 3000;
const SUN_MIN_ALPHA = 0.85; // sun opacity when fully covering the moon
const LINE_W = 1.4; // thin data lines; < ~1.3 px they shimmer in thickness when nearly flat
const LABEL_FONT = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif';
const LABEL_FONT_SMALL = '500 11px system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif';

/** Text with a dark outline so it reads on any band, cloud or curve. */
function outlinedText(ctx, text, x, y, color) {
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
  ctx.restore();
}

export class DayGraphic {
  constructor(container, { onScrub }) {
    this.onScrub = onScrub;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'day-graphic';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'slider');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.model = null;
    this.touchTimer = null;
    new ResizeObserver(() => this.draw()).observe(container);
    this.#bindInput();
  }

  #timeAtX(clientX) {
    const r = this.canvas.getBoundingClientRect();
    const { start, end } = this.model;
    const f = (clientX - r.left - PAD_X) / (r.width - 2 * PAD_X);
    return start + Math.min(1, Math.max(0, f)) * (end - start - 1);
  }

  #bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.model) return;
      clearTimeout(this.touchTimer);
      if (e.pointerType !== 'mouse') c.setPointerCapture(e.pointerId);
      this.onScrub(this.#timeAtX(e.clientX));
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.model) return;
      if (e.pointerType === 'mouse' || e.buttons || c.hasPointerCapture(e.pointerId)) this.onScrub(this.#timeAtX(e.clientX));
    });
    const release = (e) => {
      if (e.pointerType === 'mouse') { if (e.type === 'pointerleave') this.onScrub(null); return; }
      clearTimeout(this.touchTimer);
      this.touchTimer = setTimeout(() => this.onScrub(null), TOUCH_HOLD);
    };
    c.addEventListener('pointerleave', release);
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
    c.addEventListener('keydown', (e) => {
      if (!this.model) return;
      const step = e.shiftKey ? HOUR : 15 * MIN;
      const cur = this.model.viewT;
      const { start, end } = this.model;
      let next;
      if (e.key === 'ArrowLeft') next = Math.max(start, cur - step);
      else if (e.key === 'ArrowRight') next = Math.min(end - 1, cur + step);
      else if (e.key === 'Escape') next = null;
      else return;
      e.preventDefault();
      this.onScrub(next);
    });
    c.addEventListener('blur', () => { if (this.model?.scrubbing) this.onScrub(null); });
  }

  render(model) { this.model = model; this.draw(); }

  draw() {
    const m = this.model;
    if (!m) return;
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = c.parentElement.clientWidth;
    const plotH = Math.round(Math.min(220, Math.max(130, W * 0.22)));
    const H = PRECIP_H + plotH + LABEL_H;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      c.style.height = `${H}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const L = PAD_X, R = W - PAD_X, T = PRECIP_H, B = PRECIP_H + plotH;
    const pw = R - L;
    const { start, end, sun, store, overlays } = m;
    const xOf = (t) => L + ((t - start) / (end - start)) * pw;
    const mid = (T + B) / 2;
    // Keep the day's peak inside the frame; deep night may run off the bottom.
    const scale = Math.max(25, sun.maxElev * 1.15, 0.75 * Math.abs(sun.minElev));
    const yOf = (e) => mid - (e / scale) * (plotH / 2);

    // Light-phase bands.
    for (const s of sun.segments) {
      const x0 = xOf(s.from), x1 = xOf(s.to);
      ctx.fillStyle = COLORS[s.phase];
      // Overlap by a hair to avoid seams.
      ctx.fillRect(Math.floor(x0), T, Math.ceil(x1) - Math.floor(x0) + 0.5, plotH);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(L, T, pw, plotH); ctx.clip();

    // Cloud cover hanging from the top.
    if (overlays.clouds) {
      const maxDepth = plotH * 0.25;
      const pts = [];
      for (let t = start; t <= end; t += 10 * MIN) {
        const v = store.instantAt(t);
        pts.push(v ? { x: xOf(t), d: (v.cloud / 100) * maxDepth } : null);
      }
      drawRuns(ctx, pts, (run) => {
        ctx.beginPath();
        ctx.moveTo(run[0].x, T);
        for (const p of run) ctx.lineTo(p.x, T + p.d);
        ctx.lineTo(run[run.length - 1].x, T);
        ctx.closePath();
        ctx.fillStyle = COLORS.cloud;
        ctx.fill();
      });
    }

    // Aurora potential rising from the bottom, only while dark.
    if (overlays.kp && store.kp.length) {
      const maxH = plotH * 0.5;
      const pts = sun.samples.map((s) => {
        const k = smoothKp(store, s.t);
        return k ? { x: xOf(s.t), h: (k.kp / 9) * maxH * darkness(s.elev), rough: k.rough } : null;
      });
      for (const rough of [false, true]) {
        drawRuns(ctx, pts.map((p) => (p && p.rough === rough ? p : null)), (run) => {
          ctx.beginPath();
          ctx.moveTo(run[0].x, B);
          for (const p of run) ctx.lineTo(p.x, B - p.h);
          ctx.lineTo(run[run.length - 1].x, B);
          ctx.closePath();
          ctx.fillStyle = rough ? COLORS.kpRough : COLORS.kp;
          ctx.fill();
        });
      }
    }

    // Horizon and sun path.
    ctx.strokeStyle = COLORS.horizon; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, Math.round(mid) + 0.5); ctx.lineTo(R, Math.round(mid) + 0.5); ctx.stroke();
    if (overlays.sunCurve) {
      ctx.strokeStyle = COLORS.curve; ctx.lineWidth = 1;
      ctx.beginPath();
      sun.samples.forEach((s, i) => (i ? ctx.lineTo(xOf(s.t), yOf(s.elev)) : ctx.moveTo(xOf(s.t), yOf(s.elev))));
      ctx.stroke();
    }

    // Moon path: fainter and dashed so the sun's curve stays the main line.
    if (overlays.moon && m.moon) {
      ctx.strokeStyle = COLORS.moonCurve; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath();
      m.moon.samples.forEach((s, i) => (i ? ctx.lineTo(xOf(s.t), yOf(s.elev)) : ctx.moveTo(xOf(s.t), yOf(s.elev))));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Moon and sun discs (sun in front) follow their curves. The moon slides out of the frame (clipped) when
    // off-scale; the sun stops half-way out at the bottom edge so it always marks the time.
    let moonDisc = null;
    if (overlays.moon && m.moon) {
      const mr = Math.max(7, Math.min(10, plotH / 20));
      const mp = moonPosition(m.viewT, m.lat, m.lon);
      moonDisc = { x: xOf(m.viewT), y: yOf(mp.elevation), r: mr };
      ctx.save();
      ctx.translate(moonDisc.x, moonDisc.y);
      ctx.globalAlpha = mp.elevation < 0 ? 0.5 : 1;
      ctx.fillStyle = COLORS.moonDark;
      ctx.beginPath(); ctx.arc(0, 0, mr, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = 'rgba(200,220,255,0.7)'; ctx.shadowBlur = mr * 1.2;
      ctx.fillStyle = COLORS.moonLit;
      ctx.fill(new Path2D(litPath(mr, moonIllumination(m.viewT), m.lat < 0)));
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(0, 0, mr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(220,230,255,0.35)'; ctx.lineWidth = 0.75; ctx.stroke();
      ctx.restore();
    }

    {
      const r = Math.max(8, Math.min(11, plotH / 18));
      // Never lower than half-hidden by the bottom edge, so it still marks the time.
      const sx = xOf(m.viewT), sy = Math.min(B, yOf(elevationAt(sun, m.viewT)));
      ctx.save();
      // See-through where it covers the moon, so the moon stays visible behind it.
      if (moonDisc) {
        const d = Math.hypot(sx - moonDisc.x, sy - moonDisc.y), touch = r + moonDisc.r;
        if (d < touch) ctx.globalAlpha = SUN_MIN_ALPHA + (1 - SUN_MIN_ALPHA) * (d / touch) ** 2;
      }
      ctx.shadowColor = 'rgba(255,170,0,0.85)';
      ctx.shadowBlur = r * 1.6;
      const g = ctx.createRadialGradient(sx - r * 0.3, sy - r * 0.3, r * 0.1, sx, sy, r);
      g.addColorStop(0, '#fff1a8');
      g.addColorStop(0.45, '#ffc21a');
      g.addColorStop(1, '#ff9500');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }


    // Tide: mean sea level on the horizon line, high water up.
    if (overlays.tide && store.tide?.points?.length) {
      const maxAbs = Math.max(30, ...store.tide.points.map((p) => Math.abs(p.level)));
      const yH = (cm) => mid - (cm / (maxAbs * 1.15)) * (plotH / 2);
      const nodes = withinDay(store.tide.points, start, end, 2 * HOUR).map((p) => ({ t: p.t, x: xOf(p.t), y: yH(p.level) }));
      ctx.strokeStyle = COLORS.tide; ctx.lineWidth = LINE_W;
      for (const run of splitGaps(nodes, 3 * HOUR)) strokeSmooth(ctx, run);
      // High/low water times.
      ctx.font = LABEL_FONT_SMALL;
      for (const e of store.tide.extremes.filter((e) => e.t >= start && e.t < end)) {
        const x = xOf(e.t), y = yH(store.tideAt(e.t)?.level ?? e.level);
        ctx.textAlign = x < L + 20 ? 'left' : x > R - 20 ? 'right' : 'center';
        ctx.textBaseline = e.type === 'high' ? 'bottom' : 'top';
        outlinedText(ctx, clock(e.t), x, Math.min(B - 12, Math.max(T + 12, e.type === 'high' ? y - 3 : y + 3)), COLORS.tide);
      }
    }

    // Temperature: the horizon doubles as 0 °C (freezing), warm above, cold below.
    if (overlays.temperature && store.instants.length) {
      const maxAbs = Math.max(...store.instants.map((i) => Math.abs(i.temp)));
      const tScale = Math.max(15, Math.ceil(maxAbs * 1.15));
      const yT = (c) => mid - (c / tScale) * (plotH / 2);
      // Smooth curve through the actual data points (hourly / 6-hourly), one stroke whose
      // colour switches at the 0 °C line — no seams, even thickness.
      const nodes = withinDay(store.instants, start, end, 7 * HOUR).map((p) => ({ t: p.t, x: xOf(p.t), y: yT(p.temp), c: p.temp }));
      const grad = ctx.createLinearGradient(0, T, 0, B);
      const f0 = (mid - T) / plotH;
      grad.addColorStop(0, COLORS.warm); grad.addColorStop(f0, COLORS.warm);
      grad.addColorStop(f0, COLORS.cold); grad.addColorStop(1, COLORS.cold);
      ctx.strokeStyle = grad; ctx.lineWidth = LINE_W;
      for (const run of splitGaps(nodes, 7 * HOUR)) strokeSmooth(ctx, run);

      // Day's high and low (data points inside the day).
      const valid = nodes.filter((p) => p.t >= start && p.t < end);
      if (valid.length > 1) {
        const hi = valid.reduce((a, b) => (b.c > a.c ? b : a));
        const lo = valid.reduce((a, b) => (b.c < a.c ? b : a));
        ctx.font = LABEL_FONT;
        for (const [p, above] of [[hi, true], [lo, false]]) {
          if (hi === lo && !above) continue;
          ctx.textAlign = p.x < L + 20 ? 'left' : p.x > R - 20 ? 'right' : 'center';
          ctx.textBaseline = above ? 'bottom' : 'top';
          const y = Math.min(B - 14, Math.max(T + 14, above ? p.y - 4 : p.y + 4));
          outlinedText(ctx, tempShort(p.c), p.x, y, p.c >= 0 ? COLORS.warm : COLORS.cold);
        }
      }
      // Freezing-point tag on the horizon line.
      ctx.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(fmtTemp(0), R - 4, mid - 2);

    }
    ctx.restore();

    // Frame.
    ctx.strokeStyle = COLORS.frame; ctx.lineWidth = 1;
    ctx.strokeRect(L + 0.5, T + 0.5, pw - 1, plotH - 1);

    // Precipitation bars rising above the top edge.
    if (overlays.precipitation) {
      const bars = store.precipIn(start, end);
      const rate = (p, v) => v / ((p.to - p.from) / HOUR);
      // Hours the nowcast covers show its amount (see DataStore.precipShown).
      const blocks = bars.map((p) => store.precipShown(p, m.nowT));
      // Fixed square-root scale, the same every day, so a bar's height always means the
      // same amount: light (< 1 mm/h) stays low, heavy (≥ 4 mm/h, MET's bands as in
      // weather.js) is over two-thirds up, and PRECIP_FULL or more fills the strip.
      // Anything above, including a larger "up to", is cut off at the top.
      const hOf = (r) => Math.min(PRECIP_H - 2, Math.sqrt(r / PRECIP_FULL) * (PRECIP_H - 2));
      // Edges snapped to device pixels, so neighbouring blocks meet without a seam.
      const snap = (v) => Math.round(v * dpr) / dpr;
      const geo = blocks.map((p) => {
        const h = p.amount > 0 ? Math.max(2, hOf(rate(p, p.amount))) : 0;
        const hMax = p.max != null && p.max > p.amount ? Math.max(h + 2, hOf(rate(p, p.max))) : h;
        return { x0: snap(Math.max(L, xOf(p.from))), x1: snap(Math.min(R, xOf(p.to))), bar: snap(T - h), top: snap(T - hMax), up: hMax > h };
      });
      for (const g of geo) {
        if (g.bar < T) { ctx.fillStyle = COLORS.precip; ctx.fillRect(g.x0, g.bar, g.x1 - g.x0, T - g.bar); }
      }
      // "Up to": diagonal stripes inside one outline around each run of neighbouring
      // blocks (top and outer sides, open onto the bars), so it reads as a possible
      // range rather than more precipitation.
      ctx.fillStyle = stripes(ctx, COLORS.precipMax);
      for (const g of geo) if (g.up) ctx.fillRect(g.x0, g.top, g.x1 - g.x0, g.bar - g.top);
      ctx.strokeStyle = COLORS.precipMax; ctx.lineWidth = 1;
      const o = 0.5; // centre the 1 px line on the box's edge pixels
      for (let i = 0; i < geo.length; i++) {
        if (!geo[i].up) continue;
        let j = i;
        while (j + 1 < geo.length && geo[j + 1].up && Math.abs(geo[j + 1].x0 - geo[j].x1) < 0.5) j++;
        ctx.beginPath();
        ctx.moveTo(geo[i].x0 + o, geo[i].bar);
        ctx.lineTo(geo[i].x0 + o, geo[i].top + o);
        for (let k = i; k <= j; k++) {
          ctx.lineTo(geo[k].x1 - (k === j ? o : 0), geo[k].top + o);
          if (k < j) ctx.lineTo(geo[k].x1, geo[k + 1].top + o);
        }
        ctx.lineTo(geo[j].x1 - o, geo[j].bar);
        ctx.stroke();
        i = j;
      }
    }

    // Hour labels.
    ctx.font = '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.fillStyle = COLORS.label;
    ctx.textBaseline = 'top';
    const p = zonedParts(m.tz, start + HOUR * 2);
    const labelHours = W < 420 ? [0, 12, 24] : [0, 6, 12, 18, 24];
    for (const h of labelHours) {
      const t = h === 24 ? end : zonedToUtc(m.tz, p.y, p.m, p.d, h);
      const x = xOf(t);
      ctx.textAlign = h === 0 ? 'left' : h === 24 ? 'right' : 'center';
      ctx.fillText(`${String(h).padStart(2, '0')}:00`, h === 0 ? L - 2 : h === 24 ? R + 2 : x, B + 8);
    }

    // "Now" marker when the sun isn't already showing it.
    if (m.nowT >= start && m.nowT < end && m.scrubbing) {
      const x = xOf(m.nowT);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.moveTo(x, B + 1); ctx.lineTo(x - 4, B + 6); ctx.lineTo(x + 4, B + 6); ctx.closePath(); ctx.fill();
    }

    // Scrub cursor.
    if (m.scrubbing) {
      const x = Math.round(xOf(m.viewT)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
      const label = clock(m.viewT);
      ctx.font = 'bold 11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      const tw = ctx.measureText(label).width + 10;
      const lx = Math.min(R - tw, Math.max(L, x - tw / 2));
      ctx.fillStyle = '#2b2b2b';
      roundRect(ctx, lx, B + 4, tw, 17, 4); ctx.fill();
      ctx.fillStyle = '#eee'; ctx.textAlign = 'center';
      ctx.fillText(label, lx + tw / 2, B + 7);
    }


    this.canvas.setAttribute('aria-valuetext', clock(m.viewT));
  }
}

/** A repeating diagonal-stripe fill (6 px spacing), cached per colour. */
const stripeCache = new Map();
function stripes(ctx, color) {
  let pat = stripeCache.get(color);
  if (!pat) {
    const t = document.createElement('canvas');
    t.width = t.height = 6;
    const g = t.getContext('2d');
    g.strokeStyle = color; g.lineWidth = 1.2;
    g.beginPath();
    // One diagonal plus its wrapped corners, so tiles join seamlessly.
    g.moveTo(-1, 7); g.lineTo(7, -1);
    g.moveTo(-1, 1); g.lineTo(1, -1);
    g.moveTo(5, 7); g.lineTo(7, 5);
    g.stroke();
    pat = ctx.createPattern(t, 'repeat');
    stripeCache.set(color, pat);
  }
  return pat;
}

/** Data points inside [start, end] plus one neighbour on each side (within `reach`) so curves run to the edges. */
function withinDay(points, start, end, reach) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.t >= start && p.t <= end) out.push(p);
    else if (p.t < start && points[i + 1]?.t >= start && start - p.t <= reach) out.push(p);
    else if (p.t > end && points[i - 1]?.t <= end && p.t - end <= reach) { out.push(p); break; }
  }
  return out;
}

function splitGaps(nodes, maxGap) {
  const runs = [[]];
  for (const n of nodes) {
    const run = runs[runs.length - 1];
    if (run.length && n.t - run[run.length - 1].t > maxGap) runs.push([n]); else run.push(n);
  }
  return runs.filter((r) => r.length > 1);
}

/** Monotone cubic (Fritsch–Carlson) through the points: smooth, never overshoots the data. */
function strokeSmooth(ctx, p) {
  const n = p.length;
  const m = [];
  for (let i = 0; i < n - 1; i++) m.push((p[i + 1].y - p[i].y) / (p[i + 1].x - p[i].x));
  const tg = p.map((_, i) => (i === 0 ? m[0] : i === n - 1 ? m[n - 2] : m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { tg[i] = tg[i + 1] = 0; continue; }
    const a = tg[i] / m[i], b = tg[i + 1] / m[i], h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); tg[i] = k * a * m[i]; tg[i + 1] = k * b * m[i]; }
  }
  ctx.beginPath();
  ctx.moveTo(p[0].x, p[0].y);
  for (let i = 0; i < n - 1; i++) {
    const dx = (p[i + 1].x - p[i].x) / 3;
    ctx.bezierCurveTo(p[i].x + dx, p[i].y + tg[i] * dx, p[i + 1].x - dx, p[i + 1].y - tg[i + 1] * dx, p[i + 1].x, p[i + 1].y);
  }
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.stroke();
}

/** Draw contiguous non-null runs of points. */
function drawRuns(ctx, pts, fn) {
  let run = [];
  for (const p of pts) {
    if (p) run.push(p);
    else if (run.length) { if (run.length > 1) fn(run); run = []; }
  }
  if (run.length > 1) fn(run);
}

/** 0 in daylight → 1 when dark enough for aurora; eases across −3° … −9° (centred on −6°). */
function darkness(elev) {
  const f = Math.min(1, Math.max(0, (-3 - elev) / 6));
  return f * f * (3 - 2 * f);
}

/** Kp at t with short ramps between 3-hour blocks. */
function smoothKp(store, t) {
  const vals = [-15, 0, 15].map((d) => store.kpAt(t + d * MIN)).filter(Boolean);
  if (!vals.length) return null;
  return { kp: vals.reduce((s, b) => s + b.kp, 0) / vals.length, rough: vals.some((b) => b.kind === 'outlook27') };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
