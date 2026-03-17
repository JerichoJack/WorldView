/**
 * File: src/layers/satellites.js
 * Purpose: Real-time satellite orbit visualization with provider-switchable TLE/GP sources.
 * Providers: CelesTrak, Space-Track, N2YO, plus optional server-heavy snapshot mode.
 * Last updated: 2026-03-13
 */

import * as Cesium from 'cesium';
import * as satellite from 'satellite.js';
import { setServerSnapshotLayerEnabled, setServerSnapshotSatelliteConfig, subscribeServerSnapshot } from '../core/serverSnapshot.js';

// ── Config ────────────────────────────────────────────────────────────────────

const PROVIDER       = (import.meta.env.VITE_SATELLITE_PROVIDER    ?? 'celestrak').toLowerCase();
const SERVER_HEAVY_MODE = (import.meta.env.VITE_SERVER_HEAVY_MODE ?? 'false').toLowerCase() === 'true';
const N2YO_KEY       =  import.meta.env.VITE_N2YO_API_KEY          ?? '';
const SPACETRACK_USER =  import.meta.env.VITE_SPACETRACK_USERNAME   ?? '';
const SPACETRACK_PASS =  import.meta.env.VITE_SPACETRACK_PASSWORD   ?? '';
const SATELLITE_SNAPSHOT_URL = '/api/localproxy/api/satellites/snapshot';
const SNAPSHOT_POLL_MS = 2_000;
const SATELLITE_MAX_PER_CATEGORY = Math.max(parseInt(import.meta.env.VITE_SATELLITE_MAX_PER_CATEGORY ?? (import.meta.env.VITE_SATELLITE_MAX_OBJECTS ?? '500'), 10) || 500, 1);

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

/** @type {Map<string, { key: string, satrec: object, entity: Cesium.Entity, trackEntity: Cesium.Entity | null, footprintEntity: Cesium.Entity | null, meta: object }>} */
const satMap  = new Map();
let enabled   = false;  // Start disabled by default
let lastSatelliteStatusKey = '';
let selectedSatelliteKey = null;
let satelliteInfoPanelVisible = false;

const DEFAULT_CLASSIFICATION_ENABLED = !SERVER_HEAVY_MODE;

// Classification filter state — normal mode defaults to on, heavy mode defaults to off.
const classificationFilters = {
  internet: DEFAULT_CLASSIFICATION_ENABLED,
  communications: DEFAULT_CLASSIFICATION_ENABLED,
  earth_observation: DEFAULT_CLASSIFICATION_ENABLED,
  navigation: DEFAULT_CLASSIFICATION_ENABLED,
  military: DEFAULT_CLASSIFICATION_ENABLED,
  weather: DEFAULT_CLASSIFICATION_ENABLED,
  scientific: DEFAULT_CLASSIFICATION_ENABLED,
  rocket: DEFAULT_CLASSIFICATION_ENABLED,
  debris: DEFAULT_CLASSIFICATION_ENABLED,
  other: DEFAULT_CLASSIFICATION_ENABLED,
};

const EARTH_RADIUS_M = 6378137;
const SATELLITE_COLOR_MAP = {
  internet: '#4ade80',
  communications: '#60a5fa',
  earth_observation: '#22d3ee',
  navigation: '#a78bfa',
  military: '#f87171',
  weather: '#f59e0b',
  scientific: '#f472b6',
  rocket: '#9ca3af',
  debris: '#6b7280',
  other: '#cbd5e1',
};
const SATELLITE_BASE_OUTLINE_COLOR = Cesium.Color.fromCssColorString('#003366');
const SATELLITE_BASE_LABEL_COLOR = Cesium.Color.fromCssColorString('#00aaff');
const SATELLITE_SELECTION_ACCENT = Cesium.Color.fromCssColorString('#ffe066');

/**
 * Determine if a satellite entity should be visible based on enabled state and filters
 */
