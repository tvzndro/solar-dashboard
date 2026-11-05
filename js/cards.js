// Info cards. Each renderer returns an HTML string for the card body.

import { t } from './i18n.js';
import * as f from './format.js';
import { HOUR, MIN } from './time.js';
import { elevationAt, phaseOf, sunPosition } from './sun.js';
import { moonPosition, moonIllumination, phaseKey, litPath } from './moon.js';
import { beaufort, feelsLike, precipType, intensity, shortTermOutlook, kpNeeded, auroraChance } from './weather.js';

export const SNOW_WINDOWS = [3, 6, 12, 24, 48];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function srcLabel(src) {
  return Array.isArray(src) ? src.map((s) => t(`src_${s}`)).join(' + ') : t(`src_${src}`);
}

/** A value, annotated with its source when "show sources" is on. */
function makeV(ctx) {
  return (text, src, detail) => {
    if (!ctx.showSources || !src) return esc(text);
    const info = ctx.store.sources[Array.isArray(src) ? src[0] : src];
    const parts = [`${t('sourceOf')}: ${srcLabel(src)}`];
    if (detail) parts.push(detail);
    if (info?.fetchedAt) parts.push(`${t('fetched')} ${f.clock(info.fetchedAt)}`);
    return `<span class="v-src" data-src="${esc(Array.isArray(src) ? src.join(',') : src)}" title="${esc(parts.join('\n'))}">${esc(text)}</span>`;
  };
}

const row = (label, value) => `<div class="row"><span class="lbl">${esc(label)}</span><span class="val">${value}</span></div>`;
const span = (from, to) => `${f.clock(from)}–${f.clock(to)}`;

function sunCard(ctx) {
  const v = makeV(ctx);
  const { sun, viewT, lat, lon } = ctx;
  const pos = sunPosition(viewT, lat, lon);
  const elev = pos.elevation;
  const rising = elevationAt(sun, viewT + 5 * MIN) > elev;
  const phase = phaseOf(elev);
  let times;
  if (sun.polar === 'night') times = `<p class="note">${esc(t('polarNight'))}</p>`;
  else if (sun.polar === 'midnightSun') times = `<p class="note">${esc(t('midnightSun'))}</p>`;
  else {
    times = row(t('sunrise'), sun.sunrise ? v(f.clock(sun.sunrise), 'sun') : esc(t('noSunrise')))
      + row(t('sunset'), sun.sunset ? v(f.clock(sun.sunset), 'sun') : esc(t('noSunset')));
  }
  return `
    <div class="wind-head">
      <svg class="wind-arrow sun-arrow ${elev < 0 ? 'below' : ''}" viewBox="-12 -12 24 24" style="transform: rotate(${pos.azimuth}deg)" aria-hidden="true">
        <path d="M0 -10 L6 6 L0 2 L-6 6 Z" />
      </svg>
      <div class="big">${esc(t(`phase_${phase}`))} <span class="trend">${rising ? '↗' : '↘'} ${esc(t(rising ? 'rising' : 'setting'))}</span></div>
    </div>
    ${row(t('elevation'), v(f.deg(elev, 1), 'sun'))}
    ${row(t('direction'), v(`${f.deg(pos.azimuth)} ${f.compass(pos.azimuth)}`, 'sun'))}
    ${times}
    ${row(t('dayLength'), v(f.duration(sun.dayLength), 'sun'))}
    <p class="sub">${esc(t('highestAt', f.deg(sun.maxElev, 1), f.clock(sun.noon)))}</p>`;
}

