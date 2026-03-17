/**
 * File: src/ui/HUD.js
 * Purpose: Main HUD composition (status, info panels, clock, and follow interactions).
 * Notes: Includes aircraft enrichment and subsystem health surfacing.
 * Last updated: 2026-03-13
 */

import * as Cesium from 'cesium';
import { followEntity, stopFollow, isFollowing, followingLabel } from '../core/follow.js';
import { setFollowMode, setFlightGlow, hasAssetModel, setEnrichedTypecode } from '../layers/flights.js';
import { clearSatelliteSelection, setSatelliteInfoPanelVisible, setSatelliteSelection } from '../layers/satellites.js';
import {
  CITIES,
  flyTo,
  isAutoRotateEnabled,
  isOrbitalModeEnabled,
  resetNorthCamera,
  setAutoRotate,
  setOrbitalMode,
  zoomInCamera,
  zoomOutCamera,
} from '../core/camera.js';

const DEV_MODE = ((import.meta.env.VITE_DEVELOPER_MODE ?? import.meta.env.VITE_DEV_MODE ?? 'false').toLowerCase() === 'true');
const SERVER_HEAVY_MODE = ((import.meta.env.VITE_SERVER_HEAVY_MODE ?? 'false').toLowerCase() === 'true');

function combineSubsystemStatus() {
  const status = window.__shadowgridSubsystemStatus ?? {};
  const flights    = status.flights;
  const satellites = status.satellites;

  const reported = [flights, satellites].filter(Boolean);
  if (!reported.length) return null;

  const bothReported = !!(flights && satellites);
  const allOk    = reported.every(s => s.level === 'ok');
  const allError = reported.every(s => s.level === 'error');

  if (bothReported && allOk) {
    return { parts: [{ text: '● NOMINAL · ALL FEEDS ACTIVE', level: 'ok' }], level: 'ok' };
  }

  if (bothReported && allError) {
    return { parts: [{ text: '✕ OFFLINE · ALL FEEDS DOWN', level: 'error' }], level: 'error' };
  }

  // Single subsystem reported and it is ok — show plainly until the other reports
  if (!bothReported && allOk) {
    return { parts: [{ text: reported[0].msg, level: 'ok' }], level: 'ok' };
  }

  // DEGRADED — mixed state, render each part in its own colour
  const parts = [{ text: '⚠ DEGRADED', level: 'warn' }];
  // Error/warn subsystems first
  for (const s of reported) {
    if (s.level !== 'ok') parts.push({ text: s.msg, level: s.level });
  }
  // Ok subsystems after
  for (const s of reported) {
    if (s.level === 'ok') parts.push({ text: s.msg, level: 'ok' });
  }
  return { parts, level: 'warn' };
}

const _hudColours = { ok: 'rgba(0,255,136,0.7)', warn: '#ffaa00', error: '#ff4444' };

function applyHUDStatus(combined) {
  const el = document.getElementById('hud-status-msg');
  if (!el || !combined?.parts?.length) return;
  if (combined.parts.length === 1) {
    el.style.color = _hudColours[combined.parts[0].level] ?? _hudColours.ok;
    el.textContent = combined.parts[0].text;
  } else {
    el.style.color = '';
    el.innerHTML = combined.parts
      .map(p => `<span style="color:${_hudColours[p.level] ?? _hudColours.ok}">${p.text}</span>`)
      .join('<span style="color:rgba(255,255,255,0.2)"> · </span>');
  }
}

export function initHUD(viewer) {
  drawReticle(viewer);
  initEntityPicker(viewer);

  if (DEV_MODE && SERVER_HEAVY_MODE) {
    initHeavyDiagnosticsPanel();
  }

  // Global system-status bus so any layer can update the bottom status panel.
  window.addEventListener('shadowgrid:system-status', (ev) => {
    const detail = ev?.detail ?? {};
    if (typeof detail.msg !== 'string' || !detail.msg.trim()) return;

    const combined = combineSubsystemStatus();
    if (combined) {
      applyHUDStatus(combined);
      return;
    }
    setHUDStatus(detail.msg, detail.level ?? 'ok');
  });

  // If feeds emitted status during boot before HUD mounted, apply latest now.
  const combined = combineSubsystemStatus();
  if (combined) {
    applyHUDStatus(combined);
  } else {
    const cached = window.__shadowgridSystemStatus;
    if (cached?.msg) {
      setHUDStatus(cached.msg, cached.level ?? 'ok');
    }
  }

  // When follow is cancelled externally (user pans), update any open panel buttons.
  window.addEventListener('shadowgrid:unfollow', () => {
    document.querySelectorAll('#follow-btn, [data-satellite-index]').forEach((btn) => {
      setFollowBtnState(btn, false);
    });
  });
}

function initHeavyDiagnosticsPanel() {
  const panel = document.createElement('div');
  panel.id = 'hud-heavy-diagnostics';
  panel.style.cssText = `
    position: fixed;
    top: 48px;
    right: 14px;
    z-index: 11;
    pointer-events: none;
    background: rgba(4,10,18,0.88);
    border: 1px solid rgba(0,255,136,0.26);
    border-right: 2px solid rgba(0,255,136,0.55);
    padding: 8px 10px;
    min-width: 280px;
    backdrop-filter: blur(8px);
    font-family: 'Share Tech Mono', 'Courier New', monospace;
    font-size: 10px;
    line-height: 1.55;
    color: #d9ffe8;
  `;
  panel.innerHTML = `
    <div style="color:rgba(0,255,136,0.7);font-size:9px;letter-spacing:0.14em;margin-bottom:5px">DEV · HEAVY DIAGNOSTICS</div>
    <div id="hud-heavy-diag-body" style="color:#d9ffe8">Waiting for snapshot…</div>
  `;
  document.body.appendChild(panel);

  function fmtAge(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${Math.max(ms, 0).toFixed(0)} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
  }

  function cacheText(v) {
    if (v === true) return '<span style="color:#ffaa00">hit</span>';
    if (v === false) return '<span style="color:#00ff88">miss</span>';
    return '<span style="color:rgba(255,255,255,0.4)">—</span>';
  }

  function render(detail) {
    const body = document.getElementById('hud-heavy-diag-body');
    if (!body) return;
    const include = Array.isArray(detail?.include) && detail.include.length
      ? detail.include.join(', ')
      : 'none';

    const providers = detail?.providers ?? {};
    const ages = detail?.snapshotAgesMs ?? {};
    const cache = detail?.cache ?? {};
    const err = detail?.error;

    body.innerHTML = `
      <div>Mode: <span style="color:rgba(0,255,136,0.9)">${detail?.mode ?? 'unknown'}</span></div>
      <div>Include: <span style="color:rgba(0,255,136,0.9)">${include}</span></div>
      <div style="margin-top:4px;border-top:1px solid rgba(0,255,136,0.12);padding-top:4px">
        <div>Flights: <span style="color:#fff">${providers.flights ?? '—'}</span> · age ${fmtAge(ages.flights)} · cache ${cacheText(cache.flights)}</div>
        <div>Sats: <span style="color:#fff">${providers.satellites ?? '—'}</span> · age ${fmtAge(ages.satellites)} · cache ${cacheText(cache.satellites)}</div>
        <div>Traffic: <span style="color:#fff">${providers.traffic ?? '—'}</span> · age ${fmtAge(ages.traffic)} · cache ${cacheText(cache.traffic)}</div>
        <div>CCTV: <span style="color:#fff">${providers.cameras ?? '—'}</span> · age ${fmtAge(ages.cameras)} · cache ${cacheText(cache.cameras)}</div>
      </div>
      ${err ? `<div style="margin-top:4px;color:#ff7f7f">Err: ${String(err).slice(0, 110)}</div>` : ''}
    `;
  }

  window.addEventListener('shadowgrid:heavy-diagnostics', (ev) => {
    render(ev?.detail ?? null);
  });

  const cached = window.__shadowgridHeavyDiagnostics;
  if (cached) render(cached);
}

/**
 * Update the bottom-centre status panel counts.
 * Call this from flights.js / satellites.js whenever your entity lists change.
 *
 * @param {{ aircraft?: number, satellites?: number, traffic?: number, cctv?: number, objects?: number }} counts
 */
export function updateHUDCounts({ aircraft, satellites, traffic, cctv, objects } = {}) {
  if (aircraft   != null) { const el = document.getElementById('hud-count-aircraft');   if (el) el.textContent = aircraft.toLocaleString(); }
  if (satellites != null) { const el = document.getElementById('hud-count-satellites'); if (el) el.textContent = satellites.toLocaleString(); }
  if (traffic    != null) { const el = document.getElementById('hud-count-traffic');    if (el) el.textContent = traffic.toLocaleString(); }
  if (cctv       != null) { const el = document.getElementById('hud-count-cctv');       if (el) el.textContent = cctv.toLocaleString(); }
  if (objects    != null) { const el = document.getElementById('hud-count-objects');    if (el) el.textContent = objects.toLocaleString(); }
}

/**
 * Set a status message in the bottom-centre panel.
 * @param {string} msg   e.g. '⚠ FEED TIMEOUT'
 * @param {'ok'|'warn'|'error'} level
 */
export function setHUDStatus(msg, level = 'ok') {
  const el = document.getElementById('hud-status-msg');
  if (!el) return;
  el.style.color = _hudColours[level] ?? _hudColours.ok;
  el.textContent = msg;
}

// ── HUD overlay (reticle + corner brackets + coordinate readout) ──────────────

// Shared state so coordinate panel can update from camera-change events
let _hudViewer = null;
let _hudCrosshairLocation = null;

