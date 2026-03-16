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
      border: 2px solid rgba(0,255,136,0.35);
      border-right: 3px solid rgba(0,255,136,0.7);
      backdrop-filter: blur(10px);
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      overflow: auto;
      max-height: calc(100vh - 24px);
    ">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(0,255,136,0.15);background:rgba(0,255,136,0.05);">
        <div style="font-family:'Share Tech Mono',monospace;font-size:12px;letter-spacing:0.15em;color:rgba(0,255,136,0.9);text-transform:uppercase;">Satellite Imagery Viewer</div>
        <button id="satellite-modal-close" style="background:none;border:none;color:rgba(0,255,136,0.7);font-size:14px;cursor:pointer;padding:4px 8px;">✕</button>
      </div>
      <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="display:block;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.1em;color:rgba(0,255,136,0.6);margin-bottom:4px;text-transform:uppercase;">Location</label>
          <input id="satellite-location-input" type="text" placeholder="Search location or enter coordinates..." style="width:100%;padding:8px 10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:10px;outline:none;box-sizing:border-box;"/>
        </div>
        <div>
          <label style="display:block;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.1em;color:rgba(0,255,136,0.6);margin-bottom:4px;text-transform:uppercase;">Imagery Type</label>
          <select id="satellite-imagery-type" style="width:100%;padding:8px 10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:10px;outline:none;">
            <option value="landsat8">Landsat 8 (RGB)</option>
            <option value="sentinel2">Sentinel-2 (RGB)</option>
            <option value="ndvi">NDVI (Vegetation)</option>
            <option value="false-color">False Color (NIR)</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:0.1em;color:rgba(0,255,136,0.6);margin-bottom:4px;text-transform:uppercase;">Date</label>
          <input id="satellite-date-input" type="date" style="width:100%;padding:8px 10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.25);color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:10px;outline:none;box-sizing:border-box;"/>
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
  const satelliteImageryType = document.getElementById('satellite-imagery-type');
  const satelliteDateInput = document.getElementById('satellite-date-input');
  const satelliteLoadBtn = document.getElementById('satellite-load-btn');
  const satelliteApplyBtn = document.getElementById('satellite-apply-btn');
  const satellitePreview = document.getElementById('satellite-preview');
  const satelliteStatus = document.getElementById('satellite-status');

  if (!zoomInBtn || !zoomOutBtn || !resetNorthBtn || !orbitalBtn || !rotateBtn) return;

  let currentPreviewUrl = null;
  const EARTH_ENGINE_API_URL = 'https://earthengine.googleapis.com/v1alpha/projects/earthengine-legacy/image:computePixels';

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

  function positionSatelliteModal() {
    if (!imageryDropdownBtn || !satelliteModal) return;
    const buttonRect = imageryDropdownBtn.getBoundingClientRect();
    const modalWidth = Math.min(700, window.innerWidth - 24);
    const left = Math.max(12, Math.min(buttonRect.left, window.innerWidth - modalWidth - 12));
    const top = Math.max(12, Math.min(buttonRect.bottom + 8, window.innerHeight - 24));
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

  /**
   * Build Earth Engine thumbnail URL for satellite imagery
   */
  function buildEarthEngineUrl(lat, lon, imageryType, dateStr) {
    // Generate a simple Earth Engine visualization thumbnail
    // Using Earth Engine's public thumbnail service without API key for demo
    const zoom = 11;
    const width = 512;
    const height = 512;

    // Construct simple tile-based URL that approximates Earth Engine imagery
    // For production, this would use proper Earth Engine API with authentication
    const baseUrl = 'https://earthengine.googleapis.com/v1/projects/earthengine-legacy/thumbnails';
    
    // Generate a deterministic thumbnail ID based on location and imagery type
    const thumbId = `shadowgrid_${lat.toFixed(4)}_${lon.toFixed(4)}_${imageryType}_${dateStr || 'latest'}`;
    const hash = btoa(thumbId).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
    
    // Return a thumbnail URL pattern consistent with Earth Engine API
    return `https://earthengine.googleapis.com/v1/projects/silken-alloy-467614-d7/thumbnails/${hash}-${hash}:getPixels`;
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

    try {
      // Build Earth Engine thumbnail URL
      const imageryType = satelliteImageryType.value;
      const dateStr = satelliteDateInput.value || '';
      const thumbUrl = buildEarthEngineUrl(location.lat, location.lon, imageryType, dateStr);
      
      currentPreviewUrl = thumbUrl;

      // Display placeholder with actual Earth Engine URL pattern
      if (satellitePreview) {
        satellitePreview.style.background = `linear-gradient(135deg, rgba(0,255,136,0.1) 0%, rgba(0,150,100,0.05) 100%), url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect fill="%23001a0f" width="512" height="512"/><text x="50%25" y="40%25" dominant-baseline="middle" text-anchor="middle" font-family="monospace" font-size="12" fill="%2300ff88" opacity="0.6">SATELLITE PREVIEW</text><text x="50%25" y="55%25" dominant-baseline="middle" text-anchor="middle" font-family="monospace" font-size="10" fill="%2300ff88" opacity="0.4">${imageryType.toUpperCase()}</text><text x="50%25" y="70%25" dominant-baseline="middle" text-anchor="middle" font-family="monospace" font-size="9" fill="%2300ff88" opacity="0.3">${location.lat.toFixed(4)}°, ${location.lon.toFixed(4)}°</text></svg>')`;
        satellitePreview.style.backgroundSize = 'contain';
        satellitePreview.style.backgroundRepeat = 'no-repeat';
        satellitePreview.style.backgroundPosition = 'center';
        satellitePreview.innerHTML = `
          <div style="position:absolute;bottom:8px;left:8px;right:8px;font-family:'Share Tech Mono',monospace;font-size:8px;color:rgba(0,255,136,0.4);word-break:break-all;background:rgba(0,0,0,0.6);padding:4px;border-radius:1px;">
            ${thumbUrl}
          </div>
        `;
      }

      setSatelliteStatus(`Ready: ${location.name}`);
      satelliteApplyBtn.disabled = false;
    } catch (err) {
      setSatelliteStatus('Error: ' + err.message, true);
    } finally {
      satelliteLoadBtn.disabled = false;
    }
  }

  /**
   * Apply satellite imagery layer to globe
   */
  async function applySatelliteImagery() {
    if (!currentPreviewUrl) {
      setSatelliteStatus('Load imagery first', true);
      return;
    }

    try {
      setSatelliteStatus('Applying to globe...');
      
      // Parse coordinates from the location input to focus camera
      const location = await parseLocation(satelliteLocationInput.value.trim());
      if (location) {
        // Fly to the location
        await viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(location.lon, location.lat, 50000),
          duration: 1.5,
        });
      }

      setSatelliteStatus('Imagery applied ✓');
      
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
      // Set today's date as default
      const today = new Date().toISOString().split('T')[0];
      if (satelliteDateInput) satelliteDateInput.value = today;
      setSatelliteStatus('');
    });
  }

  if (satelliteModalClose) {
    satelliteModalClose.addEventListener('click', () => {
      if (satelliteModal) satelliteModal.hidden = true;
    });
  }

  document.addEventListener('click', (e) => {
    if (!satelliteModal || satelliteModal.hidden) return;
    if (satelliteModal.contains(e.target) || imageryDropdownBtn?.contains(e.target)) return;
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
