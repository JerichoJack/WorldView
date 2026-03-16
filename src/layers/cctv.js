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
// Three variants: image-only (green), video (blue), hybrid (purple)
const ICONS = {
  i: _icon('#00ff88', '#00cc66'),
  v: _icon('#00aaff', '#0088cc'),
  h: _icon('#cc88ff', '#aa66ee'),
};

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
let _serverCamMap = new Map();  // id -> Cesium.Entity in server-heavy mode
let _globePoints  = null;       // Cesium.PointPrimitiveCollection — globe-altitude coverage
let _globeReady   = false;      // cameras-globe.json loaded and points built
let _selectedCameraId = null;   // currently highlighted camera for visual feedback
let _streamHealthCache = { ts: 0, data: null }; // cached camera stream health probe

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
    const hasVideoFlag = cam.t === 'v' || cam.t === 'h';
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
    const typeLabel = isSundersOnly ? 'OSM LOCATION' : cam.t === 'v' ? 'LIVE VIDEO' : cam.t === 'h' ? 'HYBRID' : 'SNAPSHOT';
    const typeCol   = isSundersOnly ? '#ff9900' : cam.t === 'v' ? '#00aaff'   : cam.t === 'h' ? '#cc88ff' : '#00ff88';

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
        ${needsServerTranscode ? `
          <div id="cctv-transcode-note" style="margin-bottom:8px;padding:6px 8px;border:1px solid rgba(255,193,7,0.35);background:rgba(255,193,7,0.08);color:rgba(255,220,120,0.92);font-size:9px;line-height:1.4">
            Checking server transcoder status...
          </div>
        ` : ''}

        ${isSundersOnly ? `
          <div style="background:rgba(255,153,0,0.08);border:1px solid rgba(255,153,0,0.25);padding:8px;border-radius:2px;font-size:9px;line-height:1.4;color:rgba(255,153,0,0.8)">
            <div style="margin-bottom:6px"><strong>OpenStreetMap Surveillance Location</strong></div>
            ${cam.y ? `<div>Type: <span style="color:rgba(255,153,0,1)">${cam.y}</span></div>` : ''}
            ${cam.z ? `<div>Operator: <span style="color:rgba(255,153,0,1)">${cam.z}</span></div>` : ''}
            ${cam.d ? `<div>Direction: <span style="color:rgba(255,153,0,1)">${cam.d}°</span></div>` : ''}
            ${cam.k ? `<div>Height: <span style="color:rgba(255,153,0,1)">${cam.k}m</span></div>` : ''}
            ${cam.m ? `<div>Manufacturer: <span style="color:rgba(255,153,0,1)">${cam.m}</span></div>` : ''}
            <div style="margin-top:6px;color:rgba(255,153,0,0.6);font-size:8px">No live feed available · Location source: OpenStreetMap</div>
          </div>
        ` : hasPlayableVideo ? `
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
      _panel.style.display = 'none';
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
    const e = _ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(cam.o, cam.a, 0),
      billboard: {
        image:                    ICONS[cam.t] ?? ICONS.i,
        verticalOrigin:           Cesium.VerticalOrigin.CENTER,
        horizontalOrigin:         Cesium.HorizontalOrigin.CENTER,
        scale:                    new Cesium.CallbackProperty(() => _selectedCameraId === cam.i ? 2.0 : 1.25, false),
        color:                    new Cesium.CallbackProperty(() => _selectedCameraId === cam.i ? Cesium.Color.YELLOW : Cesium.Color.WHITE, false),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text:             new Cesium.CallbackProperty(() => _selectedCameraId === cam.i ? (cam.s ?? 'Camera') : '', false),
        font:             '12px "Courier New", monospace',
        color:            Cesium.Color.fromCssColorString('#00FF00'),
        outlineColor:     Cesium.Color.fromCssColorString('#000000'),
        outlineWidth:     1,
        style:            Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin:   Cesium.VerticalOrigin.TOP,
        pixelOffset:      new Cesium.Cartesian2(0, 15),
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
      },
    });
    
    // Create a larger, semi-transparent glow behind the main icon
    _ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(cam.o, cam.a, 0),
      billboard: {
        image:                    ICONS[cam.t] ?? ICONS.i,
        verticalOrigin:           Cesium.VerticalOrigin.CENTER,
        horizontalOrigin:         Cesium.HorizontalOrigin.CENTER,
        scale:                    new Cesium.CallbackProperty(() => _selectedCameraId === cam.i ? 3.2 : 0, false),
        color:                    new Cesium.CallbackProperty(() => _selectedCameraId === cam.i ? Cesium.Color.fromCssColorString('#ffff0044') : Cesium.Color.TRANSPARENT, false),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    
    tile.entities.push(e);
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

    const entity = _ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(cam.o, cam.a, 0),
      billboard: {
        image:                    ICONS[cam.t] ?? ICONS.i,
        verticalOrigin:           Cesium.VerticalOrigin.CENTER,
        horizontalOrigin:         Cesium.HorizontalOrigin.CENTER,
        scale:                    new Cesium.CallbackProperty(() => _selectedCameraId === camId ? 2.0 : 1.25, false),
        color:                    new Cesium.CallbackProperty(() => _selectedCameraId === camId ? Cesium.Color.YELLOW : Cesium.Color.WHITE, false),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text:             new Cesium.CallbackProperty(() => _selectedCameraId === camId ? (cam.s ?? 'Camera') : '', false),
        font:             '12px "Courier New", monospace',
        color:            Cesium.Color.fromCssColorString('#00FF00'),
        outlineColor:     Cesium.Color.fromCssColorString('#000000'),
        outlineWidth:     1,
        style:            Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin:   Cesium.VerticalOrigin.TOP,
        pixelOffset:      new Cesium.Cartesian2(0, 15),
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
      },
    });
    
    // Create a larger, semi-transparent glow behind the main icon
    _ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(cam.o, cam.a, 0),
      billboard: {
        image:                    ICONS[cam.t] ?? ICONS.i,
        verticalOrigin:           Cesium.VerticalOrigin.CENTER,
        horizontalOrigin:         Cesium.HorizontalOrigin.CENTER,
        scale:                    new Cesium.CallbackProperty(() => _selectedCameraId === camId ? 3.2 : 0, false),
        color:                    new Cesium.CallbackProperty(() => _selectedCameraId === camId ? Cesium.Color.fromCssColorString('#ffff0044') : Cesium.Color.TRANSPARENT, false),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    
    _serverCamMap.set(camId, entity);
  }

  for (const [camId, entity] of _serverCamMap.entries()) {
    if (!seen.has(camId)) {
      _ds.entities.remove(entity);
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
      if (_panel) _panel.style.display = 'none';
      return;
    }
    const props = picked.id?.properties;
    if (!props || props.type?.getValue() !== 'cctv') {
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
        if (_panel) _panel.style.display = 'none';
      }
    },
    get count() { return _ds.entities.values.length; },
  };
}