function shouldShowSatellite(meta) {
  if (!enabled) return false;

  const filterKey = classificationKeyForMeta(meta);
  return classificationFilters[filterKey] ?? classificationFilters.other;
}

function classificationKeyForMeta(meta = {}) {
  const rawName = String(meta.rawName ?? meta.name ?? '').toUpperCase();
  const app = (meta.application ?? 'Unknown').toLowerCase();
  const isCrewed = (meta.crewedStatus ?? '').toLowerCase() === 'crewed';

  if (/\bDEB\b|DEBRIS|FRAGMENT/.test(rawName)) return 'debris';
  if (/\bR\/B\b|ROCKET BODY|UPPER STAGE|FREGAT|BREEZE-M|CENTAUR|DELTA\s+STAGE/.test(rawName)) return 'rocket';
  if (meta.isMilitary) return 'military';
  if (app === 'weather' || /NOAA|METEOR|GOES|HIMAWARI|METOP|WEATHER/.test(rawName)) return 'weather';
  if (app === 'earth observation') return 'earth_observation';
  if (app === 'navigation') return 'navigation';
  if (app === 'astronomical' || isCrewed) return 'scientific';
  if (app === 'communication') {
    if (/STARLINK|ONEWEB|KUIPER|O3B|TDRS|SATCOM/.test(rawName)) return 'internet';
    return 'communications';
  }
  return 'other';
}

function satelliteKeyFromEntity(entity) {
  return entity?.properties?.satelliteKey?.getValue?.() ?? entity?.shadowgridMeta?.satelliteKey ?? null;
}

function isSatelliteSelected(key) {
  return key != null && key === selectedSatelliteKey;
}

function shouldShowSatelliteOverlay(record) {
  return satelliteInfoPanelVisible && shouldShowSatellite(record.meta) && isSatelliteSelected(record.key);
}

function getSatelliteBaseColor(meta) {
  const key = classificationKeyForMeta(meta);
  return Cesium.Color.fromCssColorString(SATELLITE_COLOR_MAP[key] ?? SATELLITE_COLOR_MAP.other);
}

function getSatelliteHighlightColor(meta) {
  return Cesium.Color.lerp(getSatelliteBaseColor(meta), SATELLITE_SELECTION_ACCENT, 0.55, new Cesium.Color());
}

function getSatelliteFootprintRadiusM(positionCartesian) {
  if (!positionCartesian) return 1;
  const cartographic = Cesium.Cartographic.fromCartesian(positionCartesian);
  const altitude = Math.max(cartographic?.height ?? 0, 0);
  if (!Number.isFinite(altitude) || altitude <= 0) return 1;
  const horizonAngle = Math.acos(Math.min(1, EARTH_RADIUS_M / (EARTH_RADIUS_M + altitude)));
  return Math.max(1, EARTH_RADIUS_M * horizonAngle);
}

function getGroundSubpoint(positionCartesian, result) {
  if (!positionCartesian) return undefined;
  const cartographic = Cesium.Cartographic.fromCartesian(positionCartesian);
  if (!cartographic) return undefined;
  return Cesium.Cartesian3.fromRadians(
    cartographic.longitude,
    cartographic.latitude,
    0,
    Cesium.Ellipsoid.WGS84,
    result
  );
}

function createSatelliteTrackEntity(viewer, record, positions) {
  if (!record.satrec) return null;
  return viewer.entities.add({
    polyline: {
      show: new Cesium.CallbackProperty(() => shouldShowSatelliteOverlay(record), false),
      positions,
      width: 2,
      material: new Cesium.PolylineDashMaterialProperty({
        color: new Cesium.CallbackProperty(() => getSatelliteHighlightColor(record.meta).withAlpha(0.95, new Cesium.Color()), false),
        dashLength: 12,
      }),
      arcType: Cesium.ArcType.NONE,
      clampToGround: false,
    },
  });
}

