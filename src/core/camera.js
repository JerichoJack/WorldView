/**
 * File: src/core/camera.js
 * Purpose: Initializes startup camera position and exposes shared camera helpers.
 * Notes: Supports optional IP-based startup geolocation with env fallbacks.
 * Last updated: 2026-03-13
 */

import * as Cesium from 'cesium';

const DEFAULT_LON      = parseFloat(import.meta.env.VITE_DEFAULT_LON ?? '-97.7431');
const DEFAULT_LAT      = parseFloat(import.meta.env.VITE_DEFAULT_LAT ?? '30.2672');
const DEFAULT_ALT      = parseFloat(import.meta.env.VITE_DEFAULT_ALT ?? '150000');
const USE_IP_LOCATION  = (import.meta.env.VITE_DEFAULT_USE_IP_LOCATION ?? 'true') !== 'false';

const _controlState = new WeakMap();
const _autoRotateState = new WeakMap();

const ORBIT_ROTATE_EVENTS = [
  Cesium.CameraEventType.LEFT_DRAG,
  Cesium.CameraEventType.RIGHT_DRAG,
];

const ORBIT_TILT_EVENTS = [
  Cesium.CameraEventType.RIGHT_DRAG,
];

function cloneEventTypes(v) {
  if (!v) return v;
  if (Array.isArray(v)) {
    return v.map((evt) => (typeof evt === 'object' && evt !== null ? { ...evt } : evt));
  }
  return (typeof v === 'object' && v !== null) ? { ...v } : v;
}

function captureControlState(viewer) {
  const ctrl = viewer?.scene?.screenSpaceCameraController;
  if (!ctrl) return null;
  return {
    rotateEventTypes: cloneEventTypes(ctrl.rotateEventTypes),
    tiltEventTypes: cloneEventTypes(ctrl.tiltEventTypes),
    translateEventTypes: cloneEventTypes(ctrl.translateEventTypes),
    lookEventTypes: cloneEventTypes(ctrl.lookEventTypes),
    enableTranslate: ctrl.enableTranslate,
  };
}

function ensureControlState(viewer) {
  if (!_controlState.has(viewer)) {
    _controlState.set(viewer, {
      base: captureControlState(viewer),
      orbital: false,
    });
  }
  return _controlState.get(viewer);
}

function clampZoomAmount(amount) {
  return Math.max(50, Math.min(amount, 1_000_000));
}

// ── IP geolocation ────────────────────────────────────────────────────────────
// Tries ipapi.co (free, no key), falls back to env defaults.
// Skipped entirely when VITE_DEFAULT_USE_IP_LOCATION=false.

async function getStartupLocation() {
  if (!USE_IP_LOCATION) {
    console.info(`[Camera] IP location disabled — using default (${DEFAULT_LAT.toFixed(2)}, ${DEFAULT_LON.toFixed(2)})`);
    return { lon: DEFAULT_LON, lat: DEFAULT_LAT };
  }
  try {
    const res = await fetch('https://ipapi.co/json/', {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`ipapi ${res.status}`);
    const d = await res.json();
    if (d.latitude && d.longitude) {
      console.info(`[Camera] IP location: ${d.city ?? ''}, ${d.country_name ?? ''} (${d.latitude.toFixed(2)}, ${d.longitude.toFixed(2)})`);
      return { lon: d.longitude, lat: d.latitude };
    }
  } catch (err) {
    console.warn('[Camera] IP geolocation failed, using defaults:', err.message);
  }
  return { lon: DEFAULT_LON, lat: DEFAULT_LAT };
}

export async function initCamera(viewer) {
  const camera = viewer.camera;

  // ── Initial position — IP location or hardcoded default ─────────────────
  const { lon, lat } = await getStartupLocation();

  camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, DEFAULT_ALT),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch:   Cesium.Math.toRadians(-90),
      roll:    0.0,
    },
    duration: 3.0,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });

  // Coord readouts are now owned entirely by HUD.js — nothing to wire here.
  ensureControlState(viewer);
  return camera;
}

/**
 * Fly the camera to a named city or explicit coordinates.
 * @param {Cesium.Viewer} viewer
 * @param {{ lon: number, lat: number, alt?: number, heading?: number, pitch?: number }} opts
 */
