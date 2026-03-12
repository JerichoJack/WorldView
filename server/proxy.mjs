/**
 * server/proxy.mjs
 * ShadowGrid flight data proxy — viewport-aware, on-demand hub fetching.
 *
 * The browser sends the visible bounding box with each request:
 *   GET /api/flights?bounds=minLon,minLat,maxLon,maxLat
 *
 * The proxy computes which 250nm-radius hubs overlap that bbox, fetches only
 * those hubs from opendata.adsb.fi, merges results into a persistent DB, and
 * returns the full DB snapshot filtered to the bbox.
 *
 * Hub results are cached individually per hub (TTL: 12s) so panning doesn't
 * re-fetch hubs that were just queried. The DB also retains aircraft globally
 * so previously-seen aircraft outside the viewport are preserved for when the
 * user pans back.
 *
 * Start:  node server/proxy.mjs
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import * as satellite from 'satellite.js';

const PORT       = 3001;
const RADIUS_NM  = 250;
const RADIUS_DEG = RADIUS_NM / 60;   // ~4.17 degrees
const SERVER_HEAVY_MODE = /^(1|true|yes)$/i.test(
  process.env.SHADOWGRID_SERVER_HEAVY ?? process.env.SHADOWGRID_SERVER_MODE ?? ''
);
const HUB_TTL    = SERVER_HEAVY_MODE ? 8_000 : 12_000;    // ms — don't re-fetch a hub more often than this
const STALE_MS   = SERVER_HEAVY_MODE ? 300_000 : 120_000; // keep aircraft longer in heavy mode
const MAX_CONC   = SERVER_HEAVY_MODE ? 24 : 12;           // max concurrent hub fetches per request

const HEADERS = { 'User-Agent': 'ShadowGrid/0.1 (github.com/JerichoJack/ShadowGrid)' };

function loadDotEnvVars() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return new Map();
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  const out = new Map();
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const key = s.slice(0, i).trim();
    const val = s.slice(i + 1).trim();
    out.set(key, val);
  }
  return out;
}

const DOTENV_VARS = loadDotEnvVars();
const GOOGLE_ROUTES_KEY = process.env.VITE_GOOGLE_MAPS_API_KEY || DOTENV_VARS.get('VITE_GOOGLE_MAPS_API_KEY') || '';
const BACKEND_FLIGHT_PROVIDER = (process.env.VITE_FLIGHT_PROVIDER || DOTENV_VARS.get('VITE_FLIGHT_PROVIDER') || 'opensky').toLowerCase();
const BACKEND_SATELLITE_PROVIDER = (process.env.VITE_SATELLITE_PROVIDER || DOTENV_VARS.get('VITE_SATELLITE_PROVIDER') || 'celestrak').toLowerCase();
const BACKEND_TRAFFIC_PROVIDER = (process.env.VITE_TRAFFIC_PROVIDER || DOTENV_VARS.get('VITE_TRAFFIC_PROVIDER') || 'auto').toLowerCase();
const OPENSKY_CLIENT_ID = process.env.VITE_OPENSKY_CLIENT_ID || DOTENV_VARS.get('VITE_OPENSKY_CLIENT_ID') || '';
const OPENSKY_CLIENT_SECRET = process.env.VITE_OPENSKY_CLIENT_SECRET || DOTENV_VARS.get('VITE_OPENSKY_CLIENT_SECRET') || '';
const SPACETRACK_USER = process.env.VITE_SPACETRACK_USERNAME || DOTENV_VARS.get('VITE_SPACETRACK_USERNAME') || '';
const SPACETRACK_PASS = process.env.VITE_SPACETRACK_PASSWORD || DOTENV_VARS.get('VITE_SPACETRACK_PASSWORD') || '';
const N2YO_KEY = process.env.VITE_N2YO_API_KEY || DOTENV_VARS.get('VITE_N2YO_API_KEY') || '';
const SATELLITE_MAX_PER_CATEGORY = Math.max(parseInt(process.env.VITE_SATELLITE_MAX_PER_CATEGORY || DOTENV_VARS.get('VITE_SATELLITE_MAX_PER_CATEGORY') || DOTENV_VARS.get('VITE_SATELLITE_MAX_OBJECTS') || '500', 10) || 500, 1);

// ── Satellite snapshot cache (server-side propagation mode) ─────────────────
const SAT_CATALOG_TTL_MS = 10 * 60_000;
const SAT_SNAPSHOT_POLL_TIMEOUT_MS = 8000;
const SAT_SNAPSHOT_TTL_MS = 5_000;
const TRAFFIC_SNAPSHOT_TTL_MS = 45_000;
const FLIGHT_SNAPSHOT_TTL_MS = SERVER_HEAVY_MODE ? 3_000 : 1_500;
const CAMERA_MANIFEST_TTL_MS = 10 * 60_000;
const CAMERA_TILE_CACHE_TTL_MS = 15 * 60_000;
const CAMERA_SNAPSHOT_TTL_MS = 8_000;
const SNAPSHOT_BOUNDS_GRID_DEG = 0.25;
const CAMERA_MAX_POINTS = Math.max(parseInt(process.env.SHADOWGRID_CAMERA_MAX_POINTS ?? '6000', 10) || 6000, 1);
const CACHE_DIR = path.resolve(process.cwd(), 'server', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'world-snapshot-cache.json');
let satCatalogTs = 0;
/** @type {Array<{id:string,name:string,line1:string,line2:string,satrec:any,meta:any,category:string}>} */
let satCatalog = [];
let satCatalogSource = 'unknown';
let satSnapshotCache = { ts: 0, points: [], source: 'unknown', maxCount: 0, perCategory: SATELLITE_MAX_PER_CATEGORY, categoryKey: 'all' };
let openSkyToken = '';
let openSkyTokenExp = 0;

const N2YO_SNAPSHOT_TTL_MS = 120_000;
const N2YO_SAMPLE_POINTS = [
  { lat: 0, lon: 0 },
  { lat: 0, lon: 90 },
  { lat: 0, lon: -90 },
  { lat: 45, lon: 0 },
  { lat: -45, lon: 0 },
  { lat: 45, lon: 120 },
  { lat: -45, lon: -120 },
  { lat: 60, lon: 60 },
  { lat: -60, lon: -60 },
];

/** @type {Map<string, {ts:number, payload:any}>} */
const flightSnapshotCache = new Map();
/** @type {Map<string, {ts:number, payload:any}>} */
const trafficSnapshotCache = new Map();

