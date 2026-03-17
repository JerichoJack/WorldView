/**
 * File: src/layers/airspace.js
 * Purpose: Standalone airspace overlays (GPS interference + flight restrictions).
 */

import * as Cesium from 'cesium';

const NOFLY_GPS_URL = '/api/localproxy/api/nofly_gps';
const NOFLY_GPS_POLL_MS = 5 * 60_000;
const NOFLY_GPS_DEFAULT_MAX_HEIGHT_M = 18_000;

let enabled = false;
let airspaceDataSource = null;
let noflyGpsPollTimer = null;
let noflyGpsPayloadCache = null;

const FLIGHT_ZONE_AGE_RULES = { fadeMs: 6 * 60 * 60 * 1000, expireMs: 48 * 60 * 60 * 1000 };

const zoneFilters = {
  gps: true,
  airspace: true,
};

function flattenPoints(points) {
  const out = [];
  for (const [lon, lat] of points) out.push(lon, lat);
  return out;
}

function flattenClosedPoints(points) {
  if (!points.length) return [];
  return flattenPoints([...points, points[0]]);
}

function normalizeZonePoints(points) {
  if (!Array.isArray(points)) return [];
  const filtered = points
    .map(([lon, lat]) => [Number(lon), Number(lat)])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (filtered.length > 1) {
    const [firstLon, firstLat] = filtered[0];
    const [lastLon, lastLat] = filtered[filtered.length - 1];
    if (firstLon === lastLon && firstLat === lastLat) filtered.pop();
  }
  return filtered;
}

function parseZoneTime(value) {
  const ts = Date.parse(value ?? '');
  return Number.isFinite(ts) ? ts : null;
}

function computeZoneOpacity(zone, nowMs) {
  const startsAt = parseZoneTime(zone.startsAt);
  const endsAt = parseZoneTime(zone.endsAt);
  const observedAt = parseZoneTime(zone.updatedAt) ?? parseZoneTime(zone.observedAt) ?? startsAt;

  if (startsAt && startsAt > nowMs) return 0;
  if (endsAt && nowMs <= endsAt) return 1;
  if (!observedAt) return 1;

  const ageMs = Math.max(0, nowMs - observedAt);
  if (ageMs <= FLIGHT_ZONE_AGE_RULES.fadeMs) return 1;
  if (ageMs >= FLIGHT_ZONE_AGE_RULES.expireMs) return 0;
  return 1 - ((ageMs - FLIGHT_ZONE_AGE_RULES.fadeMs) / (FLIGHT_ZONE_AGE_RULES.expireMs - FLIGHT_ZONE_AGE_RULES.fadeMs));
}

function buildZoneWindowLabel(zone) {
  const startsAt = zone.startsAt ? new Date(zone.startsAt).toISOString() : null;
  const endsAt = zone.endsAt ? new Date(zone.endsAt).toISOString() : null;
  const updatedAt = zone.updatedAt ? new Date(zone.updatedAt).toISOString() : null;
  if (startsAt && endsAt) return `${startsAt} to ${endsAt}`;
  if (updatedAt) return `Updated ${updatedAt}`;
  return 'Unknown window';
}

function reserveZoneId(baseId, usedIds) {
  const seed = String(baseId ?? 'zone');
  const base = `zone-${seed}`;
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }
  let counter = 2;
  while (usedIds.has(`${base}-${counter}`)) counter += 1;
  const unique = `${base}-${counter}`;
  usedIds.add(unique);
  return unique;
}

function addFlightRestrictionZone(zone, nowMs, maxHeight, usedIds) {
  const points = normalizeZonePoints(zone.points);
  const opacity = computeZoneOpacity(zone, nowMs);
  if (points.length < 3 || opacity <= 0 || !airspaceDataSource) return;

  const source = String(zone.source ?? '').toLowerCase();
  const isSafeAirspace = source.includes('safe airspace') || String(zone.zoneType ?? '').toLowerCase() === 'safeairspace';
  const severity = String(zone.severity ?? '').toLowerCase();
  const isHigh = severity === 'high';
  const displaySeverity = isHigh ? 'restricted airspace' : (zone.severity ?? 'medium');
  const ffaEvenColor = Cesium.Color.fromCssColorString(isHigh ? '#ff3b30' : '#ff7f73').withAlpha(0.34 * opacity);
  const ffaOddColor = Cesium.Color.fromCssColorString('#ffd4cd').withAlpha(0.08 * opacity);
  const faaOutline = Cesium.Color.fromCssColorString(isHigh ? '#ff655c' : '#ff9f96').withAlpha(0.92 * opacity);
  const safeAirspaceCss = severity === 'high'
    ? '#ea283c'
    : (severity === 'medium' ? '#ff8b00' : '#ffce00');
  const safeAirspaceFill = Cesium.Color.fromCssColorString(safeAirspaceCss).withAlpha((severity === 'high' ? 0.24 : 0.2) * opacity);
  const safeAirspaceOutline = Cesium.Color.fromCssColorString(safeAirspaceCss).withAlpha(0.95 * opacity);
  const material = isSafeAirspace
    ? safeAirspaceFill
    : new Cesium.StripeMaterialProperty({
      evenColor: ffaEvenColor,
      oddColor: ffaOddColor,
      repeat: 18,
      offset: 0.2,
      orientation: Cesium.StripeOrientation.VERTICAL,
    });
  const outline = isSafeAirspace ? safeAirspaceOutline : faaOutline;
  const zoneSeverity = isSafeAirspace ? (zone.severity ?? 'low') : displaySeverity;

  airspaceDataSource.entities.add({
    id: reserveZoneId(zone.id, usedIds),
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray(flattenPoints(points)),
      height: 0,
      extrudedHeight: maxHeight,
      material,
      outline: false,
    },
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(flattenClosedPoints(points)),
      width: isSafeAirspace ? 3 : 2,
      clampToGround: true,
      material: outline,
    },
    properties: {
      type: 'zone',
      domain: 'flight',
      id: zone.id,
      name: zone.name,
      zoneType: zone.zoneType ?? 'tfr',
      severity: zoneSeverity,
      source: zone.source ?? 'FAA',
      status: zone.status ?? 'active',
      activeWindowUtc: buildZoneWindowLabel(zone),
      summary: zone.summary ?? '',
    },
  });
}

