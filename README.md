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

## Shared config and local overrides

`config.json` is the shared default for every machine. It holds the location, units, language, card layout, graph overlays, snowfall window, cameras and debug flags.

Any change made in **Settings (⚙)** is stored as a local override in that browser only. Settings marks overridden items as **local**, with a ↺ button to reset each one. The *Shared config* section lists all overrides and has these actions:

- **Reset all to shared** drops every local change.
- **Download as config.json** exports this browser's effective setup. Commit that file to make it the new shared default.

Open tabs pick up a changed `config.json` within about 30 minutes, or straight away on reload.

### Streams

Add YouTube streams under `cameras.streams` as `{ "name": "…", "youtube": "<video ID | channel ID (UC…) | URL>" }`. A channel ID always shows that channel's current live stream. Streams autoplay muted, because browsers block autoplay with sound.

## Data sources (all keyless, browser-direct)

| What | Source |
|---|---|
| Forecast, hourly range (~2.5 days) | MET Norway Locationforecast 2.0 |
| Past days, far forecast, snowfall | Open-Meteo |
| Next two hours | MET Norway Nowcast (radar, Nordic only), falling back to Open-Meteo 15-minutely |
| Kp, 3-hourly observed + 3-day forecast | NOAA SWPC |
| Kp, beyond 3 days (daily max, shown fainter) | NOAA SWPC 27-day outlook |
| Sun position, phases, sunrise/sunset | Computed locally |
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
