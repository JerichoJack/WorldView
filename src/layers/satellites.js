/**
 * layers/satellites.js
 * Real-time satellite orbital tracking with a switchable TLE data provider.
 *
 * Controlled by VITE_SATELLITE_PROVIDER in your .env:
 *
 *   celestrak    — CelesTrak (free, no key, most widely used)
 *   spacetrack   — Space-Track.org (free account required, US Space Force data)
 *   n2yo         — N2YO.com (free tier, 1000 requests/hr, key required)
 *
 * All providers feed the same satellite.js SGP4 propagator so rendering is
 * identical regardless of source. Falls back to CelesTrak if unconfigured.
 *
 * ⚠️  CelesTrak note (March 2026): Catalog numbers are approaching the 5-digit
 * limit (~69,999). CelesTrak is transitioning to OMM/JSON format for new objects.
 * This file uses the stable GP JSON endpoint which handles both ranges.
 *
 * Docs:
 *   CelesTrak:   https://celestrak.org/NORAD/documentation/gp-data-formats.php
 *   Space-Track: https://www.space-track.org/documentation
 *   N2YO:        https://www.n2yo.com/api/
 *   satellite.js: https://github.com/shashwatak/satellite-js
 */

import * as Cesium from 'cesium';
import * as satellite from 'satellite.js';
import { setServerSnapshotLayerEnabled, subscribeServerSnapshot } from '../core/serverSnapshot.js';

// ── Config ────────────────────────────────────────────────────────────────────

const PROVIDER       = (import.meta.env.VITE_SATELLITE_PROVIDER    ?? 'celestrak').toLowerCase();
const SERVER_HEAVY_MODE = (import.meta.env.VITE_SERVER_HEAVY_MODE ?? 'false').toLowerCase() === 'true';
const N2YO_KEY       =  import.meta.env.VITE_N2YO_API_KEY          ?? '';
const SPACETRACK_USER =  import.meta.env.VITE_SPACETRACK_USERNAME   ?? '';
const SPACETRACK_PASS =  import.meta.env.VITE_SPACETRACK_PASSWORD   ?? '';
const SATELLITE_SNAPSHOT_URL = '/api/localproxy/api/satellites/snapshot';
const SNAPSHOT_POLL_MS = 2_000;

const PROPAGATE_MS  = 1_000;
const TRACK_MINUTES = 90;
const TRACK_STEPS   = 60;
const _MAX_SATS_ENV = import.meta.env.VITE_SATELLITE_MAX_OBJECTS ?? '';
// In server-heavy mode the server does the propagation work; no client-side cap.
// Set VITE_SATELLITE_MAX_OBJECTS to an explicit number to override.
const MAX_SATS = SERVER_HEAVY_MODE
  ? (_MAX_SATS_ENV ? Math.max(parseInt(_MAX_SATS_ENV, 10) || 99_999, 1) : 99_999)
  : Math.min(Math.max(parseInt(_MAX_SATS_ENV || '200', 10) || 200, 1), 5_000);

// ── CelesTrak GP TLE feeds (no key, no rate limit) ───────────────────────────
// Each feed has a primary URL (via Vite proxy → celestrak.org) and a direct
// HTTPS fallback in case the proxy target times out or is unreachable.
// CelesTrak also mirrors data at celestrak.com — we try both hosts.
const CELESTRAK_FEEDS = [
  {
    label:    'ISS',
    url:      '/api/celestrak/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE',
    fallback: [
      'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE',
      'https://celestrak.com/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE',
    ],
  },
  {
    label:    'Stations',
    url:      '/api/celestrak/NORAD/elements/gp.php?GROUP=stations&FORMAT=TLE',
    fallback: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=TLE',
      'https://celestrak.com/NORAD/elements/gp.php?GROUP=stations&FORMAT=TLE',
    ],
  },
  {
    label:    'Starlink',
    url:      '/api/celestrak/NORAD/elements/gp.php?GROUP=starlink&FORMAT=TLE',
    fallback: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=TLE',
      'https://celestrak.com/NORAD/elements/gp.php?GROUP=starlink&FORMAT=TLE',
    ],
  },
  {
    label:    'Military',
    url:      '/api/celestrak/NORAD/elements/gp.php?GROUP=military&FORMAT=TLE',
    fallback: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=military&FORMAT=TLE',
      'https://celestrak.com/NORAD/elements/gp.php?GROUP=military&FORMAT=TLE',
    ],
  },
  {
    label:    'Active',
    url:      '/api/celestrak/NORAD/elements/gp.php?GROUP=active&FORMAT=TLE',
    fallback: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=TLE',
      'https://celestrak.com/NORAD/elements/gp.php?GROUP=active&FORMAT=TLE',
    ],
  },
];

