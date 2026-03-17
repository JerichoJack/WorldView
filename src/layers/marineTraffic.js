/**
 * File: src/layers/marineTraffic.js
 * Purpose: Marine traffic layer rendering vessel positions and tracking.
 * Notes: Uses local proxy snapshots for cached marine vessel data in both normal and server-heavy modes.
 * Last updated: 2026-03-16
 */

import * as Cesium from 'cesium';
import { setServerSnapshotLayerEnabled, subscribeServerSnapshot } from '../core/serverSnapshot.js';

const SERVER_HEAVY_MODE = (import.meta.env.VITE_SERVER_HEAVY_MODE ?? 'false').toLowerCase() === 'true';
const MARINE_SNAPSHOT_URL = '/api/localproxy/api/marine/snapshot';
const VESSEL_REFRESH_MS = 60_000;
const TRACK_MAX_POINTS = 12;
const VESSEL_COLOR_CARGO = new Cesium.Color(0.2, 0.6, 1.0, 0.8); // Blue for cargo
const VESSEL_COLOR_TANKER = new Cesium.Color(0.8, 0.4, 0.2, 0.8); // Orange for tanker
const VESSEL_COLOR_PASSENGER = new Cesium.Color(0.0, 1.0, 0.6, 0.8); // Green for passenger
const VESSEL_COLOR_FISHING = new Cesium.Color(1.0, 0.8, 0.0, 0.8); // Yellow for fishing
const VESSEL_COLOR_OTHER = new Cesium.Color(0.6, 0.6, 0.8, 0.8); // Light purple for other

let enabled = false;
let viewer = null;
let vesselEntities = new Map(); // id -> { point: Entity, track: Entity, trail: Array<{lat:number, lon:number}> }
let updateTimer = null;

/**
 * Classify vessel type based on name, type code, or observable characteristics
 */
function classifyVesselType(vessel) {
  const name = (vessel.name || vessel.tags?.name || '').toLowerCase();
  const shiptype = String(vessel.type || vessel.tags?.ship || vessel.tags?.['ship:type'] || '').toLowerCase();

  if (shiptype.includes('tanker') || name.includes('tanker')) return 'tanker';
  if (shiptype.includes('cargo') || name.includes('cargo')) return 'cargo';
  if (shiptype.includes('passenger') || name.includes('passenger')) return 'passenger';
  if (shiptype.includes('fishing') || name.includes('fishing')) return 'fishing';
  return 'other';
}

/**
 * Get color for vessel type
 */
function getVesselColor(vesselType) {
  switch (vesselType) {
    case 'tanker': return VESSEL_COLOR_TANKER;
    case 'cargo': return VESSEL_COLOR_CARGO;
    case 'passenger': return VESSEL_COLOR_PASSENGER;
    case 'fishing': return VESSEL_COLOR_FISHING;
    default: return VESSEL_COLOR_OTHER;
  }
}

/**
 * Compute current viewport bounds for proxy requests.
 */
function getViewportBounds() {
  if (!viewer) return null;

  const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (!rectangle) return null;

  return {
    west: Cesium.Math.toDegrees(rectangle.west),
    south: Cesium.Math.toDegrees(rectangle.south),
    east: Cesium.Math.toDegrees(rectangle.east),
    north: Cesium.Math.toDegrees(rectangle.north),
  };
}

function buildMarineSnapshotUrl(bounds) {
  if (!bounds) return MARINE_SNAPSHOT_URL;
  const boundsStr = [bounds.west, bounds.south, bounds.east, bounds.north]
    .map(v => Number(v).toFixed(6))
    .join(',');
  return `${MARINE_SNAPSHOT_URL}?bounds=${encodeURIComponent(boundsStr)}`;
}

