#!/usr/bin/env node
// Builds data/cameras.json — a catalogue of Norwegian webcams and YouTube live
// streams listed on vindnå.no (region → municipality → camera page). The cameras
// themselves belong to their operators (Statens vegvesen, yr.no, NK-Nett, …);
// we record each camera's name, position and direct source.
//
// Run by hand only — nothing schedules this:
//   node scripts/scrape-vindnaa.mjs                 # all Norwegian regions
//   node scripts/scrape-vindnaa.mjs --region nordland --municipality bodø   # quick test
//   node scripts/scrape-vindnaa.mjs --fresh         # ignore the local page cache
//
// It is deliberately gentle: 2 requests at a time with pauses, retries with
// back-off, and a local page cache (.scrape-cache/, git-ignored) so an
// interrupted run resumes without refetching.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://xn--vindn-qra.no';
const OUT = path.join(ROOT, 'data', 'cameras.json');
const CACHE = path.join(ROOT, '.scrape-cache');
const CONCURRENCY = 2;
const PAUSE_MS = 400;
const UA = 'solar-dashboard camera list (manual one-off run; https://github.com/tvzndro/solar-dashboard)';
const FOREIGN = new Set(['danmark', 'finland', 'sverige', 'tyskland', 'värmlands-län']);

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const FRESH = args.includes('--fresh');
const ONLY_REGION = opt('region');
const ONLY_MUNI = opt('municipality');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (seg) => { try { return decodeURIComponent(seg); } catch { return seg; } };
const unescapeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

let requests = 0, cached = 0;
async function get(urlPath) {
  const url = BASE + urlPath;
  const file = path.join(CACHE, createHash('sha1').update(url).digest('hex') + '.html');
  if (!FRESH) { try { cached++; return await readFile(file, 'utf8'); } catch { cached--; } }
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(PAUSE_MS * (attempt ? 2 ** attempt * 2 : 1));
    try {
      requests++;
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'nb,no;q=0.9' } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) { console.warn(`  ${res.status} ${urlPath} — backing off`); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      await writeFile(file, html);
      return html;
    } catch (err) {
      if (attempt === 3) { console.warn(`  failed ${urlPath}: ${err.message}`); return null; }
    }
  }
  return null;
}

/** Links exactly `depth` path segments below /webkamera. */
function links(html, depth, prefix = '/webkamera/') {
  const out = new Set();
  for (const m of html.matchAll(/href="(\/webkamera\/[^"#?]+)"/g)) {
    const p = m[1];
    if (!p.startsWith(prefix)) continue;
    if (p.split('/').filter(Boolean).length === depth + 1) out.add(p);
  }
  return [...out];
}

/** Proper names from a municipality page: "Webkamera for Bodø kommune i Nordland." */
const muniNames = new Map();
function parseMunicipality(html, muniPath) {
  const m = html.match(/<h1>\s*Webkamera for (.+?) kommune i (.+?)\.?\s*</);
  if (m) muniNames.set(muniPath, { municipality: unescapeHtml(m[1]), region: unescapeHtml(m[2]) });
}

function parseCamera(html, pagePath) {
  const h1 = html.match(/<h1>\s*Webkamera\s+([\s\S]*?)<a[^>]+href="\/#(-?[\d.]+),(-?[\d.]+)/);
  if (!h1) return null;
  const name = unescapeHtml(h1[1].replace(/<[^>]+>/g, '').trim());
  const lat = +h1[2], lon = +h1[3];
  // The camera's own viewer (not the "other cameras" thumbnails further down).
  const viewer = html.match(/<div class="[^"]*webcam-zoom[^"]*"[^>]*data-webcam-zoom[^>]*>([\s\S]*?)<button/);
  const block = viewer ? viewer[1] : '';
  const yt = block.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/);
  const img = block.match(/<img[^>]+src="([^"]+)"/);
  const credit = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>\s*<img/);
  const slugs = pagePath.split('/').map(decode);
  const names = muniNames.get(pagePath.split('/').slice(0, 4).join('/'));
  const region = names?.region || slugs[2], municipality = names?.municipality || slugs[3];
  const id = pagePath.match(/-([0-9a-f]{6})$/)?.[1] || pagePath;
  const base = { id, name, region, municipality, lat: +lat.toFixed(4), lon: +lon.toFixed(4), page: BASE + pagePath };
  if (yt) return { ...base, kind: 'stream', youtube: `https://www.youtube.com/watch?v=${yt[1]}` };
  // Statens vegvesen live-video cameras (shown on vindnå.no through its own player):
  // Vegvesen also publishes a still image under the same camera ID.
  const vlive = block.match(/\/r\/vlive\.html\?([\w-]+)/);
  if (vlive) return { ...base, kind: 'image', image: `https://kamera.atlas.vegvesen.no/api/images/${vlive[1]}`, credit: 'https://www.vegvesen.no/' };
  if (img && /^https?:/.test(img[1])) {
    const url = unescapeHtml(img[1]);
    return { ...base, kind: 'image', image: url, credit: credit ? unescapeHtml(credit[1]) : null };
  }
  return { ...base, kind: 'other' };
}

async function pool(items, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const k = i++; results[k] = await fn(items[k], k); }
  }));
  return results;
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(path.dirname(OUT), { recursive: true });

  const index = await get('/webkamera');
  if (!index) throw new Error('could not load /webkamera');
  let regions = links(index, 1).filter((p) => !FOREIGN.has(decode(p.split('/')[2])));
  if (ONLY_REGION) regions = regions.filter((p) => decode(p.split('/')[2]) === ONLY_REGION);
  console.log(`${regions.length} regions`);

  const munis = [];
  for (const r of regions) {
    const html = await get(r);
    let ms = html ? links(html, 2, r + '/') : [];
    if (ONLY_MUNI) ms = ms.filter((p) => decode(p.split('/')[3]) === ONLY_MUNI);
    console.log(`  ${decode(r.split('/')[2])}: ${ms.length} municipalities`);
    munis.push(...ms);
  }

  const camPaths = new Map(); // id → path (cameras can be listed in several municipalities)
  await pool(munis, async (m) => {
    const html = await get(m);
    if (html) parseMunicipality(html, m);
    for (const p of html ? links(html, 3, m + '/') : []) {
      const id = p.match(/-([0-9a-f]{6})$/)?.[1] || p;
      if (!camPaths.has(id)) camPaths.set(id, p);
    }
  });
  console.log(`${camPaths.size} camera pages`);

  let done = 0;
  const cams = (await pool([...camPaths.values()], async (p) => {
    const html = await get(p);
    if (++done % 100 === 0) console.log(`  ${done}/${camPaths.size} (${requests} fetched, ${cached} from cache)`);
    return html ? parseCamera(html, p) : null;
  })).filter(Boolean);

  const usable = cams.filter((c) => c.kind !== 'other');
  usable.sort((a, b) => a.region.localeCompare(b.region, 'nb') || a.municipality.localeCompare(b.municipality, 'nb') || a.name.localeCompare(b.name, 'nb'));
  const out = {
    source: 'vindnå.no (camera list); cameras belong to their operators',
    scrapedAt: new Date().toISOString(),
    count: { streams: usable.filter((c) => c.kind === 'stream').length, images: usable.filter((c) => c.kind === 'image').length, skipped: cams.length - usable.length },
    cameras: usable,
  };
  await writeFile(OUT, JSON.stringify(out) + '\n');
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${out.count.streams} streams, ${out.count.images} images (${out.count.skipped} other/unsupported skipped); ${requests} requests`);
}

main().catch((err) => { console.error(err); process.exit(1); });
