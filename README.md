# Solar Dashboard

A glanceable dashboard for one location: the sun, the light, the weather and aurora potential across a day you can scrub through, plus webcams and live streams.

Static site with no build step and no backend. It's plain HTML, CSS and ES modules, so deploying is just a push.

## Deploy (GitHub Pages)

1. Push this folder to a GitHub repo.
2. Go to **Settings → Pages → Deploy from a branch**, then pick the branch and `/ (root)`.
3. Bookmark the Pages URL on each machine.

`.nojekyll` is included so Pages serves the files as they are.

To run it locally you need a static server, because ES modules don't load from `file://`:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## Settings and config files

The repo contains no location, cameras or streams. On a browser's first visit the settings dialog opens automatically: search for a place (or use *Use my location*), or **Import config file…**.

Everything is saved in that browser (localStorage). To set up another machine, use **Export config file** in settings, then **Import config file…** on the other machine. Export/import covers the location, units, language, card layout, graph overlays, snowfall window, cameras, streams and debug flags.

*Optional:* a `config.json` placed next to `index.html` on the server is used as defaults for every browser (with per-browser overrides marked **local**). It is git-ignored here so personal settings aren't published by accident.

### Streams

Add YouTube streams in settings: a video ID, a channel ID (UC…) or any YouTube URL. Links are cleaned to a canonical form automatically (tracking parameters such as `pp=`/`si=` removed), and a new stream is named after its YouTube title. Streams autoplay muted, because browsers block autoplay with sound; use the 🔇 button to unmute.

Use a video ID for a specific camera and a channel ID when the channel only runs one stream. A channel link only ever shows *one* live stream, so it can't be used for channels with several cameras (e.g. NK-Nett).

While a stream connects it shows YouTube's latest still image of that camera, and it is only uncovered once verified to be playing at the live edge (YouTube often starts embeds at the beginning of its 12-hour rewind buffer). Streams that drift more than 40 s behind jump back to live. A stream that errors or ends is reconnected automatically (after 5 s, 20 s, 60 s); only then does it show a notice to replace the link.

Webcams stop refreshing a minute after leaving view. Streams on screen always play; scrolled out of view they keep running while you're using the page, and stop after *Keep streams running after last activity* (default 5 min; 1/15/60 available) without mouse, keyboard, touch or scroll activity. Any activity starts them again in the background, so they're usually live by the time you scroll down. A running stream costs about 0.35 Mbit/s (~160 MB/hour). YouTube serves these streams at 480p regardless of player size, so there's no cheaper way to keep one connected. In a background tab streams always stop after a minute.

## Data sources (all keyless, browser-direct)

| What | Source |
|---|---|
| Forecast, hourly range (~2.5 days) | MET Norway Locationforecast 2.0 |
| Past days, far forecast, snowfall | Open-Meteo |
| Next two hours | MET Norway Nowcast (radar, Nordic only), falling back to Open-Meteo 15-minutely |
| Kp, 3-hourly observed + 3-day forecast | NOAA SWPC |
| Kp, beyond 3 days (daily max, shown fainter) | NOAA SWPC 27-day outlook |
| Tides (Norway): observed, forecast incl. weather, high/low | Kartverket sea level API |
| Tides elsewhere (model) | Open-Meteo Marine |
| Sun and moon position, phases, rise/set | Computed locally |
| Place search | Open-Meteo geocoding |

**Firefox gotcha:** never add custom headers (e.g. `User-Agent`) to api.met.no requests. Firefox would then send a CORS preflight, which MET answers without CORS headers, so the request gets blocked. Use a plain `fetch(url)`. See `js/data/fetchers.js`.

## Debugging

- **Settings → Debugging → Show where each value comes from** underlines every value. Hover one to see its source, time window and fetch time. This also adds a *Data sources* card that shows each feed's status and URL.
- **`?mock=1`** (or the *Use mock data* setting) swaps in fabricated stormy data with a strong aurora forecast.
- **`?at=2026-12-21T12:00`** pretends the clock is at that time. Combine it with a location override to check polar night or midnight sun.

## Using it

- Hover or drag across the graphic to scrub the whole dashboard. Moving away, or lifting your finger, returns to now.
- With the graphic focused, ←/→ scrub by 15 min (Shift: 1 h) and Esc returns to now.
- Use ‹ / › or the day strip to step from 2 days back to 9 days ahead. Press `t` to jump to today.
- Click the overlay chips under the graphic to toggle them.
- Click a webcam image to enlarge it.
