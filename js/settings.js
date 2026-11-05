// Settings dialog. Every control writes a local override; markers show what
// differs from the shared config.json, with per-item and global reset.

import { t, language } from './i18n.js';
import { getPath, streamsFor } from './config.js';
import { canonicalStreamLink, streamTitle, videoIdOf } from './cameras.js';
import { loadCatalog, findCameras } from './catalog.js';
import { geocode } from './data/fetchers.js';
import { SNOW_WINDOWS } from './cards.js';
import { isValidTimeZone } from './time.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Settings {
  constructor(dialog, config) {
    this.dlg = dialog;
    this.config = config;
    this.searchAbort = null;
    this.searchTimer = null;
    this.catalogUI = { radius: 25, query: '', more: false, open: {} }; // camera picker state (not saved)
    dialog.addEventListener('click', (e) => this.#onClick(e));
    dialog.addEventListener('toggle', (e) => {
      const g = e.target.dataset?.group;
      if (g) this.catalogUI.open[g] = e.target.open;
    }, true);
    // Larger preview while hovering (or tapping) a camera thumbnail.
    dialog.addEventListener('mouseover', (e) => { const img = e.target.closest?.('.cat-list img'); if (img) this.#preview(img); });
    dialog.addEventListener('mouseout', (e) => { if (e.target.closest?.('.cat-list img')) this.#preview(null); });
    dialog.addEventListener('click', (e) => {
      const img = e.target.closest?.('.cat-list img');
      if (img) this.#preview(this.previewFor === img ? null : img);
      else if (this.previewFor) this.#preview(null);
    });
    dialog.addEventListener('close', () => this.#preview(null));
    dialog.addEventListener('change', (e) => this.#onChange(e));
    dialog.addEventListener('input', (e) => {
      if (e.target.matches('[data-search]')) this.#search(e.target.value);
      if (e.target.matches('[data-catalog-query]')) {
        if (!this.catalogUI.query && e.target.value) this.catalogUI.open = { stream: true, image: true };
        this.catalogUI.query = e.target.value; this.catalogUI.more = false;
        clearTimeout(this.catalogTimer); this.catalogTimer = setTimeout(() => this.#renderCatalog(), 150);
      }
    });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // backdrop
    // Enter in a text field would submit the dialog form (= close); commit the field instead.
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox])')) { e.preventDefault(); e.target.blur(); }
    });
  }

  open() {
    this.catalogUI.open = {}; // camera lists start minimised
    this.#build();
    this.dlg.showModal();
  }

  get isOpen() { return this.dlg.open; }

  /** Called when config changes from elsewhere (e.g. shared config reloaded). */
  refresh() { if (this.isOpen) this.#build(); }

  marker(path) {
    // "local" only means something when a shared config.json is deployed.
    if (!this.config.sharedPresent || !this.config.isOverridden(path)) return '<span class="marker" data-for="' + esc(path) + '"></span>';
    return `<span class="marker on" data-for="${esc(path)}"><span class="pill">${esc(t('s_local'))}</span>`
      + `<button type="button" class="link" data-act="reset" data-path="${esc(path)}" title="${esc(t('s_reset'))}">↺</button></span>`;
  }

  #refreshMarkers() {
    for (const m of this.dlg.querySelectorAll('.marker')) m.outerHTML = this.marker(m.dataset.for);
    const cfgSec = this.dlg.querySelector('[data-section=config]');
    if (cfgSec) cfgSec.innerHTML = this.#configSection();
  }

  #build() {
    const c = this.config.effective;
    const loc = c.location || {};
    const scrollTop = this.dlg.querySelector('.settings-body')?.scrollTop ?? 0;
    const check = (path, label) => `<label class="check"><input type="checkbox" data-bind="${path}" ${getPath(c, path) ? 'checked' : ''}> ${esc(label)} ${this.marker(path)}</label>`;
    this.dlg.innerHTML = `
      <form method="dialog" class="settings">
        <header><h2>${esc(t('settings'))}</h2><button class="icon" value="close" aria-label="${esc(t('s_close'))}">✕</button></header>
        <div class="settings-body">
          ${!this.config.hasLocation ? `<p class="welcome-note">${esc(t('s_welcome'))}
            <button type="button" data-act="import">${esc(t('s_import'))}</button></p>` : ''}
          ${this.config.sharedError ? `<p class="warn">${esc(t('s_sharedError'))} (${esc(this.config.sharedError)})</p>` : ''}
          <fieldset><legend>${esc(t('s_location'))} ${this.marker('location')}</legend>
            <div class="search">
              <input type="search" data-search placeholder="${esc(t('s_search'))}" autocomplete="off">
              <button type="button" data-act="geo">${esc(t('s_useMine'))}</button>
            </div>
            <ul class="results" data-results></ul>
            <div class="grid4">
              <label>${esc(t('s_name'))}<input data-loc="name" value="${esc(loc.name)}"></label>
              <label>${esc(t('s_lat'))}<input data-loc="lat" inputmode="decimal" value="${esc(loc.lat)}"></label>
              <label>${esc(t('s_lon'))}<input data-loc="lon" inputmode="decimal" value="${esc(loc.lon)}"></label>
              <label>${esc(t('s_tz'))}<input data-loc="timezone" value="${esc(loc.timezone)}" placeholder="Europe/Oslo"></label>
            </div>
          </fieldset>

          <fieldset><legend>${esc(t('s_units'))} / ${esc(t('s_language'))}</legend>
            <div class="grid2">
              <label>${esc(t('s_units'))} ${this.marker('units')}
                <select data-bind="units">
                  <option value="metric" ${c.units === 'metric' ? 'selected' : ''}>${esc(t('metric'))}</option>
                  <option value="imperial" ${c.units === 'imperial' ? 'selected' : ''}>${esc(t('imperial'))}</option>
                </select></label>
              <label>${esc(t('s_language'))} ${this.marker('language')}
                <select data-bind="language">
                  <option value="en" ${c.language === 'en' ? 'selected' : ''}>English</option>
                  <option value="nb" ${c.language === 'nb' ? 'selected' : ''}>Norsk (bokmål)</option>
                </select></label>
            </div>
          </fieldset>

          <fieldset><legend>${esc(t('s_layout'))} ${this.marker('layout.cards')}</legend>
            <p class="hint">${esc(t('s_layoutHint'))} ${esc(t('s_snowHint'))}</p>
            <ol class="card-list">
              ${c.layout.cards.map((card, i, arr) => `
                <li>
                  <label class="check"><input type="checkbox" data-card="${card.id}" ${card.visible ? 'checked' : ''}> ${esc(t(`card_${card.id}`))}</label>
                  <span class="order">
                    <button type="button" class="icon" data-act="card-move" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="${esc(t('s_up'))}">↑</button>
                    <button type="button" class="icon" data-act="card-move" data-i="${i}" data-d="1" ${i === arr.length - 1 ? 'disabled' : ''} aria-label="${esc(t('s_down'))}">↓</button>
                  </span>
                </li>`).join('')}
            </ol>
            <label>${esc(t('s_snowWindow'))} ${this.marker('snowWindowHours')}
              <select data-bind="snowWindowHours" data-type="number">
                ${SNOW_WINDOWS.map((n) => `<option value="${n}" ${c.snowWindowHours === n ? 'selected' : ''}>${n} h</option>`).join('')}
              </select></label>
          </fieldset>

          <fieldset><legend>${esc(t('s_overlays'))}</legend>
            ${['sunCurve', 'moon', 'temperature', 'tide', 'clouds', 'precipitation', 'kp'].map((k) => check(`overlays.${k}`, t(`ov_${k}`))).join('')}
          </fieldset>

          <fieldset><legend>${esc(t('s_cameras'))}</legend>
            ${check('layout.showCameras', t('s_showCameras'))}
            ${check('layout.showStreams', t('s_showStreams'))}
            <h3>${esc(t('s_nearby'))}</h3>
            <div class="catalog-controls">
              <input type="search" data-catalog-query placeholder="${esc(t('s_catalogSearch'))}" value="${esc(this.catalogUI.query)}" autocomplete="off">
              <select data-catalog-radius aria-label="${esc(t('s_radius'))}">
                ${[10, 25, 50, 100].map((n) => `<option value="${n}" ${this.catalogUI.radius === n ? 'selected' : ''}>${n} km</option>`).join('')}
              </select>
            </div>
            <div class="catalog" data-catalog><p class="hint">${esc(t('loading'))}</p></div>
            <h3>${esc(t('s_images'))} ${this.marker('cameras.images')}</h3>
            ${c.cameras.images.map((cam, i) => `
              <div class="cam-row">
                <input data-cam="images" data-i="${i}" data-field="name" value="${esc(cam.name)}" placeholder="${esc(t('s_name'))}">
                <input data-cam="images" data-i="${i}" data-field="url" value="${esc(cam.url)}" placeholder="${esc(t('s_url'))}" class="wide">
                <input data-cam="images" data-i="${i}" data-field="refreshSeconds" type="number" min="10" value="${esc(cam.refreshSeconds ?? 60)}" title="${esc(t('s_refresh'))}" class="narrow">
                <button type="button" class="icon" data-act="cam-remove" data-list="images" data-i="${i}" aria-label="${esc(t('s_remove'))}">✕</button>
              </div>`).join('')}
            <button type="button" data-act="cam-add" data-list="images">+ ${esc(t('s_add'))}</button>
            <h3>${esc(t('s_streamList'))} ${this.marker('cameras.streams')}</h3>
            <p class="hint">${esc(t('s_streamHint'))}</p>
            <label>${esc(t('s_streamIdle'))} ${this.marker('cameras.streamIdleMinutes')}
              <select data-bind="cameras.streamIdleMinutes" data-type="number">
                ${[1, 5, 15, 60].map((n) => `<option value="${n}" ${c.cameras.streamIdleMinutes === n ? 'selected' : ''}>${n} min</option>`).join('')}
              </select></label>
            <p class="hint">${esc(t('s_streamIdleHint'))}</p>
            ${streamsFor(c).map((s, i) => `
              <div class="cam-row">
                <input data-cam="streams" data-i="${i}" data-field="name" value="${esc(s.name)}" placeholder="${esc(t('s_name'))}">
                <input data-cam="streams" data-i="${i}" data-field="youtube" value="${esc(s.youtube)}" placeholder="${esc(t('s_youtube'))}" class="wide">
                <button type="button" class="icon" data-act="cam-remove" data-list="streams" data-i="${i}" aria-label="${esc(t('s_remove'))}">✕</button>
              </div>`).join('')}
            <button type="button" data-act="cam-add" data-list="streams">+ ${esc(t('s_add'))}</button>
          </fieldset>

          <fieldset><legend>${esc(t('s_debug'))}</legend>
            ${check('debug.showSources', t('s_showSources'))}
            ${check('debug.mock', t('s_mock'))}
          </fieldset>

          <fieldset data-section="config">${this.#configSection()}</fieldset>
        </div>
      </form>`;
    // Restore the scroll position only once the camera list has been drawn (otherwise the
    // shorter dialog clamps it and the view jumps to the bottom).
    this.pendingScroll = scrollTop;
    this.#renderCatalog();
  }

  #configSection() {
    const paths = this.config.overriddenPaths();
    return `<legend>${esc(t('s_config'))}</legend>
      <h3>${esc(t('s_overridden'))}</h3>
      ${paths.length ? `<ul class="overrides">${paths.map((p) => `
        <li><code>${esc(p)}</code> <button type="button" class="link" data-act="reset" data-path="${esc(p)}">${esc(t('s_reset'))}</button></li>`).join('')}</ul>
        <button type="button" data-act="reset-all">${esc(t('s_resetAll'))}</button>`
        : `<p class="hint">${esc(t('s_noOverrides'))}</p>`}
      <div class="export">
        <button type="button" data-act="import">${esc(t('s_import'))}</button>
        <button type="button" data-act="export">${esc(t('s_export'))}</button>
        <button type="button" data-act="copy">${esc(t('s_copy'))}</button>
      </div>
      <p class="hint">${esc(t('s_exportHint'))}</p>`;
  }

  #onChange(e) {
    const el = e.target;
    const cfg = this.config;
    if (el.matches('[data-catalog-radius]')) { this.catalogUI.radius = +el.value; this.catalogUI.more = false; this.#renderCatalog(); return; }
    if (el.matches('[data-catalog-query]')) return; // handled on input
    if (el.dataset.bind) {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.type === 'number') v = Number(v);
      cfg.set(el.dataset.bind, v);
      // "Show sources" also shows/hides the Data sources card; the card checkbox stays the one control for it.
      if (el.dataset.bind === 'debug.showSources') {
        cfg.set('layout.cards', cfg.get('layout.cards').map((c) => (c.id === 'sources' ? { ...c, visible: v } : c)));
      }
      this.#build();
    } else if (el.dataset.card) {
      const cards = cfg.get('layout.cards').map((c) => (c.id === el.dataset.card ? { ...c, visible: el.checked } : c));
      cfg.set('layout.cards', cards);
      this.#build();
    } else if (el.dataset.loc) {
      const loc = { ...(cfg.get('location') || {}) };
      const k = el.dataset.loc;
      if (k === 'lat' || k === 'lon') {
        const n = parseFloat(String(el.value).replace(',', '.'));
        const lim = k === 'lat' ? 90 : 180;
        if (!Number.isFinite(n) || Math.abs(n) > lim) { el.setCustomValidity('Invalid'); el.reportValidity(); return; }
        loc[k] = n;
      } else if (k === 'timezone') {
        if (el.value && !isValidTimeZone(el.value)) { el.setCustomValidity('Unknown time zone'); el.reportValidity(); return; }
        loc.timezone = el.value || undefined;
      } else loc[k] = el.value;
      if (!loc.name && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) loc.name = `${loc.lat}, ${loc.lon}`;
      el.setCustomValidity('');
      cfg.set('location', loc);
      this.#refreshMarkers();
    } else if (el.dataset.cam) {
      const list = this.#list(el.dataset.cam);
      let v = el.dataset.field === 'refreshSeconds' ? Math.max(10, Number(el.value) || 60) : el.value.trim();
      const row = list[+el.dataset.i];
      if (el.dataset.field === 'youtube') {
        v = canonicalStreamLink(v);
        el.value = v; // show the cleaned-up link
        // Name a new stream after its YouTube title.
        if (!row.name && v) {
          streamTitle(v).then((title) => {
            if (!title) return;
            const again = this.#list('streams');
            if (again[+el.dataset.i] && !again[+el.dataset.i].name) {
              again[+el.dataset.i].name = title;
              cfg.set('cameras.streams', again);
              this.#build();
            }
          });
        }
      }
      row[el.dataset.field] = v;
      cfg.set(`cameras.${el.dataset.cam}`, list);
      this.#refreshMarkers();
    }
  }

  async #onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const cfg = this.config;
    const act = btn.dataset.act;
    if (act === 'catalog-toggle') { this.#toggleCatalogCamera(JSON.parse(btn.dataset.catalogCam)); return; }
    if (act === 'catalog-more') { this.catalogUI.more = true; this.#renderCatalog(); return; }
    if (act === 'reset') { cfg.reset(btn.dataset.path); this.#build(); }
    else if (act === 'reset-all') { cfg.resetAll(); this.#build(); }
    else if (act === 'card-move') {
      const cards = cfg.get('layout.cards');
      const i = +btn.dataset.i, j = i + +btn.dataset.d;
      [cards[i], cards[j]] = [cards[j], cards[i]];
      cfg.set('layout.cards', cards);
      this.#build();
      const again = this.dlg.querySelector(`[data-act=card-move][data-i="${j}"][data-d="${btn.dataset.d}"]`);
      (again && !again.disabled ? again : this.dlg.querySelector(`[data-card="${cards[j].id}"]`))?.focus();
    } else if (act === 'cam-add') {
      const list = this.#list(btn.dataset.list);
      list.push(btn.dataset.list === 'images' ? { name: '', url: '', refreshSeconds: 60 } : { name: '', youtube: '' });
      cfg.set(`cameras.${btn.dataset.list}`, list);
      this.#build();
    } else if (act === 'cam-remove') {
      const list = this.#list(btn.dataset.list);
      list.splice(+btn.dataset.i, 1);
      cfg.set(`cameras.${btn.dataset.list}`, list);
      this.#build();
    } else if (act === 'import') {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try { cfg.importJson(await file.text()); this.#build(); }
        catch (err) { alert(`${t('s_importError')}: ${err.message}`); }
      });
      input.click();
    } else if (act === 'export') {
      const blob = new Blob([cfg.exportJson()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'solar-dashboard-config.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (act === 'copy') {
      try { await navigator.clipboard.writeText(cfg.exportJson()); btn.textContent = t('s_copied'); } catch { /* ignore */ }
    } else if (act === 'geo') {
      navigator.geolocation?.getCurrentPosition((pos) => {
        const lat = Math.round(pos.coords.latitude * 1e4) / 1e4, lon = Math.round(pos.coords.longitude * 1e4) / 1e4;
        cfg.set('location', { name: `${lat}, ${lon}`, lat, lon, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        this.#build();
      }, (err) => alert(err.message));
    } else if (act === 'pick') {
      const r = JSON.parse(btn.dataset.place);
      cfg.set('location', { name: r.name, lat: r.lat, lon: r.lon, timezone: r.timezone });
      this.#build();
    }
  }

  // ── Camera picker (catalogue from vindnå.no) ──────────────────────────
  #isAdded(cam) {
    const c = this.config.effective;
    if (cam.kind === 'stream') return streamsFor(c).some((s) => videoIdOf(s.youtube) === videoIdOf(cam.youtube));
    return c.cameras.images.some((i) => i.url === cam.image);
  }

  #toggleCatalogCamera(cam) {
    const cfg = this.config;
    if (cam.kind === 'stream') {
      const list = this.#list('streams');
      const i = list.findIndex((s) => videoIdOf(s.youtube) === videoIdOf(cam.youtube));
      if (i >= 0) list.splice(i, 1); else list.push({ name: cam.name, youtube: cam.youtube });
      cfg.set('cameras.streams', list);
      if (i < 0 && !cfg.get('layout.showStreams')) cfg.set('layout.showStreams', true);
    } else {
      const list = this.#list('images');
      const i = list.findIndex((x) => x.url === cam.image);
      if (i >= 0) list.splice(i, 1); else list.push({ name: cam.name, url: cam.image, refreshSeconds: 60 });
      cfg.set('cameras.images', list);
      if (i < 0 && !cfg.get('layout.showCameras')) cfg.set('layout.showCameras', true);
    }
    this.#build();
  }

  #restoreScroll() {
    if (this.pendingScroll == null) return;
    const body = this.dlg.querySelector('.settings-body');
    if (body) body.scrollTop = this.pendingScroll;
    this.pendingScroll = null;
  }

  async #renderCatalog() {
    const box = this.dlg.querySelector('[data-catalog]');
    if (!box) { this.#restoreScroll(); return; }
    // Draw synchronously once loaded, so rebuilding the dialog doesn't flicker or jump.
    const catalog = this.catalogData !== undefined ? this.catalogData : (this.catalogData = await loadCatalog());
    if (!this.dlg.contains(box)) return; // dialog rebuilt meanwhile
    if (!catalog) { box.innerHTML = `<p class="hint">${esc(t('s_catalogMissing'))}</p>`; this.#restoreScroll(); return; }
    const loc = this.config.effective.location;
    const { radius, query, more } = this.catalogUI;
    const found = findCameras(catalog, this.config.hasLocation ? loc : null, { radiusKm: radius, query });
    const limit = more ? 400 : 24;
    const row = (cam) => {
      const thumb = cam.kind === 'stream'
        ? `https://i.ytimg.com/vi/${videoIdOf(cam.youtube)}/mqdefault_live.jpg`
        : cam.image;
      const full = cam.kind === 'stream' ? `https://i.ytimg.com/vi/${videoIdOf(cam.youtube)}/maxresdefault_live.jpg` : cam.image;
      const added = this.#isAdded(cam);
      const where = [cam.municipality, cam.distance != null ? `${cam.distance < 10 ? cam.distance.toFixed(1) : Math.round(cam.distance)} km` : null].filter(Boolean).join(' · ');
      const data = esc(JSON.stringify({ kind: cam.kind, name: cam.name, youtube: cam.youtube, image: cam.image }));
      return `<li class="${added ? 'added' : ''}">
        <img loading="lazy" decoding="async" src="${esc(thumb)}" data-full="${esc(full)}" data-title="${esc(cam.name)}" alt="" onerror="this.style.visibility='hidden'">
        <span class="cat-text"><b>${esc(cam.name)}</b><span class="hint">${esc(where)}</span></span>
        <button type="button" data-act="catalog-toggle" data-catalog-cam="${data}">${esc(t(added ? 's_added' : 's_add'))}</button></li>`;
    };
    const group = (kind, title) => {
      const list = found.filter((c) => c.kind === kind);
      if (!list.length) return '';
      return `<details class="cat-group" data-group="${kind}" ${this.catalogUI.open[kind] ? 'open' : ''}>
        <summary>${esc(title)} <span class="hint">(${list.length})</span></summary>
        <ul class="cat-list">${list.slice(0, limit).map(row).join('')}</ul></details>`;
    };
    const body = group('stream', t('streams')) + group('image', t('cameras'));
    const total = found.length;
    box.innerHTML = (body || `<p class="hint">${esc(query ? t('s_noResults') : t('s_noNearby', radius))}</p>`)
      + (found.filter((c) => c.kind === 'stream').length > limit || found.filter((c) => c.kind === 'image').length > limit
        ? `<button type="button" class="link" data-act="catalog-more">${esc(t('s_showAll', total))}</button>` : '')
      + `<p class="hint">${esc(t('s_catalogSource', catalog.scrapedAt.slice(0, 10)))}</p>`;
    this.#restoreScroll();
  }

  /** Show a larger preview of a catalogue thumbnail next to it (null hides). */
  #preview(img) {
    this.previewFor = img;
    let box = this.dlg.querySelector('.cat-preview');
    if (!img) { if (box) box.hidden = true; return; }
    if (!box) {
      box = document.createElement('div');
      box.className = 'cat-preview';
      box.innerHTML = '<img alt=""><span></span>';
      this.dlg.appendChild(box);
    }
    const big = box.querySelector('img');
    big.onerror = () => { if (big.src !== img.src) big.src = img.src; }; // fall back to the thumbnail
    big.src = img.dataset.full;
    box.querySelector('span').textContent = img.dataset.title;
    box.hidden = false;
    // Beside the thumbnail, kept inside the viewport.
    const r = img.getBoundingClientRect(), w = Math.min(480, innerWidth - 24), h = w * 9 / 16 + 28;
    let left = r.right + 12, top = r.top + r.height / 2 - h / 2;
    if (left + w > innerWidth - 12) left = Math.max(12, r.left - w - 12);
    if (left < 12 || (left < r.right && left + w > r.left)) { left = Math.max(12, (innerWidth - w) / 2); top = r.bottom + 8; }
    box.style.width = `${w}px`;
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(12, Math.min(innerHeight - h - 12, top))}px`;
  }

  /** Editable copy of a camera list. */
  #list(kind) {
    const c = this.config.effective;
    return (kind === 'streams' ? streamsFor(c) : c.cameras.images).map((x) => ({ ...x }));
  }

  #search(q) {
    clearTimeout(this.searchTimer);
    const ul = this.dlg.querySelector('[data-results]');
    if (q.trim().length < 2) { ul.innerHTML = ''; return; }
    this.searchTimer = setTimeout(async () => {
      this.searchAbort?.abort();
      this.searchAbort = new AbortController();
      ul.innerHTML = `<li class="hint">${esc(t('s_searching'))}</li>`;
      try {
        const res = await geocode(q.trim(), language(), this.searchAbort.signal);
        ul.innerHTML = res.length ? res.map((r) => `<li><button type="button" class="link" data-act="pick" data-place="${esc(JSON.stringify(r))}">
          <b>${esc(r.name)}</b> <span class="hint">${esc(r.detail)} · ${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}</span></button></li>`).join('')
          : `<li class="hint">${esc(t('s_noResults'))}</li>`;
      } catch (err) {
        if (err.name !== 'AbortError') ul.innerHTML = `<li class="warn">${esc(err.message)}</li>`;
      }
    }, 300);
  }
}
