// Settings dialog. Every control writes a local override; markers show what
// differs from the shared config.json, with per-item and global reset.

import { t, language } from './i18n.js';
import { getPath } from './config.js';
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
    dialog.addEventListener('click', (e) => this.#onClick(e));
    dialog.addEventListener('change', (e) => this.#onChange(e));
    dialog.addEventListener('input', (e) => { if (e.target.matches('[data-search]')) this.#search(e.target.value); });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // backdrop
    // Enter in a text field would submit the dialog form (= close); commit the field instead.
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox])')) { e.preventDefault(); e.target.blur(); }
    });
  }

  open() { this.#build(); this.dlg.showModal(); }

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
            ${c.cameras.streams.map((s, i) => `
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
    const body = this.dlg.querySelector('.settings-body');
    if (body) body.scrollTop = scrollTop;
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
      const list = cfg.get(`cameras.${el.dataset.cam}`).map((x) => ({ ...x }));
      const v = el.dataset.field === 'refreshSeconds' ? Math.max(10, Number(el.value) || 60) : el.value.trim();
      list[+el.dataset.i][el.dataset.field] = v;
      cfg.set(`cameras.${el.dataset.cam}`, list);
      this.#refreshMarkers();
    }
  }

  async #onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const cfg = this.config;
    const act = btn.dataset.act;
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
      const list = cfg.get(`cameras.${btn.dataset.list}`);
      list.push(btn.dataset.list === 'images' ? { name: '', url: '', refreshSeconds: 60 } : { name: '', youtube: '' });
      cfg.set(`cameras.${btn.dataset.list}`, list);
      this.#build();
    } else if (act === 'cam-remove') {
      const list = cfg.get(`cameras.${btn.dataset.list}`);
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