function drawReticle(viewer) {
  _hudViewer = viewer;
  let crosshairHidden = false;

  // ── Canvas overlay (reticle + corner brackets) ────────────────────────────
  const canvas  = viewer.canvas;
  const overlay = document.createElement('canvas');
  overlay.id = 'hud-reticle-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9;width:100%;height:100%;';
  document.body.appendChild(overlay);

  // ── Bottom-left: CROSSHAIR POSITION (camera centre, not cursor) ──────────
  const coordPanel = document.createElement('div');
  coordPanel.id = 'hud-coord-panel';
  coordPanel.style.cssText = `
    position: fixed;
    bottom: 56px;
    left: 16px;
    pointer-events: auto;
    z-index: 10;
    font-family: 'Share Tech Mono', 'Courier New', monospace;
    font-size: 11px;
    line-height: 1.7;
    color: #ffffff;
  `;
  coordPanel.innerHTML = `
    <div style="
      background: rgba(4,10,18,0.82);
      border: 1px solid rgba(0,255,136,0.25);
      border-left: 2px solid rgba(0,255,136,0.7);
      padding: 7px 12px 7px 10px;
      backdrop-filter: blur(8px);
      min-width: 220px;
    ">
      <div style="color:rgba(0,255,136,0.6);font-size:9px;letter-spacing:0.15em;margin-bottom:3px">✛ CROSSHAIR POSITION</div>
      <div id="hud-lat"       style="color:#e8ffe0">LAT   <span style="color:#fff;font-weight:500">–</span></div>
      <div id="hud-lon"       style="color:#e8ffe0">LON   <span style="color:#fff;font-weight:500">–</span></div>
      <div id="hud-elev"      style="color:#e8ffe0;margin-top:2px">ELEV  <span style="color:#fff;font-weight:500">–</span></div>
      <div id="hud-localtime" style="color:#e8ffe0;margin-top:2px;border-top:1px solid rgba(0,255,136,0.1);padding-top:4px">LOCAL TIME: <span style="color:rgba(0,255,136,0.9);font-weight:500">–</span></div>
      <div style="margin-top:6px;border-top:1px solid rgba(0,255,136,0.1);padding-top:6px;display:flex;align-items:center;gap:5px;pointer-events:auto;">
        <input
          id="hud-locsearch-input"
          type="text"
          placeholder="Search city or place..."
          autocomplete="off"
          style="
            width:132px;
            padding:3px 6px;
            background:rgba(0,0,0,0.55);
            border:1px solid rgba(0,255,136,0.28);
            color:#00ff88;
            font-family:'Share Tech Mono',monospace;
            font-size:10px;
            letter-spacing:0.04em;
            outline:none;
          "
        />
        <button
          id="hud-locsearch-btn"
          style="
            padding:3px 7px;
            background:rgba(0,0,0,0.55);
            border:1px solid rgba(0,255,136,0.28);
            color:rgba(0,255,136,0.8);
            font-family:'Share Tech Mono',monospace;
            font-size:10px;
            letter-spacing:0.08em;
            cursor:pointer;
          "
        >GO</button>
      </div>
      <div id="hud-locsearch-status" style="color:rgba(0,255,136,0.55);font-size:9px;letter-spacing:0.06em;margin-top:4px;min-height:12px;pointer-events:none;"></div>
    </div>
  `;
  document.body.appendChild(coordPanel);

  function setCrosshairVisibility(hidden) {
    crosshairHidden = !!hidden;
    renderCanvas();
  }

  window.addEventListener('shadowgrid:follow', () => {
    setCrosshairVisibility(true);
  });

  window.addEventListener('shadowgrid:unfollow', () => {
    setCrosshairVisibility(false);
  });

  wireLocationSearch(viewer);

  // ── Top-centre status bar ─────────────────────────────────────────────────
  const statusBar = document.createElement('div');
  statusBar.id = 'hud-status-bar';
  statusBar.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 38px;
    pointer-events: none;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Share Tech Mono', 'Courier New', monospace;
    font-size: 11px;
  `;
  statusBar.innerHTML = `
    <div style="
      background: rgba(4,10,18,0.88);
      border: 1px solid rgba(0,255,136,0.2);
      border-top: none;
      padding: 0 20px;
      height: 100%;
      display: flex;
      align-items: center;
      gap: 20px;
      backdrop-filter: blur(10px);
    ">
      <span style="color:rgba(0,255,136,0.55);font-size:9px;letter-spacing:0.2em">SHADOWGRID / UNCLASSIFIED</span>
      <span style="color:rgba(255,255,255,0.15)">|</span>
      <span id="hud-utc" style="color:rgba(0,255,136,0.8);letter-spacing:0.08em">–</span>
      <span style="color:rgba(255,255,255,0.15)">|</span>
      <span style="
        color: #00ff88;
        font-size: 9px;
        letter-spacing: 0.18em;
        border: 1px solid rgba(0,255,136,0.4);
        padding: 1px 7px;
        background: rgba(0,255,136,0.08);
      ">● LIVE</span>
    </div>
  `;
  document.body.appendChild(statusBar);

  // ── Bottom-right altitude/zoom readout ────────────────────────────────────
  const zoomPanel = document.createElement('div');
  zoomPanel.id = 'hud-zoom-panel';
  zoomPanel.style.cssText = `
    position: fixed;
    bottom: 56px;
    right: 16px;
    pointer-events: auto;
    z-index: 10;
    font-family: 'Share Tech Mono', 'Courier New', monospace;
    font-size: 11px;
    line-height: 1.7;
    text-align: right;
  `;
  zoomPanel.innerHTML = `
    <div style="
      background: rgba(4,10,18,0.82);
      border: 1px solid rgba(0,255,136,0.25);
      border-right: 2px solid rgba(0,255,136,0.7);
      padding: 7px 10px 7px 12px;
      backdrop-filter: blur(8px);
      min-width: 170px;
    ">
      <div style="color:rgba(0,255,136,0.6);font-size:9px;letter-spacing:0.15em;margin-bottom:3px;text-align:right">CAMERA</div>
      <div id="hud-cam-alt" style="color:#e8ffe0">ELEV <span style="color:#fff;font-weight:500">–</span></div>
      <div id="hud-cam-heading" style="color:#e8ffe0">HDG  <span style="color:#fff;font-weight:500">–</span></div>
      <div id="hud-cam-pitch" style="color:#e8ffe0;margin-top:2px">PITCH <span style="color:#fff;font-weight:500">–</span></div>
      <div style="margin-top:6px;border-top:1px solid rgba(0,255,136,0.1);padding-top:6px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;pointer-events:auto;">
        <button id="hud-cam-zoom-in" style="background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:rgba(0,255,136,0.78);font-family:'Share Tech Mono', monospace;font-size:9px;letter-spacing:0.06em;padding:4px 6px;cursor:pointer;">ZOOM +</button>
        <button id="hud-cam-zoom-out" style="background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:rgba(0,255,136,0.78);font-family:'Share Tech Mono', monospace;font-size:9px;letter-spacing:0.06em;padding:4px 6px;cursor:pointer;">ZOOM −</button>
        <button id="hud-cam-reset-north" style="background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:rgba(0,255,136,0.78);font-family:'Share Tech Mono', monospace;font-size:9px;letter-spacing:0.06em;padding:4px 6px;cursor:pointer;">NORTH</button>
        <button id="hud-cam-orbital" style="background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:rgba(0,255,136,0.78);font-family:'Share Tech Mono', monospace;font-size:9px;letter-spacing:0.06em;padding:4px 6px;cursor:pointer;">LABELS</button>
        <button id="hud-cam-rotate" style="grid-column:1 / span 2;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:rgba(0,255,136,0.78);font-family:'Share Tech Mono', monospace;font-size:9px;letter-spacing:0.06em;padding:4px 6px;cursor:pointer;">ROTATE</button>
      </div>
    </div>
  `;
  document.body.appendChild(zoomPanel);

  // ── Bottom-centre: SYSTEM STATUS ──────────────────────────────────────────
  const statusPanel = document.createElement('div');
  statusPanel.id = 'hud-status-panel';
  statusPanel.style.cssText = `
    position: fixed;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    pointer-events: none;
    z-index: 10;
    font-family: 'Share Tech Mono', 'Courier New', monospace;
    font-size: 11px;
    line-height: 1.7;
    text-align: center;
  `;
  statusPanel.innerHTML = `
    <div style="
      background: rgba(4,10,18,0.82);
      border: 1px solid rgba(0,255,136,0.22);
      border-bottom: none;
      padding: 6px 18px 7px;
      backdrop-filter: blur(8px);
      white-space: nowrap;
    ">
      <div style="color:rgba(0,255,136,0.6);font-size:9px;letter-spacing:0.15em;margin-bottom:4px">SYSTEM STATUS</div>
      <div style="display:flex;gap:20px;align-items:center;justify-content:center">
        <span id="hud-status-msg" style="color:rgba(0,255,136,0.7);font-size:9px;letter-spacing:0.1em">● NOMINAL · ALL FEEDS ACTIVE</span>
      </div>
      <div style="display:flex;gap:16px;margin-top:5px;justify-content:center;border-top:1px solid rgba(0,255,136,0.1);padding-top:5px">
        <span style="color:#e8ffe0">✈️ <span id="hud-count-aircraft" style="color:#fff;font-weight:500">0</span></span>
        <span style="color:rgba(255,255,255,0.2)">|</span>
        <span style="color:#e8ffe0">🛰️ <span id="hud-count-satellites" style="color:#fff;font-weight:500">0</span></span>
        <span style="color:rgba(255,255,255,0.2)">|</span>
        <span style="color:#e8ffe0">🚗 <span id="hud-count-traffic" style="color:#fff;font-weight:500">0</span></span>
        <span style="color:rgba(255,255,255,0.2)">|</span>
        <span style="color:#e8ffe0">📹 <span id="hud-count-cctv" style="color:#fff;font-weight:500">0</span></span>
      </div>
    </div>
  `;
  document.body.appendChild(statusPanel);

  // ── Between crosshair and status: layer selector dock ───────────────────
  const layersDock = document.createElement('div');
  layersDock.id = 'hud-layers';
  layersDock.style.cssText = `
    position: fixed;
    left: 0;
    top: 0;
    transform: translateX(-50%);
    pointer-events: auto;
    z-index: 10;
  `;
  layersDock.innerHTML = `
    <button id="hud-layers-toggle" style="
      background: rgba(0,0,0,0.55);
      border: 1px solid rgba(0,255,136,0.28);
      color: rgba(0,255,136,0.8);
      font-family: 'Share Tech Mono', 'Courier New', monospace;
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 3px 9px;
      cursor: pointer;
      border-radius: 2px;
      backdrop-filter: blur(8px);
    ">Layers ▾</button>
    <div id="hud-layers-menu" style="
      position: absolute;
      left: 50%;
      bottom: calc(100% + 6px);
      transform: translateX(-50%);
      min-width: 190px;
      max-height: 62vh;
      overflow-y: auto;
      display: none;
      background: rgba(4,10,18,0.94);
      border: 1px solid rgba(0,255,136,0.28);
      border-right: 2px solid rgba(0,255,136,0.7);
      padding: 8px;
      backdrop-filter: blur(8px);
    "></div>
  `;
  document.body.appendChild(layersDock);

  const existingLayerPanel = document.getElementById('panel-left');
  const layersMenu = document.getElementById('hud-layers-menu');
  if (existingLayerPanel && layersMenu) {
    existingLayerPanel.style.position = 'static';
    existingLayerPanel.style.top = 'auto';
    existingLayerPanel.style.left = 'auto';
    existingLayerPanel.style.transform = 'none';
    existingLayerPanel.style.pointerEvents = 'auto';
    existingLayerPanel.style.gap = '8px';
    layersMenu.appendChild(existingLayerPanel);
  }

  // ── Between status and camera: visual filter selector ───────────────────
  const filtersDock = document.createElement('div');
  filtersDock.id = 'hud-filters';
  filtersDock.style.cssText = `
    position: fixed;
    left: 0;
    top: 0;
    transform: translateX(-50%);
    pointer-events: auto;
    z-index: 10;
  `;
  filtersDock.innerHTML = `
    <button id="hud-filters-toggle" style="
      background: rgba(0,0,0,0.55);
      border: 1px solid rgba(0,255,136,0.28);
      color: rgba(0,255,136,0.8);
      font-family: 'Share Tech Mono', 'Courier New', monospace;
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 3px 9px;
      cursor: pointer;
      border-radius: 2px;
      backdrop-filter: blur(8px);
    ">Filters ▾</button>
    <div id="hud-filters-menu" hidden style="
      position: absolute;
      left: 50%;
      bottom: calc(100% + 6px);
      transform: translateX(-50%);
      min-width: 116px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: rgba(4,10,18,0.94);
      border: 1px solid rgba(0,255,136,0.28);
      border-right: 2px solid rgba(0,255,136,0.7);
      padding: 6px;
      backdrop-filter: blur(8px);
    ">
      <button class="shader-option-btn active" data-mode="normal" style="background:rgba(0,0,0,0.48);border:1px solid rgba(0,255,136,0.2);color:rgba(0,255,136,0.85);font-family:'Share Tech Mono', 'Courier New', monospace;font-size:10px;letter-spacing:0.09em;text-transform:uppercase;padding:5px 8px;cursor:pointer;text-align:left;">Normal</button>
      <button class="shader-option-btn" data-mode="nvg" style="background:rgba(0,0,0,0.48);border:1px solid rgba(0,255,136,0.2);color:rgba(0,255,136,0.65);font-family:'Share Tech Mono', 'Courier New', monospace;font-size:10px;letter-spacing:0.09em;text-transform:uppercase;padding:5px 8px;cursor:pointer;text-align:left;">NVG</button>
      <button class="shader-option-btn" data-mode="flir" style="background:rgba(0,0,0,0.48);border:1px solid rgba(0,255,136,0.2);color:rgba(0,255,136,0.65);font-family:'Share Tech Mono', 'Courier New', monospace;font-size:10px;letter-spacing:0.09em;text-transform:uppercase;padding:5px 8px;cursor:pointer;text-align:left;">FLIR</button>
      <button class="shader-option-btn" data-mode="crt" style="background:rgba(0,0,0,0.48);border:1px solid rgba(0,255,136,0.2);color:rgba(0,255,136,0.65);font-family:'Share Tech Mono', 'Courier New', monospace;font-size:10px;letter-spacing:0.09em;text-transform:uppercase;padding:5px 8px;cursor:pointer;text-align:left;">CRT</button>
    </div>
  `;
  document.body.appendChild(filtersDock);

  const imageryDock = document.createElement('div');
  imageryDock.id = 'hud-imagery';
  imageryDock.style.cssText = `
    position: fixed;
    left: 0;
    top: 0;
    transform: none;
    pointer-events: auto;
    z-index: 11;
  `;
  imageryDock.innerHTML = `
    <button id="hud-imagery-dropdown" style="
      background: rgba(0,0,0,0.55);
      border: 1px solid rgba(255, 145, 0, 0.28); /* changed from rgba(0,255,136,0.28) to mark as incomplete */
      color:  rgba(255, 145, 0, 0.28); /* changed from rgba(0,255,136,0.8) to mark as incomplete */
      font-family: 'Share Tech Mono', 'Courier New', monospace;
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 3px 9px;
      cursor: pointer;
      border-radius: 2px;
      backdrop-filter: blur(8px);
    ">Imagery ▾</button>
  `;
  document.body.appendChild(imageryDock);

  const satelliteModal = document.createElement('div');
  satelliteModal.id = 'satellite-imagery-modal';
  satelliteModal.hidden = true;
  satelliteModal.style.cssText = `
    position: fixed;
    left: 0;
    top: 0;
    z-index: 100;
    width: min(700px, calc(100vw - 24px));
    max-height: calc(100vh - 24px);
    pointer-events: auto;
  `;
  satelliteModal.innerHTML = `
    <div data-satellite-panel style="
      background: rgba(4,10,18,0.96);
      border: 2px solid rgba(255, 145, 0, 0.35);
      border-right: 3px solid rgba(255, 145, 0, 0.7);
      backdrop-filter: blur(10px);
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      overflow: auto;
      max-height: calc(100vh - 24px);
    ">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(0,255,136,0.15);background:rgba(0,255,136,0.05);">
        <div style="font-family:'Share Tech Mono',monospace;font-size:12px;letter-spacing:0.15em;color:rgba(255, 145, 0, 0.9);text-transform:uppercase;">Satellite Imagery Viewer - Partially Working</div>
        <button id="satellite-modal-close" style="background:none;border:none;color:rgba(0,255,136,0.7);font-size:14px;cursor:pointer;padding:4px 8px;">✕</button>
      </div>
      <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">
        <div id="satellite-pick-hint" style="font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.06em;color:rgba(0,255,136,0.62);padding:8px 10px;background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.14);">
          Press the pin button to use the current crosshair location.
        </div>
        <div>
          <label style="display:block;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.1em;color:rgba(0,255,136,0.6);margin-bottom:4px;text-transform:uppercase;">Location</label>
          <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;">
            <input id="satellite-location-input" type="text" placeholder="Search location or enter coordinates..." style="width:100%;padding:8px 10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:10px;outline:none;box-sizing:border-box;"/>
            <button id="satellite-pick-btn" style="padding:8px 10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.35);color:rgba(0,255,136,0.85);font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:0.08em;cursor:pointer;min-width:46px;">PIN</button>
          </div>
        </div>
        <div>
          <label style="display:block;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.1em;color:rgba(0,255,136,0.6);margin-bottom:4px;text-transform:uppercase;">Source</label>
          <select id="satellite-source-input" style="width:100%;padding:8px 10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:10px;outline:none;">
            <option value="auto">Auto: Policy Backend → Basemap</option>
            <option value="copernicus-dataspace">Copernicus Data Space</option>
            <option value="nasa-gibs">NASA GIBS</option>
            <option value="sentinel-hub">Sentinel Hub</option>
            <option value="basemap">Basemap only</option>
          </select>
          <div style="margin-top:4px;font-family:'Share Tech Mono',monospace;font-size:8px;color:rgba(0,255,136,0.45);letter-spacing:0.05em;">Copernicus Data Space / Sentinel Hub require server credentials for supported collections.</div>
          <div id="satellite-backend-health" style="margin-top:5px;font-family:'Share Tech Mono',monospace;font-size:8px;color:rgba(210,240,255,0.85);letter-spacing:0.05em;">Backend Health: CDS <span id="satellite-health-cds" style="color:rgba(255,200,120,0.9)">…</span> · SH <span id="satellite-health-sh" style="color:rgba(255,200,120,0.9)">…</span> · <span id="satellite-health-updated" style="color:rgba(150,210,255,0.82)">updated --:--:-- UTC</span></div>
        </div>
        <div>
          <label style="display:block;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.1em;color:rgba(0,255,136,0.6);margin-bottom:4px;text-transform:uppercase;">Collection</label>
          <select id="satellite-collection-input" style="width:100%;padding:8px 10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:10px;outline:none;">
            <option>Loading collections...</option>
          </select>
          <div id="satellite-collection-info" style="margin-top:4px;font-family:'Share Tech Mono',monospace;font-size:8px;color:rgba(0,255,136,0.45);letter-spacing:0.05em;">INFO: Loading collection details...</div>
          <div id="satellite-collection-backend-badge" style="margin-top:5px;display:inline-flex;align-items:center;gap:6px;padding:3px 7px;border:1px solid rgba(0,170,255,0.45);background:rgba(0,170,255,0.12);color:rgba(110,205,255,0.95);font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:0.08em;text-transform:uppercase;">Backend: Loading...</div>
        </div>
        <div>
          <label style="display:block;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.1em;color:rgba(0,255,136,0.6);margin-bottom:4px;text-transform:uppercase;">Bands</label>
          <select id="satellite-band-preset-input" style="width:100%;padding:8px 10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:10px;outline:none;">
            <option value="true">True Colour</option>
            <option value="false">False Colour</option>
            <option value="swir">SWIR</option>
            <option value="agriculture">Agriculture</option>
          </select>
          <input id="satellite-bands-input" type="text" value="B4,B3,B2" readonly style="width:100%;margin-top:8px;padding:8px 10px;background:rgba(0,0,0,0.38);border:1px solid rgba(0,255,136,0.15);color:rgba(0,255,136,0.88);font-family:'Share Tech Mono',monospace;font-size:10px;outline:none;box-sizing:border-box;"/>
          <div style="margin-top:4px;font-family:'Share Tech Mono',monospace;font-size:8px;color:rgba(0,255,136,0.45);letter-spacing:0.05em;">Band expression is auto-filled from Collection + Bands.</div>
        </div>
        <div>
          <label style="display:block;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.1em;color:rgba(0,255,136,0.6);margin-bottom:4px;text-transform:uppercase;">Date</label>
          <input id="satellite-date-input" type="date" style="width:100%;padding:8px 10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:10px;outline:none;box-sizing:border-box;"/>
          <div id="satellite-date-state" style="margin-top:6px;display:inline-flex;align-items:center;gap:6px;padding:3px 7px;border:1px solid rgba(0,255,136,0.25);background:rgba(0,255,136,0.08);color:rgba(0,255,136,0.9);font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:0.08em;text-transform:uppercase;">Date: Today</div>
          <div style="margin-top:4px;font-family:'Share Tech Mono',monospace;font-size:8px;color:rgba(0,255,136,0.45);letter-spacing:0.05em;">Calendar defaults to today; choosing another date highlights this field.</div>
        </div>
        <div style="position:relative;width:100%;padding-top:100%;background:rgba(0,0,0,0.3);border:1px solid rgba(0,255,136,0.15);overflow:hidden;border-radius:2px;">
          <div id="satellite-preview" style="position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:rgba(0,255,136,0.5);font-size:12px;font-family:'Share Tech Mono',monospace;">Click \"Load\" to fetch imagery</div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="satellite-load-btn" style="padding:8px 16px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.35);color:rgba(0,255,136,0.8);font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;transition:all 0.2s;">Load Imagery</button>
          <button id="satellite-apply-btn" style="padding:8px 16px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.35);color:rgba(0,255,136,0.8);font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;transition:all 0.2s;">Apply to Globe</button>
        </div>
        <div id="satellite-status" style="font-family:'Share Tech Mono',monospace;font-size:9px;color:rgba(0,255,136,0.5);text-align:center;min-height:12px;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(satelliteModal);

  function positionFiltersDock() {
    const statusRect = statusPanel.getBoundingClientRect();
    const cameraRect = zoomPanel.getBoundingClientRect();
    const x = (statusRect.right + cameraRect.left) / 2;
    const y = statusRect.top;
    filtersDock.style.left = `${x}px`;
    filtersDock.style.top = `${y}px`;
  }

  positionFiltersDock();
  window.addEventListener('resize', positionFiltersDock);

  function positionLayersDock() {
    const coordRect = coordPanel.getBoundingClientRect();
    const statusRect = statusPanel.getBoundingClientRect();
    const x = (coordRect.right + statusRect.left) / 2;
    const y = statusRect.top;
    layersDock.style.left = `${x}px`;
    layersDock.style.top = `${y}px`;
  }

  function positionImageryDock() {
    const layersRect = layersDock.getBoundingClientRect();
    imageryDock.style.left = `${layersRect.right + 8}px`;
    imageryDock.style.top = `${layersRect.top}px`;
  }

  positionLayersDock();
  window.addEventListener('resize', positionLayersDock);
  positionImageryDock();
  window.addEventListener('resize', positionImageryDock);

  wireCameraControlButtons(viewer);

  // ── Canvas render (reticle + corner brackets) ─────────────────────────────
  function renderCanvas() {
    overlay.width  = canvas.width;
    overlay.height = canvas.height;
    const ctx = overlay.getContext('2d');
    const w = overlay.width, h = overlay.height;
    const cx = w / 2, cy = h / 2;

    ctx.clearRect(0, 0, w, h);

    // ── Corner bracket decorations ──────────────────────────────────────────
    const arm = 28, margin = 18;
    const corners = [
      [margin, margin, 1, 1],
      [w - margin, margin, -1, 1],
      [margin, h - margin, 1, -1],
      [w - margin, h - margin, -1, -1],
    ];
    ctx.strokeStyle = 'rgba(0,255,136,0.5)';
    ctx.lineWidth = 1.5;
    corners.forEach(([x, y, dx, dy]) => {
      ctx.beginPath(); ctx.moveTo(x + dx * arm, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * arm); ctx.stroke();
    });

    // ── Subtle edge scan-line (top & bottom) ────────────────────────────────
    ctx.strokeStyle = 'rgba(0,255,136,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(margin + arm + 12, margin); ctx.lineTo(w - margin - arm - 12, margin); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(margin + arm + 12, h - margin); ctx.lineTo(w - margin - arm - 12, h - margin); ctx.stroke();

    if (!crosshairHidden) {
      // ── Centre reticle ─────────────────────────────────────────────────────
      const r = 22, gap = 5;
      ctx.strokeStyle = 'rgba(0,255,136,0.6)';
      ctx.lineWidth = 1;
      [[cx-r-gap,cy,cx-gap,cy],[cx+gap,cy,cx+r+gap,cy],
       [cx,cy-r-gap,cx,cy-gap],[cx,cy+gap,cx,cy+r+gap]].forEach(([x1,y1,x2,y2]) => {
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
      });
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      [0, Math.PI/2, Math.PI, 3*Math.PI/2].forEach(a => {
        ctx.beginPath();
        ctx.moveTo(cx + (r - 6) * Math.cos(a), cy + (r - 6) * Math.sin(a));
        ctx.lineTo(cx + (r + 4) * Math.cos(a), cy + (r + 4) * Math.sin(a));
        ctx.stroke();
      });
      ctx.fillStyle = 'rgba(255, 72, 0, 0.8)';
      ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ── Camera position updater ───────────────────────────────────────────────
  function updateCameraReadout() {
    try {
      const cam = viewer.camera;
      const cart = cam.positionCartographic;
      if (!cart) return;

      const lat = Cesium.Math.toDegrees(cart.latitude);
      const lon = Cesium.Math.toDegrees(cart.longitude);
      const elevKm = cart.height / 1000;
      const heading = Cesium.Math.toDegrees(cam.heading);
      const pitch   = Cesium.Math.toDegrees(cam.pitch);

      const fmt = (v, d) => v.toFixed(d);

      // Status bar centre
      const camPosEl = document.getElementById('hud-cam-pos');
      if (camPosEl) camPosEl.textContent =
        `${lat >= 0 ? 'N' : 'S'}${fmt(Math.abs(lat),2)}°  ${lon >= 0 ? 'E' : 'W'}${fmt(Math.abs(lon),2)}°`;

      // Bottom-right camera panel
      const altEl = document.getElementById('hud-cam-alt');
      if (altEl) altEl.innerHTML = `ELEV <span style="color:#fff;font-weight:500">${elevKm < 1 ? (cart.height).toFixed(0) + ' m' : fmt(elevKm,1) + ' km'}</span>`;

      const hdgEl = document.getElementById('hud-cam-heading');
      if (hdgEl) hdgEl.innerHTML = `HDG  <span style="color:#fff;font-weight:500">${fmt((heading + 360) % 360, 1)}°</span>`;

      const pitchEl = document.getElementById('hud-cam-pitch');
      if (pitchEl) pitchEl.innerHTML = `PITCH <span style="color:#fff;font-weight:500">${fmt(pitch,1)}°</span>`;

    } catch { /* ignore during init */ }
  }

  // ── UTC clock ─────────────────────────────────────────────────────────────
  function updateClock() {
    const now = new Date();
    const utc = now.toISOString().replace('T',' ').substring(0,19) + ' UTC';
    const el = document.getElementById('hud-utc');
    if (el) el.textContent = utc;
  }

  // ── Crosshair (camera centre) position tracker ────────────────────────────
  // Picks the globe point at the exact screen centre on every camera move.
  function updateCrosshairPosition() {
    try {
      const w = viewer.canvas.clientWidth;
      const h = viewer.canvas.clientHeight;
      const centre = new Cesium.Cartesian2(w / 2, h / 2);
      const ray    = viewer.camera.getPickRay(centre);
      let cart3  = viewer.scene.globe.pick(ray, viewer.scene);

      // Fallback when terrain/tiles do not return a globe intersection yet.
      if (!cart3) {
        cart3 = viewer.camera.pickEllipsoid(centre, viewer.scene.globe.ellipsoid);
      }

      if (!cart3) return;
      const carto = Cesium.Cartographic.fromCartesian(cart3);
      const lat   = Cesium.Math.toDegrees(carto.latitude);
      const lon   = Cesium.Math.toDegrees(carto.longitude);
      const elev  = carto.height;

      _hudCrosshairLocation = { lat, lon, elev };

      const fmt = (v, d) => Math.abs(v).toFixed(d);

      const latEl  = document.getElementById('hud-lat');
      const lonEl  = document.getElementById('hud-lon');
      const elevEl = document.getElementById('hud-elev');
      const ltEl   = document.getElementById('hud-localtime');

      if (latEl)  latEl.innerHTML  = `LAT   <span style="color:#fff;font-weight:500">${lat  >= 0 ? 'N' : 'S'}${fmt(lat,  4)}°</span>`;
      if (lonEl)  lonEl.innerHTML  = `LON   <span style="color:#fff;font-weight:500">${lon  >= 0 ? 'E' : 'W'}${fmt(lon,  4)}°</span>`;
      if (elevEl) elevEl.innerHTML = `ELEV  <span style="color:#fff;font-weight:500">${elev < 1000 ? elev.toFixed(0) + ' m' : (elev / 1000).toFixed(2) + ' km'}</span>`;

      // Local time at crosshair: UTC offset ≈ lon / 15 hours
      if (ltEl) {
        const offsetHrs  = lon / 15;
        const nowUtcMs   = Date.now();
        const localMs    = nowUtcMs + offsetHrs * 3_600_000;
        const localDate  = new Date(localMs);
        const hh  = localDate.getUTCHours()  .toString().padStart(2, '0');
        const mm  = localDate.getUTCMinutes().toString().padStart(2, '0');
        const ss  = localDate.getUTCSeconds().toString().padStart(2, '0');
        const sign = offsetHrs >= 0 ? '+' : '−';
        const absH = Math.abs(offsetHrs).toFixed(1).replace('.0', '');
        ltEl.innerHTML = `LOCAL TIME: <span style="color:rgba(0,255,136,0.9);font-weight:500">${hh}:${mm}:${ss} (UTC${sign}${absH})</span>`;
      }
    } catch { /* globe not ready */ }
  }

  // ── Wire everything up ────────────────────────────────────────────────────
  window.addEventListener('resize', renderCanvas);
  viewer.camera.changed.addEventListener(updateCameraReadout);
  viewer.camera.changed.addEventListener(updateCrosshairPosition);
  viewer.camera.moveEnd.addEventListener(updateCameraReadout);
  viewer.camera.moveEnd.addEventListener(updateCrosshairPosition);
  setInterval(() => { updateClock(); updateCrosshairPosition(); }, 1000);
  updateClock();
  updateCameraReadout();
  updateCrosshairPosition();
  renderCanvas();
}

function wireCameraControlButtons(viewer) {
  const SATELLITE_COLLECTION_PRESETS = [
    {
      key: 's2-sr',
      label: 'Sentinel-2 SR',
      collectionId: 'COPERNICUS/S2_SR_HARMONIZED',
      bands: {
        true: 'B4,B3,B2',
        false: 'B8,B4,B3',
        swir: 'B12,B8,B4',
        agriculture: 'B11,B8,B2',
      },
    },
    {
      key: 's2-toa',
      label: 'Sentinel-2 TOA',
      collectionId: 'COPERNICUS/S2_HARMONIZED',
      bands: {
        true: 'B4,B3,B2',
        false: 'B8,B4,B3',
        swir: 'B12,B8,B4',
        agriculture: 'B11,B8,B2',
      },
    },
    {
      key: 's1-sar',
      label: 'Sentinel-1 SAR',
      collectionId: 'COPERNICUS/S1_GRD',
      bands: {
        true: 'VV,VH',
        false: 'VV,VH',
        swir: 'VV,VH',
        agriculture: 'VV,VH',
      },
    },
    {
      key: 's3-olci',
      label: 'Sentinel-3 OLCI',
      collectionId: 'COPERNICUS/S3/OLCI',
      bands: {
        true: 'Oa08_radiance,Oa06_radiance,Oa04_radiance',
        false: 'Oa17_radiance,Oa08_radiance,Oa06_radiance',
        swir: 'Oa21_radiance,Oa17_radiance,Oa08_radiance',
        agriculture: 'Oa17_radiance,Oa08_radiance,Oa04_radiance',
      },
    },
    {
      key: 's5p-no2',
      label: 'S5P NO2',
      collectionId: 'COPERNICUS/S5P/OFFL/L3_NO2',
      bands: {
        true: 'tropospheric_NO2_column_number_density',
        false: 'tropospheric_NO2_column_number_density',
        swir: 'tropospheric_NO2_column_number_density',
        agriculture: 'tropospheric_NO2_column_number_density',
      },
    },
    {
      key: 's5p-co',
      label: 'S5P CO',
      collectionId: 'COPERNICUS/S5P/OFFL/L3_CO',
      bands: {
        true: 'CO_column_number_density',
        false: 'CO_column_number_density',
        swir: 'CO_column_number_density',
        agriculture: 'CO_column_number_density',
      },
    },
    {
      key: 's5p-so2',
      label: 'S5P SO2',
      collectionId: 'COPERNICUS/S5P/OFFL/L3_SO2',
      bands: {
        true: 'SO2_column_number_density',
        false: 'SO2_column_number_density',
        swir: 'SO2_column_number_density',
        agriculture: 'SO2_column_number_density',
      },
    },
    {
      key: 's5p-ch4',
      label: 'S5P CH4',
      collectionId: 'COPERNICUS/S5P/OFFL/L3_CH4',
      bands: {
        true: 'CH4_column_volume_mixing_ratio_dry_air',
        false: 'CH4_column_volume_mixing_ratio_dry_air',
        swir: 'CH4_column_volume_mixing_ratio_dry_air',
        agriculture: 'CH4_column_volume_mixing_ratio_dry_air',
      },
    },
    {
      key: 's5p-aai',
      label: 'S5P Aerosol AI',
      collectionId: 'COPERNICUS/S5P/OFFL/L3_AER_AI',
      bands: {
        true: 'absorbing_aerosol_index',
        false: 'absorbing_aerosol_index',
        swir: 'absorbing_aerosol_index',
        agriculture: 'absorbing_aerosol_index',
      },
    },
    {
      key: 'l9-sr',
      label: 'Landsat 9 SR',
      collectionId: 'LANDSAT/LC09/C02/T1_L2',
      bands: {
        true: 'SR_B4,SR_B3,SR_B2',
        false: 'SR_B5,SR_B4,SR_B3',
        swir: 'SR_B6,SR_B5,SR_B4',
        agriculture: 'SR_B6,SR_B5,SR_B2',
      },
    },
    {
      key: 'l8-sr',
      label: 'Landsat 8 SR',
      collectionId: 'LANDSAT/LC08/C02/T1_L2',
      bands: {
        true: 'SR_B4,SR_B3,SR_B2',
        false: 'SR_B5,SR_B4,SR_B3',
        swir: 'SR_B6,SR_B5,SR_B4',
        agriculture: 'SR_B6,SR_B5,SR_B2',
      },
    },
    {
      key: 'l7-sr',
      label: 'Landsat 7 SR',
      collectionId: 'LANDSAT/LE07/C02/T1_L2',
      bands: {
        true: 'SR_B3,SR_B2,SR_B1',
        false: 'SR_B4,SR_B3,SR_B2',
        swir: 'SR_B5,SR_B4,SR_B3',
        agriculture: 'SR_B5,SR_B4,SR_B2',
      },
    },
    {
      key: 'l5-sr',
      label: 'Landsat 5 SR',
      collectionId: 'LANDSAT/LT05/C02/T1_L2',
      bands: {
        true: 'SR_B3,SR_B2,SR_B1',
        false: 'SR_B4,SR_B3,SR_B2',
        swir: 'SR_B5,SR_B4,SR_B3',
        agriculture: 'SR_B5,SR_B4,SR_B2',
      },
    },
    {
      key: 'l9-toa',
      label: 'Landsat 9 TOA',
      collectionId: 'LANDSAT/LC09/C02/T1_TOA',
      bands: {
        true: 'B4,B3,B2',
        false: 'B5,B4,B3',
        swir: 'B6,B5,B4',
        agriculture: 'B6,B5,B2',
      },
    },
    {
      key: 'l8-toa',
      label: 'Landsat 8 TOA',
      collectionId: 'LANDSAT/LC08/C02/T1_TOA',
      bands: {
        true: 'B4,B3,B2',
        false: 'B5,B4,B3',
        swir: 'B6,B5,B4',
        agriculture: 'B6,B5,B2',
      },
    },
    {
      key: 'modis-terra-500',
      label: 'MODIS Terra 500m',
      collectionId: 'MODIS/061/MOD09GA',
      bands: {
        true: 'sur_refl_b01,sur_refl_b04,sur_refl_b03',
        false: 'sur_refl_b02,sur_refl_b01,sur_refl_b04',
        swir: 'sur_refl_b06,sur_refl_b02,sur_refl_b01',
        agriculture: 'sur_refl_b06,sur_refl_b02,sur_refl_b04',
      },
    },
    {
      key: 'modis-aqua-500',
      label: 'MODIS Aqua 500m',
      collectionId: 'MODIS/061/MYD09GA',
      bands: {
        true: 'sur_refl_b01,sur_refl_b04,sur_refl_b03',
        false: 'sur_refl_b02,sur_refl_b01,sur_refl_b04',
        swir: 'sur_refl_b06,sur_refl_b02,sur_refl_b01',
        agriculture: 'sur_refl_b06,sur_refl_b02,sur_refl_b04',
      },
    },
    {
      key: 'modis-terra-250',
      label: 'MODIS Terra 250m',
      collectionId: 'MODIS/061/MOD09GQ',
      bands: {
        true: 'sur_refl_b01,sur_refl_b02,sur_refl_b01',
        false: 'sur_refl_b02,sur_refl_b01,sur_refl_b02',
        swir: 'sur_refl_b02,sur_refl_b01,sur_refl_b02',
        agriculture: 'sur_refl_b02,sur_refl_b01,sur_refl_b02',
      },
    },
    {
      key: 'modis-vi',
      label: 'MODIS Vegetation Index',
      collectionId: 'MODIS/061/MOD13Q1',
      bands: {
        true: 'NDVI',
        false: 'EVI',
        swir: 'EVI',
        agriculture: 'NDVI',
      },
    },
    {
      key: 'modis-lst',
      label: 'MODIS Land Temp',
      collectionId: 'MODIS/061/MOD11A2',
      bands: {
        true: 'LST_Day_1km',
        false: 'LST_Night_1km',
        swir: 'LST_Day_1km',
        agriculture: 'LST_Day_1km',
      },
    },
    {
      key: 'modis-fire',
      label: 'MODIS Fire',
      collectionId: 'MODIS/061/MOD14A1',
      bands: {
        true: 'FireMask',
        false: 'MaxFRP',
        swir: 'MaxFRP',
        agriculture: 'FireMask',
      },
    },
    {
      key: 'modis-snow',
      label: 'MODIS Snow Cover',
      collectionId: 'MODIS/061/MOD10A1',
      bands: {
        true: 'NDSI_Snow_Cover',
        false: 'NDSI_Snow_Cover_Basic_QA',
        swir: 'NDSI_Snow_Cover',
        agriculture: 'NDSI_Snow_Cover',
      },
    },
    {
      key: 'modis-brdf',
      label: 'MODIS BRDF 500m',
      collectionId: 'MODIS/061/MCD43A4',
      bands: {
        true: 'Nadir_Reflectance_Band1,Nadir_Reflectance_Band4,Nadir_Reflectance_Band3',
        false: 'Nadir_Reflectance_Band2,Nadir_Reflectance_Band1,Nadir_Reflectance_Band4',
        swir: 'Nadir_Reflectance_Band6,Nadir_Reflectance_Band2,Nadir_Reflectance_Band1',
        agriculture: 'Nadir_Reflectance_Band6,Nadir_Reflectance_Band2,Nadir_Reflectance_Band4',
      },
    },
    {
      key: 'night-slc',
      label: 'Night Lights (SLC)',
      collectionId: 'NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG',
      bands: {
        true: 'avg_rad',
        false: 'avg_rad',
        swir: 'avg_rad',
        agriculture: 'avg_rad',
      },
    },
    {
      key: 'night-cf',
      label: 'Night Lights (CF)',
      collectionId: 'NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG',
      bands: {
        true: 'avg_rad',
        false: 'avg_rad',
        swir: 'avg_rad',
        agriculture: 'avg_rad',
      },
    },
    {
      key: 'night-vnp46a1',
      label: 'Night Lights (VNP46A1 Daily)',
      collectionId: 'NASA/VIIRS/VNP46A1',
      bands: {
        true: 'DNB_BRDF_Corrected_NTL',
        false: 'DNB_BRDF_Corrected_NTL',
        swir: 'DNB_BRDF_Corrected_NTL',
        agriculture: 'DNB_BRDF_Corrected_NTL',
      },
    },
    {
      key: 'viirs-surf-refl',
      label: 'VIIRS Surface Refl.',
      collectionId: 'NOAA/VIIRS/001/VNP09GA',
      bands: {
        true: 'M5,M4,M3',
        false: 'M7,M5,M4',
        swir: 'M11,M7,M5',
        agriculture: 'M11,M7,M4',
      },
    },
    {
      key: 'viirs-vi',
      label: 'VIIRS Vegetation Index',
      collectionId: 'NOAA/VIIRS/001/VNP13A1',
      bands: {
        true: 'NDVI',
        false: 'EVI',
        swir: 'EVI',
        agriculture: 'NDVI',
      },
    },
    {
      key: 'goes-16',
      label: 'GOES-16 (East)',
      collectionId: 'NOAA/GOES/16/MCMIPF',
      bands: {
        true: 'CMI_C02,CMI_C02,CMI_C01',
        false: 'CMI_C03,CMI_C02,CMI_C01',
        swir: 'CMI_C13,CMI_C07,CMI_C02',
        agriculture: 'CMI_C03,CMI_C02,CMI_C01',
      },
    },
    {
      key: 'goes-17',
      label: 'GOES-17 (West)',
      collectionId: 'NOAA/GOES/17/MCMIPF',
      bands: {
        true: 'CMI_C02,CMI_C02,CMI_C01',
        false: 'CMI_C03,CMI_C02,CMI_C01',
        swir: 'CMI_C13,CMI_C07,CMI_C02',
        agriculture: 'CMI_C03,CMI_C02,CMI_C01',
      },
    },
    {
      key: 'goes-18',
      label: 'GOES-18 (West)',
      collectionId: 'NOAA/GOES/18/MCMIPF',
      bands: {
        true: 'CMI_C02,CMI_C02,CMI_C01',
        false: 'CMI_C03,CMI_C02,CMI_C01',
        swir: 'CMI_C13,CMI_C07,CMI_C02',
        agriculture: 'CMI_C03,CMI_C02,CMI_C01',
      },
    },
    {
      key: 'aster-l1t',
      label: 'ASTER L1T',
      collectionId: 'ASTER/AST_L1T_003',
      bands: {
        true: 'B3N,B02,B01',
        false: 'B3N,B02,B01',
        swir: 'B04,B3N,B02',
        agriculture: 'B04,B3N,B02',
      },
    },
    {
      key: 'aster-ged',
      label: 'ASTER GED 100m',
      collectionId: 'NASA/ASTER_GED/AG100_003',
      bands: {
        true: 'elevation',
        false: 'elevation',
        swir: 'elevation',
        agriculture: 'elevation',
      },
    },
  ];
  const todayIsoDate = new Date().toISOString().slice(0, 10);
  const SATELLITE_COLLECTION_INFO = {
    's2-sr': 'INFO: 10m - 5 days - ESA Copernicus',
    's2-toa': 'INFO: 10m - 5 days - ESA Copernicus',
    's1-sar': 'INFO: 10m - 6 days - ESA Copernicus',
    's3-olci': 'INFO: 300m - 2 days - ESA Copernicus',
    's5p-no2': 'INFO: 7km - Daily - ESA Copernicus / Sentinel-5P',
    's5p-co': 'INFO: 7km - Daily - ESA Copernicus / Sentinel-5P',
    's5p-so2': 'INFO: 7km - Daily - ESA Copernicus / Sentinel-5P',
    's5p-ch4': 'INFO: 7km - Daily - ESA Copernicus / Sentinel-5P',
    's5p-aai': 'INFO: 7km - Daily - ESA Copernicus / Sentinel-5P',
    'l9-sr': 'INFO: 30m - 16 days - NASA / USGS',
    'l8-sr': 'INFO: 30m - 16 days - NASA / USGS',
    'l7-sr': 'INFO: 30m - 16 days - NASA / USGS',
    'l5-sr': 'INFO: 30m - 16 days - NASA / USGS',
    'l9-toa': 'INFO: 30m - 16 days - NASA / USGS',
    'l8-toa': 'INFO: 30m - 16 days - NASA / USGS',
    'modis-terra-500': 'INFO: 500m - Daily - NASA',
    'modis-aqua-500': 'INFO: 500m - Daily - NASA',
    'modis-terra-250': 'INFO: 250m - Daily - NASA',
    'modis-vi': 'INFO: 250m - Daily - NASA',
    'modis-lst': 'INFO: 1km - Daily - NASA',
    'modis-fire': 'INFO: 1km - Daily - NASA',
    'modis-snow': 'INFO: 500m - Daily - NASA',
    'modis-brdf': 'INFO: 500m - Daily - NASA',
    'night-slc': 'INFO: 500m - Monthly - NOAA VIIRS',
    'night-cf': 'INFO: 500m - Monthly - NOAA VIIRS',
    'night-vnp46a1': 'INFO: 500m - Daily - NASA VIIRS Black Marble',
    'viirs-surf-refl': 'INFO: 500m - Daily - NASA VIIRS',
    'viirs-vi': 'INFO: 500m - Daily - NASA VIIRS',
    'goes-16': 'INFO: 2km - 5-15 minutes - NOAA GOES',
    'goes-17': 'INFO: 2km - 5-15 minutes - NOAA GOES',
    'goes-18': 'INFO: 2km - 5-15 minutes - NOAA GOES',
    'aster-l1t': 'INFO: 15m - 4-16 days - NASA / METI ASTER',
    'aster-ged': 'INFO: 100m - Static - NASA ASTER',
  };
  const SATELLITE_COLLECTION_BACKEND = {
    's2-sr': 'copernicus-dataspace',
    's2-toa': 'copernicus-dataspace',
    's1-sar': 'copernicus-dataspace',
    's3-olci': 'copernicus-dataspace',
    's5p-no2': 'copernicus-dataspace',
    's5p-co': 'copernicus-dataspace',
    's5p-so2': 'copernicus-dataspace',
    's5p-ch4': 'copernicus-dataspace',
    's5p-aai': 'copernicus-dataspace',
    'l9-sr': 'copernicus-dataspace',
    'l8-sr': 'copernicus-dataspace',
    'l7-sr': 'copernicus-dataspace',
    'l5-sr': 'copernicus-dataspace',
    'l9-toa': 'copernicus-dataspace',
    'l8-toa': 'copernicus-dataspace',
    'modis-terra-500': 'nasa-gibs',
    'modis-aqua-500': 'nasa-gibs',
    'modis-terra-250': 'nasa-gibs',
    'modis-vi': 'nasa-gibs',
    'modis-lst': 'nasa-gibs',
    'modis-fire': 'nasa-gibs',
    'modis-snow': 'nasa-gibs',
    'modis-brdf': 'nasa-gibs',
    'night-slc': 'nasa-gibs',
    'night-cf': 'nasa-gibs',
    'night-vnp46a1': 'nasa-gibs',
    'viirs-surf-refl': 'nasa-gibs',
    'viirs-vi': 'nasa-gibs',
    'goes-16': 'nasa-gibs',
    'goes-17': 'nasa-gibs',
    'goes-18': 'nasa-gibs',
    'aster-l1t': 'copernicus-dataspace',
    'aster-ged': 'copernicus-dataspace',
  };

  const zoomInBtn = document.getElementById('hud-cam-zoom-in');
  const zoomOutBtn = document.getElementById('hud-cam-zoom-out');
  const resetNorthBtn = document.getElementById('hud-cam-reset-north');
  const orbitalBtn = document.getElementById('hud-cam-orbital');
  const imageryDropdownBtn = document.getElementById('hud-imagery-dropdown');
  const rotateBtn = document.getElementById('hud-cam-rotate');
  
  // Satellite imagery modal elements
  const satelliteModal = document.getElementById('satellite-imagery-modal');
  const satelliteModalClose = document.getElementById('satellite-modal-close');
  const satelliteLocationInput = document.getElementById('satellite-location-input');
  const satellitePickBtn = document.getElementById('satellite-pick-btn');
  const satellitePickHint = document.getElementById('satellite-pick-hint');
  const satelliteSourceInput = document.getElementById('satellite-source-input');
  const satelliteBackendHealth = document.getElementById('satellite-backend-health');
  const satelliteHealthCds = document.getElementById('satellite-health-cds');
  const satelliteHealthSh = document.getElementById('satellite-health-sh');
  const satelliteHealthUpdated = document.getElementById('satellite-health-updated');
  const satelliteCollectionInput = document.getElementById('satellite-collection-input');
  const satelliteCollectionInfo = document.getElementById('satellite-collection-info');
  const satelliteCollectionBackendBadge = document.getElementById('satellite-collection-backend-badge');
  const satelliteBandPresetInput = document.getElementById('satellite-band-preset-input');
  const satelliteBandsInput = document.getElementById('satellite-bands-input');
  const satelliteDateInput = document.getElementById('satellite-date-input');
  const satelliteDateState = document.getElementById('satellite-date-state');
  const satelliteLoadBtn = document.getElementById('satellite-load-btn');
  const satelliteApplyBtn = document.getElementById('satellite-apply-btn');
  const satellitePreview = document.getElementById('satellite-preview');
  const satelliteStatus = document.getElementById('satellite-status');

  if (!zoomInBtn || !zoomOutBtn || !resetNorthBtn || !orbitalBtn || !rotateBtn) return;

  let currentPreviewUrl = null;
  let currentPreviewMeta = null;
  let satelliteImageryLayer = null;
  let satellitePickArmed = false;
  const satellitePickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  const paintToggle = (btn, active) => {
    btn.style.background = active ? 'rgba(0,255,136,0.18)' : 'rgba(0,0,0,0.5)';
    btn.style.borderColor = active ? 'rgba(0,255,136,0.58)' : 'rgba(0,255,136,0.25)';
    btn.style.color = active ? '#00ff88' : 'rgba(0,255,136,0.78)';
  };

  const paintLabelsToggle = (btn, labelsOn) => {
    if (labelsOn) {
      btn.style.background = 'rgba(0,255,136,0.18)';
      btn.style.borderColor = 'rgba(0,255,136,0.58)';
      btn.style.color = '#00ff88';
      return;
    }
    btn.style.background = 'rgba(255,68,68,0.14)';
    btn.style.borderColor = 'rgba(255,68,68,0.58)';
    btn.style.color = '#ff7070';
  };

  const syncState = () => {
    const labelsOn = !isOrbitalModeEnabled(viewer);
    paintLabelsToggle(orbitalBtn, labelsOn);
    paintToggle(rotateBtn, isAutoRotateEnabled(viewer));
  };

  /**
   * Set status message in satellite modal
   */
  function setSatelliteStatus(msg, isError = false) {
    if (satelliteStatus) {
      satelliteStatus.textContent = msg;
      satelliteStatus.style.color = isError ? 'rgba(255,100,100,0.8)' : 'rgba(0,255,136,0.6)';
    }
  }

  function setSatellitePickMode(active) {
    satellitePickArmed = active;
    if (satellitePickBtn) {
      satellitePickBtn.style.background = active ? 'rgba(0,255,136,0.18)' : 'rgba(0,0,0,0.5)';
      satellitePickBtn.style.borderColor = active ? 'rgba(0,255,136,0.58)' : 'rgba(0,255,136,0.35)';
      satellitePickBtn.style.color = active ? '#00ff88' : 'rgba(0,255,136,0.85)';
    }
    if (satellitePickHint) {
      satellitePickHint.textContent = active
        ? 'Click anywhere on the globe to pick a location.'
        : 'Press the pin button to pick a location.';
      satellitePickHint.style.color = active ? '#00ff88' : 'rgba(0,255,136,0.62)';
    }
    document.body.style.cursor = active ? 'crosshair' : '';
  }

  function ensureSatelliteDateIconStyle() {
    if (document.getElementById('satellite-date-input-icon-style')) return;
    const style = document.createElement('style');
    style.id = 'satellite-date-input-icon-style';
    style.textContent = `
      #satellite-date-input::-webkit-calendar-picker-indicator {
        opacity: 1;
        cursor: pointer;
        filter: invert(35%) sepia(98%) saturate(1512%) hue-rotate(191deg) brightness(103%) contrast(103%);
      }
      #satellite-date-input::-webkit-calendar-picker-indicator:hover {
        filter: invert(37%) sepia(99%) saturate(1700%) hue-rotate(191deg) brightness(109%) contrast(108%);
      }
    `;
    document.head.appendChild(style);
  }

  function paintHealthState(el, ready) {
    if (!el) return;
    el.textContent = ready ? 'READY' : 'NOT CONFIGURED';
    el.style.color = ready ? 'rgba(0,255,136,0.9)' : 'rgba(255,140,120,0.92)';
  }

  function paintHealthTimestamp(ts) {
    if (!satelliteHealthUpdated) return;
    if (!Number.isFinite(ts)) {
      satelliteHealthUpdated.textContent = 'updated --:--:-- UTC';
      satelliteHealthUpdated.style.color = 'rgba(255,170,140,0.86)';
      return;
    }
    const d = new Date(ts);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    satelliteHealthUpdated.textContent = `updated ${hh}:${mm}:${ss} UTC`;
    satelliteHealthUpdated.style.color = 'rgba(150,210,255,0.82)';
  }

  async function refreshSatelliteBackendHealth() {
    if (!satelliteBackendHealth) return;
    paintHealthState(satelliteHealthCds, false);
    paintHealthState(satelliteHealthSh, false);
    paintHealthTimestamp(Number.NaN);
    try {
      const resp = await fetch('/api/localproxy/api/satellite-imagery/health', { cache: 'no-store' });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(payload.error || `health check failed (${resp.status})`);
      paintHealthState(satelliteHealthCds, Boolean(payload.copernicusDataspaceConfigured));
      paintHealthState(satelliteHealthSh, Boolean(payload.sentinelHubConfigured));
      paintHealthTimestamp(Number(payload.ts));
    } catch {
      if (satelliteBackendHealth) {
        satelliteBackendHealth.style.color = 'rgba(255,140,120,0.92)';
      }
      if (satelliteHealthCds) satelliteHealthCds.textContent = 'OFFLINE';
      if (satelliteHealthSh) satelliteHealthSh.textContent = 'OFFLINE';
      paintHealthTimestamp(Number.NaN);
    }
  }

  function getSelectedCollectionPreset() {
    if (!satelliteCollectionInput) return null;
    return SATELLITE_COLLECTION_PRESETS.find(item => item.key === satelliteCollectionInput.value) ?? SATELLITE_COLLECTION_PRESETS[0] ?? null;
  }

  function getBandOptionsForCollection(selected) {
    if (!selected) return [];

    const mk = (key, label, expr) => ({ key, label, expr });
    switch (selected.key) {
      case 's1-sar':
        return [
          mk('vv', 'VV', 'VV'),
          mk('vh', 'VH', 'VH'),
          mk('vv-vh', 'VV/VH Composite', 'VV,VH'),
        ];
      case 's3-olci':
        return [
          mk('true', 'True Colour', selected.bands.true),
          mk('false', 'False Colour', selected.bands.false),
          mk('ocean', 'Ocean Colour', 'Oa08_radiance,Oa06_radiance,Oa04_radiance'),
        ];
      case 's5p-no2':
        return [mk('no2', 'NO2 Column', selected.bands.true)];
      case 's5p-co':
        return [mk('co', 'CO Column', selected.bands.true)];
      case 's5p-so2':
        return [mk('so2', 'SO2 Column', selected.bands.true)];
      case 's5p-ch4':
        return [mk('ch4', 'CH4 XCH4', selected.bands.true)];
      case 's5p-aai':
        return [mk('aai', 'Aerosol Index', selected.bands.true)];
      case 'l9-sr':
      case 'l8-sr':
      case 'l7-sr':
      case 'l5-sr':
      case 'l9-toa':
      case 'l8-toa':
        return [
          mk('true', 'True Colour', selected.bands.true),
          mk('false', 'False Colour', selected.bands.false),
          mk('swir', 'SWIR', selected.bands.swir),
        ];
      case 'modis-terra-500':
      case 'modis-aqua-500':
      case 'modis-brdf':
        return [
          mk('true', 'True Colour', selected.bands.true),
          mk('false', 'False Colour', selected.bands.false),
        ];
      case 'modis-terra-250':
        return [mk('false', 'False Colour', selected.bands.false)];
      case 'modis-vi':
        return [
          mk('ndvi', 'NDVI', selected.bands.true),
          mk('evi', 'EVI', selected.bands.false),
        ];
      case 'modis-lst':
        return [
          mk('day', 'Daytime Land Surface Temperature', selected.bands.true),
          mk('night', 'Nighttime Land Surface Temperature', selected.bands.false),
        ];
      case 'modis-fire':
        return [
          mk('mask', 'Fire Mask', selected.bands.true),
          mk('frp', 'Fire Radiative Power', selected.bands.false),
        ];
      case 'modis-snow':
        return [mk('snow', 'Snow Cover', selected.bands.true)];
      case 'night-slc':
      case 'night-cf':
        return [mk('rad', 'Radiance', selected.bands.true)];
      case 'viirs-surf-refl':
        return [
          mk('true', 'True Colour', selected.bands.true),
          mk('false', 'False Colour', selected.bands.false),
          mk('swir', 'SWIR', selected.bands.swir),
        ];
      case 'viirs-vi':
        return [
          mk('ndvi', 'NDVI', selected.bands.true),
          mk('evi2', 'EVI2', selected.bands.false),
        ];
      case 'goes-16':
        return [
          mk('visible', 'Visible', 'CMI_C02'),
          mk('true', 'True Colour', selected.bands.true),
          mk('wv', 'Water Vapor', 'CMI_C08'),
          mk('ir', 'Longwave IR', 'CMI_C13'),
        ];
      case 'goes-17':
      case 'goes-18':
        return [
          mk('visible', 'Visible', 'CMI_C02'),
          mk('true', 'True Colour', selected.bands.true),
          mk('ir', 'Longwave IR', 'CMI_C13'),
        ];
      case 'aster-l1t':
        return [
          mk('nir', 'NIR', 'B3N'),
          mk('swir-geology', 'SWIR Geology', 'B04,B05,B06'),
          mk('tir', 'Thermal IR', 'B10,B11,B12'),
        ];
      case 'aster-ged':
        return [
          mk('emis', 'Emissivity', 'emissivity_mean'),
          mk('temp', 'Temperature', 'temperature'),
        ];
      default:
        return [
          mk('true', 'True Colour', selected.bands.true),
          mk('false', 'False Colour', selected.bands.false),
          mk('swir', 'SWIR', selected.bands.swir),
          mk('agriculture', 'Agriculture', selected.bands.agriculture),
        ];
    }
  }

  function updateCollectionInfo(selected) {
    const key = selected?.key ?? '';
    if (satelliteCollectionInfo) {
      satelliteCollectionInfo.textContent = SATELLITE_COLLECTION_INFO[key] ?? 'INFO: Resolution/revisit/source metadata unavailable.';
    }

    if (satelliteCollectionBackendBadge) {
      const backend = SATELLITE_COLLECTION_BACKEND[key] ?? 'nasa-gibs';
      satelliteCollectionBackendBadge.textContent = `Backend: ${backend}`;
      const isCopernicus = backend === 'copernicus-dataspace';
      const isSentinel = backend === 'sentinel-hub';
      satelliteCollectionBackendBadge.style.borderColor = isCopernicus ? 'rgba(0,200,255,0.55)' : (isSentinel ? 'rgba(255,170,0,0.52)' : 'rgba(0,170,255,0.45)');
      satelliteCollectionBackendBadge.style.background = isCopernicus ? 'rgba(0,200,255,0.12)' : (isSentinel ? 'rgba(255,170,0,0.14)' : 'rgba(0,170,255,0.12)');
      satelliteCollectionBackendBadge.style.color = isCopernicus ? 'rgba(145,235,255,0.98)' : (isSentinel ? 'rgba(255,221,153,0.95)' : 'rgba(110,205,255,0.95)');
    }
  }

  function applyCollectionPreset(options = {}) {
    if (!satelliteCollectionInput || !satelliteBandsInput || !satelliteBandPresetInput) return;
    const selected = getSelectedCollectionPreset();
    if (!selected) return;
    updateCollectionInfo(selected);

    const preserveBandKey = options.preserveBandKey
      ?? satelliteBandPresetInput.selectedOptions?.[0]?.dataset?.bandKey
      ?? '';
    const bandOptions = getBandOptionsForCollection(selected);
    satelliteBandPresetInput.innerHTML = bandOptions
      .map(item => `<option value="${item.expr}" data-band-key="${item.key}">${item.label}</option>`)
      .join('');

    const wantedKey = options.bandKey ?? preserveBandKey;
    const wantedOption = [...satelliteBandPresetInput.options].find(option => option.dataset.bandKey === wantedKey);
    if (wantedOption) {
      satelliteBandPresetInput.value = wantedOption.value;
    } else if (satelliteBandPresetInput.options.length > 0) {
      satelliteBandPresetInput.selectedIndex = 0;
    }

    satelliteBandsInput.value = satelliteBandPresetInput.value || selected.bands.true || 'B4,B3,B2';
  }

  function updateDateInputHighlight() {
    if (!satelliteDateInput) return;
    const selected = satelliteDateInput.value;
    if (selected && selected > todayIsoDate) {
      satelliteDateInput.value = todayIsoDate;
    }
    const effectiveSelected = satelliteDateInput.value;
    const isCustomDate = Boolean(effectiveSelected) && effectiveSelected !== todayIsoDate;
    satelliteDateInput.style.background = isCustomDate ? 'rgba(255,170,0,0.18)' : 'rgba(0,0,0,0.5)';
    satelliteDateInput.style.borderColor = isCustomDate ? 'rgba(255,170,0,0.62)' : 'rgba(0,255,136,0.25)';
    satelliteDateInput.style.color = isCustomDate ? '#ffd98a' : '#00ff88';
    if (satelliteDateState) {
      satelliteDateState.textContent = isCustomDate ? `Date: ${effectiveSelected}` : 'Date: Today';
      satelliteDateState.style.background = isCustomDate ? 'rgba(255,170,0,0.16)' : 'rgba(0,255,136,0.08)';
      satelliteDateState.style.borderColor = isCustomDate ? 'rgba(255,170,0,0.58)' : 'rgba(0,255,136,0.25)';
      satelliteDateState.style.color = isCustomDate ? '#ffd98a' : 'rgba(0,255,136,0.9)';
    }
  }

  function positionSatelliteModal() {
    if (!imageryDropdownBtn || !satelliteModal) return;
    const buttonRect = imageryDropdownBtn.getBoundingClientRect();
    const modalRect = satelliteModal.getBoundingClientRect();
    const modalWidth = Math.min(700, Math.max(modalRect.width, 320), window.innerWidth - 24);
    const modalHeight = Math.min(modalRect.height || 0, window.innerHeight - 24);
    const left = Math.max(12, Math.min(buttonRect.left, window.innerWidth - modalWidth - 12));
    const belowTop = buttonRect.bottom + 8;
    const aboveTop = buttonRect.top - modalHeight - 8;
    const fitsBelow = belowTop + modalHeight <= window.innerHeight - 12;
    const top = fitsBelow
      ? belowTop
      : Math.max(12, Math.min(aboveTop, window.innerHeight - modalHeight - 12));
    satelliteModal.style.left = `${left}px`;
    satelliteModal.style.top = `${top}px`;
  }

  /**
   * Parse location input (address or lat,lon coordinates)
   */
  async function parseLocation(input) {
    const trimmed = input.trim();
    
    // Try parsing as coordinates: "lat,lon"
    const coordMatch = trimmed.match(/^([-\d.]+)\s*,\s*([-\d.]+)$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lon = parseFloat(coordMatch[2]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return { lat, lon, name: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
      }
    }

    // Try geocoding via Nominatim (OSM)
    try {
      setSatelliteStatus('Searching location...');
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(trimmed)}&format=jsonv2&limit=1`
      );
      if (!resp.ok) throw new Error('Geocoding failed');
      
      const results = await resp.json();
      if (results.length === 0) {
        setSatelliteStatus('Location not found', true);
        return null;
      }

      const result = results[0];
      return {
        lat: parseFloat(result.lat),
        lon: parseFloat(result.lon),
        name: result.display_name || trimmed,
      };
    } catch (err) {
      setSatelliteStatus('Geocoding error: ' + err.message, true);
      return null;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatFailureText(failures) {
    if (!Array.isArray(failures) || failures.length === 0) return '';
    return failures
      .map((failure) => `${failure.provider}: ${failure.message}`)
      .join(' | ');
  }

  function renderSatellitePreview(payload, locationName) {
    if (!satellitePreview) return;
    const note = escapeHtml(payload.note || '');
    const bandNote = escapeHtml(payload.bandNote || '');
    const provider = escapeHtml(payload.providerLabel || payload.provider || 'Imagery');
    const req = payload.request ?? {};
    const backendPolicy = payload.backendPolicy ?? req.backendPolicy ?? {};
    const requestSummary = [
      req.collectionId ? `Collection: ${escapeHtml(req.collectionId)}` : '',
      req.bands ? `Bands: ${escapeHtml(req.bands)}` : '',
      req.date ? `Date: ${escapeHtml(req.date)}` : '',
      req.source ? `Source: ${escapeHtml(req.source)}` : '',
    ].filter(Boolean).join(' · ');
    const backendSummary = backendPolicy.authority
      ? `Backend Policy: ${escapeHtml(backendPolicy.authority)} → ${escapeHtml(backendPolicy.preferredBackend || '')}`
      : '';
    const locationLabel = escapeHtml(locationName || `${payload.location?.lat?.toFixed?.(4) ?? ''}, ${payload.location?.lon?.toFixed?.(4) ?? ''}`);
    const fallbackText = escapeHtml(formatFailureText(payload.failures));

    if (payload.previewUrl) {
      satellitePreview.innerHTML = `
        <img src="${escapeHtml(payload.previewUrl)}" alt="Satellite preview" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" />
        <div style="position:absolute;inset:auto 8px 8px 8px;font-family:'Share Tech Mono',monospace;font-size:8px;color:rgba(230,255,245,0.82);word-break:break-word;background:rgba(0,0,0,0.62);padding:6px;border-radius:2px;line-height:1.55;">
          <div style="color:#ffffff;opacity:0.92;">${provider}</div>
          <div>${note}</div>
          <div>${bandNote}</div>
          ${requestSummary ? `<div>${requestSummary}</div>` : ''}
          ${backendSummary ? `<div>${backendSummary}</div>` : ''}
          <div>${locationLabel}</div>
          ${fallbackText ? `<div style="color:rgba(255,186,120,0.92);">Fallbacks: ${fallbackText}</div>` : ''}
        </div>
      `;
      return;
    }

    satellitePreview.style.background = `linear-gradient(135deg, rgba(0,255,136,0.1) 0%, rgba(0,150,100,0.05) 100%), url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect fill="%23001a0f" width="512" height="512"/><text x="50%25" y="38%25" dominant-baseline="middle" text-anchor="middle" font-family="monospace" font-size="12" fill="%2300ff88" opacity="0.6">BASEMAP FALLBACK</text><text x="50%25" y="58%25" dominant-baseline="middle" text-anchor="middle" font-family="monospace" font-size="9" fill="%2300ff88" opacity="0.4">${escapeHtml(provider)}</text></svg>')`;
    satellitePreview.style.backgroundSize = 'cover';
    satellitePreview.style.backgroundRepeat = 'no-repeat';
    satellitePreview.style.backgroundPosition = 'center';
    satellitePreview.innerHTML = `
      <div style="position:absolute;inset:auto 8px 8px 8px;font-family:'Share Tech Mono',monospace;font-size:8px;color:rgba(230,255,245,0.82);word-break:break-word;background:rgba(0,0,0,0.62);padding:6px;border-radius:2px;line-height:1.55;">
        <div style="color:#ffffff;opacity:0.92;">${provider}</div>
        <div>${note}</div>
        <div>${bandNote}</div>
        ${requestSummary ? `<div>${requestSummary}</div>` : ''}
        ${backendSummary ? `<div>${backendSummary}</div>` : ''}
        <div>${locationLabel}</div>
        ${fallbackText ? `<div style="color:rgba(255,186,120,0.92);">Fallbacks: ${fallbackText}</div>` : ''}
      </div>
    `;
  }

  /**
   * Fetch and preview satellite imagery
   */
  async function loadSatelliteImagery() {
    const locationInput = satelliteLocationInput.value.trim();
    if (!locationInput) {
      setSatelliteStatus('Enter a location', true);
      return;
    }

    const location = await parseLocation(locationInput);
    if (!location) return;

    setSatelliteStatus('Generating preview...');
    satelliteLoadBtn.disabled = true;
    satelliteApplyBtn.disabled = true;

    try {
      const selectedCollection = getSelectedCollectionPreset();
      const collectionId = selectedCollection?.collectionId ?? 'COPERNICUS/S2_SR_HARMONIZED';
      const bands = (satelliteBandsInput?.value ?? '').trim() || 'B4,B3,B2';
      const dateStr = satelliteDateInput.value || '';
      const source = satelliteSourceInput?.value ?? 'auto';
      const query = new URLSearchParams({
        lat: String(location.lat),
        lon: String(location.lon),
        date: dateStr,
        source,
        collection: collectionId,
        bands,
      });
      const resp = await fetch(`/api/localproxy/api/satellite-imagery/preview?${query.toString()}`, {
        cache: 'no-store',
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(payload.error || `Imagery preview failed (${resp.status})`);
      }

      currentPreviewUrl = payload.previewUrl || null;
      currentPreviewMeta = payload;
      renderSatellitePreview(payload, location.name);
      const fallbackCount = Number(payload.fallbackCount || 0);
      const fallbackSuffix = fallbackCount > 0 ? ` (${fallbackCount} fallback${fallbackCount === 1 ? '' : 's'})` : '';
      setSatelliteStatus(`${payload.providerLabel || payload.provider} ready${fallbackSuffix}`);
      satelliteApplyBtn.disabled = false;
    } catch (err) {
      currentPreviewUrl = null;
      currentPreviewMeta = null;
      setSatelliteStatus('Error: ' + err.message, true);
    } finally {
      satelliteLoadBtn.disabled = false;
    }
  }

  /**
   * Apply satellite imagery layer to globe
   */
  async function applySatelliteImagery() {
    if (!currentPreviewMeta) {
      setSatelliteStatus('Load imagery first', true);
      return;
    }

    try {
      setSatelliteStatus('Applying to globe...');

      if (satelliteImageryLayer) {
        viewer.imageryLayers.remove(satelliteImageryLayer, true);
        satelliteImageryLayer = null;
      }

      const rectangle = currentPreviewMeta.rectangle;
      if (currentPreviewMeta.previewUrl && rectangle) {
        const provider = new Cesium.SingleTileImageryProvider({
          url: currentPreviewMeta.previewUrl,
          rectangle: Cesium.Rectangle.fromDegrees(rectangle.west, rectangle.south, rectangle.east, rectangle.north),
          credit: currentPreviewMeta.providerLabel || 'Satellite imagery',
        });
        satelliteImageryLayer = viewer.imageryLayers.addImageryProvider(provider);
        satelliteImageryLayer.alpha = 0.92;
      }
      
      // Parse coordinates from the location input to focus camera
      const location = await parseLocation(satelliteLocationInput.value.trim());
      if (rectangle) {
        await viewer.camera.flyTo({
          destination: Cesium.Rectangle.fromDegrees(rectangle.west, rectangle.south, rectangle.east, rectangle.north),
          duration: 1.5,
        });
      } else if (location) {
        await viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(location.lon, location.lat, 50000),
          duration: 1.5,
        });
      }

      setSatelliteStatus(
        currentPreviewMeta.provider === 'basemap'
          ? 'Basemap fallback centered on target ✓'
          : `${currentPreviewMeta.providerLabel || currentPreviewMeta.provider} applied ✓`
      );
      
      // Close modal after brief delay
      setTimeout(() => {
        if (satelliteModal) satelliteModal.hidden = true;
      }, 1500);
    } catch (err) {
      setSatelliteStatus('Apply failed: ' + err.message, true);
    }
  }

  // ── Wire imagery modal ─────────────────────────────────────────────────────
  if (imageryDropdownBtn && satelliteModal) {
    imageryDropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      satelliteModal.hidden = false;
      positionSatelliteModal();
      refreshSatelliteBackendHealth();
      setSatelliteStatus('');
    });
  }

  if (satelliteCollectionInput) {
    satelliteCollectionInput.innerHTML = SATELLITE_COLLECTION_PRESETS
      .map(item => `<option value="${item.key}">${item.label}</option>`)
      .join('');
  }

  if (satelliteCollectionInput) {
    satelliteCollectionInput.addEventListener('change', () => {
      applyCollectionPreset();
    });
  }

  if (satelliteBandPresetInput) {
    satelliteBandPresetInput.addEventListener('change', () => {
      if (!satelliteBandsInput) return;
      satelliteBandsInput.value = satelliteBandPresetInput.value || '';
    });
  }

  if (satelliteDateInput) {
    ensureSatelliteDateIconStyle();
    satelliteDateInput.max = todayIsoDate;
    if (!satelliteDateInput.value) satelliteDateInput.value = todayIsoDate;
    updateDateInputHighlight();
    satelliteDateInput.addEventListener('change', updateDateInputHighlight);
    satelliteDateInput.addEventListener('input', updateDateInputHighlight);
  }

  if (satellitePickBtn) {
    satellitePickBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!_hudCrosshairLocation || !satelliteLocationInput) {
        setSatelliteStatus('Crosshair location unavailable.', true);
        return;
      }
      setSatellitePickMode(false);
      satelliteLocationInput.value = `${_hudCrosshairLocation.lat.toFixed(6)}, ${_hudCrosshairLocation.lon.toFixed(6)}`;
      setSatelliteStatus(`Using crosshair ${_hudCrosshairLocation.lat.toFixed(4)}, ${_hudCrosshairLocation.lon.toFixed(4)}`);
    });
  }

  if (satelliteModalClose) {
    satelliteModalClose.addEventListener('click', () => {
      setSatellitePickMode(false);
      if (satelliteModal) satelliteModal.hidden = true;
    });
  }

  document.addEventListener('click', (e) => {
    if (!satelliteModal || satelliteModal.hidden) return;
    if (satelliteModal.contains(e.target) || imageryDropdownBtn?.contains(e.target)) return;
    setSatellitePickMode(false);
    satelliteModal.hidden = true;
  });

  window.addEventListener('resize', () => {
    if (satelliteModal && !satelliteModal.hidden) {
      positionSatelliteModal();
    }
  });

  if (satelliteLoadBtn) {
    satelliteLoadBtn.addEventListener('click', loadSatelliteImagery);
  }

  if (satelliteApplyBtn) {
    satelliteApplyBtn.addEventListener('click', applySatelliteImagery);
  }

  applyCollectionPreset();

  // Allow Enter to load
  if (satelliteLocationInput) {
    satelliteLocationInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadSatelliteImagery();
      }
    });
  }

  zoomInBtn.addEventListener('click', () => {
    zoomInCamera(viewer);
  });

  zoomOutBtn.addEventListener('click', () => {
    zoomOutCamera(viewer);
  });

  resetNorthBtn.addEventListener('click', () => {
    resetNorthCamera(viewer);
  });

  orbitalBtn.addEventListener('click', () => {
    const labelsOn = !isOrbitalModeEnabled(viewer);
    const nextLabelsOn = !labelsOn;
    setOrbitalMode(viewer, !nextLabelsOn);
    syncState();
  });

  rotateBtn.addEventListener('click', () => {
    const next = !isAutoRotateEnabled(viewer);
    setAutoRotate(viewer, next);
    syncState();
  });

  window.addEventListener('shadowgrid:follow', () => {
    setAutoRotate(viewer, false);
    syncState();
  });

  syncState();
}

