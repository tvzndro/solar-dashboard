// Webcam images (periodically refreshed) and YouTube live streams (autoplay, muted).

import { t } from './i18n.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The canonical form of a stream link: https://www.youtube.com/watch?v=ID for a video,
 * https://www.youtube.com/channel/UC… for a channel. Drops tracking parameters (pp=, si=, t=, …).
 * Returns the input unchanged if it isn't recognisable.
 */
export function canonicalStreamLink(input) {
  const s = String(input || '').trim();
  let m;
  if ((m = s.match(/(?:channel\/|^)(UC[\w-]{22})(?:$|[/?#])/))) return `https://www.youtube.com/channel/${m[1]}`;
  if ((m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/embed\/|\/shorts\/)([\w-]{11})/)) || (m = s.match(/^([\w-]{11})$/))) {
    return `https://www.youtube.com/watch?v=${m[1]}`;
  }
  return s;
}

/** Stream title via YouTube's oEmbed (official, CORS-enabled); null if unavailable. */
export async function streamTitle(link) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonicalStreamLink(link))}`);
    return res.ok ? (await res.json()).title || null : null;
  } catch { return null; }
}

/** Accepts a video ID, a channel ID (UC…), or any common YouTube URL. */
export function youtubeEmbedUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // controls=0 + no pointer events on the iframe: YouTube's title bar / controls only show briefly at
  // start (which we cover, see REVEAL_MS) and never on hover. Mute and fullscreen are our own buttons.
  const params = 'autoplay=1&mute=1&playsinline=1&rel=0&controls=0&disablekb=1&fs=0&iv_load_policy=3'
    + `&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
  let m;
  if ((m = s.match(/(?:channel\/|^)(UC[\w-]{22})/))) return `https://www.youtube.com/embed/live_stream?channel=${m[1]}&${params}`;
  if ((m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/embed\/|\/shorts\/)([\w-]{11})/))) return `https://www.youtube.com/embed/${m[1]}?${params}`;
  if (/^[\w-]{11}$/.test(s)) return `https://www.youtube.com/embed/${s}?${params}`;
  return null;
}

// ── Keeping live streams near live ──────────────────────────────────────
// YouTube sometimes starts a live embed far back in its DVR buffer, and a
// stalled stream falls behind. We measure the real delay with
// getMediaReferenceTime() (wall-clock time of the frame on screen) and, when it
// exceeds normal live latency (~15–25 s), seek past the end: YouTube clamps that
// to the live edge. Streams out of view are *stopped* (not paused), because a
// stopped live stream restarts at the live edge while a paused one resumes late.
// (getDuration() is NOT usable for this: on live streams it is frozen and can
// be off by an hour, which caused seek loops — buffering and flicker.)
const REVEAL_MS = 5_000;     // keep a stream covered this long after it starts playing (YouTube's start overlay)
const MAX_LAG = 40;          // s behind real time before we step in (normal latency is 15–25 s)
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

/**
 * Until a stream is shown, check every second: if YouTube started it behind live
 * (it often starts at the beginning of its 12-hour DVR buffer), jump to the live
 * edge while it is still covered; reveal it only after it has played at live for
 * REVEAL_MS (which also lets YouTube's start-of-playback overlay fade).
 */
function watchUntilLive(item) {
  if (item.el.classList.contains('ready') || !item.active || !item.player) return;
  let state, data;
  try { state = item.player.getPlayerState(); data = item.player.getVideoData?.() || {}; } catch { return; }
  if (state === 0 || item.errored) { setCover(item, 'notLive'); return; } // ended / unavailable
  if (state !== 1) { item.liveSince = null; return; }
  if (data.isLive === false) { setCover(item, 'notLive'); return; }
  const lag = liveLag(item.player);
  if (lag != null && lag > MAX_LAG) {
    item.liveSince = null;
    setCover(item, 'goingLive');
    if (Date.now() - (item.lastSeek || 0) > 4000) {
      item.lastSeek = Date.now();
      try { item.player.seekTo(item.player.getCurrentTime() + lag + 60, true); } catch { /* player gone */ }
    }
    return;
  }
  item.liveSince ??= Date.now();
  if (Date.now() - item.liveSince >= REVEAL_MS) item.el.classList.add('ready');
}