function moonCard(ctx) {
  const v = makeV(ctx);
  const { moon, viewT, lat, lon } = ctx;
  const pos = moonPosition(viewT, lat, lon);
  const ill = moonIllumination(viewT);
  const rising = moonPosition(viewT + 5 * MIN, lat, lon).elevation > pos.elevation;
  const r = 15;
  let times;
  if (moon.always === 'up') times = `<p class="note">${esc(t('moonAlwaysUp'))}</p>`;
  else if (moon.always === 'down') times = `<p class="note">${esc(t('moonAlwaysDown'))}</p>`;
  else {
    times = row(t('moonrise'), moon.rise ? v(f.clock(moon.rise), 'sun') : '—')
      + row(t('moonset'), moon.set ? v(f.clock(moon.set), 'sun') : '—');
  }
  return `
    <div class="wind-head">
      <svg class="wind-arrow moon-arrow ${pos.elevation < 0 ? 'below' : ''}" viewBox="-12 -12 24 24" style="transform: rotate(${pos.azimuth}deg)" aria-hidden="true">
        <path d="M0 -10 L6 6 L0 2 L-6 6 Z" />
      </svg>
      <div class="big">${esc(t(`moon_${phaseKey(ill.phase)}`))}</div>
      <svg class="moon-icon" viewBox="${-r - 1} ${-r - 1} ${2 * r + 2} ${2 * r + 2}" aria-hidden="true">
        <circle r="${r}" class="moon-dark" />
        <path d="${litPath(r, ill, lat < 0)}" class="moon-lit" />
      </svg>
    </div>
    ${row(t('illumination'), v(f.pct(ill.fraction * 100), 'sun'))}
    ${row(t('elevation'), v(f.deg(pos.elevation, 1), 'sun') + ` <span class="trend">${rising ? '↗' : '↘'}</span>`)}
    ${row(t('direction'), v(`${f.deg(pos.azimuth)} ${f.compass(pos.azimuth)}`, 'sun'))}
    ${times}`;
}

function weatherCard(ctx) {
  const v = makeV(ctx);
  const w = ctx.store.instantAt(ctx.viewT);
  const p = ctx.store.precipAt(ctx.viewT);
  if (!w) return `<p class="empty">${esc(t('noData'))}</p>`;
  const feels = feelsLike(w.temp, w.wind, w.rh);
  const instDetail = span(w.from, w.to);
  let precipText = '—';
  if (p) {
    const hrs = (p.to - p.from) / HOUR;
    const rate = p.amount / hrs;
    const type = precipType(w.temp, p.snow > 0);
    precipText = rate > 0
      ? `${f.precip(rate)}${t('perHour')} ${t('ptype')[type]}`
      : f.precip(0);
    if (p.max != null && p.max > p.amount) precipText += ` (${t('likelyMax')} ${f.precip(p.max / hrs)})`;
  }
  return `
    <div class="big">${v(f.tempPrecise(w.temp), w.src, instDetail)}</div>
    ${row(t('feelsLike'), v(f.temp(feels), 'derived', `${srcLabel(w.src)} → wind chill / apparent temperature`))}
    ${row(t('cloudCover'), v(f.pct(w.cloud), w.src, instDetail))}
    ${row(t('precipitation'), p ? v(precipText, p.src, span(p.from, p.to)) : '—')}
    ${w.rh != null ? row(t('humidity'), v(f.pct(w.rh), w.src, instDetail)) : ''}`;
}

function windCard(ctx) {
  const v = makeV(ctx);
  const w = ctx.store.instantAt(ctx.viewT);
  if (!w) return `<p class="empty">${esc(t('noData'))}</p>`;
  const bf = beaufort(w.wind);
  const detail = span(w.from, w.to);
  return `
    <div class="wind-head">
      <svg class="wind-arrow" viewBox="-12 -12 24 24" style="transform: rotate(${(w.dir + 180) % 360}deg)" aria-hidden="true">
        <path d="M0 -10 L6 6 L0 2 L-6 6 Z" />
      </svg>
      <div>
        <div class="big">${v(f.speed(w.wind), w.src, detail)}</div>
        <div class="sub">${esc(t('beaufort')[bf])} · Beaufort ${bf}</div>
      </div>
    </div>
    ${w.gust != null ? row(t('gusts'), v(f.speed(w.gust), w.src, detail)) : ''}
    ${row(t('direction'), v(`${t('from')} ${f.compass(w.dir)} (${f.deg(w.dir)})`, w.src, detail))}`;
}

