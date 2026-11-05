# Solar Dashboard — Rewrite Brief

This is a fresh build. The **main day graphic** is the only thing carried over from the existing app; its look is shown in `reference/`. Everything else is designed from scratch.

---

## 1. Purpose

A glanceable dashboard for one location: where the sun is, what the light is like, what the weather is doing, and whether there's a chance of aurora, across a single day you can scrub through. It also shows a few local webcams and live streams. It's used on several machines in the same household and is typically left open.

---

## 2. The day graphic (keep this look)

The graphic should stay recognisably the same as in `reference/`. How it's built is open, and so is polishing it, as long as it still reads as the same graphic.

What makes it look the way it does:

- **A horizontal timeline of one local day**, midnight to midnight, with hour labels underneath.
- **Background bands by light phase.** Darkest for night, then astronomical, nautical and civil twilight, then bright blue daylight. The phases switch at about −18°, −12°, −6° and 0° sun elevation. The palette goes from near‑black through deep navy to bright blue (`#3a86ff`).
- **The sun's elevation curve** as a thin, faint white line, with a faint horizon line across the middle.
- **A glowing yellow‑orange sun disc** at the viewed time. It stays on the edge of the graphic when the sun is far below the horizon.
- **Cloud cover** as a soft grey band hanging down from the top edge. More cloud makes it thicker.
- **Precipitation** as blue bars rising *above* the top edge of the graphic. Where the forecast gives a likely maximum, a fainter cap shows it.
- **Aurora potential (Kp)** as a translucent green area rising from the bottom edge, shown only while it's dark enough to matter.

Moving across the graphic scrubs the whole dashboard to that moment, and leaving it returns to now. It should also work with touch.

**Reference images:**

| File | Shows |
|---|---|
| `graphic-real-data-0300.png` | Live data |
| `graphic-storm-day-1030.png` | Fabricated data: daytime |
| `graphic-storm-night-2200.png` | Fabricated data: night with a strong aurora forecast |
| `graphic-polar-night.png` | Fabricated data: 78°N in December |

---

## 3. What it must do

How these are presented is up to you.

- **Sun:** sunrise and sunset, day length, elevation, direction and the current light phase. Polar night and midnight sun must make sense.
- **Weather at the viewed time:** temperature with feels‑like, wind with gusts, direction and a descriptive (Beaufort‑style) name, cloud cover, and precipitation.
- **Short‑term precipitation outlook**, e.g. "light snow in 25 min".
- **Kp index.**
- **Snowfall estimates** for the past and next few hours. The window is adjustable.
- **Past, present and future:** the timeline covers recent past as well as forecast. You can step to other days, a couple back and about a week or more ahead, and jump back to today.
- **Customisation:** choose which information is shown and in what order, and which graph overlays are visible.
- **Settings:** location, metric or imperial units, and English or Norwegian.
- **Cameras:** image webcams that refresh periodically, plus YouTube live streams that autoplay. Both can be hidden.
- **Debugging aids:** a way to see where a value came from, and to run with mock data.

---

## 4. Platform

- **Hosted on GitHub Pages** and opened by bookmark from several Windows and Linux machines, in both Firefox and Chrome. It must not depend on any particular local machine being on.
- **No backend.** Everything runs in the browser with public, keyless data sources. A build step is fine if deploying stays as simple as a push.
- **A shared config file in the repo** provides defaults: location, units, language, layout and cameras. Each browser can override these locally. Users should be able to see what's overridden, reset to the shared defaults, and export their local setup as a new shared config.
- The site is public, so it should contain nothing private beyond the location and camera choices.
- **Firefox gotcha:** don't set custom headers such as `User-Agent` on requests to api.met.no. Chrome silently drops a script‑set `User-Agent`, but Firefox sends it, which turns the request into a CORS preflight (`OPTIONS`). MET answers the preflight with a bare `204` and no `Access-Control-Allow-*` headers, so Firefox blocks the request and no weather data loads. A plain `fetch(url)` works in both browsers.

---

## 5. Done when

- It runs from GitHub Pages in Firefox and Chrome on Windows and Linux, with live data.
- The day graphic is recognisably the same as `reference/`, and scrubbing works with mouse and touch.
- Everything in §3 works, in English and Norwegian, with clear units.
- The shared config plus local overrides work across machines.