function createSatelliteFootprintEntity(viewer, record) {
  const position = new Cesium.CallbackPositionProperty((time, result) => {
    const currentPosition = record.entity?.position?.getValue?.(time);
    return getGroundSubpoint(currentPosition, result);
  }, false);
  const radius = new Cesium.CallbackProperty((time) => {
    const currentPosition = record.entity?.position?.getValue?.(time);
    return getSatelliteFootprintRadiusM(currentPosition);
  }, false);

  return viewer.entities.add({
    position,
    ellipse: {
      show: new Cesium.CallbackProperty(() => shouldShowSatelliteOverlay(record), false),
      semiMajorAxis: radius,
      semiMinorAxis: radius,
      material: new Cesium.ColorMaterialProperty(
        new Cesium.CallbackProperty(() => getSatelliteHighlightColor(record.meta).withAlpha(0.12, new Cesium.Color()), false)
      ),
      outline: true,
      outlineColor: new Cesium.CallbackProperty(() => getSatelliteHighlightColor(record.meta).withAlpha(0.9, new Cesium.Color()), false),
      numberOfVerticalLines: 0,
    },
  });
}

export function setSatelliteSelection(entityOrKey, active = true) {
  const key = typeof entityOrKey === 'string' ? entityOrKey : satelliteKeyFromEntity(entityOrKey);
  if (!key) return;
  if (active) {
    selectedSatelliteKey = key;
    return;
  }
  if (selectedSatelliteKey === key) {
    selectedSatelliteKey = null;
  }
}

export function clearSatelliteSelection() {
  selectedSatelliteKey = null;
  satelliteInfoPanelVisible = false;
}

export function setSatelliteInfoPanelVisible(visible) {
  satelliteInfoPanelVisible = !!visible;
}

