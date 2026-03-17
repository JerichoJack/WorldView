/**
 * File: src/core/serverSnapshot.js
 * Purpose: Client-side manager for server-heavy world snapshot polling and fanout.
 * Notes: Publishes diagnostics, throttles refresh, and updates active layer state.
 * Last updated: 2026-03-13
 */

import * as Cesium from 'cesium';

const SERVER_HEAVY_MODE = (import.meta.env.VITE_SERVER_HEAVY_MODE ?? 'false').toLowerCase() === 'true';
const WORLD_SNAPSHOT_URL = '/api/localproxy/api/world/snapshot';
const SNAPSHOT_POLL_MS = 2_000;
const CAMERA_THROTTLE_MS = 350;
const SATELLITE_MAX_OBJECTS = Math.max(parseInt(import.meta.env.VITE_SATELLITE_MAX_OBJECTS ?? '99999', 10) || 99999, 1);
const CAMERA_MAX_OBJECTS = Math.max(parseInt(import.meta.env.VITE_SERVER_CAMERA_MAX_OBJECTS ?? '3000', 10) || 3000, 1);
const SATELLITE_MAX_PER_CATEGORY = Math.max(parseInt(import.meta.env.VITE_SATELLITE_MAX_PER_CATEGORY ?? `${SATELLITE_MAX_OBJECTS}`, 10) || SATELLITE_MAX_OBJECTS, 1);

let viewer = null;
let pollTimer = null;
let cameraTimer = null;
let inFlightPromise = null;
let lastPayload = null;
let lastError = null;

const subscribers = new Map();
const activeLayers = new Set();
const satelliteSnapshotConfig = {
  categories: [],
  perCategory: SATELLITE_MAX_PER_CATEGORY,
};

function publishDiagnostics(payload = null, error = null) {
  if (typeof window === 'undefined') return;

  const now = Date.now();
  const data = {
    enabled: SERVER_HEAVY_MODE,
    ts: now,
    include: [...activeLayers].sort(),
    mode: payload?.mode ?? lastPayload?.mode ?? 'unknown',
    providers: payload?.diagnostics?.providers ?? lastPayload?.diagnostics?.providers ?? {},
    cache: payload?.diagnostics?.cache ?? lastPayload?.diagnostics?.cache ?? {},
    snapshotAgesMs: {
      flights: Number.isFinite(payload?.flights?.ts) ? Math.max(0, now - payload.flights.ts) : null,
      satellites: Number.isFinite(payload?.satellites?.ts) ? Math.max(0, now - payload.satellites.ts) : null,
      traffic: Number.isFinite(payload?.traffic?.ts) ? Math.max(0, now - payload.traffic.ts) : null,
      marine: Number.isFinite(payload?.marine?.ts) ? Math.max(0, now - payload.marine.ts) : null,
      cameras: Number.isFinite(payload?.cameras?.ts) ? Math.max(0, now - payload.cameras.ts) : null,
    },
    error: error ? (error?.message ?? String(error)) : null,
  };

  window.__shadowgridHeavyDiagnostics = data;
  window.dispatchEvent(new CustomEvent('shadowgrid:heavy-diagnostics', { detail: data }));
}

function getViewportBounds() {
  if (!viewer) return null;

  try {
    const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    if (!rect) return null;
    return {
      minLon: Cesium.Math.toDegrees(rect.west),
      minLat: Cesium.Math.toDegrees(rect.south),
      maxLon: Cesium.Math.toDegrees(rect.east),
      maxLat: Cesium.Math.toDegrees(rect.north),
    };
  } catch {
    return null;
  }
}

function activeLayersNeedBounds() {
  return activeLayers.has('flights') || activeLayers.has('traffic') || activeLayers.has('marine') || activeLayers.has('cameras');
}