/** @type {{ts:number, tileDeg:number, tiles:Array<{key:string,lat:number,lng:number,count:number}>}} */
let cameraManifestCache = { ts: 0, tileDeg: 5, tiles: [] };
/** @type {Map<string, {ts:number, cameras:Array<any>}>} */
const cameraTileCache = new Map();
/** @type {Map<string, {ts:number, payload:any}>} */
const cameraSnapshotCache = new Map();

let cacheWriteTimer = null;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function scheduleCacheWrite() {
  if (cacheWriteTimer) return;
  cacheWriteTimer = setTimeout(() => {
    cacheWriteTimer = null;
    try {
      ensureCacheDir();
      const out = {
        ts: Date.now(),
        flights: [...flightSnapshotCache.entries()].slice(0, 64),
        traffic: [...trafficSnapshotCache.entries()].slice(0, 64),
        satellites: satSnapshotCache,
      };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(out));
    } catch (err) {
      console.warn(`[proxy] Cache write failed: ${err?.message ?? 'unknown'}`);
    }
  }, 400);
}

function loadSnapshotCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [key, value] of data.flights ?? []) {
      if (value?.payload && Number.isFinite(value?.ts)) {
        flightSnapshotCache.set(key, value);
      }
    }
    for (const [key, value] of data.traffic ?? []) {
      if (value?.payload && Number.isFinite(value?.ts)) {
        trafficSnapshotCache.set(key, value);
      }
    }
    if (data?.satellites?.payload && Number.isFinite(data?.satellites?.ts)) {
      satSnapshotCache = data.satellites;
    } else if (data?.satellites?.points && Number.isFinite(data?.satellites?.ts)) {
      satSnapshotCache = data.satellites;
    }
  } catch (err) {
    console.warn(`[proxy] Cache load failed: ${err?.message ?? 'unknown'}`);
  }
}

function quantize(value, step = SNAPSHOT_BOUNDS_GRID_DEG) {
  return Math.round(value / step) * step;
}

function normalizeBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  const [minLonRaw, minLatRaw, maxLonRaw, maxLatRaw] = bounds.map(Number);
  if (![minLonRaw, minLatRaw, maxLonRaw, maxLatRaw].every(Number.isFinite)) return null;
  const minLon = Math.max(-180, Math.min(180, minLonRaw));
  const maxLon = Math.max(-180, Math.min(180, maxLonRaw));
  const minLat = Math.max(-90, Math.min(90, minLatRaw));
  const maxLat = Math.max(-90, Math.min(90, maxLatRaw));
  return [Math.min(minLon, maxLon), Math.min(minLat, maxLat), Math.max(minLon, maxLon), Math.max(minLat, maxLat)];
}

function boundsCacheKey(bounds, fallback = 'global') {
  const b = normalizeBounds(bounds);
  if (!b) return fallback;
  const [minLon, minLat, maxLon, maxLat] = b;
  return `${quantize(minLon).toFixed(2)},${quantize(minLat).toFixed(2)},${quantize(maxLon).toFixed(2)},${quantize(maxLat).toFixed(2)}`;
}

async function ensureCameraManifest() {
  const now = Date.now();
  if (cameraManifestCache.tiles.length && (now - cameraManifestCache.ts) < CAMERA_MANIFEST_TTL_MS) return;

  const manifestPath = path.resolve(process.cwd(), 'public', 'camera-data', 'tiles-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    cameraManifestCache = { ts: now, tileDeg: 5, tiles: [] };
    return;
  }

  const raw = fs.readFileSync(manifestPath, 'utf8');
  const data = JSON.parse(raw);
  const tileDeg = Number.isFinite(data?.tileDeg) ? data.tileDeg : 5;
  const tiles = Array.isArray(data?.tiles)
    ? data.tiles.filter(t => Number.isFinite(t?.lat) && Number.isFinite(t?.lng) && t.lat >= -90 && t.lat <= 90 && t.lng >= -180 && t.lng <= 180 && typeof t.key === 'string')
    : [];

  cameraManifestCache = {
    ts: now,
    tileDeg,
    tiles,
  };
}

async function readCameraTile(tileKey) {
  const now = Date.now();
  const cached = cameraTileCache.get(tileKey);
  if (cached && (now - cached.ts) < CAMERA_TILE_CACHE_TTL_MS) return cached.cameras;

  const tilePath = path.resolve(process.cwd(), 'public', 'camera-data', 'tiles', `${tileKey}.json`);
  if (!fs.existsSync(tilePath)) {
    cameraTileCache.set(tileKey, { ts: now, cameras: [] });
    return [];
  }

  try {
    const raw = fs.readFileSync(tilePath, 'utf8');
    const data = JSON.parse(raw);
    const cameras = Array.isArray(data) ? data : [];
    cameraTileCache.set(tileKey, { ts: now, cameras });
    return cameras;
  } catch {
    cameraTileCache.set(tileKey, { ts: now, cameras: [] });
    return [];
  }
}

async function getCameraSnapshot(bounds, maxPoints = CAMERA_MAX_POINTS) {
  await ensureCameraManifest();
  const b = normalizeBounds(bounds);
  if (!b) {
    return { cameras: [], total: 0, source: 'camera-tiles', mode: 'bounds-required', cacheHit: false, ts: Date.now() };
  }

  const cacheKey = `cam:${boundsCacheKey(b)}:${maxPoints}`;
  const now = Date.now();
  const cached = cameraSnapshotCache.get(cacheKey);
  if (cached && (now - cached.ts) < CAMERA_SNAPSHOT_TTL_MS) {
    return { ...cached.payload, cacheHit: true };
  }

  const [minLon, minLat, maxLon, maxLat] = b;
  const tileDeg = cameraManifestCache.tileDeg;
  const tiles = cameraManifestCache.tiles.filter(t => {
    const tileMaxLat = t.lat + tileDeg;
    const tileMaxLon = t.lng + tileDeg;
    if (tileMaxLat < minLat || t.lat > maxLat) return false;
    if (tileMaxLon < minLon || t.lng > maxLon) return false;
    return true;
  });

  const cameras = [];
  for (const tile of tiles) {
    const tileCameras = await readCameraTile(tile.key);
    for (const cam of tileCameras) {
      if (!Number.isFinite(cam?.a) || !Number.isFinite(cam?.o)) continue;
      if (cam.a < minLat || cam.a > maxLat || cam.o < minLon || cam.o > maxLon) continue;
      cameras.push(cam);
      if (cameras.length >= maxPoints) break;
    }
    if (cameras.length >= maxPoints) break;
  }

  const generatedAt = Date.now();
  const payload = {
    cameras,
    total: cameras.length,
    source: 'camera-tiles',
    tileCount: tiles.length,
    cacheHit: false,
    ts: generatedAt,
  };

  cameraSnapshotCache.set(cacheKey, { ts: generatedAt, payload });
  scheduleCacheWrite();
  return payload;
}