function getEnabledSatelliteCategories() {
  return Object.entries(classificationFilters)
    .filter(([, isOn]) => isOn)
    .map(([category]) => category);
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
      satMap.forEach(({ entity, meta }) => {
        entity.show = shouldShowSatellite(meta);
      });
    },
    setClassificationFilter(classification, enabled) {
      const key = classification.toLowerCase();
      if (key in classificationFilters) {
        classificationFilters[key] = enabled;
        // Update visibility of all entities
        satMap.forEach(({ entity, meta }) => {
          entity.show = shouldShowSatellite(meta);
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

  function syncServerSnapshotSatelliteConfig() {
    setServerSnapshotSatelliteConfig({
      categories: getEnabledSatelliteCategories(),
      perCategory: SATELLITE_MAX_PER_CATEGORY,
    });
  }

  syncServerSnapshotSatelliteConfig();

  function applyEntityVisibility(record) {
    const visible = enabledLocal && shouldShowSatellite(record.meta);
    record.entity.show = visible;
  }

  function classifyPointColor(meta) {
    return getSatelliteBaseColor(meta);
  }

  function buildSnapshotMeta(point) {
    if (point?.meta && typeof point.meta === 'object') {
      return {
        rawName: point.name ?? point.meta.rawName ?? 'Unknown',
        isMilitary: point.meta.isMilitary === true,
        application: point.meta.application ?? 'Unknown',
        crewedStatus: point.meta.crewedStatus ?? 'Uncrewed',
        orbitType: point.meta.orbitType ?? 'Unknown',
      };
    }
    return deriveSatelliteMeta(point?.name ?? 'Unknown', point?.line2 ?? '');
  }

  function upsertPoint(point) {
    const pos = Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.altM);
    const key = String(point.id ?? point.name ?? `${point.lat}:${point.lon}`);
    const existing = entities.get(key);
    const meta = buildSnapshotMeta(point);
    if (existing) {
      existing.entity.position = pos;
      if (existing.trackEntity && point.line1 && point.line2) {
        try {
          existing.satrec = satellite.twoline2satrec(point.line1, point.line2);
        } catch {
          existing.satrec = null;
        }
      }
      existing.meta = meta;
      applyEntityVisibility(existing);
      return;
    }

    let satrec = null;
    if (point.line1 && point.line2) {
      try {
        satrec = satellite.twoline2satrec(point.line1, point.line2);
      } catch {
        satrec = null;
      }
    }

    const record = { key, entity: null, trackEntity: null, footprintEntity: null, satrec, meta };
    const trackEntity = satrec ? createSatelliteTrackEntity(viewer, record, computeGroundTrack(satrec, new Date())) : null;

    const entity = viewer.entities.add({
      id: `sat-${key}`,
      position: pos,
      point: {
        pixelSize:       new Cesium.CallbackProperty(() => isSatelliteSelected(record.key) ? 18 : 15, false),
        color:           new Cesium.CallbackProperty(() => isSatelliteSelected(record.key) ? getSatelliteHighlightColor(record.meta) : classifyPointColor(record.meta), false),
        outlineColor:    new Cesium.CallbackProperty(() => isSatelliteSelected(record.key) ? SATELLITE_SELECTION_ACCENT : SATELLITE_BASE_OUTLINE_COLOR, false),
        outlineWidth:    new Cesium.CallbackProperty(() => isSatelliteSelected(record.key) ? 2 : 1, false),
        scaleByDistance: new Cesium.NearFarScalar(1e5, 2, 1e7, 0.8),
      },
      label: {
        text:             point.name,
        font:             '24px "Share Tech Mono", monospace',
        color:            new Cesium.CallbackProperty(() => isSatelliteSelected(record.key) ? SATELLITE_SELECTION_ACCENT : SATELLITE_BASE_LABEL_COLOR, false),
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
        satelliteKey: key,
        name: point.name,
        application: meta.application,
        isMilitary: meta.isMilitary,
        crewedStatus: meta.crewedStatus,
        provider: 'server-snapshot',
      },
      properties: {
        type: 'satellite',
        satelliteKey: key,
        name: point.name,
        provider: point.source ?? 'server-snapshot',
        isMilitary: meta.isMilitary,
        orbitType: meta.orbitType ?? 'Unknown',
        application: meta.application ?? 'Unknown',
        crewedStatus: meta.crewedStatus ?? 'Unknown',
      },
      show: false,
    });

    record.entity = entity;
    record.trackEntity = trackEntity;
    record.footprintEntity = createSatelliteFootprintEntity(viewer, record);
    entities.set(key, record);
    applyEntityVisibility(record);
  }

  function applySnapshot(points) {
    const seen = new Set();
    for (const p of points) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !Number.isFinite(p.altM)) continue;
      const pointId = String(p.id ?? p.name ?? `${p.lat}:${p.lon}`);
      seen.add(pointId);
      upsertPoint(p);
    }

    for (const [id, record] of entities) {
      if (!seen.has(id)) {
        viewer.entities.remove(record.entity);
        if (record.trackEntity) viewer.entities.remove(record.trackEntity);
        if (record.footprintEntity) viewer.entities.remove(record.footprintEntity);
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

  function isCartesianOnScreen(cartesian) {
    if (!cartesian) return false;
    const windowPos = viewer.scene.cartesianToCanvasCoordinates(cartesian);
    if (!windowPos) return false;
    const width = viewer.canvas.clientWidth || viewer.canvas.width;
    const height = viewer.canvas.clientHeight || viewer.canvas.height;
    return windowPos.x >= 0 && windowPos.x <= width && windowPos.y >= 0 && windowPos.y <= height;
  }

  setInterval(() => {
    if (!enabledLocal) return;
    const now = new Date();
    for (const record of entities.values()) {
      if (!record.satrec) continue;

      const pv = satellite.propagate(record.satrec, now);
      if (pv?.position) {
        const nextPos = eciToCartesian(pv.position, now);
        // Keep visible satellites moving smoothly between server snapshots.
        if (isCartesianOnScreen(nextPos)) {
          record.entity.position = nextPos;
        }
      }

      if (!record.trackEntity) continue;
      if (!isSatelliteSelected(record.key)) continue;
      if (now.getSeconds() % 30 !== 0) continue;
      const positions = computeGroundTrack(record.satrec, now);
      record.trackEntity.polyline.positions = new Cesium.ConstantProperty(positions);
    }
  }, PROPAGATE_MS);

  return {
    setEnabled(val) {
      enabledLocal = val;
      enabled = val;
      setServerSnapshotLayerEnabled('satellites', enabledLocal);
      syncServerSnapshotSatelliteConfig();
      entities.forEach((record) => {
        applyEntityVisibility(record);
      });
    },
    setClassificationFilter(classification, isEnabled) {
      const key = classification.toLowerCase();
      if (!(key in classificationFilters)) return;
      classificationFilters[key] = !!isEnabled;
      syncServerSnapshotSatelliteConfig();
      entities.forEach((record) => {
        applyEntityVisibility(record);
      });
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

  return { isMilitary, application, crewedStatus, orbitType, rawName: name ?? '' };
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

  const weather = [
    'NOAA', 'METEOR', 'METOP', 'GOES', 'HIMAWARI', 'WEATHER',
  ];
  if (weather.some(k => upperName.includes(k))) return 'Weather';

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

  const key = name;
  const record = { key, entity: null, trackEntity: null, footprintEntity: null, satrec, meta };
  const pointColor = getSatelliteBaseColor({ ...meta, rawName: name });

  const isMilitary = meta.isMilitary === true;

  const initPos        = eciToCartesian(posVel.position, now);
  const trackPositions = computeGroundTrack(satrec, now);
  const trackEntity = createSatelliteTrackEntity(viewer, record, trackPositions);

  const entity = viewer.entities.add({
    id: `sat-${key}`,
    position: initPos,
    show: shouldShowSatellite(meta),
    point: {
      pixelSize:       new Cesium.CallbackProperty(() => isSatelliteSelected(record.key) ? 14 : 10, false),
      color:           new Cesium.CallbackProperty(() => isSatelliteSelected(record.key) ? getSatelliteHighlightColor(record.meta) : pointColor, false),
      outlineColor:    new Cesium.CallbackProperty(() => isSatelliteSelected(record.key) ? SATELLITE_SELECTION_ACCENT : SATELLITE_BASE_OUTLINE_COLOR, false),
      outlineWidth:    new Cesium.CallbackProperty(() => isSatelliteSelected(record.key) ? 2 : 1, false),
      scaleByDistance: new Cesium.NearFarScalar(1e5, 2, 1e7, 0.8),
    },
    label: {
      text:             name,
      font:             '24px "Share Tech Mono", monospace',
      color:            new Cesium.CallbackProperty(() => isSatelliteSelected(record.key) ? SATELLITE_SELECTION_ACCENT : SATELLITE_BASE_LABEL_COLOR, false),
      outlineColor:     Cesium.Color.fromCssColorString('#003366'),
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
      satelliteKey: key,
      name,
      provider: PROVIDER,
      isMilitary,
      orbitType: meta.orbitType ?? 'Unknown',
      application: meta.application ?? 'Unknown',
      crewedStatus: meta.crewedStatus ?? 'Unknown',
    },
  });

  record.entity = entity;
  record.trackEntity = trackEntity;
  record.footprintEntity = createSatelliteFootprintEntity(viewer, record);

  satMap.set(name, record);
}

// ── Per-frame position update ─────────────────────────────────────────────────

function updatePosition({ key, satrec, entity, trackEntity }, now) {
  const posVel = satellite.propagate(satrec, now);
  if (!posVel.position) return;
  entity.position = eciToCartesian(posVel.position, now);

  if (trackEntity && isSatelliteSelected(key) && now.getSeconds() % 30 === 0) {
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