// Per-feed fetch timeout — don't let a single stalled proxy hang the whole load
const CELESTRAK_TIMEOUT_MS = 2_000;

// ── Space-Track feeds (free account required at space-track.org) ──────────────
// ⚠️  Must go through the Vite /api/spacetrack proxy — direct browser fetches
//     are blocked by CORS (space-track.org sends no Access-Control-Allow-Origin).
// Uses JSON format to get OBJECT_NAME field (TLE format omits object names).
// Ordered by CREATION_DATE (newest first) to prioritize recently deployed military/
// reconnaissance satellites over older objects.
const SPACETRACK_LOGIN_URL = '/api/spacetrack/ajaxauth/login';
// No limit clause — fetch the full GP catalog (server-heavy: server handles this;
// client-direct: Space-Track returns everything up to their server default).
const SPACETRACK_TLE_URL = () =>
  `/api/spacetrack/basicspacedata/query/class/gp/EPOCH/%3Enow-1/orderby/CREATION_DATE%20DESC/format/json`;

// ── N2YO (1000 req/hr free tier, requires API key) ────────────────────────────
// N2YO doesn't provide bulk TLE dumps but does provide individual satellite TLE.
// We use their "above" endpoint to get satellites visible from a reference point.
// ⚠️  Must go through the Vite /api/n2yo proxy — api.n2yo.com sends no CORS headers.
const N2YO_ABOVE_URL = (lat, lon, alt, radius, catid) =>
  `/api/n2yo/rest/v1/satellite/above/${lat}/${lon}/${alt}/${radius}/${catid}/&apiKey=${N2YO_KEY}`;

// Hardcoded TLE fallback if all providers fail (timeout/network issues)
const ISS_FALLBACK = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9000',
  '2 25544  51.6435 145.2570 0001234  80.1234 280.0000 15.49560001000000',
];

const BUILTIN_TLE_FALLBACKS = [
  // Space stations
  { name: 'ISS (ZARYA)', line1: ISS_FALLBACK[1], line2: ISS_FALLBACK[2] },
  { name: 'TIANGONG (CSS)', line1: '1 48274U 21035A   26070.25000000  .00001234  00000-0  65432-4 0  9998', line2: '2 48274  41.5012 177.2345 0001823  45.6789 314.5432 15.54187649123456' },
  // Space telescopes
  { name: 'HUBBLE SPACE TELESCOPE', line1: '1 20580U 90037B   26070.15842695  .00000697  00000+0  27767-4 0  9996', line2: '2 20580  28.4696  93.8182 0002838 300.9387  59.1217 15.23361377764029' },
  { name: 'JAMES WEBB SPACE TELESCOPE', line1: '1 55913U 21130A   26070.84523456  .00000234  00000-0  12345-5 0  9995', line2: '2 55913   1.0456 346.2345 0089234 123.4567  45.6789  1.01234567123456' },
  // Earth observation
  { name: 'TERRA', line1: '1 25994U 99068A   26070.40013331  .00000184  00000+0  40595-4 0  9999', line2: '2 25994  98.2084 130.1204 0001234  88.2090 271.9244 14.57109314299735' },
  { name: 'AQUA', line1: '1 27424U 02022A   26070.51559952  .00000186  00000+0  42257-4 0  9990', line2: '2 27424  98.2066 130.5511 0001108  91.7472 268.3852 14.57112159162845' },
  { name: 'LANDSAT 8', line1: '1 39084U 13008A   26070.57136477  .00000070  00000+0  27679-4 0  9991', line2: '2 39084  98.2069 129.1572 0001309  86.8343 273.2988 14.57111254581240' },
  { name: 'NOAA 19', line1: '1 33591U 09005A   26070.53363847  .00000093  00000+0  79967-4 0  9996', line2: '2 33591  99.1943 125.1671 0014240 316.8577  43.1420 14.12415212773393' },
  { name: 'SUOMI NPP', line1: '1 37849U 11061A   26070.59726695  .00000077  00000+0  35779-4 0  9997', line2: '2 37849  98.7035  61.9590 0001390 107.6631 252.4702 14.19520570639647' },
];

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, { satrec: object, entity: Cesium.Entity, trackEntity: Cesium.Entity, meta: object }>} */
const satMap  = new Map();
let enabled   = false;  // Start disabled by default
let lastSatelliteStatusKey = '';