function outlookCard(ctx) {
  const v = makeV(ctx);
  const nc = ctx.store.nowcast;
  const temp = ctx.store.instantAt(ctx.nowT)?.temp;
  const o = shortTermOutlook(nc, ctx.nowT, temp);
  if (!o) return `<p class="empty">${esc(t('noOutlook'))}</p>`;
  const what = (o.rate != null) ? `${t('intensity')[intensity(o.rate)]} ${t('ptype')[o.type]}` : '';
  const text = {
    start: () => t('startsIn', what, f.relMinutes(o.inMs)),
    stop: () => t('stopsIn', what, f.relMinutes(o.inMs)),
    continues: () => t('continues', what, f.relMinutes(o.inMs)),
    dry: () => t('dry', f.relMinutes(o.horizonMs)),
  }[o.kind]();
  const steps = o.steps;
  const maxRate = Math.max(2, ...steps.map((s) => s.rate));
  const bars = steps.map((s) => `<i style="height:${Math.max(s.rate > 0 ? 2 : 0, (s.rate / maxRate) * 100)}%" title="${esc(f.clock(s.t))}: ${esc(f.precip(s.rate))}${esc(t('perHour'))}"></i>`).join('');
  const notNow = ctx.scrubbing || !ctx.isToday;
  return `
    <div class="big outlook-text">${v(text, nc.src)}</div>
    <div class="spark" aria-hidden="true">${bars}</div>
    <div class="spark-axis"><span>${esc(f.clock(steps[0].t))}</span><span>${esc(f.clock(steps[steps.length - 1].t + nc.stepMs))}</span></div>
    ${notNow ? `<p class="note">${esc(t('outlookAlwaysNow'))}</p>` : ''}`;
}

function auroraCard(ctx) {
  const v = makeV(ctx);
  const { store, sun, viewT, lat } = ctx;
  const b = store.kpAt(viewT);
  const need = kpNeeded(lat);
  // Max over the dark part of the viewed day.
  const dark = sun.segments.filter((s) => ['night', 'astronomical', 'nautical'].includes(s.phase));
  let maxDark = null;
  for (const s of dark) for (const k of store.kpIn(s.from, s.to)) if (!maxDark || k.kp > maxDark.kp) maxDark = k;
  const kindLabel = (k) => t(k.kind === 'observed' ? 'observed' : k.kind === 'predicted' ? 'predicted' : 'outlook27');
  let head;
  if (b) {
    const w = store.instantAt(viewT);
    const c = auroraChance(b.kp, lat, elevationAt(sun, viewT), w?.cloud);
    const chance = c.dark
      ? `<div class="chance chance-${c.level}">${esc(t('chance')[c.level])}${c.cloudy ? ` <span class="sub">(${esc(t('cloudy'))})</span>` : ''}</div>`
      : `<div class="chance chance-none">${esc(t('tooBright'))}</div>`;
    head = `
      <div class="big">Kp ${v(f.num(b.kp, 1), b.src, b.kind === 'outlook27' ? kindLabel(b) : `${span(b.from, b.to)} · ${kindLabel(b)}`)} <span class="tag tag-${b.kind}">${esc(kindLabel(b))}</span></div>
      ${chance}`;
  } else head = `<p class="empty">${esc(t('noKp'))}</p>`;
  return `
    ${head}
    ${dark.length
      ? row(t('maxDark'), maxDark ? v(`Kp ${f.num(maxDark.kp, 1)}${maxDark.kind === 'outlook27' ? '' : ` · ${span(maxDark.from, maxDark.to)}`}`, maxDark.src, kindLabel(maxDark)) : '—')
      : `<p class="note">${esc(t('noDark'))}</p>`}
    <p class="sub">${esc(t('kpNeeded', need))}</p>`;
}