// ── Hub grid — mathematically tiled at 250nm radius with ~30% overlap ─────────
// Generated by: lat step = RADIUS_DEG * 1.4, lon step = lat_step / cos(lat)

function generateHubGrid() {
  const LAT_STEP = RADIUS_DEG * 1.4;
  const hubs = [];
  let lat = -70 + LAT_STEP / 2;
  while (lat <= 83) {
    const cosLat  = Math.max(Math.cos(lat * Math.PI / 180), 0.08);
    const lonStep = Math.min(LAT_STEP / cosLat, 360);
    let lon = -180;
    while (lon < 180) {
      let normLon = lon % 360;
      if (normLon > 180) normLon -= 360;
      hubs.push({ lat: Math.round(lat * 10) / 10, lon: Math.round(normLon * 10) / 10 });
      lon += lonStep;
    }
    lat += LAT_STEP;
  }
  return hubs;
}

const ALL_HUBS = generateHubGrid();
console.log(`[proxy] Hub grid: ${ALL_HUBS.length} hubs at ${RADIUS_NM}nm radius`);

// ── Per-hub fetch cache (avoid re-fetching hubs that were just queried) ────────
/** @type {Map<string, { time: number, promise?: Promise }>} */
const hubCache = new Map();

function hubKey(hub) { return `${hub.lat},${hub.lon}`; }

function boundsToQueryCenter(bounds) {
  if (!bounds) return null;
  const [minLon, minLat, maxLon, maxLat] = bounds;
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;

  let lonSpan = maxLon - minLon;
  if (lonSpan < 0) lonSpan += 360;
  const latSpan = Math.max(0, maxLat - minLat);

  let centerLon = minLon + lonSpan / 2;
  if (centerLon > 180) centerLon -= 360;
  const centerLat = minLat + latSpan / 2;

  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.max(Math.cos(centerLat * Math.PI / 180), 0.1);
  const diagKm = Math.hypot(latSpan * kmPerDegLat, lonSpan * kmPerDegLon);
  const radiusNm = Math.min(250, Math.max(75, Math.round((diagKm / 1.852) * 0.6)));

  return { lat: centerLat, lon: centerLon, distNm: radiusNm };
}

async function fetchReadsbProvider(baseUrl, bounds, globalMode = false) {
  const urls = [];
  if (globalMode) {
    urls.push(`${baseUrl}/v2/all`);
  } else {
    const center = boundsToQueryCenter(bounds);
    if (center) {
      urls.push(`${baseUrl}/v2/lat/${center.lat.toFixed(4)}/lon/${center.lon.toFixed(4)}/dist/${center.distNm}`);
      urls.push(`${baseUrl}/v2/point/${center.lat.toFixed(4)}/${center.lon.toFixed(4)}/${center.distNm}`);
    } else {
      urls.push(`${baseUrl}/v2/point/0/0/250`);
    }
  }

  let lastError = null;
  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      if (!resp.ok) {
        lastError = new Error(`${baseUrl} ${resp.status}`);
        continue;
      }
      const data = await resp.json();
      upsert(data.aircraft ?? data.ac ?? []);
      return true;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error(`${baseUrl} unavailable`);
}

function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

function gcDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function decodeGooglePolyline(encoded) {
  const coords = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);

    coords.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }
  return coords;
}

function trafficFlowFromSpeed(speed) {
  switch (speed) {
    case 'TRAFFIC_JAM': return { density: 9, speed: 3.5, priority: 3 };
    case 'SLOW': return { density: 6, speed: 8.5, priority: 3 };
    default: return { density: 3, speed: 15, priority: 2 };
  }
}

function osmRoadClass(tags = {}) {
  const highway = tags.highway || '';
  if (['motorway', 'trunk', 'primary'].includes(highway)) {
    return { density: 12, speed: 25, priority: 3 };
  }
  if (['secondary', 'tertiary'].includes(highway)) {
    return { density: 6, speed: 15, priority: 2 };
  }
  if (['residential', 'unclassified', 'living_street'].includes(highway)) {
    return { density: 2, speed: 10, priority: 1 };
  }
  return { density: 1, speed: 8, priority: 0 };
}

function resolveTrafficBackendMode() {
  const hasGoogleKey = GOOGLE_ROUTES_KEY.trim().length > 0;
  if (BACKEND_TRAFFIC_PROVIDER === 'google') return hasGoogleKey ? 'google-live' : 'osm-sim';
  if (BACKEND_TRAFFIC_PROVIDER === 'osm') return 'osm-sim';
  return hasGoogleKey ? 'google-live' : 'osm-sim';
}