export function flyTo(viewer, { lon, lat, alt = 1500, heading = 0, pitch = -90 }) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
    orientation: {
      heading: Cesium.Math.toRadians(heading),
      pitch:   Cesium.Math.toRadians(pitch),
      roll:    0,
    },
    duration: 2.5,
    easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
  });
}

export function zoomInCamera(viewer, ratio = 0.18) {
  const camera = viewer?.camera;
  if (!camera) return;
  const height = camera.positionCartographic?.height ?? DEFAULT_ALT;
  camera.zoomIn(clampZoomAmount(height * ratio));
}

export function zoomOutCamera(viewer, ratio = 0.22) {
  const camera = viewer?.camera;
  if (!camera) return;
  const height = camera.positionCartographic?.height ?? DEFAULT_ALT;
  camera.zoomOut(clampZoomAmount(height * ratio));
}

export function resetNorthCamera(viewer) {
  const camera = viewer?.camera;
  if (!camera) return;
  const destination = Cesium.Cartesian3.clone(camera.positionWC);
  camera.flyTo({
    destination,
    orientation: {
      heading: 0,
      pitch: camera.pitch,
      roll: 0,
    },
    duration: 0.8,
    easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
  });
}

export function setOrbitalMode(viewer, enabled) {
  const ctrl = viewer?.scene?.screenSpaceCameraController;
  if (!ctrl) return false;

  const state = ensureControlState(viewer);
  if (!state?.base) return false;

  if (enabled) {
    ctrl.rotateEventTypes = cloneEventTypes(ORBIT_ROTATE_EVENTS);
    ctrl.tiltEventTypes = cloneEventTypes(ORBIT_TILT_EVENTS);
    ctrl.translateEventTypes = [];
    ctrl.enableTranslate = false;
    state.orbital = true;
    window.dispatchEvent(new CustomEvent('shadowgrid:camera-orbital-mode', {
      detail: { enabled: true },
    }));
    return true;
  }

  ctrl.rotateEventTypes = cloneEventTypes(state.base.rotateEventTypes);
  ctrl.tiltEventTypes = cloneEventTypes(state.base.tiltEventTypes);
  ctrl.translateEventTypes = cloneEventTypes(state.base.translateEventTypes);
  ctrl.lookEventTypes = cloneEventTypes(state.base.lookEventTypes);
  ctrl.enableTranslate = state.base.enableTranslate;
  state.orbital = false;
  window.dispatchEvent(new CustomEvent('shadowgrid:camera-orbital-mode', {
    detail: { enabled: false },
  }));
  return false;
}

export function isOrbitalModeEnabled(viewer) {
  return !!_controlState.get(viewer)?.orbital;
}

export function setAutoRotate(viewer, enabled, speedDegPerSec = 2.8) {
  const scene = viewer?.scene;
  if (!scene) return false;

  const existing = _autoRotateState.get(viewer);
  if (existing?.callback) {
    scene.preRender.removeEventListener(existing.callback);
  }

  if (!enabled) {
    _autoRotateState.set(viewer, { enabled: false, callback: null, lastTs: 0, speedDegPerSec });
    return false;
  }

  const state = {
    enabled: true,
    callback: null,
    lastTs: 0,
    speedDegPerSec,
  };

  state.callback = () => {
    const now = performance.now();
    if (!state.lastTs) {
      state.lastTs = now;
      return;
    }
    const dtSec = Math.min((now - state.lastTs) / 1000, 0.2);
    state.lastTs = now;

    if (viewer.trackedEntity) return;
    const radians = Cesium.Math.toRadians(state.speedDegPerSec) * dtSec;
    viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -radians);
  };

  scene.preRender.addEventListener(state.callback);
  _autoRotateState.set(viewer, state);
  return true;
}

export function isAutoRotateEnabled(viewer) {
  return !!_autoRotateState.get(viewer)?.enabled;
}

/** Named city presets */
export const CITIES = {
  austin:  { lon: -97.7431, lat: 30.2672, alt:  8000 },
  london:  { lon:  -0.1276, lat: 51.5074, alt:  8000 },
  nyc:     { lon: -74.0060, lat: 40.7128, alt:  8000 },
  tokyo:   { lon: 139.6917, lat: 35.6895, alt:  8000 },
  dubai:   { lon:  55.2708, lat: 25.2048, alt:  8000 },
  globe:   { lon:   0,      lat: 20,      alt: 20_000_000 },
};