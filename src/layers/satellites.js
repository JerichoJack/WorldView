/**
 * layers/satellites.js
 * Fetches TLE data from CelesTrak, propagates orbital positions in real time
 * using satellite.js (SGP4), and renders each satellite + its ground track.
 *
 * CelesTrak:   https://celestrak.org/SOCRATES/query.php
 * satellite.js: https://github.com/shashwatak/satellite-js
 */

import * as Cesium from 'cesium';
import * as satellite from 'satellite.js';

// TLE catalog groups from CelesTrak
const TLE_FEEDS = [
  { name: 'stations',  url: '/api/celestrak/SOCRATES/query.php?NAME=ISS&FORMAT=TLE' },
  { name: 'starlink',  url: '/api/celestrak/pub/TLE/starlink.txt' },
  { name: 'military',  url: '/api/celestrak/pub/TLE/military.txt' },
];

// Fallback hard-coded TLE for ISS if network is unavailable
const ISS_FALLBACK_TLE = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9000',
  '2 25544  51.6435 145.2570 0001234  80.1234 280.0000 15.49560001000000',
];

const PROPAGATE_MS  = 1_000;   // update positions every second
const TRACK_MINUTES = 90;      // ground track lookahead
const TRACK_STEPS   = 60;

/** @type {Map<string, { satrec: object, entity: Cesium.Entity, trackEntity: Cesium.Entity }>} */
const satMap  = new Map();
let   enabled = true;

export async function initSatellites(viewer) {
  const tleRecords = await loadTLEs();

  for (const { name, line1, line2 } of tleRecords) {
    try {
      const satrec = satellite.twoline2satrec(line1, line2);
      addSatelliteEntity(viewer, name, satrec);
    } catch {
      // Skip malformed TLEs
    }
  }

  // Propagate positions every second
  setInterval(() => {
    if (!enabled) return;
    const now = new Date();
    for (const [, rec] of satMap) {
      updatePosition(rec, now);
    }
  }, PROPAGATE_MS);

  console.info(`[Satellites] ${satMap.size} satellites tracked`);

  return {
    setEnabled(val) {
      enabled = val;
      satMap.forEach(({ entity, trackEntity }) => {
        entity.show      = val;
        trackEntity.show = val;
      });
    },
    get count() { return satMap.size; },
  };
}

// ── TLE loading ─────────────────────────────────────────────────────────────

async function loadTLEs() {
  const records = [];

  // Try live feeds; fall back gracefully
  for (const feed of TLE_FEEDS) {
    try {
      const resp = await fetch(feed.url);
      if (!resp.ok) throw new Error(resp.status);
      const text = await resp.text();
      records.push(...parseTLE(text));
    } catch (err) {
      console.warn(`[Satellites] Could not load ${feed.name}:`, err.message);
    }
  }

  // Always include ISS as a guaranteed fallback
  if (!records.find(r => r.name.includes('ISS'))) {
    records.push({
      name: ISS_FALLBACK_TLE[0],
      line1: ISS_FALLBACK_TLE[1],
      line2: ISS_FALLBACK_TLE[2],
    });
  }

  // Cap at 200 satellites for performance
  return records.slice(0, 200);
}

function parseTLE(text) {
  const lines   = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const records = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    records.push({ name: lines[i], line1: lines[i + 1], line2: lines[i + 2] });
  }
  return records;
}

// ── Entity creation ─────────────────────────────────────────────────────────

function addSatelliteEntity(viewer, name, satrec) {
  const now          = new Date();
  const posVel       = satellite.propagate(satrec, now);
  if (!posVel.position) return;

  const initPos      = eciToCartesian(posVel.position, now);

  // ── Ground track polyline ────────────────────────────────────────────────
  const trackPositions = computeGroundTrack(satrec, now);

  const trackEntity = viewer.entities.add({
    polyline: {
      positions:        trackPositions,
      width:            1,
      material:         new Cesium.PolylineDashMaterialProperty({
        color:          Cesium.Color.fromCssColorString('#00ff8844'),
        dashLength:     16,
      }),
      arcType:          Cesium.ArcType.NONE,
      clampToGround:    false,
    },
  });

  // ── Satellite point + label ──────────────────────────────────────────────
  const entity = viewer.entities.add({
    position:   initPos,
    point: {
      pixelSize:        5,
      color:            Cesium.Color.fromCssColorString('#00aaff'),
      outlineColor:     Cesium.Color.fromCssColorString('#003366'),
      outlineWidth:     1,
      scaleByDistance:  new Cesium.NearFarScalar(1e5, 2, 1e7, 0.8),
    },
    label: {
      text:             name,
      font:             '9px "Share Tech Mono", monospace',
      fillColor:        Cesium.Color.fromCssColorString('#00aaff'),
      outlineColor:     Cesium.Color.BLACK,
      outlineWidth:     2,
      style:            Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset:      new Cesium.Cartesian2(8, -5),
      scaleByDistance:  new Cesium.NearFarScalar(1e5, 1, 1e7, 0),
      translucencyByDistance: new Cesium.NearFarScalar(1e5, 1, 5e6, 0),
    },
    properties: { type: 'satellite', name },
  });

  satMap.set(name, { satrec, entity, trackEntity });
}

// ── Per-frame update ────────────────────────────────────────────────────────

function updatePosition({ satrec, entity, trackEntity }, now) {
  const posVel = satellite.propagate(satrec, now);
  if (!posVel.position) return;

  entity.position = eciToCartesian(posVel.position, now);

  // Refresh ground track every 30 s (expensive)
  if (now.getSeconds() % 30 === 0) {
    const positions = computeGroundTrack(satrec, now);
    trackEntity.polyline.positions = new Cesium.ConstantProperty(positions);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function eciToCartesian(eciPos, date) {
  const gmst = satellite.gstime(date);
  const geo  = satellite.eciToGeodetic(eciPos, gmst);
  return Cesium.Cartesian3.fromDegrees(
    Cesium.Math.toDegrees(geo.longitude),
    Cesium.Math.toDegrees(geo.latitude),
    geo.height * 1000   // km → m
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