async function buildOsmTrafficRoads(minLon, minLat, maxLon, maxLat) {
  const query = `
    [out:json];
    (
      way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street"](${minLat},${minLon},${maxLat},${maxLon});
    );
    out geom;
  `;

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...HEADERS },
    body: query,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Overpass ${resp.status}`);

  const data = await resp.json();
  const roads = [];
  for (const way of (data.elements ?? []).filter(el => el.type === 'way')) {
    if (!way.tags?.highway || !Array.isArray(way.geometry) || way.geometry.length < 2) continue;
    const profile = osmRoadClass(way.tags);
    const coords = way.geometry.map(node => ({ lat: node.lat, lon: node.lon }));
    roads.push({
      id: `osm-${way.id}`,
      name: way.tags.name || '[unnamed]',
      coords,
      density: profile.density,
      speed: profile.speed,
      priority: profile.priority,
      totalLength: coords.reduce((sum, _, idx) => {
        if (idx === 0) return sum;
        const prev = coords[idx - 1];
        const curr = coords[idx];
        return sum + gcDistanceMeters(prev.lat, prev.lon, curr.lat, curr.lon);
      }, 0),
    });
  }

  return roads;
}

async function getOpenSkyTokenServer() {
  if (!OPENSKY_CLIENT_ID || !OPENSKY_CLIENT_SECRET) return '';
  if (openSkyToken && Date.now() < openSkyTokenExp) return openSkyToken;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: OPENSKY_CLIENT_ID,
    client_secret: OPENSKY_CLIENT_SECRET,
  });

  const resp = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(12_000),
  });
  if (!resp.ok) throw new Error(`OpenSky token ${resp.status}`);

  const data = await resp.json();
  openSkyToken = data.access_token ?? '';
  openSkyTokenExp = Date.now() + Math.max(((data.expires_in ?? 3600) - 60) * 1000, 60_000);
  return openSkyToken;
}

async function fetchOpenSkyProvider() {
  const token = await getOpenSkyTokenServer();
  const headers = token ? { Authorization: `Bearer ${token}`, ...HEADERS } : HEADERS;
  const resp = await fetch('https://opensky-network.org/api/states/all', {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`OpenSky ${resp.status}`);

  const data = await resp.json();
  const aircraft = (data.states ?? [])
    .filter(s => Number.isFinite(s?.[5]) && Number.isFinite(s?.[6]) && s?.[8] !== true)
    .map(s => ({
      hex: (s[0] ?? '').trim().toLowerCase(),
      flight: (s[1] ?? '').trim(),
      lon: s[5],
      lat: s[6],
      alt_baro: Number.isFinite(s[7]) ? s[7] * 3.281 : 10000,
      gs: Number.isFinite(s[9]) ? s[9] * 1.944 : 0,
      track: Number.isFinite(s[10]) ? s[10] : 0,
      baro_rate: Number.isFinite(s[11]) ? s[11] * 196.85 : 0,
      squawk: s[14] ?? '',
      category: '',
      t: '',
      dbFlags: 0,
    }));

  upsert(aircraft);
}

async function fetchN2yoSnapshot(maxCount = Infinity) {
  if (!N2YO_KEY) {
    throw new Error('N2YO API key missing');
  }

  const points = [];
  const seen = new Set();
  const limit = Number.isFinite(maxCount) ? maxCount : Infinity;

  for (const sample of N2YO_SAMPLE_POINTS) {
    const url = `https://api.n2yo.com/rest/v1/satellite/above/${sample.lat}/${sample.lon}/0/90/0/&apiKey=${N2YO_KEY}`;
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`N2YO ${resp.status}`);
    const data = await resp.json();
    for (const sat of data.above ?? []) {
      const satId = String(sat.satid ?? sat.satid ?? sat.satname ?? `${sat.satlat}_${sat.satlng}`);
      if (seen.has(satId)) continue;
      const lat = Number(sat.satlat);
      const lon = Number(sat.satlng);
      const altKm = Number(sat.satalt);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altKm)) continue;
      seen.add(satId);
      points.push({
        id: satId,
        name: sat.satname ?? `N2YO ${satId}`,
        lat,
        lon,
        altM: altKm * 1000,
      });
      if (points.length >= limit) {
        return points;
      }
    }
  }

  return points;
}

function googleRoutePairsForBounds(minLon, minLat, maxLon, maxLat) {
  const cx = (minLon + maxLon) / 2;
  const cy = (minLat + maxLat) / 2;
  const dx = (maxLon - minLon) * 0.46;
  const dy = (maxLat - minLat) * 0.46;
  const p = {
    w: { lat: cy, lon: cx - dx },
    e: { lat: cy, lon: cx + dx },
    n: { lat: cy + dy, lon: cx },
    s: { lat: cy - dy, lon: cx },
    nw: { lat: cy + dy, lon: cx - dx },
    ne: { lat: cy + dy, lon: cx + dx },
    sw: { lat: cy - dy, lon: cx - dx },
    se: { lat: cy - dy, lon: cx + dx },
  };
  return [[p.w, p.e], [p.e, p.w], [p.n, p.s], [p.s, p.n], [p.nw, p.se], [p.ne, p.sw]];
}

async function buildGoogleTrafficRoads(minLon, minLat, maxLon, maxLat) {
  if (!GOOGLE_ROUTES_KEY) throw new Error('Google Routes key missing on server');
  const pairs = googleRoutePairsForBounds(minLon, minLat, maxLon, maxLat);
  const departureTime = new Date(Date.now() + 5 * 60_000).toISOString();
  const roads = [];

  for (let i = 0; i < pairs.length; i++) {
    const [origin, destination] = pairs[i];
    const body = {
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lon } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lon } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
      departureTime,
      extraComputations: ['TRAFFIC_ON_POLYLINE'],
      polylineQuality: 'HIGH_QUALITY',
      polylineEncoding: 'ENCODED_POLYLINE',
      computeAlternativeRoutes: false,
    };

    const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_ROUTES_KEY,
        'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) continue;
    const data = await resp.json();
    const route = data?.routes?.[0];
    const encoded = route?.polyline?.encodedPolyline;
    if (!encoded) continue;

    const points = decodeGooglePolyline(encoded);
    if (points.length < 2) continue;
    const intervals = route?.travelAdvisory?.speedReadingIntervals ?? [];

    if (!intervals.length) {
      const f = trafficFlowFromSpeed('NORMAL');
      roads.push({
        id: `g-${i}-all`,
        coords: points,
        density: f.density,
        speed: f.speed,
        priority: f.priority,
      });
      continue;
    }

    intervals.forEach((it, idx) => {
      const start = Math.max(0, it.startPolylinePointIndex ?? 0);
      const end = Math.min(points.length - 1, it.endPolylinePointIndex ?? points.length - 1);
      if (end - start < 1) return;
      const seg = points.slice(start, end + 1);
      if (seg.length < 2) return;
      const f = trafficFlowFromSpeed(it.speed ?? 'NORMAL');
      roads.push({ id: `g-${i}-${idx}`, coords: seg, density: f.density, speed: f.speed, priority: f.priority });
    });
  }

  return roads.map(r => ({
    ...r,
    totalLength: r.coords.reduce((sum, _, i) => i === 0 ? sum : sum + gcDistanceMeters(r.coords[i - 1].lat, r.coords[i - 1].lon, r.coords[i].lat, r.coords[i].lon), 0),
  }));
}

function parseTLEText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  let pendingName = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('0 ')) { pendingName = line.slice(2).trim(); continue; }
    if (!line.startsWith('1 ')) continue;
    const line1 = line;
    const line2 = lines[i + 1] ?? '';
    if (!line2.startsWith('2 ')) continue;
    out.push({ name: pendingName || `SAT-${out.length + 1}`, line1, line2 });
    pendingName = '';
    i += 1;
  }
  return out;
}

function classifySatelliteMilitaryStatus(upperName) {
  const military = [
    'NROL', 'NRO', 'USAF', 'USA-', 'USSF', 'AFSPC', 'COSMOS', 'YAOGAN', 'MILITARY', 'DEFENSE',
    'DSP', 'SBIRS', 'WARNING', 'EARLY WARN', 'KH-11', 'KH-9', 'KH-8', 'KEYHOLE', 'ORION',
    'IMPROVED CRYSTAL', 'LACROSSE', 'RAINBOW', 'VORTEX', 'JUMPSEAT', 'MILSTAR', 'SKYNET',
    'PYRAMIDS', 'FLTSAT', 'DSCS', 'AFSAT', 'AFTS-', 'NAVY', 'SSN-', 'FLTSATCOM', 'UFO-',
    'ZIYUAN', 'HUANJING', 'KOPEK', 'CYKLOP', 'KVANT', 'PROGNOZ', 'HEXAGON', 'GAMBIT',
    'TALENT', 'SIGINT', 'COMINT', 'ELINT', 'RECONNAISSANCE', 'RECONNAISSANCE IMAGERY',
    'NATIONAL SECURITY',
  ];
  return military.some(k => upperName.includes(k));
}