// ── Location search (city presets + OpenStreetMap Nominatim fallback) ──────

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

function wireLocationSearch(viewer) {
  const input  = document.getElementById('hud-locsearch-input');
  const btn    = document.getElementById('hud-locsearch-btn');
  const status = document.getElementById('hud-locsearch-status');
  if (!input || !btn) return;

  async function runSearch() {
    const q = input.value.trim();
    if (!q) {
      setSearchStatus(status, 'Type a place', true);
      return;
    }

    const aliases = {
      'new york': 'nyc',
      'new york city': 'nyc',
      ny: 'nyc',
      global: 'globe',
      world: 'globe',
    };

    const key = aliases[q.toLowerCase()] ?? q.toLowerCase();
    const preset = CITIES[key];
    if (preset) {
      flyTo(viewer, { ...preset, pitch: -90 });
      setSearchStatus(status, 'Found');
      input.value = '';
      return;
    }

    setSearchStatus(status, 'Searching...');
    try {
      const params = new URLSearchParams({
        q,
        format: 'jsonv2',
        limit: '8',
        addressdetails: '1',
        dedupe: '1',
      });

      const resp = await fetch(`${NOMINATIM_URL}?${params}`, {
        headers: { Accept: 'application/json' },
      });
      if (!resp.ok) throw new Error(String(resp.status));

      const results = await resp.json();
      const best = (Array.isArray(results) ? results : []).reduce((acc, item) => {
        const type = item?.type ?? '';
        const baseScore = { city: 120, town: 110, village: 95, hamlet: 80, suburb: 55 }[type] ?? 40;
        const cityStr = [item?.address?.city, item?.address?.town, item?.address?.village]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        const score = baseScore + (item?.class === 'place' ? 25 : 0) + (cityStr.includes(q.toLowerCase()) ? 80 : 0);
        if (!acc || score > acc._score) return { ...item, _score: score };
        return acc;
      }, null);

      if (!best) {
        setSearchStatus(status, 'Not found', true);
        return;
      }

      const lat = Number(best.lat);
      const lon = Number(best.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        setSearchStatus(status, 'Bad result', true);
        return;
      }

      flyTo(viewer, { lon, lat, alt: 70000, pitch: -90 });
      setSearchStatus(status, 'Found');
      input.value = '';
    } catch (err) {
      console.warn('[HUD] Location search failed:', err?.message ?? err);
      setSearchStatus(status, 'Failed', true);
    }
  }

  btn.addEventListener('click', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });
}

