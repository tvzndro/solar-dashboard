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

export class Cameras {
  constructor(container) {
    this.el = container;
    this.key = null;
    this.timers = [];
    this.players = [];
    // Coming back to the tab: snap streams back to live.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) for (const p of this.players) goLive(p, LIVE_LAG_START);
    });
  }

  /** Only rebuilds when the camera config actually changed, so streams keep playing. */
  update({ images, streams, showCameras, showStreams }) {
    const key = JSON.stringify([images, streams, showCameras, showStreams, t('cameras')]);
    if (key === this.key) return;
    this.key = key;
    for (const tm of this.timers) clearInterval(tm);
    this.timers = [];
    for (const p of this.players || []) { try { p.destroy(); } catch { /* ignore */ } }
    this.players = [];

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

    const frames = [...this.el.querySelectorAll('.stream iframe')];
    if (frames.length) this.#attachPlayers(frames, key);

    this.el.querySelectorAll('.cam').forEach((fig) => {
      const cam = imgs[+fig.dataset.i];
      const img = fig.querySelector('img');
      const err = fig.querySelector('.cam-error');
      // Load into a detached image first so a failed refresh keeps the last good frame.
      const load = () => {
        const probe = new Image();
        probe.onload = () => { img.src = probe.src; err.hidden = true; fig.classList.remove('failed'); };
        probe.onerror = () => { if (!img.src) { err.hidden = false; fig.classList.add('failed'); } };
        probe.src = bust(cam.url);
      };
      load();
      this.timers.push(setInterval(() => { if (!document.hidden) load(); }, Math.max(10, cam.refreshSeconds || 60) * 1000));
      fig.addEventListener('click', () => fig.classList.toggle('wide'));
    });
  }

  async #attachPlayers(frames, key) {
    const YT = await loadYouTubeApi();
    if (key !== this.key) return; // config changed meanwhile
    for (const iframe of frames) {
      const player = new YT.Player(iframe, {
        events: {
          onStateChange: (e) => { if (e.data === YT.PlayerState.PLAYING) goLive(e.target, LIVE_LAG_START); },
        },
      });
      this.players.push(player);
    }
    // Catch drift (stalls, sleeping laptop, background tab) and re-sync.
    this.timers.push(setInterval(() => {
      if (document.hidden) return;
      for (const p of this.players) {
        try { if (p.getPlayerState?.() === YT.PlayerState.PLAYING) goLive(p, LIVE_LAG_DRIFT); } catch { /* not ready */ }
      }
    }, 60_000));
  }
}