function buildSnapshotUrl() {
  if (!SERVER_HEAVY_MODE || !viewer || activeLayers.size === 0) return null;

  const params = new URLSearchParams();
  const include = [...activeLayers].sort();
  params.set('include', include.join(','));

  if (activeLayersNeedBounds()) {
    const bounds = getViewportBounds();
    if (bounds) {
      params.set(
        'bounds',
        `${bounds.minLon.toFixed(6)},${bounds.minLat.toFixed(6)},${bounds.maxLon.toFixed(6)},${bounds.maxLat.toFixed(6)}`,
      );
    }
  }

  if (activeLayers.has('satellites')) {
    params.set('satMax', `${SATELLITE_MAX_OBJECTS}`);
    params.set('satPerCategory', `${satelliteSnapshotConfig.perCategory}`);
    params.set('satCategories', satelliteSnapshotConfig.categories.length > 0 ? satelliteSnapshotConfig.categories.join(',') : '__none__');
  }
  if (activeLayers.has('cameras')) {
    params.set('camMax', `${CAMERA_MAX_OBJECTS}`);
  }

  return `${WORLD_SNAPSHOT_URL}?${params.toString()}`;
}

function notifyData(payload) {
  for (const subscriber of subscribers.values()) {
    subscriber.onData?.(payload);
  }
}

function notifyError(error) {
  for (const subscriber of subscribers.values()) {
    subscriber.onError?.(error);
  }
}

function stopPollingIfIdle() {
  if (activeLayers.size > 0) return;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function ensurePolling() {
  if (!SERVER_HEAVY_MODE || activeLayers.size === 0 || pollTimer) return;
  pollTimer = setInterval(() => {
    requestServerSnapshotRefresh();
  }, SNAPSHOT_POLL_MS);
}

export function registerServerSnapshotViewer(nextViewer) {
  if (!SERVER_HEAVY_MODE || viewer === nextViewer) return;
  viewer = nextViewer;

  viewer.camera.changed.addEventListener(() => {
    if (!activeLayersNeedBounds() || activeLayers.size === 0) return;
    if (cameraTimer) return;

    cameraTimer = setTimeout(() => {
      cameraTimer = null;
      requestServerSnapshotRefresh();
    }, CAMERA_THROTTLE_MS);
  });
}

export function subscribeServerSnapshot(layerName, handlers = {}) {
  if (!SERVER_HEAVY_MODE) return () => {};

  subscribers.set(layerName, handlers);
  if (lastPayload) {
    handlers.onData?.(lastPayload);
  }

  return () => {
    subscribers.delete(layerName);
    activeLayers.delete(layerName);
    stopPollingIfIdle();
  };
}

export function setServerSnapshotLayerEnabled(layerName, enabled) {
  if (!SERVER_HEAVY_MODE) return;

  if (enabled) {
    activeLayers.add(layerName);
    ensurePolling();
    requestServerSnapshotRefresh();
    return;
  }

  activeLayers.delete(layerName);
  stopPollingIfIdle();
}

export async function requestServerSnapshotRefresh() {
  if (!SERVER_HEAVY_MODE) return null;
  const url = buildSnapshotUrl();
  if (!url) return null;
  if (inFlightPromise) return inFlightPromise;

  inFlightPromise = (async () => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`world snapshot ${resp.status}`);
      const payload = await resp.json();
      lastPayload = payload;
      lastError = null;
      notifyData(payload);
      publishDiagnostics(payload, null);
      return payload;
    } catch (error) {
      lastError = error;
      notifyError(error);
      publishDiagnostics(lastPayload, error);
      throw error;
    } finally {
      inFlightPromise = null;
    }
  })();

  try {
    return await inFlightPromise;
  } catch {
    return null;
  }
}

export function getLastServerSnapshot() {
  return lastPayload;
}

export function getLastServerSnapshotDiagnostics() {
  return typeof window !== 'undefined' ? (window.__shadowgridHeavyDiagnostics ?? null) : null;
}

export function isServerSnapshotMode() {
  return SERVER_HEAVY_MODE;
}

export function setServerSnapshotSatelliteConfig(config = {}) {
  if (!SERVER_HEAVY_MODE) return;

  const categories = Array.isArray(config.categories)
    ? config.categories.filter(Boolean).map(String).map(v => v.toLowerCase())
    : null;
  const perCategoryRaw = Number.parseInt(config.perCategory, 10);

  if (categories) {
    satelliteSnapshotConfig.categories = [...new Set(categories)];
  }
  if (Number.isFinite(perCategoryRaw) && perCategoryRaw > 0) {
    satelliteSnapshotConfig.perCategory = perCategoryRaw;
  }

  if (activeLayers.has('satellites')) {
    requestServerSnapshotRefresh();
  }
}