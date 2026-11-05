// Shared config (config.json in the repo) + per-browser overrides (localStorage).
// Objects merge deeply; arrays and scalars are replaced whole.

const LS_KEY = 'solar-dashboard.overrides.v1';

export const BUILTIN_DEFAULTS = {
  location: { name: 'Oslo', lat: 59.91, lon: 10.75, timezone: 'Europe/Oslo' },
  units: 'metric',
  language: 'en',
  layout: {
    cards: ['sun', 'weather', 'wind', 'outlook', 'aurora', 'snow'].map((id) => ({ id, visible: true })),
    showCameras: true,
    showStreams: true,
  },
  overlays: { sunCurve: true, temperature: true, clouds: true, precipitation: true, kp: true },
  snowWindowHours: 12,
  cameras: { images: [], streams: [] },
  debug: { showSources: false, mock: false },
};

export const ALL_CARDS = ['sun', 'weather', 'wind', 'outlook', 'aurora', 'snow', 'sources'];

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

/** Ensure the layout contains every known card exactly once (new cards appended hidden). */
function normaliseLayout(cfg) {
  const seen = new Set();
  const cards = (cfg.layout?.cards || []).filter((c) => ALL_CARDS.includes(c.id) && !seen.has(c.id) && seen.add(c.id));
  for (const id of ALL_CARDS) if (!seen.has(id)) cards.push({ id, visible: false });
  cfg.layout.cards = cards;
  return cfg;
}

export class Config {
  constructor() {
    this.shared = normaliseLayout(clone(BUILTIN_DEFAULTS));
    this.sharedLoaded = false;
    this.sharedError = null;
    this.overrides = this.#readOverrides();
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
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

  /** The effective config, formatted as a drop-in replacement for config.json. */
  exportJson() { return JSON.stringify(this.effective, null, 2) + '\n'; }
}
