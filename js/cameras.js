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

// ── Keeping live streams near live ──────────────────────────────────────
// YouTube sometimes starts a live embed far back in its DVR buffer, and a
// paused or stalled stream falls behind. We measure the real delay with
// getMediaReferenceTime() (wall-clock time of the frame on screen) and, only
// when it is well over a minute, seek forward once to ~30 s behind live.
// Normal live latency is ~15–25 s, so ordinary playback is never touched.
// (getDuration() is NOT usable for this: on live streams it is frozen and can
// be off by an hour, which caused seek loops — buffering and flicker.)
const MAX_LAG = 90;          // s behind live before we step in
const TARGET_LAG = 30;       // s behind live to land at (safely inside the buffer)
const SETTLE_MS = 8_000;     // let playback settle before measuring
const COOLDOWN_MS = 180_000; // at most one correction per stream per 3 min
const MAX_FAILURES = 3;      // stop trying if corrections don't stick

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

/** Seconds the displayed frame is behind real time, or null if unknown / not live. */
function liveLag(p) {
  try {
    if (p.getVideoData?.().isLive !== true) return null;
    const ref = p.getMediaReferenceTime?.();
    if (!ref) return null;
    const lag = Date.now() / 1000 - ref;
    return lag > -120 && lag < 7 * 86400 ? Math.max(0, lag) : null; // ignore nonsense / clock skew
  } catch { return null; }
}

/** One correction attempt, guarded by cooldown and a failure limit (no seek loops). */
function keepLive(item) {
  const p = item.player;
  try { if (!p || p.getPlayerState() !== 1 /* PLAYING */) return; } catch { return; }
  const lag = liveLag(p);
  if (lag == null) return;
  if (lag <= MAX_LAG) { item.failures = 0; return; }
  if (item.failures >= MAX_FAILURES || Date.now() - (item.lastFix || 0) < COOLDOWN_MS) return;
  item.lastFix = Date.now();
  item.failures = (item.failures || 0) + 1;
  try { p.seekTo(p.getCurrentTime() + (lag - TARGET_LAG), true); } catch { /* player gone */ }
}

function scheduleKeepLive(item) {
  clearTimeout(item.settleTimer);
  item.settleTimer = setTimeout(() => keepLive(item), SETTLE_MS);
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
      // Coming back to the tab: check running streams haven't fallen behind.
      if (!document.hidden) for (const it of this.items) if (it.player && it.active) scheduleKeepLive(it);
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
      clearTimeout(it.idleTimer); clearTimeout(it.settleTimer); it.suspend();
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
        resume: () => { item.failures = 0; try { item.player?.playVideo(); } catch { /* not ready */ } },
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
          onStateChange: (e) => { if (e.data === YT.PlayerState.PLAYING) scheduleKeepLive(item); },
        },
      });
    }
    // Catch slow drift (stalls, sleeping laptop).
    this.timers.push(setInterval(() => {
      if (!document.hidden) for (const it of items) if (it.active) keepLive(it);
    }, 60_000));
  }
}