function classifySatelliteApplication(upperName) {
  const astronomical = ['HUBBLE', 'JWST', 'JAMES WEBB', 'CHANDRA', 'XMM', 'FERMI', 'TESS', 'KEPLER', 'GAIA', 'EUCLID', 'ASTRO'];
  if (astronomical.some(k => upperName.includes(k))) return 'Astronomical';

  const navigation = ['GPS', 'NAVSTAR', 'GLONASS', 'GALILEO', 'BEIDOU', 'QZSS', 'IRNSS', 'NAVIC', 'EGNOS', 'WAAS'];
  if (navigation.some(k => upperName.includes(k))) return 'Navigation';

  const earthObservation = ['LANDSAT', 'SENTINEL', 'TERRA', 'AQUA', 'NOAA', 'METEOR', 'HIMAWARI', 'GOES', 'RADARSAT', 'PLEIADES', 'WORLDVIEW', 'SPOT', 'SUOMI', 'NPP'];
  if (earthObservation.some(k => upperName.includes(k))) return 'Earth Observation';

  const communication = ['STARLINK', 'ONEWEB', 'IRIDIUM', 'GLOBALSTAR', 'INTELSAT', 'EUTELSAT', 'INMARSAT', 'TELSTAR', 'ASTRA', 'O3B', 'TDRS', 'SKYNET', 'SATCOM'];
  if (communication.some(k => upperName.includes(k))) return 'Communication';

  return 'Unknown';
}

function classifySatelliteCrewedStatus(upperName) {
  const crewed = ['ISS', 'ZARYA', 'TIANGONG', 'CSS', 'CREW DRAGON', 'STARLINER', 'SOYUZ', 'SHENZHOU'];
  return crewed.some(k => upperName.includes(k)) ? 'Crewed' : 'Uncrewed';
}

function classifySatelliteOrbitType(line2 = '') {
  const l2 = String(line2).padEnd(69, ' ');
  const inclinationDeg = Number.parseFloat(l2.slice(8, 16).trim());
  const eccRaw = l2.slice(26, 33).trim();
  const eccentricity = Number.parseFloat(`0.${eccRaw}`);
  const meanMotionRevDay = Number.parseFloat(l2.slice(52, 63).trim());

  if (!Number.isFinite(meanMotionRevDay) || meanMotionRevDay <= 0) return 'Unknown';

  const periodMinutes = 1440 / meanMotionRevDay;
  const nearGeoPeriod = Math.abs(periodMinutes - 1436) < 40;
  const lowInclination = Number.isFinite(inclinationDeg) ? inclinationDeg < 20 : false;
  const lowEccentricity = Number.isFinite(eccentricity) ? eccentricity < 0.02 : true;

  if (nearGeoPeriod && lowInclination && lowEccentricity) return 'GEO';
  if (periodMinutes < 128) return 'LEO';
  if (periodMinutes < 600) return 'MEO';
  const highEccentricity = Number.isFinite(eccentricity) ? eccentricity > 0.25 : false;
  if (highEccentricity || periodMinutes >= 600) return 'HEO';
  return 'Unknown';
}

function deriveSatelliteMeta(name, line2) {
  const upperName = String(name ?? '').toUpperCase();
  return {
    isMilitary: classifySatelliteMilitaryStatus(upperName),
    application: classifySatelliteApplication(upperName),
    crewedStatus: classifySatelliteCrewedStatus(upperName),
    orbitType: classifySatelliteOrbitType(line2),
  };
}

function categoryForSatelliteMeta(meta) {
  if (meta?.isMilitary) return 'military';
  if ((meta?.crewedStatus ?? '').toLowerCase() === 'crewed') return 'crewed';
  const app = (meta?.application ?? 'unknown').toLowerCase();
  if (app === 'earth observation') return 'earthobservation';
  if (app === 'communication') return 'communication';
  if (app === 'navigation') return 'navigation';
  if (app === 'astronomical') return 'astronomical';
  return 'unknown';
}

async function ensureSatelliteCatalog() {
  const now = Date.now();
  if (satCatalog.length && (now - satCatalogTs) < SAT_CATALOG_TTL_MS) return;

  async function loadFromCelesTrak() {
    const url = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=TLE';
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(SAT_SNAPSHOT_POLL_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`CelesTrak ${resp.status}`);
    const text = await resp.text();
    const parsed = parseTLEText(text);
    satCatalog = parsed.map((t, idx) => {
      const meta = deriveSatelliteMeta(t.name, t.line2);
      return {
      id: `${idx}:${t.name}`,
      name: t.name,
      line1: t.line1,
      line2: t.line2,
      satrec: satellite.twoline2satrec(t.line1, t.line2),
      meta,
      category: categoryForSatelliteMeta(meta),
    };
    });
    satCatalogSource = 'celestrak';
  }

  async function loadFromSpaceTrack() {
    if (!SPACETRACK_USER || !SPACETRACK_PASS) {
      throw new Error('Space-Track credentials missing');
    }

    const loginBody = new URLSearchParams({
      identity: SPACETRACK_USER,
      password: SPACETRACK_PASS,
    });

    const loginResp = await fetch('https://www.space-track.org/ajaxauth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...HEADERS,
      },
      body: loginBody.toString(),
      signal: AbortSignal.timeout(SAT_SNAPSHOT_POLL_TIMEOUT_MS),
    });
    if (!loginResp.ok) throw new Error(`Space-Track login ${loginResp.status}`);

    const cookie = loginResp.headers.get('set-cookie') ?? '';
    if (!cookie) throw new Error('Space-Track session cookie missing');

    // Omit limit clause → Space-Track returns their full GP catalog
    const queryUrl = `https://www.space-track.org/basicspacedata/query/class/gp/EPOCH/%3Enow-1/orderby/CREATION_DATE%20DESC/format/json`;
    const gpResp = await fetch(queryUrl, {
      headers: {
        ...HEADERS,
        Cookie: cookie,
      },
      signal: AbortSignal.timeout(SAT_SNAPSHOT_POLL_TIMEOUT_MS),
    });
    if (!gpResp.ok) throw new Error(`Space-Track GP ${gpResp.status}`);

    const rows = await gpResp.json();
    const allRows = (Array.isArray(rows) ? rows : []).filter(r => r?.TLE_LINE1 && r?.TLE_LINE2);
    satCatalog = allRows.map((r, idx) => {
      const name = (r.OBJECT_NAME ?? `NORAD ${r.NORAD_CAT_ID ?? idx}`).trim();
      const line1 = r.TLE_LINE1;
      const line2 = r.TLE_LINE2;
      const meta = deriveSatelliteMeta(name, line2);
      return {
      id: `${idx}:${r.OBJECT_NAME ?? r.NORAD_CAT_ID ?? 'SAT'}`,
      name,
      line1,
      line2,
      satrec: satellite.twoline2satrec(line1, line2),
      meta,
      category: categoryForSatelliteMeta(meta),
    };
    });
    satCatalogSource = 'spacetrack';
  }

  try {
    switch (BACKEND_SATELLITE_PROVIDER) {
      case 'spacetrack':
        await loadFromSpaceTrack();
        break;
      case 'n2yo':
        // Browser-direct N2YO is targeted queries only; server snapshot mode
        // uses direct position sampling instead of TLE propagation.
        await loadFromCelesTrak();
        break;
      case 'celestrak':
      default:
        await loadFromCelesTrak();
        break;
    }
  } catch (err) {
    console.warn(`[proxy] Satellite catalog load failed (${BACKEND_SATELLITE_PROVIDER}), fallback to CelesTrak: ${err?.message ?? 'unknown'}`);
    await loadFromCelesTrak();
  }

  satCatalogTs = now;
}

