/**
 * File: src/layers/cctv.js
 * Purpose: Renders global camera coverage using tiled camera datasets and globe dots.
 * Notes: Supports snapshot/HLS previews and optional server-heavy snapshot mode.
 * Last updated: 2026-03-13
 */

import * as Cesium from 'cesium';
import Hls from 'hls.js';
import { requestServerSnapshotRefresh, setServerSnapshotLayerEnabled, subscribeServerSnapshot } from '../core/serverSnapshot.js';

// ── Config ─────────────────────────────────────────────────────────────────────
const MANIFEST_URL  = '/camera-data/tiles-manifest.json';
const TILE_BASE     = '/camera-data/tiles';
const GLOBE_CAM_URL = '/camera-data/cameras-globe.json';
const CAMERA_SNAPSHOT_URL = '/api/localproxy/api/cameras/snapshot';
const SERVER_HEAVY_MODE = (import.meta.env.VITE_SERVER_HEAVY_MODE ?? 'false').toLowerCase() === 'true';
const SERVER_SNAPSHOT_MAX_CAMERAS = Math.max(parseInt(import.meta.env.VITE_SERVER_CAMERA_MAX_OBJECTS ?? '3000', 10) || 3000, 100);
const MAX_ALT_M     = 3_000_000;  // 3,000 km — individual tiles hidden above this
const OSM_FOV_MAX_ALT_M = 12_000; // persistent OSM FOV cones only at close zoom
const MAX_TILES     = 24;         // max cached & visible tiles (LRU)
const THROTTLE_MS   = 400;        // min ms between viewport recalculations

// Globe coverage dot colors — match the camera icon palette
// typeIdx: 0=image (#00ff88 green)  1=video (#00aaff blue)  2=hybrid (#cc88ff purple)
const GLOBE_COLORS = [
  new Cesium.Color(0 / 255, 255 / 255, 136 / 255, 0.9),
  new Cesium.Color(0 / 255, 170 / 255, 255 / 255, 0.9),
  new Cesium.Color(204 / 255, 136 / 255, 255 / 255, 0.9),
];

// ── Icons ──────────────────────────────────────────────────────────────────────
// Three variants for feed-backed cameras: image-only (green), video (blue), hybrid (purple)
const FEED_ICONS = {
  i: _icon('#00ff88', '#00cc66'),
  v: _icon('#00aaff', '#0088cc'),
  h: _icon('#cc88ff', '#aa66ee'),
};
// Flock ALPR badge icon — sourced from flock.md [image9] (Automatic Licence Plate Recognition)
const ALPR_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAB7UlEQVR4XqWVXUsbURCGz38s1CIUFKFFCcaPQmlINIr4QY3a1qtCe1MNbS2lGPAnCN6oYES9VBpiiIkfSTbZTZPpPifddLObyNoOvDDMmXnOOZM9E1U8KUvxtCzlXFUqtxVpNpsS1MilhloYsBSOcWvI8eGBLEZfSHjgsYSePgokcqmhFgYsVbo05Cyd9iU/VKfpI4GljLuKJGZe6eCoveOHd8uy8/1LT7FOnhcIA5ayOyFjg0/08YtXeakahrdVule1alXLsiwpFvK+1sCApSgg8HF9pScsc3Eua3MxLXzTNHW+95RYG8h1uhmnejM/3S7CJ0b+PwINebsQbxfhE3OA14Ure5Op+4GtXpl/ZEk281PWl2a18GmDA8Tcvg9o2f3Z/rohkdCQVmprU+r1ut3fipbz4QcCmrWa/Pj8ydcbYqy5LRCQ60XDz3xAYqy5LRjQvm4s/NwHJMaa2wIBuVbqW9IHJOa9smOcvCuQJ8XnwEeb2kpKfHJEC5+YF7K/t6tBaGp8+C+QX21iqF+/z0I+13pitU65jU3J875nGLAU8ywxG9FBkt6vLrZ37ibWvTAEA5YqZe3xdfz/4wsGLMWUNW5aM/H19EsJD/b5knuJXGqohdGa2PwF2IJeur6Txq9GR8/uM3Kpodbh/AYZzNApS0FcsgAAAABJRU5ErkJggg==';
const OSM_ICON_CACHE = new Map();

function _icon(fill, lens) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 14" width="22" height="14">
    <rect x="0" y="2" width="14" height="10" rx="2" fill="${fill}" opacity="0.9"/>
    <circle cx="8" cy="7" r="3.2" fill="#000"/>
    <circle cx="8" cy="7" r="1.8" fill="${lens}" opacity="0.7"/>
    <rect x="14" y="4" width="5" height="6" rx="1" fill="${fill}" opacity="0.85"/>
    <rect x="19" y="5" width="3" height="4" rx="1" fill="${fill}" opacity="0.7"/>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

// ── Module state ───────────────────────────────────────────────────────────────
let _viewer       = null;
let _enabled      = false;
let _manifest     = null;       // tiles-manifest.json parsed object
let _manifestMap  = new Map();  // key → { lat, lng, count }
let _ds           = null;       // Cesium.CustomDataSource
let _tileCache    = new Map();  // key → { entities: [], loadedAt: number }
let _loadingTiles = new Set();  // keys currently fetching
let _panel        = null;       // DOM click-panel
let _throttleId   = null;
let _hlsInstance  = null;       // active hls.js instance — destroyed on panel close
let _serverCamMap = new Map();  // id -> { entities: Cesium.Entity[] } in server-heavy mode
let _globePoints  = null;       // Cesium.PointPrimitiveCollection — globe-altitude coverage
let _globeReady   = false;      // cameras-globe.json loaded and points built
let _selectedCameraId = null;   // currently highlighted camera for visual feedback
let _streamHealthCache = { ts: 0, data: null }; // cached camera stream health probe
let _selectionOverlayEntities = []; // selected OSM camera FOV overlays
let _alprReturnView = null; // previous Cesium camera view before ALPR "Go to"

// ── Utility ────────────────────────────────────────────────────────────────────

/** Append/refresh a `t=<timestamp>` query param to force image re-fetch. */
function freshUrl(url) {
  if (!url) return url;
  const clean = url.replace(/([?&])t=\d+/, '').replace(/[?&]$/, '');
  return clean + (clean.includes('?') ? '&' : '?') + 't=' + Date.now();
}

/** Classify a videoUrl into 'hls' | 'mp4' | 'transcode' | 'other' */
function videoKind(url) {
  if (!url) return 'other';
  if (/^(rtmp|rtsp|mms):/i.test(url)) return 'transcode';
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (/\.mp4(\?|$)/i.test(url))  return 'mp4';
  return 'other';
}

function sourceProtocol(url) {
  if (!url) return 'UNKNOWN';
  const m = String(url).match(/^([a-z][a-z0-9+.-]*):/i);
  return m?.[1] ? m[1].toUpperCase() : 'HTTP(S)';
}

