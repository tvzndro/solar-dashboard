// Optional shared config (config.json next to index.html — not in the repo by
// default) + per-browser overrides (localStorage). Objects merge deeply; arrays
// and scalars are replaced whole. The built-in defaults hold no location or
// cameras: a fresh browser starts with the settings dialog open.

import { canonicalStreamLink } from './cameras.js';
import { presetFor } from './presets.js';

const LS_KEY = 'solar-dashboard.overrides.v1';

export const BUILTIN_DEFAULTS = {
  location: null,
  units: 'metric',
  language: 'en',
  layout: {
    cards: ['sun', 'moon', 'weather', 'wind', 'outlook', 'aurora', 'tide', 'snow'].map((id) => ({ id, visible: true })),
    showCameras: true,
    showStreams: true,
  },
  overlays: { sunCurve: true, moon: true, temperature: true, tide: true, clouds: true, precipitation: true, kp: true },
  snowWindowHours: 12,
  cameras: { images: [], streams: null }, // streams: null = the location's default streams (presets.js)
  debug: { showSources: false, mock: false },
};

export const ALL_CARDS = ['sun', 'moon', 'weather', 'wind', 'outlook', 'aurora', 'tide', 'snow', 'sources'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return clone(over === undefined ? base : over);
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : clone(v);
  return out;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
  o[keys[keys.length - 1]] = value;
}

function deletePath(obj, path) {
  const keys = path.split('.');
  const stack = [obj];
  let o = obj;
  for (const k of keys.slice(0, -1)) { if (!isObj(o[k])) return; o = o[k]; stack.push(o); }
  delete o[keys[keys.length - 1]];
  // Prune now-empty parents.
  for (let i = keys.length - 2; i >= 0; i--) {
    if (Object.keys(stack[i + 1]).length === 0) delete stack[i][keys[i]];
  }
}

function leafPaths(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) out.push(...leafPaths(v, p)); else out.push(p);
  }
  return out;
}

/**
 * Ensure the layout contains every known card exactly once. Cards added in a
 * newer version are inserted after their predecessor and shown (except the
 * debug-only Data sources card).
 */
function normaliseLayout(cfg) {
  const seen = new Set();
  const cards = (cfg.layout?.cards || []).filter((c) => ALL_CARDS.includes(c.id) && !seen.has(c.id) && seen.add(c.id));
  ALL_CARDS.forEach((id, i) => {
    if (seen.has(id)) return;
    const after = cards.findIndex((c) => c.id === ALL_CARDS[i - 1]);
    cards.splice(after + 1, 0, { id, visible: id !== 'sources' });
  });
  cfg.layout.cards = cards;
  return cfg;
}

/** The stream list in effect: the user's own list, or the default streams for the location. */
export function streamsFor(cfg) {
  if (Array.isArray(cfg.cameras?.streams)) return cfg.cameras.streams;
  return presetFor(cfg.location)?.streams || [];
}

function canonicalStreams(list) {
  return Array.isArray(list) ? list.map((s) => ({ ...s, youtube: canonicalStreamLink(s.youtube) })) : list;
}

export function hasLocation(loc) {
  return !!loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon);
}

export class Config {
  constructor() {
    this.shared = normaliseLayout(clone(BUILTIN_DEFAULTS));
    this.sharedLoaded = false;
    this.sharedError = null;
    this.overrides = this.#readOverrides();
    // Tidy saved stream links (tracking parameters etc.) to their canonical form.
    const saved = this.overrides.cameras?.streams;
    if (Array.isArray(saved) && JSON.stringify(canonicalStreams(saved)) !== JSON.stringify(saved)) {
      this.overrides.cameras.streams = canonicalStreams(saved);
      try { localStorage.setItem(LS_KEY, JSON.stringify(this.overrides)); } catch { /* private mode */ }
    }
    this.listeners = new Set();
  }

  #readOverrides() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
  }

  #save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.overrides)); } catch { /* private mode */ }
    this.#emit();
  }

  #emit() { for (const fn of this.listeners) fn(this.effective); }

  onChange(fn) { this.listeners.add(fn); }

  async loadShared() {
    try {
      const res = await fetch('config.json', { cache: 'no-cache' });
      // No shared config deployed is normal: everything comes from this browser.
      const json = res.status === 404 ? {} : res.ok ? await res.json() : null;
      if (!json) throw new Error(`HTTP ${res.status}`);
      this.sharedPresent = res.ok;
      const next = normaliseLayout(deepMerge(BUILTIN_DEFAULTS, json));
      const changed = !deepEqual(next, this.shared);
      this.shared = next;
      this.sharedLoaded = true;
      this.sharedError = null;
      if (changed) this.#emit();
    } catch (err) {
      this.sharedError = String(err.message || err);
    }
  }

  get effective() { return normaliseLayout(deepMerge(this.shared, this.overrides)); }

  get(path) { return getPath(this.effective, path); }

  /** Set a local override. Setting a value equal to the shared one removes the override. */
  set(path, value) {
    if (deepEqual(value, getPath(this.shared, path))) deletePath(this.overrides, path);
    else setPath(this.overrides, path, clone(value));
    this.#save();
  }

  reset(path) { deletePath(this.overrides, path); this.#save(); }

  resetAll() { this.overrides = {}; this.#save(); }

  /** Paths overridden locally whose value actually differs from the shared config. */
  overriddenPaths() {
    return leafPaths(this.overrides).filter((p) => !deepEqual(getPath(this.overrides, p), getPath(this.shared, p)));
  }

  isOverridden(path) {
    return this.overriddenPaths().some((p) => p === path || p.startsWith(path + '.') || path.startsWith(p + '.'));
  }

  get hasLocation() { return hasLocation(this.effective.location); }

  /** Replace this browser's settings with an exported config file. */
  importJson(text) {
    const obj = JSON.parse(text);
    if (!isObj(obj)) throw new Error('Not a config object');
    const known = Object.keys(BUILTIN_DEFAULTS);
    const clean = Object.fromEntries(Object.entries(obj).filter(([k]) => known.includes(k)));
    if (!Object.keys(clean).length) throw new Error('No recognised settings in file');
    if (clean.location && !hasLocation(clean.location)) throw new Error('Location needs numeric lat and lon');
    if (Array.isArray(clean.cameras?.streams)) clean.cameras = { ...clean.cameras, streams: canonicalStreams(clean.cameras.streams) };
    this.overrides = clean;
    this.#save();
  }

  /** The effective config, formatted as a drop-in replacement for config.json. */
  exportJson() { return JSON.stringify(this.effective, null, 2) + '\n'; }
}