function setCover(item, key) {
  const cover = item.el.querySelector('.stream-cover');
  if (cover && cover.dataset.key !== key) { cover.dataset.key = key; cover.textContent = t(key); }
  item.el.classList.toggle('dead', key === 'notLive');
}

/** One correction attempt, guarded by cooldown and a failure limit (no seek loops). */
function keepLive(item) {
  if (!item.el.classList.contains('ready')) return; // still covered: watchUntilLive handles it
  const p = item.player;
  try { if (!p || p.getPlayerState() !== 1 /* PLAYING */) return; } catch { return; }
  const lag = liveLag(p);
  if (lag == null) return;
  if (lag <= MAX_LAG) { item.failures = 0; return; }
  if (item.failures >= MAX_FAILURES || Date.now() - (item.lastFix || 0) < COOLDOWN_MS) return;
  item.lastFix = Date.now();
  item.failures = (item.failures || 0) + 1;
  try { p.seekTo(p.getCurrentTime() + lag + 60, true); } catch { /* player gone */ }
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
          <div class="frame"><iframe src="${esc(s.embed)}" title="${esc(s.name || 'YouTube')}" tabindex="-1"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>
            <div class="stream-cover" data-key="connecting">${esc(t('connecting'))}</div></div>
          <figcaption><span>${esc(s.name || '')}</span>
            <span class="stream-btns">
              <button type="button" class="icon" data-stream="mute" aria-label="${esc(t('unmute'))}" title="${esc(t('unmute'))}">🔇</button>
              <button type="button" class="icon" data-stream="full" aria-label="${esc(t('fullscreen'))}" title="${esc(t('fullscreen'))}">⛶</button>
            </span></figcaption>
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

    // Streams: stop when idle, play again (at the live edge) when seen.
    for (const fig of this.el.querySelectorAll('.stream')) {
      const item = {
        el: fig, inView: false, active: true, player: null,
        suspend: () => {
          fig.classList.remove('ready'); item.liveSince = null; setCover(item, 'connecting');
          try { item.player?.stopVideo(); } catch { /* not ready */ }
        },
        resume: () => { item.failures = 0; try { item.player?.playVideo(); } catch { /* not ready */ } },
      };
      this.items.push(item);
      // Fallback if the YouTube API never loads: show the frame anyway.
      setTimeout(() => { if (!item.player) fig.classList.add('ready'); }, 20_000);
      fig.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-stream]');
        if (!btn) return;
        if (btn.dataset.stream === 'full') {
          const frame = fig.querySelector('.frame');
          if (document.fullscreenElement) document.exitFullscreen(); else frame.requestFullscreen?.();
        } else {
          try {
            const muted = item.player.isMuted();
            if (muted) item.player.unMute(); else item.player.mute();
            btn.textContent = muted ? '🔊' : '🔇';
            btn.title = btn.ariaLabel = t(muted ? 'mute' : 'unmute');
          } catch { /* player not ready */ }
        }
      });
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
          onReady: (e) => { if (!item.active) e.target.stopVideo(); },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING) { item.errored = false; scheduleKeepLive(item); }
            if (e.data === YT.PlayerState.ENDED) { item.el.classList.remove('ready'); setCover(item, 'notLive'); }
          },
          onError: () => { item.errored = true; item.el.classList.remove('ready'); setCover(item, 'notLive'); },
        },
      });
    }
    this.timers.push(setInterval(() => { for (const it of items) watchUntilLive(it); }, 1000));
    // Catch slow drift (stalls, sleeping laptop).
    this.timers.push(setInterval(() => {
      if (!document.hidden) for (const it of items) if (it.active) keepLive(it);
    }, 60_000));
  }
}