function satelliteSnapshot(maxCount = Infinity, options = {}) {
  const nowDate = new Date();
  const gmst = satellite.gstime(nowDate);
  const points = [];
  const limit = Number.isFinite(maxCount) ? maxCount : satCatalog.length;
  const selectedCategories = Array.isArray(options.categories)
    ? options.categories.filter(Boolean).map(v => String(v).toLowerCase())
    : [];
  const categoryFilterEnabled = selectedCategories.length > 0;
  const perCategory = Number.isFinite(options.perCategory) && options.perCategory > 0
    ? Math.floor(options.perCategory)
    : SATELLITE_MAX_PER_CATEGORY;
  const perCategoryCounts = new Map();

  for (let i = 0; i < satCatalog.length; i++) {
    if (points.length >= limit) break;
    const s = satCatalog[i];
    const category = s.category ?? 'unknown';

    if (categoryFilterEnabled && !selectedCategories.includes(category)) {
      continue;
    }
    if (categoryFilterEnabled) {
      const used = perCategoryCounts.get(category) ?? 0;
      if (used >= perCategory) continue;
      perCategoryCounts.set(category, used + 1);
    }

    const pv = satellite.propagate(s.satrec, nowDate);
    if (!pv?.position) continue;
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    if (!Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude) || !Number.isFinite(geo.height)) continue;
    points.push({
      id: s.id,
      name: s.name,
      lat: toDeg(geo.latitude),
      lon: toDeg(geo.longitude),
      altM: geo.height * 1000,
      line1: s.line1,
      line2: s.line2,
      category,
      meta: s.meta,
    });
  }
  return points;
}

async function getSatellitesSnapshotPayload(maxCount = Infinity, options = {}) {
  const now = Date.now();
  const requestMax = Number.isFinite(maxCount) ? maxCount : Infinity;
  const requestedPerCategory = Number.isFinite(options.perCategory) && options.perCategory > 0
    ? Math.floor(options.perCategory)
    : SATELLITE_MAX_PER_CATEGORY;
  const selectedCategories = Array.isArray(options.categories)
    ? options.categories.filter(Boolean).map(v => String(v).toLowerCase())
    : [];
  const categoryKey = selectedCategories.length ? selectedCategories.sort().join(',') : 'all';
  const snapshotTtl = BACKEND_SATELLITE_PROVIDER === 'n2yo' ? N2YO_SNAPSHOT_TTL_MS : SAT_SNAPSHOT_TTL_MS;
  if (satSnapshotCache.points.length && satSnapshotCache.source === BACKEND_SATELLITE_PROVIDER && satSnapshotCache.categoryKey === categoryKey && satSnapshotCache.perCategory === requestedPerCategory && (now - satSnapshotCache.ts) < snapshotTtl && satSnapshotCache.maxCount >= requestMax) {
    const points = Number.isFinite(requestMax)
      ? satSnapshotCache.points.slice(0, requestMax)
      : satSnapshotCache.points;
    return { points, total: points.length, ts: satSnapshotCache.ts, source: `server-propagated:${satSnapshotCache.source}`, cacheHit: true };
  }

  const computeMax = Number.isFinite(requestMax) ? requestMax : 99_999;
  let points;
  let source;
  if (BACKEND_SATELLITE_PROVIDER === 'n2yo') {
    points = await fetchN2yoSnapshot(computeMax);
    source = 'n2yo';
  } else {
    await ensureSatelliteCatalog();
    points = satelliteSnapshot(computeMax, {
      categories: selectedCategories,
      perCategory: requestedPerCategory,
    });
    source = satCatalogSource;
  }
  const generatedAt = Date.now();
  satSnapshotCache = {
    ts: generatedAt,
    points,
    source,
    maxCount: computeMax,
    perCategory: requestedPerCategory,
    categoryKey,
  };
  scheduleCacheWrite();
  return { points: Number.isFinite(requestMax) ? points.slice(0, requestMax) : points, total: Number.isFinite(requestMax) ? Math.min(points.length, requestMax) : points.length, ts: generatedAt, source: `server-propagated:${source}`, cacheHit: false };
}

async function getTrafficPayload(bounds) {
  const b = normalizeBounds(bounds);
  if (!b) {
    return { roads: [], total: 0, ts: Date.now(), source: 'traffic-server', mode: 'bounds-required' };
  }

  const backendMode = resolveTrafficBackendMode();
  const cacheKey = `${backendMode}:${boundsCacheKey(b, 'traffic-global')}`;
  const cached = trafficSnapshotCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.ts) < TRAFFIC_SNAPSHOT_TTL_MS) {
    return { ...cached.payload, cacheHit: true };
  }

  const [minLon, minLat, maxLon, maxLat] = b;
  const roads = backendMode === 'google-live'
    ? await buildGoogleTrafficRoads(minLon, minLat, maxLon, maxLat)
    : await buildOsmTrafficRoads(minLon, minLat, maxLon, maxLat);
  const generatedAt = Date.now();
  const payload = {
    roads,
    total: roads.length,
    ts: generatedAt,
    source: backendMode === 'google-live' ? 'google-routes-server' : 'osm-overpass-server',
    mode: backendMode,
    cacheKey,
    cacheHit: false,
  };
  trafficSnapshotCache.set(cacheKey, { ts: generatedAt, payload });
  scheduleCacheWrite();
  return payload;
}