/** Route camera streams through local proxy for CORS/auth handling and protocol conversion. */
function proxiedVideoUrl(url) {
  if (!url) return null;
  return `/api/localproxy/api/cameras/stream?url=${encodeURIComponent(url)}`;
}

async function getCameraStreamHealth() {
  const now = Date.now();
  if (_streamHealthCache.data && (now - _streamHealthCache.ts) < 30_000) {
    return _streamHealthCache.data;
  }
  try {
    const res = await fetch('/api/localproxy/api/cameras/stream/health', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _streamHealthCache = { ts: now, data };
    return data;
  } catch {
    return null;
  }
}

/** Tear down any active hls.js instance. */
function destroyHls() {
  if (_hlsInstance) {
    _hlsInstance.destroy();
    _hlsInstance = null;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function isOsmOnlyCamera(cam) {
  return cam?.s === 'osm' && !cam?.u && !cam?.x;
}

function normalizeOsmKind(cam) {
  const surveillanceType = String(cam?.w || '').toLowerCase();
  const cameraType = String(cam?.y || '').toLowerCase();
  if (surveillanceType === 'guard') return 'guard';
  if (surveillanceType === 'alpr') return 'alpr';
  if (cameraType === 'fixed') return 'fixed';
  if (cameraType === 'panning') return 'panning';
  if (cameraType === 'dome') return 'dome';
  if (surveillanceType === 'camera') return 'camera';
  return 'camera';
}

function getOsmPalette(cam) {
  const scope = String(cam?.e || '').toLowerCase();
  if (scope === 'public') {
    return { fill: '#cf3e36', stroke: '#ff9a93', glow: '#ff8a80', label: 'PUBLIC' };
  }
  if (scope === 'indoor') {
    return { fill: '#2f8f4e', stroke: '#93f0b0', glow: '#7bffac', label: 'INDOOR' };
  }
  if (scope === 'outdoor' || scope === 'private') {
    return { fill: '#225ca8', stroke: '#91c9ff', glow: '#77b7ff', label: 'OUTDOOR' };
  }
  return { fill: '#b86d10', stroke: '#ffd19a', glow: '#ffc36f', label: 'SURVEILLANCE' };
}

/** Return a fill/stroke palette for any camera — OSM uses scope-based colors; feed cameras use feed-type colors. */
function getFovPalette(cam) {
  if (isOsmOnlyCamera(cam)) return getOsmPalette(cam);
  const fill   = cam.t === 'v' ? '#00aaff' : cam.t === 'h' ? '#cc88ff' : '#00ff88';
  const stroke = cam.t === 'v' ? '#0088cc' : cam.t === 'h' ? '#aa66ee' : '#00cc66';
  return { fill, stroke };
}

function getOsmGlyph(kind) {
  switch (kind) {
    case 'fixed':
      return `
        <rect x="8" y="11" width="11" height="7" rx="2" fill="#ffffff"/>
        <circle cx="13.5" cy="14.5" r="2.1" fill="#0b0f12"/>
        <path d="M19 12.2 L24 10.8 L24 18.2 L19 16.8 Z" fill="#ffffff" opacity="0.95"/>
        <path d="M23.5 14.5 L28 12.5" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" opacity="0.95"/>
      `;
    case 'panning':
      return `
        <rect x="8" y="11" width="11" height="7" rx="2" fill="#ffffff"/>
        <circle cx="13.5" cy="14.5" r="2.1" fill="#0b0f12"/>
        <path d="M19 12.2 L24 10.8 L24 18.2 L19 16.8 Z" fill="#ffffff" opacity="0.95"/>
        <path d="M9 8.2 Q13.5 4.8 18 8.2" stroke="#ffffff" stroke-width="1.6" fill="none" stroke-linecap="round" opacity="0.95"/>
        <path d="M9.4 8.4 L7.7 8.4 L8.6 6.9" fill="#ffffff" opacity="0.95"/>
        <path d="M17.6 8.4 L19.3 8.4 L18.4 6.9" fill="#ffffff" opacity="0.95"/>
      `;
    case 'dome':
      return `
        <path d="M10 13 A6 6 0 0 1 22 13" fill="#ffffff"/>
        <path d="M9 13 H23 V17.5 Q16 22 9 17.5 Z" fill="#ffffff" opacity="0.96"/>
        <circle cx="16" cy="15.2" r="2.1" fill="#0b0f12"/>
      `;
    case 'guard':
      return `
        <circle cx="16" cy="11" r="3.2" fill="#ffffff"/>
        <path d="M11 22 Q16 15 21 22" stroke="#ffffff" stroke-width="2.3" fill="none" stroke-linecap="round"/>
        <path d="M12.2 16.3 H19.8" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round"/>
      `;
    case 'alpr':
      return `
        <rect x="6.5" y="10" width="19" height="11" rx="3" fill="#ffffff"/>
        <rect x="8.8" y="12.5" width="14.4" height="6" rx="1.2" fill="#0b0f12" opacity="0.9"/>
        <text x="16" y="17.1" font-size="4.5" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif">ALPR</text>
      `;
    default:
      return `
        <rect x="8" y="11" width="11" height="7" rx="2" fill="#ffffff"/>
        <circle cx="13.5" cy="14.5" r="2.1" fill="#0b0f12"/>
        <path d="M19 12.2 L24 10.8 L24 18.2 L19 16.8 Z" fill="#ffffff" opacity="0.95"/>
      `;
  }
}

function getOsmIcon(cam) {
  const kind = normalizeOsmKind(cam);
  // ALPR cameras use the Flock badge icon directly (no SVG pin wrapper)
  if (kind === 'alpr') return ALPR_ICON;
  const palette = getOsmPalette(cam);
  const key = `${kind}:${palette.fill}`;
  if (OSM_ICON_CACHE.has(key)) return OSM_ICON_CACHE.get(key);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40" width="32" height="40">
    <path d="M16 38 L10.5 27.5 H21.5 Z" fill="${palette.fill}" opacity="0.95"/>
    <circle cx="16" cy="16" r="11.2" fill="${palette.fill}" stroke="${palette.stroke}" stroke-width="1.6"/>
    ${getOsmGlyph(kind)}
  </svg>`;
  const icon = 'data:image/svg+xml;base64,' + btoa(svg);
  OSM_ICON_CACHE.set(key, icon);
  return icon;
}

function billboardImageForCamera(cam) {
  return isOsmOnlyCamera(cam) ? getOsmIcon(cam) : (FEED_ICONS[cam.t] ?? FEED_ICONS.i);
}

function markerVerticalOrigin(cam) {
  // ALPR uses a flat badge icon — center it on the point rather than anchoring the pin tip
  if (isOsmOnlyCamera(cam) && normalizeOsmKind(cam) === 'alpr') return Cesium.VerticalOrigin.CENTER;
  return Cesium.VerticalOrigin.BOTTOM;
}

function markerHeightReference(_cam) {
  return Cesium.HeightReference.CLAMP_TO_GROUND;
}

function markerPixelOffset(cam) {
  return isOsmOnlyCamera(cam) ? new Cesium.Cartesian2(0, 0) : new Cesium.Cartesian2(0, -2);
}

function labelTextForCamera(cam) {
  if (_selectedCameraId !== cam.i) return '';
  if (isOsmOnlyCamera(cam)) {
    return cam.w || cam.y || cam.e || 'OSM';
  }
  return cam.s ?? 'Camera';
}

function destinationPoint(latDeg, lonDeg, bearingDeg, distanceM) {
  const radiusM = 6378137;
  const lat1 = Cesium.Math.toRadians(latDeg);
  const lon1 = Cesium.Math.toRadians(lonDeg);
  const brng = Cesium.Math.toRadians(bearingDeg);
  const angDist = distanceM / radiusM;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAng = Math.sin(angDist);
  const cosAng = Math.cos(angDist);
  const lat2 = Math.asin(sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * sinAng * cosLat1,
    cosAng - sinLat1 * Math.sin(lat2),
  );
  return {
    lat: Cesium.Math.toDegrees(lat2),
    lon: Cesium.Math.toDegrees(lon2),
  };
}

function clearSelectionOverlay() {
  for (const entity of _selectionOverlayEntities) {
    _ds?.entities.remove(entity);
  }
  _selectionOverlayEntities = [];
}

function captureCurrentView() {
  if (!_viewer?.camera) return null;
  const cam = _viewer.camera;
  const carto = cam.positionCartographic;
  if (!carto) return null;
  return {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
    height: carto.height,
    heading: cam.heading,
    pitch: cam.pitch,
    roll: cam.roll,
  };
}

function flyToOsmCameraFov(cam) {
  if (!_viewer) return;
  const target = Cesium.Cartesian3.fromDegrees(Number(cam.o), Number(cam.a), 0);
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.clone(_viewer.camera.directionWC),
    new Cesium.Cartesian3(),
  );
  const rangeM = estimateFovRangeMeters(cam);
  const distanceM = Cesium.Math.clamp(rangeM * 2.4, 600, 3000);
  const destination = Cesium.Cartesian3.add(
    target,
    Cesium.Cartesian3.multiplyByScalar(direction, -distanceM, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );

  // Keep the destination safely above terrain so the camera does not clip underground.
  const destCarto = Cesium.Cartographic.fromCartesian(destination);
  if (destCarto && Number.isFinite(destCarto.height) && destCarto.height < 120) {
    destCarto.height = 120;
    Cesium.Cartesian3.fromRadians(destCarto.longitude, destCarto.latitude, destCarto.height, undefined, destination);
  }

  _viewer.camera.flyTo({
    destination,
    orientation: {
      heading: _viewer.camera.heading,
      pitch: _viewer.camera.pitch,
      roll: _viewer.camera.roll,
    },
    duration: 1.1,
  });
}

function flyBackToPreviousView() {
  if (!_viewer || !_alprReturnView) return;
  const view = _alprReturnView;
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
    orientation: {
      heading: view.heading,
      pitch: view.pitch,
      roll: view.roll,
    },
    duration: 1.1,
  });
  _alprReturnView = null;
}

function shouldRenderOsmFov(cam) {
  if (!_enabled || !_viewer) return false;
  if (_viewer.camera.positionCartographic.height > OSM_FOV_MAX_ALT_M) return false;
  const kind = normalizeOsmKind(cam);
  if (kind === 'guard') return false;
  // ALPR always shows a FOV cone (narrow forward arc) — direction defaults to 0° if unset
  if (kind === 'alpr') return true;
  if (kind !== 'dome' && !Number.isFinite(Number(cam.d))) return false;
  return true;
}

function estimateFovRangeMeters(cam) {
  const kind = normalizeOsmKind(cam);
  const heightM = Number.isFinite(Number(cam.k)) ? Number(cam.k) : 5;
  const tiltDeg = Number.isFinite(Number(cam.g)) ? Number(cam.g) : 15;
  const base = heightM / Math.tan(Cesium.Math.toRadians(Cesium.Math.clamp(tiltDeg, 5, 85)));
  const fallback = heightM * 4.5;
  const raw = Number.isFinite(base) && base > 0 ? base : fallback;
  const factor = kind === 'alpr' ? 1.3 : kind === 'panning' ? 1.25 : kind === 'dome' ? 0.9 : 1.0;
  return Cesium.Math.clamp(raw * factor, 8, 140);
}

function estimateFovSpreadDegrees(cam) {
  const kind = normalizeOsmKind(cam);
  if (kind === 'guard') return 0;
  if (kind === 'alpr') return 16;
  if (kind === 'fixed') return 24;
  if (kind === 'panning') return 80;
  if (kind === 'dome') return cam.d != null ? 180 : 360;
  return 38;
}

function buildSectorPositions(cam, rangeM, spreadDeg) {
  const direction = Number.isFinite(Number(cam.d)) ? Number(cam.d) : 0;
  const lat = Number(cam.a);
  const lon = Number(cam.o);
  const positions = [Cesium.Cartesian3.fromDegrees(lon, lat, 0)];
  const start = direction - (spreadDeg / 2);
  const steps = Math.max(8, Math.ceil(spreadDeg / 10));
  for (let step = 0; step <= steps; step++) {
    const bearing = start + (spreadDeg * (step / steps));
    const pt = destinationPoint(lat, lon, bearing, rangeM);
    positions.push(Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, 0));
  }
  return positions;
}

function renderSelectionOverlay(cam) {
  clearSelectionOverlay();
  if (!_ds) return;
  const kind = normalizeOsmKind(cam);
  if (kind === 'guard') return;
  if (kind !== 'dome' && kind !== 'alpr' && !Number.isFinite(Number(cam.d))) return;

  const palette = getFovPalette(cam);
  const fillColor = Cesium.Color.fromCssColorString(palette.fill).withAlpha(0.18);
  const edgeColor = Cesium.Color.fromCssColorString(palette.stroke).withAlpha(0.78);
  const rangeM = estimateFovRangeMeters(cam);
  const spreadDeg = estimateFovSpreadDegrees(cam);
  const lat = Number(cam.a);
  const lon = Number(cam.o);

  if (spreadDeg >= 360) {
    _selectionOverlayEntities.push(_ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
      ellipse: {
        semiMajorAxis: rangeM,
        semiMinorAxis: rangeM,
        material: fillColor,
        outline: true,
        outlineColor: edgeColor,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    }));
    return;
  }

  const hierarchy = buildSectorPositions(cam, rangeM, spreadDeg);
  _selectionOverlayEntities.push(_ds.entities.add({
    polygon: {
      hierarchy,
      material: fillColor,
      outline: true,
      outlineColor: edgeColor,
      perPositionHeight: false,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    },
  }));

  if (cam.d != null) {
    const tip = destinationPoint(lat, lon, Number(cam.d), rangeM);
    _selectionOverlayEntities.push(_ds.entities.add({
      polyline: {
        positions: [
          Cesium.Cartesian3.fromDegrees(lon, lat, 0),
          Cesium.Cartesian3.fromDegrees(tip.lon, tip.lat, 0),
        ],
        width: 2,
        clampToGround: true,
        material: edgeColor,
      },
    }));
  }
}

function createPersistentFovEntities(cam) {
  if (!_ds) return [];
  const kind = normalizeOsmKind(cam);
  if (kind === 'guard') return [];
  if (kind !== 'dome' && kind !== 'alpr' && !Number.isFinite(Number(cam.d))) return [];

  const palette = getFovPalette(cam);
  const fillColor = Cesium.Color.fromCssColorString(palette.fill).withAlpha(0.09);
  const edgeColor = Cesium.Color.fromCssColorString(palette.stroke).withAlpha(0.42);
  const rangeM = estimateFovRangeMeters(cam);
  const spreadDeg = estimateFovSpreadDegrees(cam);
  const lat = Number(cam.a);
  const lon = Number(cam.o);
  const show = new Cesium.CallbackProperty(() => shouldRenderOsmFov(cam), false);
  const entities = [];

  if (spreadDeg >= 360) {
    entities.push(_ds.entities.add({
      show,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
      ellipse: {
        semiMajorAxis: rangeM,
        semiMinorAxis: rangeM,
        material: fillColor,
        outline: true,
        outlineColor: edgeColor,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    }));
    return entities;
  }

  const hierarchy = buildSectorPositions(cam, rangeM, spreadDeg);
  entities.push(_ds.entities.add({
    show,
    polygon: {
      hierarchy,
      material: fillColor,
      outline: true,
      outlineColor: edgeColor,
      perPositionHeight: false,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    },
  }));

  if (cam.d != null) {
    const tip = destinationPoint(lat, lon, Number(cam.d), rangeM);
    entities.push(_ds.entities.add({
      show,
      polyline: {
        positions: [
          Cesium.Cartesian3.fromDegrees(lon, lat, 0),
          Cesium.Cartesian3.fromDegrees(tip.lon, tip.lat, 0),
        ],
        width: 1.5,
        clampToGround: true,
        material: edgeColor,
      },
    }));
  }

  return entities;
}

function fieldRow(label, value, accentColor, href = null) {
  if (value == null || value === '') return '';
  const safeValue = escapeHtml(value);
  const rendered = href
    ? `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color:${accentColor};text-decoration:underline">${safeValue}</a>`
    : `<span style="color:${accentColor}">${safeValue}</span>`;
  return `<div style="display:grid;grid-template-columns:108px 1fr;gap:8px;align-items:start"><div style="color:rgba(224,255,232,0.55)">${escapeHtml(label)}</div><div>${rendered}</div></div>`;
}

function renderOsmDetails(cam, accentColor) {
  const objectType = cam.p || 'node';
  const objectId = cam.q || cam.i;
  const osmHref = cam.q ? `https://www.openstreetmap.org/${encodeURIComponent(objectType)}/${encodeURIComponent(cam.q)}` : null;
  const rows = [
    fieldRow('id', objectId, accentColor, osmHref),
    fieldRow('latitude', String(cam.a), accentColor),
    fieldRow('longitude', String(cam.o), accentColor),
    fieldRow('camera:mount', cam.r, accentColor),
    fieldRow('camera:type', cam.y, accentColor),
    fieldRow('direction', cam.d != null ? `${cam.d}` : null, accentColor),
    fieldRow('camera:angle', cam.g != null ? `${cam.g}` : null, accentColor),
    fieldRow('man_made', 'surveillance', accentColor),
    fieldRow('manufacturer', cam.m, accentColor),
    fieldRow('manufacturer:wikidata', cam.f, accentColor),
    fieldRow('surveillance', cam.e, accentColor),
    fieldRow('surveillance:type', cam.w, accentColor),
    fieldRow('surveillance:zone', cam.j, accentColor),
    fieldRow('height', cam.k != null ? `${cam.k} m` : null, accentColor),
    fieldRow('operator', cam.z, accentColor),
    fieldRow('timestamp', cam.n, accentColor),
    fieldRow('version', cam.b != null ? `${cam.b}` : null, accentColor),
  ].filter(Boolean).join('');

  return `
    <div style="background:rgba(255,255,255,0.04);border:1px solid ${accentColor}44;padding:10px;border-radius:2px;font-size:9px;line-height:1.45;color:rgba(255,255,255,0.85)">
      <div style="margin-bottom:8px;color:${accentColor};font-size:10px;letter-spacing:0.08em;text-transform:uppercase">OpenStreetMap Surveillance Object</div>
      <div style="display:grid;gap:4px">${rows}</div>
      <div style="margin-top:8px;color:rgba(255,255,255,0.55);font-size:8px">No live feed available. Marker icon, color, and field of view are derived from OSM surveillance tags.</div>
    </div>`;
}
// ── DOM Panel ──────────────────────────────────────────────────────────────────

function buildPanel() {
  const p = document.createElement('div');
  p.id = 'cctv-panel';
  Object.assign(p.style, {
    position:       'fixed',
    top:            '80px',
    right:          '16px',
    background:     'rgba(4,10,18,0.93)',
    border:         '1px solid rgba(0,255,136,0.4)',
    color:          '#e0ffe8',
    fontFamily:     '"Share Tech Mono","Courier New",monospace',
    fontSize:       '11px',
    lineHeight:     '1.7',
    padding:        '0',
    pointerEvents:  'all',
    display:        'none',
    backdropFilter: 'blur(10px)',
    width:          '300px',
    zIndex:         '21',   // above info-panel (z:20)
    overflow:       'hidden',
    boxShadow:      '0 4px 32px rgba(0,0,0,0.7)',
  });
  document.body.appendChild(p);
  return p;
}

function renderPanel(cam) {
    destroyHls();
    if (!_panel) _panel = buildPanel();

    // Update selection highlight
    _selectedCameraId = cam.i;

    // For new dual-URL schema: cam.u = image, cam.x = video
    // For video (v): only cam.x is set; for image (i): only cam.u is set
    // For hybrid (h): both cam.u (image) and cam.x (video) are set
    // For sunders-only (source='sunders'): no URLs, show OSM metadata instead
    // Temporary policy: hybrid feeds use snapshot-only rendering.
    const hasVideoFlag = cam.t === 'v';
    const hasImageFlag = cam.t === 'i' || cam.t === 'h';
    const sourceVideoUrl = hasVideoFlag ? (cam.x || cam.u) : null;     // prefer cam.x for video
    const kind         = videoKind(sourceVideoUrl);
    const protocolLabel = sourceProtocol(sourceVideoUrl);
    const needsServerTranscode = hasVideoFlag && sourceVideoUrl && kind === 'transcode';
    const hasPlayableVideo = hasVideoFlag && !!sourceVideoUrl;
    const videoUrl  = hasPlayableVideo ? proxiedVideoUrl(sourceVideoUrl) : null;
    const hasImage  = hasImageFlag || !hasPlayableVideo;
    const imageUrl  = hasImage ? freshUrl(cam.u || cam.x) : null;  // fallback to video if no image
    
    // Log debug info for hybrid cameras to troubleshoot STREAM UNAVAILABLE
    if (cam.t === 'h') {
      console.log(`[CCTV] Hybrid camera ${cam.i}: cam.u=${!!cam.u}, cam.x=${!!cam.x}, sourceVideo=${!!sourceVideoUrl}, proxiedVideo=${!!videoUrl}`);
    }
    
    const isSundersOnly = !videoUrl && !imageUrl;
    const osmPalette = isSundersOnly ? getOsmPalette(cam) : null;
    const osmKind = isSundersOnly ? normalizeOsmKind(cam) : null;
    const isAlprOsm = isSundersOnly && osmKind === 'alpr';
    const typeLabel = isSundersOnly
      ? `OSM ${String(cam.w || cam.y || osmKind || 'camera').toUpperCase()}`
      : cam.t === 'v' ? 'LIVE VIDEO' : cam.t === 'h' ? 'HYBRID' : 'SNAPSHOT';
    const typeCol   = isSundersOnly ? osmPalette.fill : cam.t === 'v' ? '#00aaff'   : cam.t === 'h' ? '#cc88ff' : '#00ff88';

    renderSelectionOverlay(cam);

    _panel.innerHTML = `
      <div style="padding:8px 12px;background:rgba(0,255,136,0.06);border-bottom:1px solid rgba(0,255,136,0.2);display:flex;justify-content:space-between;align-items:center">
        <span style="color:${typeCol};font-size:9px;letter-spacing:0.2em">◉ CCTV · ${typeLabel}</span>
        <div style="display:flex;gap:8px;align-items:center">
          <span style="font-size:9px;padding:1px 6px;border:1px solid ${typeCol}44;color:${typeCol};letter-spacing:0.08em;text-transform:uppercase">${cam.s?.toUpperCase() ?? '—'}</span>
          <button id="cctv-close" style="background:none;border:none;color:rgba(255,255,255,0.5);cursor:pointer;font-size:16px;padding:0 4px;line-height:1">×</button>
        </div>
      </div>
      <div style="padding:8px 12px">
        <div style="color:rgba(0,255,136,0.45);font-size:9px;margin-bottom:8px;letter-spacing:0.05em">
          ${cam.a.toFixed(5)}° · ${cam.o.toFixed(5)}°
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <button id="cctv-goto-fov" style="flex:1;background:rgba(0,255,136,0.08);border:1px solid rgba(0,255,136,0.35);color:rgba(200,255,220,0.95);cursor:pointer;font-size:9px;padding:4px 7px;font-family:inherit;letter-spacing:0.06em;text-transform:uppercase">Go to FOV</button>
          <button id="cctv-back-fov" style="flex:1;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.25);color:rgba(255,255,255,0.75);cursor:${_alprReturnView ? 'pointer' : 'not-allowed'};opacity:${_alprReturnView ? '1' : '0.5'};font-size:9px;padding:4px 7px;font-family:inherit;letter-spacing:0.06em;text-transform:uppercase" ${_alprReturnView ? '' : 'disabled'}>Back</button>
        </div>
        ${needsServerTranscode ? `
          <div id="cctv-transcode-note" style="margin-bottom:8px;padding:6px 8px;border:1px solid rgba(255,193,7,0.35);background:rgba(255,193,7,0.08);color:rgba(255,220,120,0.92);font-size:9px;line-height:1.4">
            Checking server transcoder status...
          </div>
        ` : ''}

        ${isSundersOnly ? renderOsmDetails(cam, typeCol) : hasPlayableVideo ? `
          <div style="background:#000;position:relative;overflow:hidden;border:1px solid rgba(0,170,255,0.25)">
            <video id="cctv-video"
              autoplay muted playsinline controls
              style="width:100%;max-height:220px;display:block;background:#000">
            </video>
            <div id="cctv-video-err" style="display:none;color:rgba(255,100,100,0.8);font-size:10px;padding:16px;text-align:center;flex-direction:column;align-items:center;gap:6px">
              ⚠ VIDEO STREAM ${!videoUrl ? 'NOT AVAILABLE' : 'BLOCKED (auth/CORS/upstream)'}
              ${videoUrl ? `<span style="font-size:9px;color:rgba(255,100,100,0.6)">Showing latest snapshot below...</span>` : ''}
              <a href="${videoUrl || cam.x || cam.u}" target="_blank" rel="noopener noreferrer"
                 style="color:rgba(0,170,255,0.7);font-size:9px;text-decoration:underline">${videoUrl ? 'Try direct link' : 'No video link'} ↗</a>
            </div>
          </div>
          <div style="margin-top:5px;display:flex;justify-content:flex-end">
            <a href="${videoUrl || cam.x || cam.u}" target="_blank" rel="noopener noreferrer"
               style="color:rgba(0,170,255,0.45);font-size:9px;text-decoration:none;letter-spacing:0.05em">⬡ open in browser ↗</a>
          </div>
        ` : `
          <div style="background:#000;min-height:80px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(0,255,136,0.15);position:relative;overflow:hidden">
            <img id="cctv-img" src="${imageUrl}" alt="camera"
                 style="max-width:100%;max-height:200px;display:block;width:100%;object-fit:contain">
            <div id="cctv-err" style="display:none;color:rgba(255,100,100,0.8);font-size:10px;padding:16px;text-align:center;position:absolute;inset:0;flex-direction:column;align-items:center;justify-content:center;background:#000">
              ⚠ FEED UNAVAILABLE
            </div>
          </div>
          <div style="margin-top:5px;display:flex;justify-content:space-between;align-items:center">
            <span style="color:rgba(0,255,136,0.35);font-size:9px" id="cctv-ts">${_utcTime()}</span>
            <button id="cctv-refresh" style="background:none;border:1px solid rgba(0,255,136,0.25);color:rgba(0,255,136,0.6);cursor:pointer;font-size:9px;padding:2px 7px;font-family:inherit;letter-spacing:0.05em">↺ REFRESH</button>
          </div>
        `}
      </div>`;

    _panel.style.display = 'block';

    // Common: close button destroys video/hls and clears highlight
    document.getElementById('cctv-close')?.addEventListener('click', () => {
      destroyHls();
      const v = document.getElementById('cctv-video');
      if (v) { v.pause(); v.src = ''; }
      _selectedCameraId = null;  // clear highlight
      clearSelectionOverlay();
      _panel.style.display = 'none';
    });

    document.getElementById('cctv-goto-fov')?.addEventListener('click', () => {
      if (!_alprReturnView) _alprReturnView = captureCurrentView();
      flyToOsmCameraFov(cam);
      renderPanel(cam);
    });
    document.getElementById('cctv-back-fov')?.addEventListener('click', () => {
      flyBackToPreviousView();
      renderPanel(cam);
    });

    if (hasPlayableVideo) {
      const videoEl = document.getElementById('cctv-video');
      const errEl   = document.getElementById('cctv-video-err');

      function showVideoError() {
        if (videoEl) videoEl.style.display = 'none';
        if (errEl)   errEl.style.display = 'flex';
        // For hybrid cameras, also try to show the fallback image
        if (cam.t === 'h' && imageUrl) {
          setTimeout(() => {
            const imgFallback = document.createElement('img');
            imgFallback.src = imageUrl;
            imgFallback.style.cssText = 'max-width:100%;max-height:220px;display:block;width:100%;object-fit:contain;margin-top:8px;border:1px solid rgba(0,255,136,0.15);';
            imgFallback.onerror = () => imgFallback.remove();
            if (errEl) {
              const fallbackLabel = document.createElement('div');
              fallbackLabel.textContent = '↓ Image snapshot fallback:';
              fallbackLabel.style.cssText = 'font-size:9px;margin-top:8px;color:rgba(0,255,136,0.6);margin-bottom:4px;';
              errEl.insertAdjacentElement('afterend', fallbackLabel);
              fallbackLabel.insertAdjacentElement('afterend', imgFallback);
            }
          }, 100);
        }
      }

      if (kind === 'hls' || needsServerTranscode) {
        if (Hls.isSupported()) {
          _hlsInstance = new Hls({ lowLatencyMode: true, maxBufferLength: 10 });
          _hlsInstance.loadSource(videoUrl);
          _hlsInstance.attachMedia(videoEl);
          _hlsInstance.on(Hls.Events.ERROR, (_evt, data) => {
            console.warn(`[CCTV] HLS error (${cam.i}):`, data);
            if (data.fatal) showVideoError();
          });
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari native HLS
          videoEl.src = videoUrl;
          videoEl.addEventListener('error', showVideoError, { once: true });
        } else {
          showVideoError();
        }
      } else if (kind === 'mp4') {
        videoEl.src = videoUrl;
        videoEl.addEventListener('error', (e) => {
          console.warn(`[CCTV] MP4 error (${cam.i}):`, e.target.error?.message ?? e);
          showVideoError();
        }, { once: true });
      } else {
        // Unknown stream — try native video; if that fails, show link
        videoEl.src = videoUrl;
        videoEl.addEventListener('error', (e) => {
          console.warn(`[CCTV] Unknown stream error (${cam.i}):`, e.target.error?.message ?? e);
          showVideoError();
        }, { once: true });
      }

    } else {
      // Image snapshot
      const imgEl = document.getElementById('cctv-img');
      const errEl = document.getElementById('cctv-err');
      const tsEl  = document.getElementById('cctv-ts');

      imgEl?.addEventListener('error', () => {
        if (imgEl) imgEl.style.display = 'none';
        if (errEl) errEl.style.display = 'flex';
      }, { once: true });

      document.getElementById('cctv-refresh')?.addEventListener('click', () => {
        if (imgEl) imgEl.style.display = 'block';
        if (errEl) errEl.style.display = 'none';
        if (imgEl) imgEl.src = freshUrl(cam.u);
        if (tsEl)  tsEl.textContent = _utcTime();
      });
    }

    if (needsServerTranscode) {
      const transcodeNote = document.getElementById('cctv-transcode-note');
      getCameraStreamHealth().then((health) => {
        if (!transcodeNote) return;
        if (!health) {
          transcodeNote.textContent = 'Server transcoder status unavailable. Ensure /api/localproxy/api/cameras/stream/health is reachable.';
          return;
        }
        if (health.ffmpegAvailable) {
          transcodeNote.textContent = `Server transcoder ready (ffmpeg detected). Source protocol: ${protocolLabel}.`;
          transcodeNote.style.borderColor = 'rgba(0,255,136,0.35)';
          transcodeNote.style.background = 'rgba(0,255,136,0.08)';
          transcodeNote.style.color = 'rgba(180,255,220,0.92)';
        } else {
          transcodeNote.textContent = `Server transcoder unavailable: ffmpeg not installed. Source protocol: ${protocolLabel}.`;
          transcodeNote.style.borderColor = 'rgba(255,100,100,0.35)';
          transcodeNote.style.background = 'rgba(255,100,100,0.08)';
          transcodeNote.style.color = 'rgba(255,180,180,0.92)';
        }
      });
    }
  }

  function _utcTime() {
    return new Date().toUTCString().slice(17, 25) + ' UTC';
  }

// ── Tile management ─────────────────────────────────────────────────────────────

async function _loadTile(key) {
  if (_loadingTiles.has(key) || _tileCache.has(key)) return;
  _loadingTiles.add(key);
  try {
    const res = await fetch(`${TILE_BASE}/${key}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cameras = await res.json();
    _tileCache.set(key, { entities: [], loadedAt: Date.now(), cameras });
    if (_enabled) await _spawnEntities(key);
    _evictLRU();
  } catch {
    // Tile missing or network error — silent fail, try again next pan
  } finally {
    _loadingTiles.delete(key);
  }
}

async function _spawnEntities(key) {
  const tile = _tileCache.get(key);
  if (!tile || tile.entities.length > 0) return; // already spawned
  const cameras = tile.cameras;
  for (let i = 0; i < cameras.length; i++) {
    // Yield to event loop every 50 entities to avoid jank
    if (i > 0 && i % 50 === 0) await new Promise(r => setTimeout(r, 0));
    if (!_enabled || !_tileCache.has(key)) break; // disabled/evicted mid-spawn
    const cam = cameras[i];
    
    // Create main camera icon with dynamic scaling and color tinting
    const entityBundle = [];
    const e = _ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(cam.o, cam.a, 0),
      billboard: {
        image:                    billboardImageForCamera(cam),
        verticalOrigin:           markerVerticalOrigin(cam),
        horizontalOrigin:         Cesium.HorizontalOrigin.CENTER,
        heightReference:          markerHeightReference(cam),
        pixelOffset:              markerPixelOffset(cam),
        scale:                    new Cesium.CallbackProperty(() => _selectedCameraId === cam.i ? 2.0 : 1.25, false),
        color:                    new Cesium.CallbackProperty(() => _selectedCameraId === cam.i ? Cesium.Color.YELLOW : Cesium.Color.WHITE, false),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text:             new Cesium.CallbackProperty(() => labelTextForCamera(cam), false),
        font:             '12px "Courier New", monospace',
        color:            Cesium.Color.fromCssColorString('#00FF00'),
        outlineColor:     Cesium.Color.fromCssColorString('#000000'),
        outlineWidth:     1,
        style:            Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin:   Cesium.VerticalOrigin.TOP,
        pixelOffset:      new Cesium.Cartesian2(0, 10),
      },
      properties: {
        type:        'cctv',
        camId:       cam.i,
        camLat:      cam.a,
        camLng:      cam.o,
        camUrl:      cam.u,      // image URL
        camVideoUrl: cam.x,       // video URL (new field for dual-URL support)
        camFeedType: cam.t,
        camSource:   cam.s,
        camType:     cam.y,      // sunders: camera type
        camOperator: cam.z,      // sunders: operator
        camDirect:   cam.d,      // sunders: direction (degrees)
        camHeight:   cam.k,      // sunders: height (meters)
        camMfg:      cam.m,      // sunders: manufacturer
        camMount:    cam.r,
        camSurveil:  cam.e,
        camSurvType: cam.w,
        camZone:     cam.j,
        camAngle:    cam.g,
        camStamp:    cam.n,
        camVer:      cam.b,
        camMfgWiki:  cam.f,
        camOsmType:  cam.p,
        camOsmObjId: cam.q,
      },
    });
    entityBundle.push(e);
    
    // Create a larger, semi-transparent glow behind the main icon
    const glow = _ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(cam.o, cam.a, 0),
      billboard: {
        image:                    billboardImageForCamera(cam),
        verticalOrigin:           markerVerticalOrigin(cam),
        horizontalOrigin:         Cesium.HorizontalOrigin.CENTER,
        heightReference:          markerHeightReference(cam),
        pixelOffset:              markerPixelOffset(cam),
        scale:                    new Cesium.CallbackProperty(() => _selectedCameraId === cam.i ? 3.2 : 0, false),
        color:                    new Cesium.CallbackProperty(() => _selectedCameraId === cam.i ? Cesium.Color.fromCssColorString('#ffff0044') : Cesium.Color.TRANSPARENT, false),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entityBundle.push(glow);

    entityBundle.push(...createPersistentFovEntities(cam));
    
    tile.entities.push(...entityBundle);
  }
}

function _despawnTile(key) {
  const tile = _tileCache.get(key);
  if (!tile) return;
  for (const e of tile.entities) _ds.entities.remove(e);
  tile.entities = [];
}

function _evictLRU() {
  if (_tileCache.size <= MAX_TILES) return;
  const sorted = [..._tileCache.entries()].sort((a, b) => a[1].loadedAt - b[1].loadedAt);
  for (const [k] of sorted.slice(0, _tileCache.size - MAX_TILES)) {
    _despawnTile(k);
    _tileCache.delete(k);
  }
}

// ── Viewport ─────────────────────────────────────────────────────────────────────

function _visibleTileKeys() {
  if (!_manifest) return [];
  if (_viewer.camera.positionCartographic.height > MAX_ALT_M) return [];
  const rect = _viewer.camera.computeViewRectangle();
  if (!rect) return [];
  const W = Cesium.Math.toDegrees(rect.west);
  const E = Cesium.Math.toDegrees(rect.east);
  const S = Cesium.Math.toDegrees(rect.south);
  const N = Cesium.Math.toDegrees(rect.north);
  const D = _manifest.tileDeg;
  const keys = [];
  for (const t of _manifest.tiles) {
    if (t.lat + D < S || t.lat > N) continue;
    if (t.lng + D < W || t.lng > E) continue;
    keys.push(t.key);
  }
  return keys;
}

async function _updateTiles() {
  if (SERVER_HEAVY_MODE) {
    await _updateTilesServerSnapshot();
    return;
  }

  const altM   = _viewer.camera.positionCartographic.height;
  const visible = new Set(_visibleTileKeys());

  if (altM > MAX_ALT_M) {
    // Above ceiling — despawn everything
    for (const k of [..._tileCache.keys()]) _despawnTile(k);
    return;
  }

  // Spawn already-loaded visible tiles; fetch unknown ones
  for (const k of visible) {
    if (_tileCache.has(k)) {
      await _spawnEntities(k);
    } else {
      _loadTile(k);  // async, no await — fetches in background
    }
  }

  // Despawn out-of-view tiles (keep in tile cache for fast re-show)
  for (const [k, tile] of _tileCache.entries()) {
    if (!visible.has(k) && tile.entities.length > 0) _despawnTile(k);
  }
}

async function _updateTilesServerSnapshot() {
  await requestServerSnapshotRefresh();
}

function _applyServerSnapshotCameras(cameras) {
  if (!_enabled) return;

  const altM = _viewer.camera.positionCartographic.height;
  if (altM > MAX_ALT_M) {
    _ds.entities.removeAll();
    _serverCamMap.clear();
    return;
  }

  const seen = new Set();
  for (const cam of cameras) {
    const camId = String(cam?.i ?? `${cam?.a}_${cam?.o}`);
    if (!Number.isFinite(cam?.a) || !Number.isFinite(cam?.o)) continue;
    seen.add(camId);

    const existing = _serverCamMap.get(camId);
    if (existing) continue;

    const entityBundle = [];
    const entity = _ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(cam.o, cam.a, 0),
      billboard: {
        image:                    billboardImageForCamera(cam),
        verticalOrigin:           markerVerticalOrigin(cam),
        horizontalOrigin:         Cesium.HorizontalOrigin.CENTER,
        heightReference:          markerHeightReference(cam),
        pixelOffset:              markerPixelOffset(cam),
        scale:                    new Cesium.CallbackProperty(() => _selectedCameraId === camId ? 2.0 : 1.25, false),
        color:                    new Cesium.CallbackProperty(() => _selectedCameraId === camId ? Cesium.Color.YELLOW : Cesium.Color.WHITE, false),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text:             new Cesium.CallbackProperty(() => (_selectedCameraId === camId ? (cam.w || cam.y || cam.s || 'Camera') : ''), false),
        font:             '12px "Courier New", monospace',
        color:            Cesium.Color.fromCssColorString('#00FF00'),
        outlineColor:     Cesium.Color.fromCssColorString('#000000'),
        outlineWidth:     1,
        style:            Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin:   Cesium.VerticalOrigin.TOP,
        pixelOffset:      new Cesium.Cartesian2(0, 10),
      },
      properties: {
        type:        'cctv',
        camId:       camId,
        camLat:      cam.a,
        camLng:      cam.o,
        camUrl:      cam.u,
        camVideoUrl: cam.x,       // video URL (new field for dual-URL support)
        camFeedType: cam.t,
        camSource:   cam.s,
        camType:     cam.y,      // sunders: camera type
        camOperator: cam.z,      // sunders: operator
        camDirect:   cam.d,      // sunders: direction (degrees)
        camHeight:   cam.k,      // sunders: height (meters)
        camMfg:      cam.m,      // sunders: manufacturer
        camMount:    cam.r,
        camSurveil:  cam.e,
        camSurvType: cam.w,
        camZone:     cam.j,
        camAngle:    cam.g,
        camStamp:    cam.n,
        camVer:      cam.b,
        camMfgWiki:  cam.f,
        camOsmType:  cam.p,
        camOsmObjId: cam.q,
      },
    });
    entityBundle.push(entity);
    
    // Create a larger, semi-transparent glow behind the main icon
    const glow = _ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(cam.o, cam.a, 0),
      billboard: {
        image:                    billboardImageForCamera(cam),
        verticalOrigin:           markerVerticalOrigin(cam),
        horizontalOrigin:         Cesium.HorizontalOrigin.CENTER,
        heightReference:          markerHeightReference(cam),
        pixelOffset:              markerPixelOffset(cam),
        scale:                    new Cesium.CallbackProperty(() => _selectedCameraId === camId ? 3.2 : 0, false),
        color:                    new Cesium.CallbackProperty(() => _selectedCameraId === camId ? Cesium.Color.fromCssColorString('#ffff0044') : Cesium.Color.TRANSPARENT, false),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entityBundle.push(glow);
    entityBundle.push(...createPersistentFovEntities(cam));
    
    _serverCamMap.set(camId, { entities: entityBundle });
  }

  for (const [camId, bundle] of _serverCamMap.entries()) {
    if (!seen.has(camId)) {
      for (const entity of bundle.entities) _ds.entities.remove(entity);
      _serverCamMap.delete(camId);
    }
  }
}

/**
 * Sync _globePoints and _ds visibility based on current altitude + enabled state.
 * Globe coverage now stays on at all altitudes for consistent location presence.
 * Tile/server entities remain an overlay that can stream in/out with viewport detail.
 */
function _syncVisibility() {
  if (_globePoints) _globePoints.show = _enabled && _globeReady;
  _ds.show = _enabled;
}

/**
 * Background-load cameras-globe.json and build a PointPrimitiveCollection.
 * Called once at init — no await, runs in background.
 */
async function _loadGlobeCoverage() {
  try {
    const res = await fetch(GLOBE_CAM_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.d)) throw new Error('unexpected format');

    const col = new Cesium.PointPrimitiveCollection();
    col.show = false;
    for (const [lat, lng, ti] of data.d) {
      col.add({
        position:                 Cesium.Cartesian3.fromDegrees(lng, lat, 10),
        color:                    GLOBE_COLORS[ti] ?? GLOBE_COLORS[0],
        pixelSize:                3,
      });
    }
    _globePoints = _viewer.scene.primitives.add(col);
    _globeReady  = true;
    console.info(`[CCTV] Globe coverage ready — ${data.n.toLocaleString()} cameras`);
    _syncVisibility();   // apply correct show state for current altitude
  } catch (err) {
    console.warn('[CCTV] Globe coverage unavailable:', err.message,
      '— run `node server/collectors/collectCameras.mjs` to regenerate cameras-globe.json');
  }
}

function _onCameraChange() {
  if (!_enabled) return;
  _syncVisibility();   // keep fallback coverage visible while detail entities refresh
  if (_throttleId) return;
  _throttleId = setTimeout(() => {
    _throttleId = null;
    _updateTiles();
  }, THROTTLE_MS);
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function initCCTV(viewer) {
  _viewer = viewer;

  // Custom data source — allows bulk show/hide via _ds.show
  _ds = new Cesium.CustomDataSource('cctv');
  await viewer.dataSources.add(_ds);
  _ds.show = false;

  if (!SERVER_HEAVY_MODE) {
    // Load manifest (small ~50 KB — once only)
    try {
      const res  = await fetch(MANIFEST_URL);
      if (res.ok) {
        _manifest = await res.json();
        for (const t of _manifest.tiles) _manifestMap.set(t.key, t);
        console.info(`[CCTV] Manifest loaded — ${_manifest.totalCameras.toLocaleString()} cameras in ${_manifest.tiles.length} tiles`);
      }
    } catch {
      console.warn('[CCTV] Manifest not found — run `node server/collectors/collectCameras.mjs` to build the database.');
    }
  } else {
    console.info('[CCTV] Server-heavy mode enabled (snapshot endpoint)');
    subscribeServerSnapshot('cameras', {
      onData(payload) {
        _applyServerSnapshotCameras(payload?.cameras?.cameras ?? []);
      },
    });
  }

  // Globe coverage — load all known camera positions in background (both modes).
  // Builds a PointPrimitiveCollection used when altitude > MAX_ALT_M.
  _loadGlobeCoverage();

  // Build the click panel DOM early
  _panel = buildPanel();

  // Click handler — show camera panel when a CCTV entity is picked
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);

    // Close panel on any non-CCTV click
    if (!Cesium.defined(picked) || !picked.id) {
      _selectedCameraId = null;
      clearSelectionOverlay();
      if (_panel) _panel.style.display = 'none';
      return;
    }
    const props = picked.id?.properties;
    if (!props || props.type?.getValue() !== 'cctv') {
      _selectedCameraId = null;
      clearSelectionOverlay();
      if (_panel) _panel.style.display = 'none';
      return;
    }

    renderPanel({
      i: props.camId?.getValue(),
      a: props.camLat?.getValue(),
      o: props.camLng?.getValue(),
      u: props.camUrl?.getValue(),
      x: props.camVideoUrl?.getValue(),  // video URL from dual-URL schema
      t: props.camFeedType?.getValue(),
      s: props.camSource?.getValue(),
      y: props.camType?.getValue(),      // sunders: camera type
      z: props.camOperator?.getValue(),  // sunders: operator
      d: props.camDirect?.getValue(),    // sunders: direction
      k: props.camHeight?.getValue(),    // sunders: height
      m: props.camMfg?.getValue(),       // sunders: manufacturer
      r: props.camMount?.getValue(),
      e: props.camSurveil?.getValue(),
      w: props.camSurvType?.getValue(),
      j: props.camZone?.getValue(),
      g: props.camAngle?.getValue(),
      n: props.camStamp?.getValue(),
      b: props.camVer?.getValue(),
      f: props.camMfgWiki?.getValue(),
      p: props.camOsmType?.getValue(),
      q: props.camOsmObjId?.getValue(),
    });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // React to camera movement
  viewer.camera.changed.addEventListener(_onCameraChange);

  return {
    setEnabled(val) {
      _enabled = !!val;
      _syncVisibility();  // sets _ds.show and _globePoints.show based on altitude
      if (_enabled) {
        if (SERVER_HEAVY_MODE) {
          setServerSnapshotLayerEnabled('cameras', true);
        }
        _updateTiles();
      } else {
        setServerSnapshotLayerEnabled('cameras', false);
        if (SERVER_HEAVY_MODE) {
          _ds.entities.removeAll();
          _serverCamMap.clear();
        } else {
          // Despawn all entities; tile cache stays for fast re-enable
          for (const k of [..._tileCache.keys()]) _despawnTile(k);
        }
        _selectedCameraId = null;
        clearSelectionOverlay();
        if (_panel) _panel.style.display = 'none';
      }
    },
    get count() { return _ds.entities.values.length; },
  };
}
