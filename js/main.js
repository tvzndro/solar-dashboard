// App bootstrap: wires config, data, graphic, cards, cameras and settings together.

import { Config } from './config.js';
import { setLanguage, t } from './i18n.js';
import * as f from './format.js';
import { DataStore } from './data/store.js';
import { DayGraphic } from './graphic.js';
import { renderCards, SNOW_WINDOWS } from './cards.js';
import { Cameras } from './cameras.js';
import { Settings } from './settings.js';
import { sunDay } from './sun.js';
import { dayRange, browserTimeZone, isValidTimeZone, MIN, DAY } from './time.js';

const MIN_DAY = -2;
const MAX_DAY = 9;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const params = new URLSearchParams(location.search);

// Debug: ?at=2026-12-21T12:00 pretends the clock is at that (browser-local) time.
const clockShift = params.get('at') && !Number.isNaN(Date.parse(params.get('at'))) ? Date.parse(params.get('at')) - Date.now() : 0;
const clockNow = () => Date.now() + clockShift;

const config = new Config();
const state = { dayOffset: 0, scrubT: null, now: clockNow() };
let renderQueued = false;
let storeKey = null;
let sunCache = { key: null, value: null };

const store = new DataStore(() => queueRender());
const graphic = new DayGraphic($('#graphic'), { onScrub: (tt) => { state.scrubT = tt; queueRender(); } });
const cameras = new Cameras($('#cameras'));
const settings = new Settings($('#settings'), config);

function cfg() { return config.effective; }
function mockMode() { return params.get('mock') === '1' || !!cfg().debug.mock; }

function timeZone() {
  const z = cfg().location.timezone;
  if (z && isValidTimeZone(z)) return z;
  return store.timezone || browserTimeZone();
}

function ensureStore() {
  const { lat, lon } = cfg().location;
  const key = JSON.stringify([lat, lon, mockMode()]);
  if (key === storeKey) return;
  storeKey = key;
  store.start({ lat, lon, mock: mockMode(), now: clockNow });
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  const c = cfg();
  setLanguage(c.language);
  f.setUnits(c.units);
  const tz = timeZone();
  f.setTimeZone(tz);
  const { lat, lon } = c.location;
  const now = state.now = clockNow();

  const [start, end] = dayRange(tz, now, state.dayOffset);
  const [todayStart] = dayRange(tz, now, 0);
  const sKey = `${start}|${end}|${lat}|${lon}`;
  if (sunCache.key !== sKey) sunCache = { key: sKey, value: sunDay(start, end, lat, lon) };
  const sun = sunCache.value;

  const scrubbing = state.scrubT != null;
  let viewT = scrubbing ? state.scrubT : start + (now - todayStart);
  viewT = Math.min(end - 1, Math.max(start, viewT));
  const isToday = state.dayOffset === 0;

  // Header.
  document.title = `${c.location.name} — ${f.clock(viewT)}`;
  $('#place').textContent = c.location.name;
  $('#date').textContent = f.longDate(start + DAY / 2);
  $('#prev').disabled = state.dayOffset <= MIN_DAY;
  $('#next').disabled = state.dayOffset >= MAX_DAY;
  $('#prev').title = t('prevDay');
  $('#next').title = t('nextDay');
  $('#today').textContent = t('today');
  $('#today').hidden = isToday;
  $('#settings-btn').title = t('settings');
  $('#view-time').textContent = f.clock(viewT);
  const rel = Math.abs(viewT - now) < MIN ? t('now') : f.relHours(viewT - now);
  $('#view-rel').textContent = rel;
  $('#view-rel').classList.toggle('is-now', rel === t('now'));
  $('#mock-banner').hidden = !mockMode();
  $('#mock-banner').textContent = t('mockBanner');

  graphic.render({ start, end, sun, store, viewT, nowT: now, scrubbing, overlays: c.overlays, tz });

  // Overlay legend / toggles.
  const legend = $('#legend');
  const legendHtml = ['sunCurve', 'clouds', 'precipitation', 'kp'].map((k) =>
    `<button type="button" class="chip chip-${k} ${c.overlays[k] ? 'on' : ''}" data-overlay="${k}" aria-pressed="${!!c.overlays[k]}">${t(`ov_${k}`)}</button>`).join('');
  if (legend._html !== legendHtml) { legend.innerHTML = legendHtml; legend._html = legendHtml; legend.setAttribute('aria-label', t('s_overlayLegend')); }

  // Day strip for quick navigation.
  const strip = $('#days');
  const stripHtml = Array.from({ length: MAX_DAY - MIN_DAY + 1 }, (_, i) => {
    const off = MIN_DAY + i;
    const [ds] = dayRange(tz, now, off);
    const label = off === 0 ? t('today') : f.shortDay(ds + DAY / 2);
    return `<button type="button" data-day="${off}" class="${off === state.dayOffset ? 'on' : ''} ${off < 0 ? 'past' : ''}">${label}</button>`;
  }).join('');
  if (strip._html !== stripHtml) { strip.innerHTML = stripHtml; strip._html = stripHtml; strip.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }

  const snowWindow = SNOW_WINDOWS.includes(c.snowWindowHours) ? c.snowWindowHours : 12;
  renderCards($('#cards'), {
    store, sun, viewT, nowT: now, lat, lon, scrubbing, isToday, snowWindow,
    units: c.units, showSources: c.debug.showSources,
  }, c.layout.cards);

  cameras.update({ images: c.cameras.images, streams: c.cameras.streams, showCameras: c.layout.showCameras, showStreams: c.layout.showStreams });

  // Status line.
  const srcs = Object.values(store.sources);
  const failed = Object.entries(store.sources).filter(([, s]) => s.status === 'error' || s.status === 'stale');
  const last = Math.max(0, ...srcs.map((s) => s.fetchedAt || 0));
  $('#status').innerHTML = [
    store.loading ? `<span>${t('loading')}</span>` : '',
    last ? `<span>${t('updated')} ${f.clock(last)}</span>` : '',
    ...failed.map(([n, s]) => `<span class="warn" title="${esc(s.error)}">${t(`src_${n}`)}: ${t('failed')}</span>`),
  ].filter(Boolean).join(' · ');
}