// ── Aircraft database ─────────────────────────────────────────────────────────
/** @type {Map<string, object>} */
const db = new Map();

function upsert(aircraft) {
  const now = Date.now();
  for (const a of aircraft) {
    const id = (a.hex ?? '').toLowerCase().trim();
    if (!id || !a.lat || !a.lon) continue;
    if (a.alt_baro === 'ground' || (a.alt_baro ?? 0) <= 100) continue;
    db.set(id, {
      hex:      id,
      flight:   (a.flight ?? a.r ?? '').trim(),
      lat:      a.lat,
      lon:      a.lon,
      alt_baro: a.alt_baro ?? a.alt_geom ?? 10000,
      track:    a.track ?? 0,
      gs:       a.gs ?? 0,
      // enrichment fields — used for icon shape, color classification, HUD panel
      t:        a.t        ?? '',       // ICAO type code e.g. "H60", "B738", "A320"
      category: a.category ?? '',       // ADS-B category byte e.g. "A7" = rotorcraft
      dbFlags:  a.dbFlags  ?? 0,        // bit 0 = military
      squawk:   a.squawk   ?? '',
      baro_rate: a.baro_rate ?? a.geom_rate ?? 0,
      _seen:    now,
    });
  }
}

function pruneStale() {
  const cutoff = Date.now() - STALE_MS;
  let n = 0;
  for (const [id, a] of db) { if (a._seen < cutoff) { db.delete(id); n++; } }
  if (n) console.log(`[proxy] Pruned ${n} — DB: ${db.size}`);
}

setInterval(pruneStale, 30_000);

// ── Hub selection — find hubs that overlap the viewport bbox ──────────────────

function hubsForBounds(minLon, minLat, maxLon, maxLat) {
  // Pad the bbox by one hub radius so we catch aircraft near the edges
  const pad = RADIUS_DEG * 1.1;
  const pMinLat = minLat - pad, pMaxLat = maxLat + pad;
  const pMinLon = minLon - pad, pMaxLon = maxLon + pad;
  const wraps = pMaxLon - pMinLon >= 360; // full globe visible

  return ALL_HUBS.filter(h => {
    if (h.lat < pMinLat || h.lat > pMaxLat) return false;
    if (wraps) return true;
    if (pMinLon < -180 || pMaxLon > 180) {
      // bbox wraps antimeridian
      return h.lon >= pMinLon + 360 || h.lon <= pMaxLon - 360 ||
             (h.lon >= pMinLon && h.lon <= pMaxLon);
    }
    return h.lon >= pMinLon && h.lon <= pMaxLon;
  });
}

// ── Hub fetcher with per-hub TTL cache ────────────────────────────────────────

async function fetchHub(hub) {
  const key = hubKey(hub);
  const cached = hubCache.get(key);

  // Return cached promise if hub was recently fetched
  if (cached) {
    if (cached.promise) return cached.promise; // in-flight
    if (Date.now() - cached.time < HUB_TTL) return; // fresh, skip
  }

  const promise = (async () => {
    try {
      const url = `https://opendata.adsb.fi/api/v3/lat/${hub.lat}/lon/${hub.lon}/dist/${RADIUS_NM}`;
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`${res.status}`);
      const d = await res.json();
      upsert(d.aircraft ?? d.ac ?? []);
    } catch (err) {
      // Silently ignore individual hub failures
    } finally {
      hubCache.set(key, { time: Date.now(), promise: null });
    }
  })();

  hubCache.set(key, { time: Date.now(), promise });
  return promise;
}

// ── Request handler ───────────────────────────────────────────────────────────

async function getFlightsPayload(query = {}) {
  let hubs = [];
  let flightSource = BACKEND_FLIGHT_PROVIDER;
  const requestHeavy = query.mode === 'heavy' || SERVER_HEAVY_MODE;
  const viewportBufferDeg = requestHeavy ? 3 : 1;
  const parts = (query.bounds ?? '').split(',').map(Number);
  const bounds = (parts.length === 4 && parts.every(n => Number.isFinite(n))) ? normalizeBounds(parts) : null;
  const cacheKey = `${requestHeavy ? 'heavy' : 'normal'}:${boundsCacheKey(bounds)}:${BACKEND_FLIGHT_PROVIDER}`;
  const cached = flightSnapshotCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < FLIGHT_SNAPSHOT_TTL_MS) {
    return { ...cached.payload, cacheHit: true };
  }

  // Use configured backend provider where available; keep proxy hub mode as fallback.
  let shouldUseHubGridFallback = BACKEND_FLIGHT_PROVIDER === 'proxy';

  if (BACKEND_FLIGHT_PROVIDER === 'airplaneslive' || BACKEND_FLIGHT_PROVIDER === 'adsbool') {
    try {
      const base = BACKEND_FLIGHT_PROVIDER === 'airplaneslive'
        ? 'https://api.airplanes.live'
        : 'https://api.adsb.lol';
      // In server-heavy mode use /v2/all for global coverage (no viewport limit)
      await fetchReadsbProvider(base, bounds, requestHeavy);
    } catch (err) {
      console.warn(`[proxy] ${BACKEND_FLIGHT_PROVIDER} backend fetch failed, falling back to hub grid: ${err?.message ?? 'unknown'}`);
      shouldUseHubGridFallback = true;
      flightSource = `${BACKEND_FLIGHT_PROVIDER}:fallback-hub-grid`;
    }
  }

  if (BACKEND_FLIGHT_PROVIDER === 'opensky') {
    try {
      await fetchOpenSkyProvider();
    } catch (err) {
      console.warn(`[proxy] OpenSky backend fetch failed, falling back to hub grid: ${err?.message ?? 'unknown'}`);
      shouldUseHubGridFallback = true;
      flightSource = 'opensky:fallback-hub-grid';
    }
  }

  if (shouldUseHubGridFallback) {
    // In heavy mode fetch ALL hubs globally; otherwise only viewport hubs
    if (requestHeavy) {
      hubs = ALL_HUBS;
    } else if (bounds) {
      const [minLon, minLat, maxLon, maxLat] = bounds;
      hubs = hubsForBounds(minLon, minLat, maxLon, maxLat);
    }

    const batches = [];
    for (let i = 0; i < hubs.length; i += MAX_CONC) {
      batches.push(hubs.slice(i, i + MAX_CONC));
    }
    for (const batch of batches) {
      await Promise.allSettled(batch.map(h => fetchHub(h)));
    }
  }

  // In server-heavy mode return the entire DB (global mode); otherwise filter to bbox
  let aircraft = [...db.values()].map(({ _seen, ...rest }) => rest);

  if (!requestHeavy && bounds) {
    const [minLon, minLat, maxLon, maxLat] = bounds;
    aircraft = aircraft.filter(a =>
      a.lat >= minLat - viewportBufferDeg && a.lat <= maxLat + viewportBufferDeg &&
      a.lon >= minLon - viewportBufferDeg && a.lon <= maxLon + viewportBufferDeg
    );
  }

  console.log(`[proxy] flights=${flightSource} ${hubs.length} hubs queried → ${aircraft.length} aircraft in viewport${requestHeavy ? ' (heavy)' : ''}`);

  const payload = { aircraft, total: aircraft.length, ts: Date.now(), source: flightSource, cacheKey, cacheHit: false };
  flightSnapshotCache.set(cacheKey, { ts: Date.now(), payload });
  scheduleCacheWrite();
  return payload;
}