function snowCard(ctx) {
  const v = makeV(ctx);
  const n = ctx.snowWindow;
  const H = n * HOUR;
  const past = ctx.store.snowBetween(ctx.viewT - H, ctx.viewT);
  const next = ctx.store.snowBetween(ctx.viewT, ctx.viewT + H);
  const fmt = (s) => (!s.srcs.length ? '—' : s.cm < 0.05 ? t('snowNone') : f.snow(s.cm)) + (s.srcs.length && !s.complete ? '*' : '');
  const i = SNOW_WINDOWS.indexOf(n);
  return `
    <div class="snow-grid">
      <div><div class="lbl">${esc(t('past'))} ${esc(t('hours', n))}</div><div class="big">${v(fmt(past), past.srcs, 'snow from precipitation × temperature')}</div></div>
      <div><div class="lbl">${esc(t('next'))} ${esc(t('hours', n))}</div><div class="big">${v(fmt(next), next.srcs, 'snow from precipitation × temperature')}</div></div>
    </div>
    <div class="stepper">
      <button type="button" data-action="snow-window" data-value="${SNOW_WINDOWS[Math.max(0, i - 1)]}" ${i <= 0 ? 'disabled' : ''} aria-label="−">−</button>
      <span>${esc(t('hours', n))}</span>
      <button type="button" data-action="snow-window" data-value="${SNOW_WINDOWS[Math.min(SNOW_WINDOWS.length - 1, i + 1)]}" ${i >= SNOW_WINDOWS.length - 1 ? 'disabled' : ''} aria-label="+">+</button>
    </div>
    <p class="note">${esc(t('snowNote'))}</p>`;
}

function tideCard(ctx) {
  const v = makeV(ctx);
  const { store, viewT } = ctx;
  const cur = store.tideAt(viewT);
  if (!cur) return `<p class="empty">${esc(t('noData'))}</p>`;
  const { high, low } = store.nextTides(viewT);
  const ext = (e) => (e ? v(`${f.clock(e.t)} · ${f.tideLevel(e.level)}`, cur.src, f.shortDay(e.t)) : '—');
  const nextFirst = high && low && low.t < high.t ? [['nextLow', low], ['nextHigh', high]] : [['nextHigh', high], ['nextLow', low]];
  const surge = cur.level - cur.tide;
  const station = store.tide.station;
  return `
    <div class="big">${v(f.tideLevel(cur.level), cur.src, `${t(`tide_${cur.kind}`)} · ${t('relMsl')}`)}
      <span class="trend">${cur.rising ? '↗' : '↘'} ${esc(t(cur.rising ? 'tideRising' : 'tideFalling'))}</span></div>
    ${nextFirst.map(([k, e]) => row(t(k), ext(e))).join('')}
    ${Math.abs(surge) >= 1 ? row(t('weatherEffect'), v(f.tideLevel(surge), cur.src, t('weatherEffectHint'))) : ''}
    <p class="sub">${esc(t('relMsl'))}${station ? ` · ${esc(station)}` : ''} · ${esc(t(`src_${cur.src}`))}</p>`;
}

function sourcesCard(ctx) {
  const entries = Object.entries(ctx.store.sources);
  const items = entries.map(([name, s]) => {
    const status = s.status === 'ok' ? `${t('fetched')} ${f.clock(s.fetchedAt)}`
      : s.status === 'loading' ? t('loading')
      : `${t('failed')}: ${s.error}${s.fetchedAt ? ` (${t('fetched')} ${f.clock(s.fetchedAt)})` : ''}`;
    const note = s.note ? ` · ${t(s.note)}` : '';
    return `<li class="src-${s.status}"><b>${esc(t(`src_${name}`))}</b><br><span class="sub">${esc(status + note)}</span>
      ${s.url ? `<br><a href="${esc(s.url)}" target="_blank" rel="noopener" class="sub">${esc(s.url.replace(/^https:\/\//, '').slice(0, 60))}…</a>` : ''}</li>`;
  });
  items.push(`<li><b>${esc(t('src_sun'))}</b><br><span class="sub">NOAA solar position algorithm</span></li>`);
  return `<ul class="sources">${items.join('')}</ul>`;
}

export const CARDS = {
  sun: sunCard, moon: moonCard, weather: weatherCard, wind: windCard, outlook: outlookCard,
  aurora: auroraCard, tide: tideCard, snow: snowCard, sources: sourcesCard,
};

export function renderCards(container, ctx, layout) {
  const ids = layout.filter((c) => c.visible && !ctx.hidden?.has(c.id)).map((c) => c.id);
  const html = ids.map((id) => {
    let body;
    try { body = CARDS[id](ctx); } catch (err) { console.error(err); body = `<p class="empty">${esc(String(err))}</p>`; }
    return `<section class="card card-${id}"><h2>${esc(t(`card_${id}`))}</h2>${body}</section>`;
  }).join('');
  if (container._html !== html) { container.innerHTML = html; container._html = html; }
}