function addGpsInterferenceZone(zone, nowMs, maxHeight, usedIds) {
  const points = normalizeZonePoints(zone.points);
  const opacity = computeZoneOpacity(zone, nowMs);
  if (points.length < 3 || opacity <= 0 || !airspaceDataSource) return;

  const fill = Cesium.Color.fromCssColorString(zone.severity === 'high' ? '#ff3b30' : '#ffd54a').withAlpha((zone.severity === 'high' ? 0.22 : 0.18) * opacity);
  const outline = Cesium.Color.fromCssColorString(zone.severity === 'high' ? '#ff746c' : '#ffe17c').withAlpha(0.92 * opacity);

  airspaceDataSource.entities.add({
    id: reserveZoneId(zone.id, usedIds),
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray(flattenPoints(points)),
      height: Number(zone.floorMeters ?? 0),
      extrudedHeight: Number(zone.ceilingMeters ?? maxHeight),
      material: fill,
      outline: false,
    },
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(flattenClosedPoints(points)),
      width: 2,
      clampToGround: true,
      material: outline,
    },
    properties: {
      type: 'zone',
      domain: 'flight',
      id: zone.id,
      name: zone.name,
      zoneType: zone.zoneType ?? 'gps',
      severity: zone.severity ?? 'medium',
      source: zone.source ?? 'GPSJam',
      status: zone.status ?? 'active',
      activeWindowUtc: buildZoneWindowLabel(zone),
      summary: zone.summary ?? '',
    },
  });
}

function syncVisibility() {
  if (airspaceDataSource) airspaceDataSource.show = enabled;
}

function renderZones(payload) {
  noflyGpsPayloadCache = payload;
  if (!airspaceDataSource) return;

  const nowMs = Date.now();
  const maxHeight = Number(payload?.maxFlightHeightMeters ?? NOFLY_GPS_DEFAULT_MAX_HEIGHT_M);
  const usedIds = new Set();
  airspaceDataSource.entities.removeAll();

  if (zoneFilters.airspace) {
    for (const zone of payload?.flightRestrictions ?? []) {
      addFlightRestrictionZone(zone, nowMs, maxHeight, usedIds);
    }
  }

  if (zoneFilters.gps) {
    for (const zone of payload?.gpsInterference ?? []) {
      addGpsInterferenceZone(zone, nowMs, maxHeight, usedIds);
    }
  }

  syncVisibility();
}

function getViewportBounds(viewer) {
  try {
    const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    if (!rect) return null;
    const toDeg = Cesium.Math.toDegrees;
    return {
      minLon: toDeg(rect.west),
      minLat: toDeg(rect.south),
      maxLon: toDeg(rect.east),
      maxLat: toDeg(rect.north),
    };
  } catch {
    return null;
  }
}

function noflyGpsUrlForViewer(viewer) {
  if (!viewer) return NOFLY_GPS_URL;
  const bounds = getViewportBounds(viewer);
  if (!bounds) return NOFLY_GPS_URL;
  const boundsStr = [bounds.minLon, bounds.minLat, bounds.maxLon, bounds.maxLat]
    .map(v => Number(v).toFixed(4))
    .join(',');
  return `${NOFLY_GPS_URL}?bounds=${encodeURIComponent(boundsStr)}`;
}

async function refreshZones(viewer) {
  try {
    const response = await fetch(noflyGpsUrlForViewer(viewer));
    if (!response.ok) throw new Error(`nofly_gps ${response.status}`);
    const payload = await response.json();
    renderZones(payload);
  } catch (error) {
    console.warn('[AirSpace] No-fly/GPS refresh failed:', error);
    if (noflyGpsPayloadCache) renderZones(noflyGpsPayloadCache);
  }
}

export async function initAirspace(viewer) {
  airspaceDataSource = new Cesium.CustomDataSource('nofly-gps-zones');
  await viewer.dataSources.add(airspaceDataSource);
  syncVisibility();

  if (noflyGpsPollTimer) {
    window.clearInterval(noflyGpsPollTimer);
  }

  noflyGpsPollTimer = window.setInterval(() => {
    if (enabled) refreshZones(viewer);
  }, NOFLY_GPS_POLL_MS);

  return {
    setEnabled(val) {
      enabled = !!val;
      syncVisibility();
      if (enabled) refreshZones(viewer);
    },
    setZoneFilter(zoneType, filterEnabled) {
      const zoneKey = (zoneType ?? '').toLowerCase();
      if (zoneKey in zoneFilters) {
        zoneFilters[zoneKey] = !!filterEnabled;
        if (noflyGpsPayloadCache) {
          renderZones(noflyGpsPayloadCache);
        } else if (enabled) {
          refreshZones(viewer);
        }
      }
    },
    get count() {
      return airspaceDataSource?.entities?.values?.length ?? 0;
    },
  };
}