async function handleFlights(query, res) {
  const payload = await getFlightsPayload(query);
  res.writeHead(200);
  res.end(JSON.stringify(payload));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const [path, qs] = req.url.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs ?? ''));
  const url   = path.replace(/\/$/, '');

  if (url === '/api/flights') {
    await handleFlights(query, res);
  } else if (url === '/api/traffic/google') {
    const parts = (query.bounds ?? '').split(',').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'bounds must be minLon,minLat,maxLon,maxLat' }));
      return;
    }
    try {
      const payload = await getTrafficPayload(parts);
      res.writeHead(200);
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'traffic request failed' }));
    }
  } else if (url === '/api/satellites/snapshot') {
    const rawMax = parseInt(query.max ?? '0', 10);
    // 0 or missing → no limit (full catalog); otherwise honour the requested count
    const maxCount = rawMax > 0 ? rawMax : Infinity;
    const perCategory = Math.max(parseInt(query.perCategory ?? `${SATELLITE_MAX_PER_CATEGORY}`, 10) || SATELLITE_MAX_PER_CATEGORY, 1);
    const categories = String(query.categories ?? '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    try {
      const payload = await getSatellitesSnapshotPayload(maxCount, { perCategory, categories });
      res.writeHead(200);
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'satellite snapshot failed' }));
    }
  } else if (url === '/api/cameras/snapshot') {
    const parts = (query.bounds ?? '').split(',').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'bounds must be minLon,minLat,maxLon,maxLat' }));
      return;
    }
    const maxCount = Math.max(parseInt(query.max ?? `${CAMERA_MAX_POINTS}`, 10) || CAMERA_MAX_POINTS, 1);
    try {
      const payload = await getCameraSnapshot(parts, maxCount);
      res.writeHead(200);
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'camera snapshot failed' }));
    }
  } else if (url === '/api/world/snapshot') {
    const parts = (query.bounds ?? '').split(',').map(Number);
    const bounds = (parts.length === 4 && parts.every(n => Number.isFinite(n))) ? parts : null;
    const include = new Set((query.include ?? 'flights,satellites,traffic,cameras').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    const maxSat = Math.max(parseInt(query.satMax ?? '0', 10) || 0, 0) || Infinity;
    const satPerCategory = Math.max(parseInt(query.satPerCategory ?? `${SATELLITE_MAX_PER_CATEGORY}`, 10) || SATELLITE_MAX_PER_CATEGORY, 1);
    const satCategories = String(query.satCategories ?? '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    const maxCam = Math.max(parseInt(query.camMax ?? `${CAMERA_MAX_POINTS}`, 10) || CAMERA_MAX_POINTS, 1);

    try {
      const payload = { ts: Date.now(), mode: SERVER_HEAVY_MODE ? 'heavy' : 'normal' };
      const flightsPromise = include.has('flights')
        ? getFlightsPayload({
          bounds: bounds ? bounds.join(',') : '',
          mode: 'heavy',
        })
        : null;
      const satellitesPromise = include.has('satellites')
        ? getSatellitesSnapshotPayload(maxSat, { perCategory: satPerCategory, categories: satCategories })
        : null;
      const trafficPromise = (include.has('traffic') && bounds)
        ? getTrafficPayload(bounds)
        : null;
      const camerasPromise = (include.has('cameras') && bounds)
        ? getCameraSnapshot(bounds, maxCam)
        : null;

      const [flightsPayload, satellitesPayload, trafficPayload, camerasPayload] = await Promise.all([
        flightsPromise,
        satellitesPromise,
        trafficPromise,
        camerasPromise,
      ]);

      if (flightsPayload) payload.flights = flightsPayload;
      if (satellitesPayload) payload.satellites = satellitesPayload;
      if (trafficPayload) payload.traffic = trafficPayload;
      if (camerasPayload) payload.cameras = camerasPayload;

      payload.diagnostics = {
        providers: {
          flights: payload.flights?.source ?? null,
          satellites: payload.satellites?.source ?? null,
          traffic: payload.traffic?.source ?? null,
          cameras: payload.cameras?.source ?? null,
        },
        cache: {
          flights: payload.flights?.cacheHit ?? null,
          satellites: payload.satellites?.cacheHit ?? null,
          traffic: payload.traffic?.cacheHit ?? null,
          cameras: payload.cameras?.cacheHit ?? null,
        },
      };

      res.writeHead(200);
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'world snapshot failed' }));
    }
  } else if (url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      db: db.size,
      hubs: ALL_HUBS.length,
      hub_cache: hubCache.size,
      cache: {
        flights: flightSnapshotCache.size,
        traffic: trafficSnapshotCache.size,
        sat_points: satSnapshotCache.points?.length ?? 0,
        camera_tiles: cameraTileCache.size,
        camera_snapshots: cameraSnapshotCache.size,
      },
    }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => {
  loadSnapshotCacheFromDisk();
  console.log(`[proxy] Mode: ${SERVER_HEAVY_MODE ? 'heavy' : 'normal'}`);
  console.log(`[proxy] Providers: flights=${BACKEND_FLIGHT_PROVIDER}, satellites=${BACKEND_SATELLITE_PROVIDER}`);
  console.log(`[proxy] ShadowGrid → http://localhost:${PORT}/api/flights?bounds=minLon,minLat,maxLon,maxLat`);
  ensureSatelliteCatalog()
    .then(() => {
      console.log(`[proxy] Satellite catalog primed: ${satCatalog.length} objects (${satCatalogSource})`);
    })
    .catch((err) => {
      console.warn(`[proxy] Satellite catalog warm-up failed: ${err?.message ?? 'unknown'}`);
    });
});