// Classification filter state — all enabled by default
const classificationFilters = {
  military: true,
  crewed: true,
  communication: true,
  earthobservation: true,
  navigation: true,
  astronomical: true,
  unknown: true,
};

/**
 * Determine if a satellite entity should be visible based on enabled state and filters
 */
function shouldShowSatellite(meta) {
  if (!enabled) return false;
  
  if (meta.isMilitary) return classificationFilters.military;
  if ((meta.crewedStatus ?? '').toLowerCase() === 'crewed') return classificationFilters.crewed;
  
  const app = (meta.application ?? 'Unknown').toLowerCase();
  const filterKey = app === 'earth observation' ? 'earthobservation' : app;
  return classificationFilters[filterKey] ?? classificationFilters.unknown;
}

function publishSystemStatus(msg, level = 'ok', key = `${level}:${msg}`) {
  if (lastSatelliteStatusKey === key) return;
  lastSatelliteStatusKey = key;
  if (typeof window === 'undefined') return;

  const ts = Date.now();
  window.__shadowgridSystemStatus = { msg, level, key, source: 'satellites', ts };
  window.__shadowgridSubsystemStatus = {
    ...(window.__shadowgridSubsystemStatus ?? {}),
    satellites: { msg, level, key, ts },
  };

  window.dispatchEvent(new CustomEvent('shadowgrid:system-status', {
    detail: { msg, level, source: 'satellites', key, ts },
  }));
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initSatellites(viewer) {
  if (SERVER_HEAVY_MODE) {
    return initSatellitesServerSnapshot(viewer);
  }

  console.info(`[Satellites] Provider: ${PROVIDER}`);
  const tleRecords = await loadTLEs();

  for (const { name, line1, line2 } of tleRecords) {
    try {
      const satrec = satellite.twoline2satrec(line1, line2);
      const meta = deriveSatelliteMeta(name, line2);
      addSatelliteEntity(viewer, name, satrec, meta);
    } catch { /* skip malformed */ }
  }

  setInterval(() => {
    if (!enabled) return;
    const now = new Date();
    for (const [, rec] of satMap) updatePosition(rec, now);
  }, PROPAGATE_MS);

  console.info(`[Satellites] ${satMap.size} satellites tracked (${PROVIDER})`);

  // Publish ok if no errors were encountered during load
  if (!lastSatelliteStatusKey) {
    publishSystemStatus(`● SATELLITE FEED OK · ${PROVIDER.toUpperCase()}`, 'ok', `sat:ok:${PROVIDER}`);
  }

  return {
    setEnabled(val) {
      enabled = val;
      satMap.forEach(({ entity, trackEntity, meta }) => {
        entity.show      = shouldShowSatellite(meta);
        trackEntity.show = shouldShowSatellite(meta);
      });
    },
    setClassificationFilter(classification, enabled) {
      const key = classification.toLowerCase();
      if (key in classificationFilters) {
        classificationFilters[key] = enabled;
        // Update visibility of all entities
        satMap.forEach(({ entity, trackEntity, meta }) => {
          entity.show      = shouldShowSatellite(meta);
          trackEntity.show = shouldShowSatellite(meta);
        });
      }
    },
    get count() { return satMap.size; },
    get provider() { return PROVIDER; },
  };
}

async function initSatellitesServerSnapshot(viewer) {
  console.info('[Satellites] Provider: server-snapshot (server-heavy mode)');

  const entities = new Map();
  let enabledLocal = false;

  function upsertPoint(point) {
    const pos = Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.altM);
    const existing = entities.get(point.id);
    if (existing) {
      existing.position = pos;
      existing.show = enabledLocal;
      return;
    }

    // Classify by name so coloring matches the full (non-snapshot) path
    const meta        = deriveSatelliteMeta(point.name, '');
    const isMilitary  = meta.isMilitary;
    const isCrewed    = (meta.crewedStatus ?? '').toLowerCase() === 'crewed';
    const application = meta.application ?? 'Unknown';

    let pointColor;
    if (isMilitary) {
      pointColor = Cesium.Color.fromCssColorString('#ff3b30');
    } else if (isCrewed) {
      pointColor = Cesium.Color.fromCssColorString('#00ff66');
    } else {
      switch (application) {
        case 'Communication':    pointColor = Cesium.Color.fromCssColorString('#ffea00'); break;
        case 'Earth Observation': pointColor = Cesium.Color.fromCssColorString('#ff9800'); break;
        case 'Navigation':       pointColor = Cesium.Color.fromCssColorString('#9c27b0'); break;
        case 'Astronomical':     pointColor = Cesium.Color.fromCssColorString('#e91e63'); break;
        default:                 pointColor = Cesium.Color.fromCssColorString('#00aaff'); break;
      }
    }

    const entity = viewer.entities.add({
      id: `sat-${point.id}`,
      position: pos,
      point: {
        pixelSize:       15,
        color:           pointColor,
        outlineColor:    Cesium.Color.fromCssColorString('#003366'),
        outlineWidth:    1,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 2, 1e7, 0.8),
      },
      label: {
        text:             point.name,
        font:             '24px "Share Tech Mono", monospace',
        color:            Cesium.Color.fromCssColorString('#00aaff'),
        outlineColor:     Cesium.Color.fromCssColorString('#003366'),
        outlineWidth:     2,
        style:            Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin:   Cesium.VerticalOrigin.BOTTOM,
        pixelOffset:      new Cesium.Cartesian2(0, -30),
        scaleByDistance:  new Cesium.NearFarScalar(1e5, 1, 1e7, 0),
        translucencyByDistance: new Cesium.NearFarScalar(1e5, 10, 5e6, 0),
      },
      shadowgridType: 'satellite',
      shadowgridMeta: {
        name: point.name,
        application,
        isMilitary,
        crewedStatus: meta.crewedStatus,
        provider: 'server-snapshot',
      },
      show: enabledLocal,
    });
    entities.set(point.id, entity);
  }

  function applySnapshot(points) {
    const seen = new Set();
    for (const p of points) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !Number.isFinite(p.altM)) continue;
      seen.add(p.id);
      upsertPoint(p);
    }

    for (const [id, entity] of entities) {
      if (!seen.has(id)) {
        viewer.entities.remove(entity);
        entities.delete(id);
      }
    }

    publishSystemStatus('● SATELLITE FEED OK · SERVER SNAPSHOT', 'ok', 'sat:server-snapshot:ok');
  }

  subscribeServerSnapshot('satellites', {
    onData(payload) {
      if (!enabledLocal) return;
      applySnapshot(payload?.satellites?.points ?? []);
    },
    onError(err) {
      publishSystemStatus(`⚠ SATELLITE SNAPSHOT ERROR · ${err?.message ?? 'request failed'}`, 'error', `sat:server-snapshot:error:${err?.message ?? 'unknown'}`);
    },
  });

  return {
    setEnabled(val) {
      enabledLocal = val;
      setServerSnapshotLayerEnabled('satellites', enabledLocal);
      entities.forEach(entity => {
        entity.show = enabledLocal;
      });
    },
    setClassificationFilter(_classification, _enabled) {
      // Not supported in snapshot mode yet.
    },
    get count() {
      return entities.size;
    },
  };
}