function setSearchStatus(el, text, isError = false) {
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'rgba(255,80,80,0.85)' : 'rgba(0,255,136,0.6)';
  clearTimeout(el._clearTimer);
  el._clearTimer = setTimeout(() => {
    el.textContent = '';
  }, 2800);
}

// ── Entity picker + enriched panel ───────────────────────────────────────────

let currentSelectedFlightId = null;

function initEntityPicker(viewer) {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);

  // ── Panel DOM ──────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'info-panel';
  Object.assign(panel.style, {
    position:       'fixed',
    top:            '80px',
    right:          '16px',
    background:     'rgba(4,10,18,0.92)',
    border:         '1px solid rgba(0,255,136,0.35)',
    color:          '#e0ffe8',
    fontFamily:     '"Share Tech Mono", monospace',
    fontSize:       '11px',
    lineHeight:     '1.75',
    padding:        '0',
    pointerEvents:  'all',
    display:        'none',
    backdropFilter: 'blur(10px)',
    width:          '280px',
    zIndex:         '20',
    borderRadius:   '4px',
    overflow:       'hidden',
    boxShadow:      '0 4px 32px rgba(0,0,0,0.7)',
  });
  document.body.appendChild(panel);

  // ── Click handler ──────────────────────────────────────────────────────────
  handler.setInputAction(async (click) => {
    const pickedEntities = collectPickedEntities(viewer, click.position);
    if (!pickedEntities.length) {
      // Remove glow from previously selected flight
      if (currentSelectedFlightId) {
        setFlightGlow(currentSelectedFlightId, false);
        currentSelectedFlightId = null;
      }
      clearSatelliteSelection();
      panel.style.display = 'none';
      return;
    }

    const primaryEntity = pickedEntities[0];
    const primaryType = getEntityType(primaryEntity);
    const satelliteEntities = primaryType === 'satellite'
      ? pickedEntities.filter(entity => getEntityType(entity) === 'satellite')
      : [];

    if (satelliteEntities.length) {
      // Remove glow from previously selected flight when selecting satellite
      if (currentSelectedFlightId) {
        setFlightGlow(currentSelectedFlightId, false);
        currentSelectedFlightId = null;
      }

      setSatelliteSelection(primaryEntity, true);
      setSatelliteInfoPanelVisible(true);

      const satellites = satelliteEntities.map(getSatellitePanelData);
      panel.style.display = 'block';
      panel.innerHTML = satelliteListHtml(satellites);
      wireSatelliteButtons(panel, viewer, satellites);
      wirePanelClose(panel);
      return;
    }

    const entity = primaryEntity;
    const props  = entity.properties;
    if (!props) return;

    const type = primaryType;

    if (type === 'flight') {
      clearSatelliteSelection();
      const icao     = (props.icao?.getValue() ?? String(entity.id).replace('flight-','')).toUpperCase();
      const rawCallsign = (props.callsign?.getValue() ?? '').trim();
      // Don't fall back to ICAO hex — use it for display only if no real callsign
      const callsign = rawCallsign || icao;
      const altFt    = props.altFt?.getValue() ?? 0;
      const kts      = props.kts?.getValue()   ?? 0;
      const heading  = props.heading?.getValue() ?? 0;
      const squawk   = props.squawk?.getValue() ?? '';
      const vert     = props.vert?.getValue()   ?? 0;
      const dbFlags  = props.dbFlags?.getValue()  ?? 0;
      const provider = (props.provider?.getValue() ?? 'adsb').toUpperCase();
      const classification = (props.classification?.getValue() ?? null);
      // Live type code from ADS-B feed (e.g. "B38M") — available immediately, no lookup needed
      const liveTypecode = (props.typecode?.getValue() ?? '').toUpperCase() || null;

      // Remove glow from previously selected flight and apply to new one
      if (currentSelectedFlightId && currentSelectedFlightId !== icao.toLowerCase()) {
        setFlightGlow(currentSelectedFlightId, false);
      }
      currentSelectedFlightId = icao.toLowerCase();
      setFlightGlow(currentSelectedFlightId, true);

      // Show a loading state immediately, pre-filled with live ADS-B data we already have
      panel.style.display = 'block';
      renderPanel(panel, { icao, callsign, altFt, kts, heading, squawk, vert, provider, dbFlags, classification,
        typecode: liveTypecode, loading: true }, viewer, entity);

      // Fetch enrichment in background — pass null callsign if we only have the ICAO hex
      const info = await fetchAircraftInfo(icao.toLowerCase(), rawCallsign || null);
      // Keep live typecode if enrichment didn't return one
      if (!info.typecode && liveTypecode) info.typecode = liveTypecode;
      // Persist the enriched typecode into flights.js's cache so Follow can load the
      // correct 3D asset. This survives update cycles (OpenSky never sends typecodes)
      // and entity re-creation if the aircraft scrolls out then back into the viewport.
      if (info.typecode) setEnrichedTypecode(icao.toLowerCase(), info.typecode);
      renderPanel(panel, { icao, callsign, altFt, kts, heading, squawk, vert, provider, dbFlags, classification, ...info }, viewer, entity);

    } else if (type === 'satellite') {
      setSatelliteSelection(entity, true);
      setSatelliteInfoPanelVisible(true);
      const { name, provider, isMilitary, orbitType, application, crewedStatus } = getSatellitePanelData(entity);
      panel.style.display = 'block';
      panel.innerHTML = satelliteHtml({ name, provider, isMilitary, orbitType, application, crewedStatus });
      wireFollowButton(panel, viewer, entity, name, 'satellite');
      wirePanelClose(panel);

    } else if (type === 'zone') {
      if (currentSelectedFlightId) {
        setFlightGlow(currentSelectedFlightId, false);
        currentSelectedFlightId = null;
      }
      clearSatelliteSelection();

      const domain = (props.domain?.getValue() ?? 'flight').toLowerCase();
      const name = props.name?.getValue() ?? 'Unnamed Region';
      const zoneType = props.zoneType?.getValue() ?? null;
      const outageType = props.outageType?.getValue() ?? null;
      const severity = props.severity?.getValue() ?? 'unknown';
      const source = props.source?.getValue() ?? 'Unspecified source';
      const status = props.status?.getValue() ?? 'unknown';
      const activeWindowUtc = props.activeWindowUtc?.getValue() ?? 'Unknown window';
      const summary = props.summary?.getValue() ?? '';
      const asnScope = props.asnScope?.getValue() ?? null;

      panel.style.display = 'block';
      panel.innerHTML = zoneHtml({
        domain,
        name,
        zoneType,
        outageType,
        severity,
        source,
        status,
        activeWindowUtc,
        summary,
        asnScope,
      });
      wirePanelClose(panel);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function collectPickedEntities(viewer, position) {
  const drillResults = viewer.scene.drillPick(position, 16) ?? [];
  const entities = [];
  const seen = new Set();

  for (const result of drillResults) {
    const entity = result?.id;
    if (!entity) continue;
    const key = String(entity.id ?? entity.name ?? entities.length);
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push(entity);
  }

  if (entities.length) return entities;

  const picked = viewer.scene.pick(position);
  if (!Cesium.defined(picked) || !picked.id) return [];
  return [picked.id];
}

function getEntityType(entity) {
  return entity?.properties?.type?.getValue?.() ?? null;
}

function getSatellitePanelData(entity) {
  const props = entity?.properties;
  return {
    entity,
    name: props?.name?.getValue() ?? entity?.id ?? 'Unknown Satellite',
    provider: (props?.provider?.getValue() ?? 'celestrak').toUpperCase(),
    isMilitary: props?.isMilitary?.getValue() ?? false,
    orbitType: props?.orbitType?.getValue() ?? 'Unknown',
    application: props?.application?.getValue() ?? 'Unknown',
    crewedStatus: props?.crewedStatus?.getValue() ?? 'Unknown',
  };
}

// ── Enrichment fetcher ────────────────────────────────────────────────────────

// Aircraft static info cached by ICAO (reg, type, operator — doesn't change)
const aircraftCache = new Map();
// Route cached by callsign (changes per flight — short TTL)
const routeCache    = new Map(); // callsign → { route, operator, ts }
const ROUTE_TTL     = 5 * 60 * 1000; // 5 minutes

async function fetchAircraftInfo(icao, callsign) {
  const info = { registration: null, typecode: null, typeDesc: null, operator: null, route: null, country: null, year: null };

  // ── 1. Static aircraft info (cached permanently per ICAO) ──────────────────
  if (aircraftCache.has(icao)) {
    Object.assign(info, aircraftCache.get(icao));
  } else {
    // Try adsbdb.com first
    try {
      const r = await fetch(`https://api.adsbdb.com/v0/aircraft/${icao}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        const a = d.response?.aircraft;
        if (a) {
          // type_code = ICAO designator (e.g. "B38M"), manufacturer = brand (e.g. "BOEING")
          info.typecode = a.type_code ?? null;
          const mfr     = (a.manufacturer ?? '').trim();
          // typeDesc shows the manufacturer only — typecode already encodes the specific variant.
          // e.g. typeDisplay = "B788 · BOEING" not "B788 · BOEING 787 8"
          info.typeDesc = mfr || null;
          info.registration = a.registration ?? null;
          info.operator     = a.registered_owner ?? null;
          info.country      = a.registered_owner_country_iso_name ?? null;
          info.year         = a.year_built ?? null;
        }
      }
    } catch { /* ignore */ }

    // Fallback: hexdb.io — run if we're missing registration OR type code
    if (!info.registration || !info.typecode) {
      try {
        const r = await fetch(`https://hexdb.io/api/v1/aircraft/${icao}`, { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const d = await r.json();
          if (!info.registration) info.registration = d.Registration    ?? null;
          if (!info.typecode)     info.typecode     = d.ICAOTypeCode    ?? null;
          // Build typeDesc from hexdb Type field if not already set
          const hexType = d.Type ?? null;
          if (!info.typeDesc && hexType) info.typeDesc = hexType;
          if (!info.operator)  info.operator   = d.RegisteredOwners ?? null;
          if (!info.country)   info.country    = d.Country ?? null;
        }
      } catch { /* ignore */ }
    }

    aircraftCache.set(icao, { ...info });
  }

  // ── 2. Live route lookup by callsign (short TTL cache) ────────────────────
  // Routes change per flight so we cache by callsign with a 5-min TTL,
  // NOT by ICAO (which would show yesterday's route for today's flight).
  // Only attempt lookup for proper airline-style callsigns (e.g. UAL123, BAW456)
  // Skip tail numbers and other non-airline identifiers
  if (callsign && callsign.length >= 4) {
    // Validate callsign is in airline format: 2-3 letters + 1-4 digits (+ optional letter)
    // Valid: UAL123, BAW456, RYR22A, Invalid: 405LP, N404LP, TEST
    // Airline callsigns are 2-3 letters + 1-4 digits + optional suffix letter.
    // Also reject 6-char hex-looking strings (e.g. ICAO addresses like CEF05F)
    // by requiring at least one non-hex digit (G-Z range) in the letter prefix.
    const isAirlineCallsign = /^[A-Z]{2,3}\d{1,4}[A-Z]{0,2}$/.test(callsign)
      && callsign.length <= 9
      && !/^[0-9A-F]{6}$/i.test(callsign);
    
    if (isAirlineCallsign) {
      const cached = routeCache.get(callsign);
      if (cached && Date.now() - cached.ts < ROUTE_TTL) {
        info.route    = cached.route;
        if (!info.operator) info.operator = cached.operator;
      } else {
        try {
          const r = await fetch(`https://api.adsbdb.com/v0/callsign/${callsign}`, { signal: AbortSignal.timeout(4000) });
          if (r.ok) {
            const d  = await r.json();
            const fl = d.response?.flightroute;
            if (fl) {
              const orig = fl.origin?.iata_code      ?? fl.origin?.icao_code      ?? '';
              const dest = fl.destination?.iata_code ?? fl.destination?.icao_code ?? '';
              info.route = (orig && dest) ? `${orig} → ${dest}` : null;
              const airline = fl.airline?.name ?? null;
              if (!info.operator && airline) info.operator = airline;
              routeCache.set(callsign, { route: info.route, operator: airline, ts: Date.now() });
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  return info;
}

// ── Panel renderer ────────────────────────────────────────────────────────────

function renderPanel(panel, data, viewer, entity) {
  const {
    icao, callsign, altFt, kts, heading, squawk, vert, provider, dbFlags, classification,
    registration, typecode, typeDesc, operator, route, country, year, loading
  } = data;

  const altFtStr   = altFt  ? `${Math.round(altFt).toLocaleString()} ft`  : '–';
  const altKm      = altFt  ? `${(altFt*0.3048/1000).toFixed(1)} km`      : '';
  const spdStr     = kts    ? `${Math.round(kts)} kts · ${Math.round(kts*1.852)} km/h` : '–';
  const hdgStr     = heading ? `${Math.round(heading)}°`                  : '–';
  const vsStr      = vert   ? `${vert > 0 ? '↑' : '↓'} ${Math.abs(Math.round(vert)).toLocaleString()} ft/min` : 'level';
  const acColor    = aircraftClassColor(classification, dbFlags, callsign);
  const acLabel    = aircraftClassLabel(classification, dbFlags, callsign);
  const typeDisplay = typecode
    ? (typeDesc ? `${typecode} · ${typeDesc}` : typecode)
    : typeDesc;
  const has3dModel = hasAssetModel(typecode);
  const aircraftIcon = has3dModel ? '3D ✈' : '✈';

  const row = (label, val, dim = false) => val
    ? `<tr><td style="opacity:0.5;padding-right:12px;white-space:nowrap">${label}</td><td style="${dim?'opacity:0.65':''}font-weight:500">${val}</td></tr>`
    : '';

  const adsbLolLink = `https://adsb.lol/?icao=${icao.toLowerCase()}`;
  const fr24Link    = registration ? `https://www.flightradar24.com/${registration}` : null;

  panel.innerHTML = `
    <div style="background:rgba(0,0,0,0.3);padding:12px 16px;border-bottom:1px solid ${acColor}44;border-left:3px solid ${acColor}">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:20px;color:${acColor}">${aircraftIcon}</span>
        <div>
          <div style="font-size:15px;font-weight:bold;letter-spacing:0.12em;color:#fff">
            ${callsign !== icao ? callsign : (registration ?? icao)}
          </div>
          <div style="opacity:0.55;font-size:10px;margin-top:1px">${icao} ${registration ? '· ' + registration : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-left:auto">
          <span style="font-size:9px;font-weight:bold;color:${acColor};border:1px solid ${acColor}55;padding:2px 6px;border-radius:3px;letter-spacing:0.1em">${acLabel}</span>
          <span style="cursor:pointer;opacity:0.5;font-size:14px" id="panel-close">✕</span>
        </div>
      </div>
    </div>

    <div style="padding:10px 16px">
      ${loading ? `<div style="opacity:0.45;font-size:10px;margin-bottom:8px">Fetching aircraft data...</div>` : ''}

      <table style="width:100%;border-collapse:collapse;font-size:11px">
        ${row('Type',     typeDisplay)}
        ${row('Operator', operator)}
        ${row('Country',  country)}
        ${row('Filed Route', route)}
        ${row('Year',     year)}
      </table>

      <div style="margin:10px 0;border-top:1px solid rgba(0,255,136,0.1)"></div>

      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <tr>
          <td style="opacity:0.5;padding-right:12px">Altitude</td>
          <td><span style="font-weight:bold">${altFtStr}</span>${altKm ? ` <span style="opacity:0.5">${altKm}</span>` : ''}</td>
        </tr>
        ${row('Speed',    spdStr)}
        ${row('Heading',  hdgStr)}
        ${row('Vert. Rate', vsStr)}
        ${row('Squawk',   squawk || null)}
      </table>

      <div style="margin:10px 0;border-top:1px solid rgba(0,255,136,0.1)"></div>

      <div style="display:flex;gap:8px;font-size:10px;align-items:center">
        <a href="${adsbLolLink}" target="_blank" style="color:#00ff88;opacity:0.7;text-decoration:none">
          ↗ adsb.lol
        </a>
        ${fr24Link ? `<a href="${fr24Link}" target="_blank" style="color:#00ff88;opacity:0.7;text-decoration:none">↗ FlightRadar24</a>` : ''}
        <span style="margin-left:auto;opacity:0.3;font-size:9px">LIVE · ${provider}</span>
      </div>

      <div style="margin-top:10px">
        <button id="follow-btn" style="
          width:100%;padding:6px 0;border-radius:3px;cursor:pointer;
          font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:0.1em;
          border:1px solid ${acColor}66;background:transparent;color:${acColor}bb;
          transition:all 0.15s ease;
        ">◎ FOLLOW</button>
      </div>
    </div>
  `;

  wirePanelClose(panel);
  wireFollowButton(panel, viewer, entity, callsign, 'flight');
}

// ── Shared panel helpers ──────────────────────────────────────────────────────

function wirePanelClose(panel) {
  document.getElementById('panel-close')?.addEventListener('click', () => {
    stopFollow();
    // Remove glow from selected flight
    if (currentSelectedFlightId) {
      setFlightGlow(currentSelectedFlightId, false);
      currentSelectedFlightId = null;
    }
    clearSatelliteSelection();
    panel.style.display = 'none';
  });
}

function wireFollowButton(panel, viewer, entity, label, type) {
  const btn = document.getElementById('follow-btn');
  if (!btn) return;

  // Extract the raw icao hex from entity id (strip 'flight-' prefix)
  const icaoHex = type === 'flight'
    ? String(entity.id).replace(/^flight-/, '')
    : null;

  // Reflect current follow state on open
  const alreadyFollowing = isFollowing() && followingLabel() === label;
  setFollowBtnState(btn, alreadyFollowing);

  btn.addEventListener('click', () => {
    if (isFollowing() && followingLabel() === label) {
      // ── UNFOLLOW ──────────────────────────────────────────────────────────
      if (icaoHex) setFollowMode(icaoHex, false);
      stopFollow(false, true);
      setFollowBtnState(btn, false);
    } else {
      // ── FOLLOW ────────────────────────────────────────────────────────────
      if (icaoHex) setFollowMode(icaoHex, true);
      if (type === 'satellite') setSatelliteSelection(entity, true);

      followEntity(viewer, entity, {
        label,
        type,
        onStop: () => {
          // Called if follow is cancelled by user panning away
          if (icaoHex) setFollowMode(icaoHex, false);
          const b = document.getElementById('follow-btn');
          if (b) setFollowBtnState(b, false);
        },
      });
      setFollowBtnState(btn, true);
    }
  });
}

function wireSatelliteButtons(panel, viewer, satellites) {
  const buttons = panel.querySelectorAll('[data-satellite-index]');
  buttons.forEach((btn) => {
    const index = Number.parseInt(btn.dataset.satelliteIndex ?? '', 10);
    const sat = satellites[index];
    if (!sat) return;

    const alreadyFollowing = isFollowing() && followingLabel() === sat.name;
    setFollowBtnState(btn, alreadyFollowing);

    btn.addEventListener('click', () => {
      setSatelliteSelection(sat.entity, true);

      if (isFollowing() && followingLabel() === sat.name) {
        stopFollow(false, true);
        setFollowBtnState(btn, false);
        return;
      }

      followEntity(viewer, sat.entity, {
        label: sat.name,
        type: 'satellite',
        onStop: () => {
          const nextBtn = panel.querySelector(`[data-satellite-index="${index}"]`);
          if (nextBtn) setFollowBtnState(nextBtn, false);
        },
      });

      buttons.forEach(otherBtn => setFollowBtnState(otherBtn, otherBtn === btn));
    });
  });
}

function setFollowBtnState(btn, active) {
  if (active) {
    btn.textContent    = '⊙ UNFOLLOW';
    btn.style.background  = 'rgba(255,80,80,0.12)';
    btn.style.color       = '#ff6060';
    btn.style.borderColor = '#ff606066';
  } else {
    btn.textContent    = '◎ FOLLOW';
    btn.style.background  = 'transparent';
    btn.style.color       = '#00ff8899';
    btn.style.borderColor = '#00ff8844';
  }
}

function satelliteHtml({ name, provider, isMilitary, orbitType, application, crewedStatus }) {
  const militaryBadge = isMilitary ? '<span style="color:#ff3b30;font-weight:bold">[MILITARY]</span> ' : '';
  return `
    <div style="background:rgba(0,170,255,0.1);padding:12px 16px;border-bottom:1px solid rgba(0,170,255,0.2)">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:18px">◈</span>
        <div style="font-size:14px;font-weight:bold;letter-spacing:0.1em;color:#00aaff">${militaryBadge}${name}</div>
        <div style="margin-left:auto;cursor:pointer;opacity:0.5" id="panel-close">✕</div>
      </div>
    </div>
    <div style="padding:12px 16px;font-size:11px">
      <div style="opacity:0.6;margin-bottom:10px">
        Orbital tracking active<br>
        Orbit: <span style="opacity:0.9">${orbitType}</span><br>
        Application: <span style="opacity:0.9">${application}</span><br>
        Crewed: <span style="opacity:0.9">${crewedStatus}</span><br>
        <span style="opacity:0.5;font-size:9px">TLE · ${provider}</span>
      </div>
      <button id="follow-btn" style="
        width:100%;padding:6px 0;border-radius:3px;cursor:pointer;
        font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:0.1em;
        border:1px solid #00aaff44;background:transparent;color:#00aaffbb;
        transition:all 0.15s ease;
      ">◎ FOLLOW</button>
    </div>
  `;
}

function satelliteListHtml(satellites) {
  const countLabel = satellites.length === 1 ? '1 OBJECT' : `${satellites.length} OBJECTS`;
  const entries = satellites.map((sat, index) => {
    const militaryBadge = sat.isMilitary ? '<span style="color:#ff3b30;font-weight:bold">[MILITARY]</span> ' : '';
    return `
      <div style="padding:12px 16px;${index ? 'border-top:1px solid rgba(0,170,255,0.12);' : ''}">
        <div style="font-size:13px;font-weight:bold;letter-spacing:0.08em;color:#eafcff">${militaryBadge}${sat.name}</div>
        <div style="opacity:0.62;margin-top:6px;line-height:1.7">
          Orbit: <span style="opacity:0.92">${sat.orbitType}</span><br>
          Application: <span style="opacity:0.92">${sat.application}</span><br>
          Crewed: <span style="opacity:0.92">${sat.crewedStatus}</span><br>
          <span style="opacity:0.5;font-size:9px">TLE · ${sat.provider}</span>
        </div>
        <button
          data-satellite-index="${index}"
          style="
            width:100%;padding:6px 0;margin-top:10px;border-radius:3px;cursor:pointer;
            font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:0.1em;
            border:1px solid #00aaff44;background:transparent;color:#00aaffbb;
            transition:all 0.15s ease;
          "
        >◎ FOLLOW</button>
      </div>
    `;
  }).join('');

  return `
    <div style="background:rgba(0,170,255,0.1);padding:12px 16px;border-bottom:1px solid rgba(0,170,255,0.2)">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:18px">◈</span>
        <div>
          <div style="font-size:14px;font-weight:bold;letter-spacing:0.1em;color:#00aaff">${countLabel}</div>
          <div style="opacity:0.5;font-size:9px;margin-top:2px">OVERLAPPING SATELLITES AT THIS PICK</div>
        </div>
        <div style="margin-left:auto;cursor:pointer;opacity:0.5" id="panel-close">✕</div>
      </div>
    </div>
    <div style="max-height:440px;overflow:auto">
      ${entries}
    </div>
  `;
}

function zoneHtml({
  domain,
  name,
  zoneType,
  outageType,
  severity,
  source,
  status,
  activeWindowUtc,
  summary,
  asnScope,
}) {
  const isInternet = domain === 'internet';
  const zoneTypeNorm = String(zoneType ?? '').toLowerCase();
  const sourceNorm = String(source ?? '').toLowerCase();
  const isGps = zoneTypeNorm.includes('gps') || zoneTypeNorm.includes('gnss');
  const isSafeAirspace = !isInternet && !isGps && (sourceNorm.includes('safe airspace') || zoneTypeNorm === 'safeairspace');
  const isFaaTfr = !isInternet && !isGps && !isSafeAirspace;
  const safeAirspaceAccent = String(severity ?? '').toLowerCase() === 'high'
    ? '#ea283c'
    : (String(severity ?? '').toLowerCase() === 'medium' ? '#ff8b00' : '#ffce00');
  const accent = isInternet
    ? '#00b9ff'
    : (isGps ? '#ffd54a' : (isSafeAirspace ? safeAirspaceAccent : '#ff6b57'));
  const icon = isInternet
    ? '⌁'
    : (isGps ? '⌖' : (isSafeAirspace ? '▲' : '⛔'));
  const title = isInternet
    ? 'INTERNET OUTAGE'
    : (isGps ? 'GPS INTERFERENCE' : (isSafeAirspace ? 'SAFE AIRSPACE RISK' : 'FAA NO FLY ZONE'));
  const typedValue = isInternet
    ? (outageType ?? 'unknown').replaceAll('-', ' ')
    : (isGps
      ? 'GPS INTERFERENCE'
      : (isSafeAirspace
        ? (String(severity ?? '').toLowerCase() === 'high'
          ? 'RISK LEVEL ONE - DO NOT FLY'
          : (String(severity ?? '').toLowerCase() === 'medium'
            ? 'RISK LEVEL TWO - DANGER EXISTS'
            : 'RISK LEVEL THREE - CAUTION'))
        : 'RESTRICTED AIRSPACE'));
  const badgeLabel = isSafeAirspace
    ? (String(severity ?? '').toLowerCase() === 'high'
      ? 'LEVEL 1'
      : (String(severity ?? '').toLowerCase() === 'medium' ? 'LEVEL 2' : 'LEVEL 3'))
    : String(severity).toUpperCase();
  const statusLabel = isSafeAirspace ? String(status ?? 'active') : String(status).toUpperCase();
  const summaryText = String(summary ?? '');
  const cleanedSummary = isGps
    ? summaryText
      .replace(/\b\d+\s+suspect aircraft out of\s+\d+\s+observed aircraft in this H3 cell\.?/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    : summaryText;

  return `
    <div style="background:rgba(0,0,0,0.3);padding:12px 16px;border-bottom:1px solid ${accent}44;border-left:3px solid ${accent}">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:18px;color:${accent}">${icon}</span>
        <div>
          <div style="font-size:13px;font-weight:bold;letter-spacing:0.08em;color:#fff">${name}</div>
          <div style="opacity:0.6;font-size:9px;margin-top:1px">${title}</div>
        </div>
        <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
          <span style="font-size:9px;font-weight:bold;color:${accent};border:1px solid ${accent}55;padding:2px 6px;border-radius:3px;letter-spacing:0.1em">${badgeLabel}</span>
          <span style="cursor:pointer;opacity:0.5;font-size:14px" id="panel-close">✕</span>
        </div>
      </div>
    </div>
    <div style="padding:10px 16px">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <tr><td style="opacity:0.5;padding-right:12px;white-space:nowrap">Type</td><td style="font-weight:500">${typedValue}</td></tr>
        <tr><td style="opacity:0.5;padding-right:12px;white-space:nowrap">Status</td><td style="font-weight:500">${statusLabel}</td></tr>
        <tr><td style="opacity:0.5;padding-right:12px;white-space:nowrap">Window (UTC)</td><td style="font-weight:500">${activeWindowUtc}</td></tr>
        ${asnScope ? `<tr><td style="opacity:0.5;padding-right:12px;white-space:nowrap">ASN Scope</td><td style="font-weight:500">${asnScope}</td></tr>` : ''}
      </table>

      <div style="margin:10px 0;border-top:1px solid rgba(0,255,136,0.1)"></div>

      <div style="font-size:10px;line-height:1.7;opacity:0.88">
        ${cleanedSummary ? `<div style="margin-bottom:7px">${cleanedSummary}</div>` : ''}
        <div style="opacity:0.58">Source: ${source}</div>
      </div>
    </div>
  `;
}

// Classification colors — must match flights.js
function normalizeAircraftClassification(classification, dbFlags, callsign) {
  const normalized = (classification ?? '').toLowerCase();
  if (normalized === 'military' || normalized === 'commercial' || normalized === 'emergency' || normalized === 'ground') {
    return normalized;
  }
  const sq = String(classification ?? '').trim();
  if (sq === '7500' || sq === '7600' || sq === '7700') return 'emergency';
  if ((dbFlags ?? 0) & 1) return 'military';
  const cs = (callsign ?? '').toUpperCase();
  if (/^[A-Z]{2,3}\d{1,4}[A-Z]?$/.test(cs)) return 'commercial';
  return 'commercial';
}

function aircraftClassColor(classification, dbFlags, callsign) {
  const c = normalizeAircraftClassification(classification, dbFlags, callsign);
  if (c === 'emergency') return '#ef4444';
  if (c === 'military') return '#f97316';
  if (c === 'ground') return '#6b7280';
  return '#60a5fa';
}
function aircraftClassLabel(classification, dbFlags, callsign) {
  return normalizeAircraftClassification(classification, dbFlags, callsign).toUpperCase();
}
// stub kept for any leftover references
function altitudeColor() { return '#00e676'; }
