// Webcam images (periodically refreshed) and YouTube live streams (autoplay, muted).

import { t } from './i18n.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Accepts a video ID, a channel ID (UC…), or any common YouTube URL. */
export function youtubeEmbedUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const params = `autoplay=1&mute=1&playsinline=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
  let m;
  if ((m = s.match(/(?:channel\/|^)(UC[\w-]{22})/))) return `https://www.youtube.com/embed/live_stream?channel=${m[1]}&${params}`;
  if ((m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/embed\/|\/shorts\/)([\w-]{11})/))) return `https://www.youtube.com/embed/${m[1]}?${params}`;
  if (/^[\w-]{11}$/.test(s)) return `https://www.youtube.com/embed/${s}?${params}`;
  return null;
}

// ── Live-edge keeping ───────────────────────────────────────────────────
// YouTube sometimes starts a live embed somewhere in its DVR buffer (e.g. the
// viewer's remembered position) instead of at "live". We watch the player and
// jump to the live edge whenever it starts playing, and if it drifts behind.
const LIVE_LAG_START = 20;   // s behind live tolerated when playback starts
const LIVE_LAG_DRIFT = 90;   // s behind live tolerated while running
let ytApi = null;
function loadYouTubeApi() {
  if (!ytApi) {
    ytApi = new Promise((resolve) => {
      if (window.YT?.Player) return resolve(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
  }
  return ytApi;
}

function liveLag(p) {
  try {
    if (p.getVideoData?.().isLive !== true) return 0; // only ever touch live streams
    return p.getDuration() - p.getCurrentTime();
  } catch { return 0; }
}

function goLive(p, tolerance) {
  if (liveLag(p) > tolerance) { try { p.seekTo(p.getDuration(), true); } catch { /* player gone */ } }
}

function bust(url) {
  return url + (url.includes('?') ? '&' : '?') + '_ts=' + Math.floor(Date.now() / 1000);
}

const IDLE_TIMEOUT = 60_000; // pause a camera/stream after this long out of view

export class Cameras {
  constructor(container) {
    this.el = container;
    this.key = null;
    this.timers = [];
    this.items = [];
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const item = this.items.find((it) => it.el === e.target);
        if (item) { item.inView = e.isIntersecting; this.#sync(item); }
      }
    });
    document.addEventListener('visibilitychange', () => {
      for (const item of this.items) this.#sync(item);
      // Coming back to the tab: snap running streams back to live.
      if (!document.hidden) for (const it of this.items) if (it.player && it.active) goLive(it.player, LIVE_LAG_START);
    });
  }

  /**
   * Each camera/stream is "active" while visible. After IDLE_TIMEOUT out of view
   * (scrolled away or tab hidden) it is suspended; it resumes when seen again.
   */
  #sync(item) {
    const visible = item.inView && !document.hidden;
    if (visible) {
      clearTimeout(item.idleTimer); item.idleTimer = null;
      if (!item.active) { item.active = true; item.resume(); }
    } else if (item.active && !item.idleTimer) {
      item.idleTimer = setTimeout(() => { item.idleTimer = null; item.active = false; item.suspend(); }, IDLE_TIMEOUT);
    }
  }

  /** Only rebuilds when the camera config actually changed, so streams keep playing. */
  update({ images, streams, showCameras, showStreams }) {
    const key = JSON.stringify([images, streams, showCameras, showStreams, t('cameras')]);
    if (key === this.key) return;
    this.key = key;
    for (const tm of this.timers) clearInterval(tm);
    this.timers = [];
    for (const it of this.items) {
      clearTimeout(it.idleTimer); it.suspend();
      try { it.player?.destroy(); } catch { /* ignore */ }
    }
    this.items = [];
    this.observer.disconnect();

    const parts = [];
    const imgs = showCameras ? images.filter((c) => c.url) : [];
    const strs = showStreams ? streams.map((s) => ({ ...s, embed: youtubeEmbedUrl(s.youtube) })).filter((s) => s.embed) : [];
    if (strs.length) {
      parts.push(`<h2 class="section-title">${esc(t('streams'))}</h2><div class="stream-grid">${strs.map((s) => `
        <figure class="stream">
          <div class="frame"><iframe src="${esc(s.embed)}" title="${esc(s.name || 'YouTube')}"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>
          ${s.name ? `<figcaption>${esc(s.name)}</figcaption>` : ''}
        </figure>`).join('')}</div>`);
    }
    if (imgs.length) {
      parts.push(`<h2 class="section-title">${esc(t('cameras'))}</h2><div class="cam-grid">${imgs.map((c, i) => `
        <figure class="cam" data-i="${i}">
          <img alt="${esc(c.name || '')}" decoding="async">
          <div class="cam-error" hidden>${esc(t('camError'))}</div>
          <figcaption>${esc(c.name || '')}</figcaption>
        </figure>`).join('')}</div>`);
    }
    this.el.innerHTML = parts.join('');
    this.el.hidden = !parts.length;

    // Streams: pause when idle, play again (at the live edge) when seen.
    for (const fig of this.el.querySelectorAll('.stream')) {
      const item = {
        el: fig, inView: false, active: true, player: null,
        suspend: () => { try { item.player?.pauseVideo(); } catch { /* not ready */ } },
        resume: () => { try { item.player?.playVideo(); } catch { /* not ready */ } },
      };
      this.items.push(item);
    }
    const streamItems = this.items.slice();
    if (streamItems.length) this.#attachPlayers(streamItems, key);

    // Webcam images: refresh periodically while active.
    this.el.querySelectorAll('.cam').forEach((fig) => {
      const cam = imgs[+fig.dataset.i];
      const img = fig.querySelector('img');
      const err = fig.querySelector('.cam-error');
      const every = Math.max(10, cam.refreshSeconds || 60) * 1000;
      let lastLoad = 0;
      // Load into a detached image first so a failed refresh keeps the last good frame.
      const load = () => {
        lastLoad = Date.now();
        const probe = new Image();
        probe.onload = () => { img.src = probe.src; err.hidden = true; fig.classList.remove('failed'); };
        probe.onerror = () => { if (!img.src) { err.hidden = false; fig.classList.add('failed'); } };
        probe.src = bust(cam.url);
      };
      const item = {
        el: fig, inView: false, active: true, interval: null,
        suspend: () => { clearInterval(item.interval); item.interval = null; },
        resume: () => {
          if (Date.now() - lastLoad >= every) load();
          clearInterval(item.interval);
          item.interval = setInterval(load, every);
        },
      };
      load();
      item.resume();
      this.items.push(item);
      fig.addEventListener('click', () => fig.classList.toggle('wide'));
    });

    // Everything starts active; anything not seen within IDLE_TIMEOUT gets suspended.
    for (const item of this.items) { this.observer.observe(item.el); this.#sync(item); }
  }

  async #attachPlayers(items, key) {
    const YT = await loadYouTubeApi();
    if (key !== this.key) return; // config changed meanwhile
    for (const item of items) {
      item.player = new YT.Player(item.el.querySelector('iframe'), {
        events: {
          onReady: (e) => { if (!item.active) e.target.pauseVideo(); },
          onStateChange: (e) => { if (e.data === YT.PlayerState.PLAYING) goLive(e.target, LIVE_LAG_START); },
        },
      });
    }
    // Catch drift (stalls, sleeping laptop) and re-sync running streams.
    this.timers.push(setInterval(() => {
      if (document.hidden) return;
      for (const it of items) {
        try { if (it.active && it.player?.getPlayerState?.() === YT.PlayerState.PLAYING) goLive(it.player, LIVE_LAG_DRIFT); } catch { /* not ready */ }
      }
    }, 60_000));
  }
}