// ── Events ────────────────────────────────────────────────────────────────
config.onChange(() => { ensureStore(); settings.refresh(); queueRender(); });

$('#prev').addEventListener('click', () => { state.dayOffset = Math.max(MIN_DAY, state.dayOffset - 1); state.scrubT = null; queueRender(); });
$('#next').addEventListener('click', () => { state.dayOffset = Math.min(MAX_DAY, state.dayOffset + 1); state.scrubT = null; queueRender(); });
$('#today').addEventListener('click', () => { state.dayOffset = 0; state.scrubT = null; queueRender(); });
$('#settings-btn').addEventListener('click', () => settings.open());
$('#days').addEventListener('click', (e) => {
  const b = e.target.closest('[data-day]');
  if (b) { state.dayOffset = +b.dataset.day; state.scrubT = null; queueRender(); }
});
$('#legend').addEventListener('click', (e) => {
  const b = e.target.closest('[data-overlay]');
  if (b) config.set(`overlays.${b.dataset.overlay}`, !cfg().overlays[b.dataset.overlay]);
});
$('#cards').addEventListener('click', (e) => {
  const b = e.target.closest('[data-action=snow-window]');
  if (b) config.set('snowWindowHours', Number(b.dataset.value));
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, dialog, canvas')) return;
  if (e.key === 'ArrowLeft' && !$('#prev').disabled) $('#prev').click();
  else if (e.key === 'ArrowRight' && !$('#next').disabled) $('#next').click();
  else if (e.key === 't' || e.key === 'Home') $('#today').click();
});

// Clock tick; refresh data when the tab wakes up after a long sleep.
setInterval(queueRender, 20_000);
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > 10 * MIN) store.refreshAll();
  queueRender();
});
// Pick up changes to the shared config.json without a reload.
setInterval(() => config.loadShared(), 30 * MIN);

// ── Start ─────────────────────────────────────────────────────────────────
(async () => {
  setLanguage(cfg().language);
  await config.loadShared();
  ensureStore();
  render();
})();