async function fetchVesselsFromProxy() {
  const bounds = getViewportBounds();
  if (!bounds) return [];

  try {
    const response = await fetch(buildMarineSnapshotUrl(bounds));

    if (!response.ok) {
      console.warn(`[MarineTraffic] Proxy API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data?.vessels) ? data.vessels : [];
  } catch (err) {
    console.warn('[MarineTraffic] Proxy fetch failed:', err.message);
    return [];
  }
}

/**
 * Build/update a vessel trail list from either server-provided track or prior positions.
 */
function resolveTrack(vessel, existingTrail = []) {
  if (Array.isArray(vessel.track) && vessel.track.length >= 2) {
    return vessel.track
      .filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
      .slice(-TRACK_MAX_POINTS);
  }

  const trail = [...existingTrail, { lat: vessel.lat, lon: vessel.lon }];
  return trail.slice(-TRACK_MAX_POINTS);
}

/**
 * Render/update vessel entities and track polylines.
 */
function applyVesselSnapshot(vessels = []) {
  if (!viewer) return;

  try {
    const seen = new Set();

    for (const vessel of vessels) {
      if (!Number.isFinite(vessel?.lat) || !Number.isFinite(vessel?.lon)) continue;
      const vesselId = String(vessel.id ?? `${vessel.name ?? 'vessel'}-${vessel.lat}-${vessel.lon}`);
      seen.add(vesselId);

      const vesselType = classifyVesselType(vessel);
      const color = getVesselColor(vesselType);
      const track = resolveTrack(vessel, vesselEntities.get(vesselId)?.trail ?? []);
      const trackPositions = track.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 8));

      if (vesselEntities.has(vesselId)) {
        const record = vesselEntities.get(vesselId);
        record.point.position = Cesium.Cartesian3.fromDegrees(vessel.lon, vessel.lat, 10);
        record.point.label.text = vessel.name || vesselId;
        record.point.point.color = color;
        record.point.label.fillColor = color;
        record.point.properties = new Cesium.PropertyBag({
          type: vesselType,
          shipType: vessel.type,
          speed: vessel.speed ?? 'N/A',
          heading: vessel.heading ?? 'N/A',
          source: vessel.simulated ? 'simulated' : 'live',
        });
        record.track.polyline.positions = trackPositions;
        record.track.polyline.material = color.withAlpha(0.35);
        record.track.show = enabled;
        record.trail = track;
      } else {
        const pointEntity = viewer.entities.add({
          id: `marine-point-${vesselId}`,
          position: Cesium.Cartesian3.fromDegrees(vessel.lon, vessel.lat, 10),
          point: {
            pixelSize: 6,
            color,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.NONE,
          },
          label: {
            text: vessel.name || vesselId,
            font: '10px "Share Tech Mono"',
            fillColor: color,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
            verticalOrigin: Cesium.VerticalOrigin.TOP,
            pixelOffset: new Cesium.Cartesian2(0, 12),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1_000_000),
            scale: 0.9,
          },
          properties: {
            type: vesselType,
            shipType: vessel.type,
            speed: vessel.speed ?? 'N/A',
            heading: vessel.heading ?? 'N/A',
            source: vessel.simulated ? 'simulated' : 'live',
          },
          show: enabled,
        });

        const trackEntity = viewer.entities.add({
          id: `marine-track-${vesselId}`,
          polyline: {
            positions: trackPositions,
            width: 2,
            material: color.withAlpha(0.35),
            clampToGround: false,
            arcType: Cesium.ArcType.GEODESIC,
          },
          show: enabled,
        });

        vesselEntities.set(vesselId, {
          point: pointEntity,
          track: trackEntity,
          trail: track,
        });
      }
    }

    for (const [id, record] of vesselEntities.entries()) {
      if (!seen.has(id)) {
        viewer.entities.remove(record.point);
        viewer.entities.remove(record.track);
        vesselEntities.delete(id);
      }
    }
  } catch (err) {
    console.warn('[MarineTraffic] Snapshot apply failed:', err.message);
  }
}

async function refreshMarineSnapshot() {
  if (!viewer || !enabled || SERVER_HEAVY_MODE) return;
  const vessels = await fetchVesselsFromProxy();
  applyVesselSnapshot(vessels);
}

function setEntityVisibility(show) {
  for (const record of vesselEntities.values()) {
    record.point.show = show;
    record.track.show = show;
  }
}

/**
 * Export interface
 */
export async function initMarineTraffic(viewer_) {
  viewer = viewer_;

  if (SERVER_HEAVY_MODE) {
    subscribeServerSnapshot('marine', {
      onData(payload) {
        if (!enabled) return;
        applyVesselSnapshot(payload?.marine?.vessels ?? []);
      },
      onError(err) {
        if (!enabled) return;
        console.warn('[MarineTraffic] Server snapshot failed:', err?.message ?? 'unknown');
      },
    });
  }

  return {
    async setEnabled(en) {
      enabled = en;
      setEntityVisibility(enabled);

      if (enabled) {
        if (SERVER_HEAVY_MODE) {
          setServerSnapshotLayerEnabled('marine', true);
          return;
        }

        await refreshMarineSnapshot();
        if (updateTimer) clearInterval(updateTimer);
        updateTimer = setInterval(() => {
          refreshMarineSnapshot();
        }, VESSEL_REFRESH_MS);
      } else {
        setServerSnapshotLayerEnabled('marine', false);
        if (updateTimer) clearInterval(updateTimer);
        updateTimer = null;
      }
    },

    get count() {
      return vesselEntities.size;
    },

    get enabled() {
      return enabled;
    },
  };
}