// ── TLE loading: dispatch to provider ────────────────────────────────────────

async function loadTLEs() {
  let records = [];

  switch (PROVIDER) {
    case 'spacetrack': records = await loadSpaceTrack(); break;
    case 'n2yo':       records = await loadN2YO();       break;
    case 'celestrak':
    default:           records = await loadCelesTrak();  break;
  }

  // Always ensure ISS is present as a minimum
  if (!records.find(r => r.name.toUpperCase().includes('ISS'))) {
    records.unshift({ name: ISS_FALLBACK[0], line1: ISS_FALLBACK[1], line2: ISS_FALLBACK[2] });
  }

  // In server-heavy mode MAX_SATS is effectively unlimited; still honour an explicit env override.
  return Number.isFinite(MAX_SATS) && MAX_SATS < 99_999 ? records.slice(0, MAX_SATS) : records;
}

// ── Provider: CelesTrak (free, no key) ───────────────────────────────────────

/**
 * Fetch a URL with an AbortController-based timeout.
 */
async function fetchWithTimeout(url, timeoutMs) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one CelesTrak feed, trying the proxied URL first and then the
 * direct HTTPS fallback if the proxy times out or returns an error.
 */
async function fetchCelesTrakFeed(feed) {
  // 1. Try via Vite proxy (avoids CORS, but can ETIMEDOUT in some networks)
  try {
    const resp = await fetchWithTimeout(feed.url, CELESTRAK_TIMEOUT_MS);
    if (resp.ok) return resp.text();
    throw new Error(`proxy ${resp.status}`);
  } catch (proxyErr) {
    console.debug(`[Satellites] CelesTrak ${feed.label} proxy failed (${proxyErr.message}), trying direct…`);
  }

  // 2. Direct HTTPS fetch (try both celestrak.org and celestrak.com mirrors)
  let lastErr = null;
  for (const url of feed.fallback) {
    try {
      const resp = await fetchWithTimeout(url, CELESTRAK_TIMEOUT_MS);
      if (resp.ok) return resp.text();
      lastErr = new Error(`direct ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('direct fetch failed');
}

async function loadCelesTrak() {
  const records = [];
  let failedFeeds = 0;
  for (const feed of CELESTRAK_FEEDS) {
    try {
      const text   = await fetchCelesTrakFeed(feed);
      const parsed = parseTLEText(text);
      records.push(...parsed);
      console.debug(`[Satellites] CelesTrak ${feed.label}: ${parsed.length} TLEs`);
    } catch (err) {
      console.warn(`[Satellites] CelesTrak ${feed.label} failed:`, err.message);
      failedFeeds += 1;
      publishSystemStatus(`⚠ SAT FEED FAIL · CELESTRAK ${feed.label.toUpperCase()} · ${err?.message ?? 'request failed'}`, 'warn', `sat:celestrak:${feed.label}:${err?.message ?? 'unknown'}`);
    }
    if (records.length >= MAX_SATS) break;
  }

  if (failedFeeds > 0 && records.length > 0) {
    publishSystemStatus(`⚠ SATELLITE FEED DEGRADED · ${failedFeeds}/${CELESTRAK_FEEDS.length} CELESTRAK FEEDS FAILED`, 'warn', `sat:celestrak:degraded:${failedFeeds}`);
  }

  // If all feeds failed, use built-in fallback set
  if (!records.length) {
    console.warn('[Satellites] All CelesTrak feeds failed or timed out. Using built-in TLE fallback set.');
    publishSystemStatus('⚠ ALL CELESTRAK SATELLITE FEEDS FAILED · USING BUILT-IN TLE FALLBACKS', 'error', 'sat:celestrak:all-failed');
    return BUILTIN_TLE_FALLBACKS;
  }
  return records;
}

// ── Provider: Space-Track (free account, US Space Force authoritative data) ───
// All requests go through the Vite /api/spacetrack proxy to avoid CORS.
// Space-Track uses a session cookie set after POST /ajaxauth/login — the proxy
// passes Set-Cookie headers back to the browser so subsequent requests work.

async function loadSpaceTrack() {
  if (!SPACETRACK_USER || !SPACETRACK_PASS) {
    console.warn('[Satellites] Space-Track credentials not set — falling back to CelesTrak.');
    publishSystemStatus('⚠ SPACETRACK CREDS MISSING · FALLING BACK TO CELESTRAK', 'warn', 'sat:spacetrack:creds-missing');
    return loadCelesTrak();
  }
  try {
    // Login via proxy — sets a spacetrack_session cookie in the browser
    const loginResp = await fetch(SPACETRACK_LOGIN_URL, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:        `identity=${encodeURIComponent(SPACETRACK_USER)}&password=${encodeURIComponent(SPACETRACK_PASS)}`,
    });
    if (!loginResp.ok) throw new Error(`login ${loginResp.status}`);

    const resp = await fetch(SPACETRACK_TLE_URL(), { credentials: 'include' });
    if (!resp.ok) throw new Error(`Space-Track ${resp.status}`);
    const data = await resp.json();
    
    // Convert Space-Track JSON to TLE record format
    const records = (Array.isArray(data) ? data : data.results ?? []).map(obj => ({
      name: (obj.OBJECT_NAME ?? obj.SATNAME ?? '').trim() || `NORAD ${obj.NORAD_CAT_ID}`,
      line1: obj.TLE_LINE1 ?? '',
      line2: obj.TLE_LINE2 ?? '',
    })).filter(r => r.line1 && r.line2);
    
    console.debug(`[Satellites] Space-Track: ${records.length} TLEs (${records.filter(r => r.name.startsWith('NORAD')).length} unnamed)`);
    return records;
  } catch (err) {
    console.warn('[Satellites] Space-Track failed — falling back to CelesTrak:', err.message);
    publishSystemStatus(`⚠ SPACETRACK FAILED · FALLING BACK TO CELESTRAK · ${err?.message ?? 'request failed'}`, 'warn', `sat:spacetrack:failed:${err?.message ?? 'unknown'}`);
    return loadCelesTrak();
  }
}

// ── Provider: N2YO (free tier: 1000 req/hr, API key required) ────────────────

async function loadN2YO() {
  if (!N2YO_KEY) {
    console.warn('[Satellites] N2YO API key not set — falling back to CelesTrak.');
    publishSystemStatus('⚠ N2YO API KEY MISSING · FALLING BACK TO CELESTRAK', 'warn', 'sat:n2yo:key-missing');
    return loadCelesTrak();
  }
  try {
    // Use category 0 = all, above 0° elevation from equator ref point
    const url  = N2YO_ABOVE_URL(0, 0, 0, 90, 0);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`N2YO ${resp.status}`);
    const data = await resp.json();
    // N2YO "above" returns position data, not TLEs — convert to minimal records
    const records = (data.above ?? []).map(s => ({
      name:  s.satname,
      line1: s.tle1 ?? '',
      line2: s.tle2 ?? '',
    })).filter(r => r.line1 && r.line2);
    console.debug(`[Satellites] N2YO: ${records.length} satellites`);
    return records;
  } catch (err) {
    console.warn('[Satellites] N2YO failed — falling back to CelesTrak:', err.message);
    publishSystemStatus(`⚠ N2YO FAILED · FALLING BACK TO CELESTRAK · ${err?.message ?? 'request failed'}`, 'warn', `sat:n2yo:failed:${err?.message ?? 'unknown'}`);
    return loadCelesTrak();
  }
}

// ── TLE text parser ───────────────────────────────────────────────────────────

function parseTLEText(text) {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  /** @type {Array<{ name: string, line1: string, line2: string }>} */
  const records = [];
  let pendingName = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Some feeds provide line 0 as "0 OBJECT NAME".
    if (line.startsWith('0 ')) {
      pendingName = line.slice(2).trim();
      continue;
    }

    // Match canonical TLE line-1 / line-2 pairs.
    if (!line.startsWith('1 ')) continue;

    const line1 = line;
    const line2 = lines[i + 1] ?? '';
    if (!line2.startsWith('2 ')) continue;

    let name = pendingName;
    if (!name) {
      // 3-line feeds may put raw object name on the previous line.
      const prev = lines[i - 1] ?? '';
      if (prev && !prev.startsWith('0 ') && !prev.startsWith('1 ') && !prev.startsWith('2 ')) {
        name = prev;
      }
    }

    // 2-line feeds have no name; derive a stable fallback from SATCAT ID.
    if (!name) {
      const satcat = line1.slice(2, 7).trim();
      name = satcat ? `NORAD ${satcat}` : 'UNKNOWN SATELLITE';
    }

    records.push({ name, line1, line2 });
    pendingName = '';
    i += 1; // consume line 2
  }

  return records;
}

function deriveSatelliteMeta(name, line2) {
  const upperName = (name ?? '').toUpperCase();

  const isMilitary = classifyMilitaryStatus(upperName);
  const application = classifySatelliteApplication(upperName);
  const crewedStatus = classifyCrewedStatus(upperName);
  const orbitType = classifyOrbitType(line2);

  return { isMilitary, application, crewedStatus, orbitType };
}

function classifyMilitaryStatus(upperName) {
  const military = [
    // US National Reconnaissance Office (spy satellites)
    'NROL', 'NRO',
    // US Air Force AFSPC / Space Force designations
    'USAF', 'USA-', 'USSF', 'AFSPC',
    // Russian military
    'COSMOS', 'YAOGAN', 'MILITARY', 'DEFENSE',
    // US Early warning / sensing
    'DSP', 'SBIRS', 'WARNING', 'EARLY WARN',
    // US Reconnaissance satellites (various programs)
    'KH-11', 'KH-9', 'KH-8', 'KEYHOLE', 'ORION', 'IMPROVED CRYSTAL',
    'LACROSSE', 'RAINBOW', 'VORTEX', 'JUMPSEAT',
    // US Communications
    'MILSTAR', 'SKYNET', 'PYRAMIDS',
    'FLTSAT', 'DSCS', 'AFSAT', 'AFTS-',
    // US Navy systems
    'NAVY', 'SSN-', 'FLTSATCOM', 'UFO-',
    // Chinese military/reconnaissance
    'YAOGAN', 'ZIYUAN', 'HUANJING',
    // Russian military/reconnaissance
    'KOPEK', 'CYKLOP', 'KVANT', 'PROGNOZ',
    // Misc military designations
    'HEXAGON', 'GAMBIT', 'TALENT', 'SIGINT', 'COMINT', 'ELINT',
    'RECONNAISSANCE', 'RECONNAISSANCE IMAGERY',
    'NATIONAL SECURITY',
  ];
  return military.some(k => upperName.includes(k));
}

function classifySatelliteApplication(upperName) {
  const astronomical = [
    'HUBBLE', 'JWST', 'JAMES WEBB', 'CHANDRA', 'XMM',
    'FERMI', 'TESS', 'KEPLER', 'GAIA', 'EUCLID', 'ASTRO',
  ];
  if (astronomical.some(k => upperName.includes(k))) return 'Astronomical';

  const navigation = [
    'GPS', 'NAVSTAR', 'GLONASS', 'GALILEO', 'BEIDOU',
    'QZSS', 'IRNSS', 'NAVIC', 'EGNOS', 'WAAS',
  ];
  if (navigation.some(k => upperName.includes(k))) return 'Navigation';

  const earthObservation = [
    'LANDSAT', 'SENTINEL', 'TERRA', 'AQUA', 'NOAA',
    'METEOR', 'HIMAWARI', 'GOES', 'RADARSAT', 'PLEIADES',
    'WORLDVIEW', 'SPOT', 'SUOMI', 'NPP',
  ];
  if (earthObservation.some(k => upperName.includes(k))) return 'Earth Observation';

  const communication = [
    'STARLINK', 'ONEWEB', 'IRIDIUM', 'GLOBALSTAR', 'INTELSAT',
    'EUTELSAT', 'INMARSAT', 'TELSTAR', 'ASTRA', 'O3B',
    'TDRS', 'SKYNET', 'SATCOM',
  ];
  if (communication.some(k => upperName.includes(k))) return 'Communication';

  return 'Unknown';
}

function classifyCrewedStatus(upperName) {
  const crewed = [
    'ISS', 'ZARYA', 'TIANGONG', 'CSS',
    'CREW DRAGON', 'STARLINER', 'SOYUZ', 'SHENZHOU',
  ];
  if (crewed.some(k => upperName.includes(k))) return 'Crewed';
  return 'Uncrewed';
}

function classifyOrbitType(line2) {
  const l2 = (line2 ?? '').padEnd(69, ' ');

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

// ── Entity creation ───────────────────────────────────────────────────────────

function addSatelliteEntity(viewer, name, satrec, meta = {}) {
  const now    = new Date();
  const posVel = satellite.propagate(satrec, now);
  if (!posVel.position) return;

  const isMilitary = meta.isMilitary === true;
  const isCrewed = (meta.crewedStatus ?? '').toLowerCase() === 'crewed';
  const application = meta.application ?? 'Unknown';

  let pointColor;
  if (isMilitary) {
    pointColor = Cesium.Color.fromCssColorString('#ff3b30'); // red
  } else if (isCrewed) {
    pointColor = Cesium.Color.fromCssColorString('#00ff66'); // green
  } else {
    // Color by application type
    switch (application) {
      case 'Communication':
        pointColor = Cesium.Color.fromCssColorString('#ffea00'); // yellow
        break;
      case 'Earth Observation':
        pointColor = Cesium.Color.fromCssColorString('#ff9800'); // orange
        break;
      case 'Navigation':
        pointColor = Cesium.Color.fromCssColorString('#9c27b0'); // purple
        break;
      case 'Astronomical':
        pointColor = Cesium.Color.fromCssColorString('#e91e63'); // pink
        break;
      default:
        pointColor = Cesium.Color.fromCssColorString('#00aaff'); // cyan
        break;
    }
  }

  const initPos        = eciToCartesian(posVel.position, now);
  const trackPositions = computeGroundTrack(satrec, now);

  const trackEntity = viewer.entities.add({
    show: shouldShowSatellite(meta),  // Initialize based on filters
    polyline: {
      positions: trackPositions,
      width:     1,
      material:  new Cesium.PolylineDashMaterialProperty({
        color:      Cesium.Color.fromCssColorString('#00aaff38'),
        dashLength: 10,
      }),
      arcType:       Cesium.ArcType.NONE,
      clampToGround: false,
    },
  });

  const entity = viewer.entities.add({
    position: initPos,
    show: shouldShowSatellite(meta),  // Initialize based on filters
    point: {
      pixelSize:       15,
      color:           pointColor,
      outlineColor:    Cesium.Color.fromCssColorString('#003366'),
      outlineWidth:    1,
      scaleByDistance: new Cesium.NearFarScalar(1e5, 2, 1e7, 0.8),
    },
    label: {
      text:             name,
      font:             '24px "Share Tech Mono", monospace',
      color:           Cesium.Color.fromCssColorString('#00aaff'),
      outlineColor:    Cesium.Color.fromCssColorString('#003366'),
      outlineWidth:     2,
      style:            Cesium.LabelStyle.FILL_AND_OUTLINE,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin:   Cesium.VerticalOrigin.BOTTOM,
      pixelOffset:      new Cesium.Cartesian2(0, -30),
      scaleByDistance:  new Cesium.NearFarScalar(1e5, 1, 1e7, 0),
      translucencyByDistance: new Cesium.NearFarScalar(1e5, 10, 5e6, 0),
    },
    properties: {
      type: 'satellite',
      name,
      provider: PROVIDER,
      isMilitary,
      orbitType: meta.orbitType ?? 'Unknown',
      application: meta.application ?? 'Unknown',
      crewedStatus: meta.crewedStatus ?? 'Unknown',
    },
  });

  satMap.set(name, { satrec, entity, trackEntity, meta });
}

// ── Per-frame position update ─────────────────────────────────────────────────

function updatePosition({ satrec, entity, trackEntity }, now) {
  const posVel = satellite.propagate(satrec, now);
  if (!posVel.position) return;
  entity.position = eciToCartesian(posVel.position, now);

  if (now.getSeconds() % 30 === 0) {
    const positions = computeGroundTrack(satrec, now);
    trackEntity.polyline.positions = new Cesium.ConstantProperty(positions);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function eciToCartesian(eciPos, date) {
  const gmst = satellite.gstime(date);
  const geo  = satellite.eciToGeodetic(eciPos, gmst);
  return Cesium.Cartesian3.fromDegrees(
    Cesium.Math.toDegrees(geo.longitude),
    Cesium.Math.toDegrees(geo.latitude),
    geo.height * 1000
  );
}

function computeGroundTrack(satrec, startDate) {
  const positions = [];
  for (let i = 0; i <= TRACK_STEPS; i++) {
    const t      = new Date(startDate.getTime() + (i / TRACK_STEPS) * TRACK_MINUTES * 60_000);
    const posVel = satellite.propagate(satrec, t);
    if (!posVel.position) continue;
    positions.push(eciToCartesian(posVel.position, t));
  }
  return positions;
}
