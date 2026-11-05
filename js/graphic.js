// The day graphic: light-phase bands, sun path and disc, clouds hanging from
// the top, precipitation bars above it, aurora (Kp) rising from the bottom.
// Hover / drag scrubs; leaving returns to now.

import { zonedParts, zonedToUtc, MIN, HOUR } from './time.js';
import { elevationAt } from './sun.js';
import { clock } from './format.js';

const COLORS = {
  night: '#060608',
  astronomical: '#161a2e',
  nautical: '#1d2b52',
  civil: '#274b98',
  day: '#3a86ff',
  cloud: 'rgba(118,118,118,0.96)',
  precip: '#0a84c8',
  precipMax: 'rgba(18,90,130,0.85)',
  kp: 'rgba(16,185,80,0.5)',
  kpRough: 'rgba(16,185,80,0.28)',
  frame: 'rgba(255,255,255,0.16)',
  horizon: 'rgba(255,255,255,0.32)',
  curve: 'rgba(255,255,255,0.5)',
  label: '#8a8a8a',
};

const PRECIP_H = 40;
const LABEL_H = 26;
const PAD_X = 10;
const TOUCH_HOLD = 3000;

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
        if (s.elev >= -6) return null;
        const k = smoothKp(store, s.t);
        return k ? { x: xOf(s.t), h: (k.kp / 9) * maxH, rough: k.rough } : null;
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
    ctx.restore();

    // Frame.
    ctx.strokeStyle = COLORS.frame; ctx.lineWidth = 1;
    ctx.strokeRect(L + 0.5, T + 0.5, pw - 1, plotH - 1);

    // Precipitation bars rising above the top edge.
    if (overlays.precipitation) {
      const bars = store.precipIn(start, end);
      const rate = (p, v) => v / ((p.to - p.from) / HOUR);
      const top = Math.max(2, ...bars.map((p) => rate(p, Math.max(p.amount, p.max ?? 0))));
      const hOf = (r) => Math.min(PRECIP_H - 2, (r / top) * (PRECIP_H - 2));
      for (const p of bars) {
        const x0 = Math.max(L, xOf(p.from)), x1 = Math.min(R, xOf(p.to));
        const h = p.amount > 0 ? Math.max(2, hOf(rate(p, p.amount))) : 0;
        const hMax = p.max != null && p.max > p.amount ? Math.max(h + 2, hOf(rate(p, p.max))) : h;
        if (hMax > h) { ctx.fillStyle = COLORS.precipMax; ctx.fillRect(x0, T - hMax, x1 - x0, hMax - h); }
        if (h > 0) { ctx.fillStyle = COLORS.precip; ctx.fillRect(x0, T - h, x1 - x0, h); }
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

    // The sun disc, pinned to the edge when far below (or above) the frame.
    const r = Math.max(8, Math.min(11, plotH / 18));
    const sx = Math.min(R - r * 0.4, Math.max(L + r * 0.4, xOf(m.viewT)));
    const sy = Math.min(B - r, Math.max(T + r, yOf(elevationAt(sun, m.viewT))));
    ctx.save();
    ctx.shadowColor = 'rgba(255,170,0,0.85)';
    ctx.shadowBlur = r * 1.6;
    const g = ctx.createRadialGradient(sx - r * 0.3, sy - r * 0.3, r * 0.1, sx, sy, r);
    g.addColorStop(0, '#fff1a8');
    g.addColorStop(0.45, '#ffc21a');
    g.addColorStop(1, '#ff9500');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    this.canvas.setAttribute('aria-valuetext', clock(m.viewT));
  }
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
