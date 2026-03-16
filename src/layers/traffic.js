/**
 * File: src/layers/traffic.js
 * Purpose: Traffic layer rendering road congestion as Google Maps-style colored polylines.
 * Notes: Uses provider auto-selection (Overpass/Google/server snapshot) and adaptive profiles.
 * Last updated: 2026-03-13
 */

import * as Cesium from 'cesium';
import { setServerSnapshotLayerEnabled, subscribeServerSnapshot } from '../core/serverSnapshot.js';

const OVERPASS_API = 'https://overpass-api.de/api/interpreter';
const GOOGLE_ROUTES_API = '/api/google-routes/directions/v2:computeRoutes';
const GOOGLE_SERVER_ROADS_API = '/api/localproxy/api/traffic/google';
const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '';
const TRAFFIC_PROVIDER = (import.meta.env.VITE_TRAFFIC_PROVIDER ?? 'auto').toLowerCase();
const SERVER_HEAVY_MODE = (import.meta.env.VITE_SERVER_HEAVY_MODE ?? 'false').toLowerCase() === 'true';
const TRAFFIC_REBUILD_MINUTES = 5;
const GOOGLE_REFRESH_MS = 90_000;
const GOOGLE_DEPARTURE_OFFSET_MS = 5 * 60_000;
const TRAFFIC_MAX_PARTICLES_RAW = Number.parseInt(import.meta.env.VITE_TRAFFIC_MAX_PARTICLES ?? '50000', 10);
const TRAFFIC_MAX_PARTICLES = Number.isFinite(TRAFFIC_MAX_PARTICLES_RAW)
  ? Math.min(Math.max(TRAFFIC_MAX_PARTICLES_RAW, 100), 50_000)
  : 10_000;
const CONGESTION_COLORS = {
  free:     new Cesium.Color(0.384, 0.784, 0.227, 0.92), // #62c83a green  - free flow
  moderate: new Cesium.Color(0.969, 0.788, 0.282, 0.92), // #f7c948 yellow - moderate
  slow:     new Cesium.Color(0.957, 0.486, 0.180, 0.92), // #f47c2e orange - slow
  jam:      new Cesium.Color(0.753, 0.224, 0.169, 0.92), // #c0392b red    - standstill
};
const ROAD_LINE_WIDTHS = { 3: 8, 2: 6, 1: 4, 0: 3 };

let enabled = false;
let viewer = null;
let roadNetwork = new Map(); // bbox -> {roads: [], ready: bool}
let currentBbox = null;
let roadPrimitives = [];
let currentRoadSegmentCount = 0;
let trafficProfile = { label: 'daytime', densityMult: 1.0, speedMult: 1.0, maxParticles: TRAFFIC_MAX_PARTICLES };
let lastProfileMinute = -1;
let trafficMode = 'osm-sim';
let refreshTimer = null;
let googleRefreshInFlight = false;
let lastTrafficSnapshotTs = 0;

/**
 * Haversine distance (meters)
 */
function distance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Normalize angle to 0-360
 */
function normalizeAngle(angle) {
  while (angle < 0) angle += 360;
  while (angle >= 360) angle -= 360;
  return angle;
}

/**
 * Bearing from point A to point B
 */
function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeAngle((Math.atan2(y, x) * 180) / Math.PI);
}

/**
 * OSM road class → simulation parameters
 */
function getRoadClass(tags) {
  const highway = tags.highway || '';
  
  if (['motorway', 'trunk', 'primary'].includes(highway)) {
    return { density: 12, speed: 25, priority: 3 }; // fast, heavy traffic
  }
  if (['secondary', 'tertiary'].includes(highway)) {
    return { density: 6, speed: 15, priority: 2 };
  }
  if (['residential', 'unclassified'].includes(highway)) {
    return { density: 2, speed: 10, priority: 1 };
  }
  return { density: 1, speed: 8, priority: 0 };
}

function resolveTrafficMode() {
  const hasGoogleKey = GOOGLE_MAPS_KEY.trim().length > 0;

  if (TRAFFIC_PROVIDER === 'google') {
    if (hasGoogleKey) return 'google-live';
    console.warn('[Traffic] VITE_TRAFFIC_PROVIDER=google but no VITE_GOOGLE_MAPS_API_KEY; falling back to OSM simulation');
    return 'osm-sim';
  }

  if (TRAFFIC_PROVIDER === 'osm') return 'osm-sim';
  if (TRAFFIC_PROVIDER === 'auto') return hasGoogleKey ? 'google-live' : 'osm-sim';

  console.warn(`[Traffic] Unknown VITE_TRAFFIC_PROVIDER='${TRAFFIC_PROVIDER}', using auto mode`);
  return hasGoogleKey ? 'google-live' : 'osm-sim';
}

function decodeGooglePolyline(encoded) {
  const coords = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dlon = (result & 1) ? ~(result >> 1) : (result >> 1);
    lon += dlon;

    coords.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }

  return coords;
}

function speedClassToFlow(speedClass) {
  switch (speedClass) {
    case 'TRAFFIC_JAM':
      return { density: 9, speed: 3.5, priority: 3 };
    case 'SLOW':
      return { density: 6, speed: 8.5, priority: 3 };
    case 'NORMAL':
    default:
      return { density: 3, speed: 15, priority: 2 };
  }
}

function createGoogleRoutePairs(bbox) {
  const cx = (bbox.west + bbox.east) / 2;
  const cy = (bbox.south + bbox.north) / 2;
  const dx = (bbox.east - bbox.west) * 0.46;
  const dy = (bbox.north - bbox.south) * 0.46;

  const points = {
    w: { lat: cy, lon: cx - dx },
    e: { lat: cy, lon: cx + dx },
    n: { lat: cy + dy, lon: cx },
    s: { lat: cy - dy, lon: cx },
    nw: { lat: cy + dy, lon: cx - dx },
    ne: { lat: cy + dy, lon: cx + dx },
    sw: { lat: cy - dy, lon: cx - dx },
    se: { lat: cy - dy, lon: cx + dx },
  };

  return [
    [points.w, points.e],
    [points.e, points.w],
    [points.n, points.s],
    [points.s, points.n],
    [points.nw, points.se],
    [points.ne, points.sw],
  ];
}

async function fetchGoogleTrafficRoads(bbox) {
  if (SERVER_HEAVY_MODE) {
    const bounds = `${bbox.west.toFixed(6)},${bbox.south.toFixed(6)},${bbox.east.toFixed(6)},${bbox.north.toFixed(6)}`;
    const serverResp = await fetch(`${GOOGLE_SERVER_ROADS_API}?bounds=${bounds}`);
    if (serverResp.ok) {
      const data = await serverResp.json();
      return data?.roads ?? [];
    }
    console.warn(`[Traffic] Server roads endpoint failed (${serverResp.status}), falling back to browser mode`);
  }

  const pairs = createGoogleRoutePairs(bbox);
  const roads = [];
  const departureTime = new Date(Date.now() + GOOGLE_DEPARTURE_OFFSET_MS).toISOString();

  for (let i = 0; i < pairs.length; i++) {
    const [origin, destination] = pairs[i];
    const body = {
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lon } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lon } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
      departureTime,
      extraComputations: ['TRAFFIC_ON_POLYLINE'],
      polylineQuality: 'HIGH_QUALITY',
      polylineEncoding: 'ENCODED_POLYLINE',
      computeAlternativeRoutes: false,
    };

    const resp = await fetch(GOOGLE_ROUTES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
        'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`Google Routes API error ${resp.status}`);
    }

    const data = await resp.json();
    const route = data?.routes?.[0];
    const encoded = route?.polyline?.encodedPolyline;
    if (!encoded) continue;

    const polyPoints = decodeGooglePolyline(encoded);
    if (polyPoints.length < 2) continue;

    const speedIntervals = route?.travelAdvisory?.speedReadingIntervals ?? [];
    if (!speedIntervals.length) {
      const base = speedClassToFlow('NORMAL');
      roads.push({
        id: `g-${i}-all`,
        name: 'google-traffic',
        coords: polyPoints,
        density: base.density,
        speed: base.speed,
        priority: base.priority,
        totalLength: polyPoints.reduce((sum, _, idx) => {
          if (idx === 0) return sum;
          const prev = polyPoints[idx - 1];
          return sum + distance(prev.lat, prev.lon, polyPoints[idx].lat, polyPoints[idx].lon);
        }, 0),
      });
      continue;
    }

    speedIntervals.forEach((interval, idx) => {
      const start = Math.max(0, interval.startPolylinePointIndex ?? 0);
      const end = Math.min(polyPoints.length - 1, interval.endPolylinePointIndex ?? polyPoints.length - 1);
      if (end - start < 1) return;

      const slice = polyPoints.slice(start, end + 1);
      if (slice.length < 2) return;

      const flow = speedClassToFlow(interval.speed ?? 'NORMAL');
      roads.push({
        id: `g-${i}-${idx}`,
        name: `google-${interval.speed ?? 'NORMAL'}`,
        coords: slice,
        density: flow.density,
        speed: flow.speed,
        priority: flow.priority,
        totalLength: slice.reduce((sum, _, segIdx) => {
          if (segIdx === 0) return sum;
          const prev = slice[segIdx - 1];
          return sum + distance(prev.lat, prev.lon, slice[segIdx].lat, slice[segIdx].lon);
        }, 0),
      });
    });
  }

  return roads;
}

async function refreshGoogleTrafficForCurrentBbox() {
  if (!enabled || trafficMode !== 'google-live' || !currentBbox || googleRefreshInFlight) return;
  googleRefreshInFlight = true;

  try {
    const roads = await fetchGoogleTrafficRoads(currentBbox);
    if (!roads.length) {
      console.warn('[Traffic] Google traffic returned no segments; keeping previous roads');
      return;
    }
    await attachTerrainHeights(roads);
    renderRoads(roads);
    console.info(`[Traffic] Google traffic live refresh: ${roads.length} segments`);
  } catch (err) {
    console.warn('[Traffic] Google traffic refresh failed, continuing with existing roads:', err.message);
  } finally {
    googleRefreshInFlight = false;
  }
}

async function applyServerTrafficSnapshot(snapshot) {
  if (!enabled) return;

  const roads = snapshot?.roads ?? [];
  const snapshotTs = Number(snapshot?.ts ?? 0);
  if (!roads.length) return;
  if (snapshotTs && snapshotTs === lastTrafficSnapshotTs) return;

  if (trafficMode === 'osm-sim') {
    refreshTrafficProfile();
  }

  lastTrafficSnapshotTs = snapshotTs;
  await attachTerrainHeights(roads);
  if (currentBbox) {
    const key = `${currentBbox.west}_${currentBbox.south}_${currentBbox.east}_${currentBbox.north}`;
    roadNetwork.set(key, { roads, ready: true });
  }
  renderRoads(roads);

  console.info(`[Traffic] Server snapshot refresh: ${roads.length} segments`);
}

function localHourFromLongitude(lon) {
  const utcHour = new Date().getUTCHours();
  const offsetHours = lon / 15;
  const hour = (utcHour + offsetHours) % 24;
  return hour < 0 ? hour + 24 : hour;
}

function getTrafficProfile(localHour) {
  // Broad synthetic profile: this layer is simulated flow, not live telemetry.
  if (localHour < 5 || localHour >= 23) {
    return { label: 'late-night', densityMult: 0.14, speedMult: 0.72, maxParticles: Math.round(TRAFFIC_MAX_PARTICLES * 0.24) };
  }
  if (localHour < 7) {
    return { label: 'early-morning', densityMult: 0.28, speedMult: 0.8, maxParticles: Math.round(TRAFFIC_MAX_PARTICLES * 0.37) };
  }
  if (localHour < 10) {
    return { label: 'morning-rush', densityMult: 0.95, speedMult: 1.05, maxParticles: Math.round(TRAFFIC_MAX_PARTICLES * 0.86) };
  }
  if (localHour < 16) {
    return { label: 'midday', densityMult: 0.62, speedMult: 0.92, maxParticles: Math.round(TRAFFIC_MAX_PARTICLES * 0.59) };
  }
  if (localHour < 20) {
    return { label: 'evening-rush', densityMult: 1.0, speedMult: 1.0, maxParticles: TRAFFIC_MAX_PARTICLES };
  }
  return { label: 'night', densityMult: 0.34, speedMult: 0.85, maxParticles: Math.round(TRAFFIC_MAX_PARTICLES * 0.43) };
}

function refreshTrafficProfile() {
  if (!currentBbox) return false;
  const now = new Date();
  const minuteBucket = Math.floor(now.getTime() / (TRAFFIC_REBUILD_MINUTES * 60_000));
  if (minuteBucket === lastProfileMinute) return false;

  const centerLon = (currentBbox.west + currentBbox.east) / 2;
  const localHour = localHourFromLongitude(centerLon);
  trafficProfile = getTrafficProfile(localHour);
  lastProfileMinute = minuteBucket;
  console.info(`[Traffic] Profile: ${trafficProfile.label} (local hour ~${localHour.toFixed(1)})`);
  return true;
}

/**
 * Sample terrain heights for all road vertices so particles align with the map.
 */
async function attachTerrainHeights(roads) {
  if (!roads.length || !viewer?.terrainProvider) return;

  try {
    const refs = [];
    const positions = [];

    for (const road of roads) {
      road.vertexHeights = new Array(road.coords.length).fill(0);
      for (let i = 0; i < road.coords.length; i++) {
        const c = road.coords[i];
        refs.push({ road, i });
        positions.push(Cesium.Cartographic.fromDegrees(c.lon, c.lat, 0));
      }
    }

    const chunkSize = 2000;
    for (let start = 0; start < positions.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, positions.length);
      const chunkPositions = positions.slice(start, end);
      const chunkRefs = refs.slice(start, end);

      await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, chunkPositions);

      for (let k = 0; k < chunkPositions.length; k++) {
        const h = Number.isFinite(chunkPositions[k].height) ? chunkPositions[k].height : 0;
        const ref = chunkRefs[k];
        ref.road.vertexHeights[ref.i] = h;
      }
    }
  } catch (err) {
    console.warn('[Traffic] Terrain sampling failed, using sea-level fallback:', err.message);
  }
}

function segmentHeight(road, indexA, indexB, ratio) {
  const heights = road.vertexHeights;
  if (!Array.isArray(heights) || heights.length === 0) return 0;
  const hA = heights[indexA] ?? 0;
  const hB = heights[indexB] ?? hA;
  return hA + (hB - hA) * ratio;
}

/**
 * Fetch and parse OSM ways in a bounding box via Overpass API
 */
async function fetchOSMRoads(bbox) {
  const key = `${bbox.west}_${bbox.south}_${bbox.east}_${bbox.north}`;
  
  // Return cached result if already loaded
  if (roadNetwork.has(key) && roadNetwork.get(key).ready) {
    return roadNetwork.get(key).roads;
  }
  
  // Prevent duplicate fetches
  if (roadNetwork.has(key) && !roadNetwork.get(key).ready) {
    return [];
  }

  roadNetwork.set(key, { roads: [], ready: false });

  try {
    // Overpass query: fetch major roads in bbox
    const query = `
      [out:json];
      (
        way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
      );
      out geom;
    `;

    const response = await fetch(OVERPASS_API, {
      method: 'POST',
      body: query,
      headers: { 'Content-Type': 'text/plain' }
    });

    if (!response.ok) {
      console.warn(`[Traffic] Overpass API error: ${response.status}`);
      roadNetwork.get(key).ready = true;
      return [];
    }

    const data = await response.json();
    const roads = [];
    const ways = (data.elements || []).filter(el => el.type === 'way');

    for (const way of ways) {
      if (!way.tags?.highway || !Array.isArray(way.geometry) || way.geometry.length < 2) continue;

      const roadClass = getRoadClass(way.tags);
      const coords = way.geometry.map(n => ({ lat: n.lat, lon: n.lon }));

      roads.push({
        id: way.id,
        name: way.tags.name || '[unnamed]',
        coords,
        density: roadClass.density,
        speed: roadClass.speed,
        priority: roadClass.priority,
        totalLength: coords.reduce((sum, _, i) => {
          if (i === 0) return sum;
          const prev = coords[i - 1];
          return sum + distance(prev.lat, prev.lon, coords[i].lat, coords[i].lon);
        }, 0)
      });
    }

    roadNetwork.get(key).roads = roads;
    roadNetwork.get(key).ready = true;
    console.info(`[Traffic] Loaded ${roads.length} road segments in bbox ${key}`);
    return roads;
  } catch (err) {
    console.error('[Traffic] OSM fetch failed:', err);
    roadNetwork.get(key).ready = true;
    return [];
  }
}

/**
 * Map a road segment to a congestion level based on traffic mode and time-of-day profile.
 * Returns: 'free' | 'moderate' | 'slow' | 'jam'
 */
function getCongestionLevel(road, profile) {
  if (trafficMode === 'google-live') {
    if (road.name?.includes('TRAFFIC_JAM')) return 'jam';
    if (road.name?.includes('SLOW')) return 'slow';
    return 'free';
  }
  // OSM simulation: approximate congestion from road class + density multiplier
  const dm = profile.densityMult;
  const p = road.priority ?? 0;
  if (p >= 3) return dm >= 0.85 ? 'slow'     : dm >= 0.45 ? 'moderate' : 'free';
  if (p === 2) return dm >= 0.85 ? 'slow'     : 'moderate';
  return               dm >= 0.85 ? 'moderate' : 'free';
}

function getRoadLineWidth(road) {
  return ROAD_LINE_WIDTHS[road.priority ?? 0] ?? 3;
}

/**
 * Render road segments as Google Maps-style color-coded polylines draped on terrain.
 * Green = free flow - Yellow = moderate - Orange = slow - Red = standstill
 * Segments are batched by congestion level into GroundPolylinePrimitives for efficiency.
 */
function renderRoads(roads) {
  roadPrimitives.forEach(p => viewer.scene.primitives.remove(p));
  roadPrimitives = [];

  if (!roads.length || !viewer) return;

  const profile = trafficMode === 'google-live' ? { densityMult: 1.0 } : trafficProfile;

  // Group segments by congestion level for efficient primitive batching
  const groups = { free: [], moderate: [], slow: [], jam: [] };
  for (const road of roads) {
    if (!road.coords || road.coords.length < 2) continue;
    groups[getCongestionLevel(road, profile)].push(road);
  }

  for (const [level, levelRoads] of Object.entries(groups)) {
    if (!levelRoads.length) continue;

    const instances = levelRoads.map(road =>
      new Cesium.GeometryInstance({
        geometry: new Cesium.GroundPolylineGeometry({
          positions: road.coords.map(c => Cesium.Cartesian3.fromDegrees(c.lon, c.lat)),
          width: getRoadLineWidth(road),
        }),
      })
    );

    const primitive = new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineMaterialAppearance({
        material: Cesium.Material.fromType('Color', { color: CONGESTION_COLORS[level] }),
      }),
    });

    viewer.scene.primitives.add(primitive);
    roadPrimitives.push(primitive);
  }

  currentRoadSegmentCount = roads.length;
  console.info(`[Traffic] Rendered ${roads.length} road segments (traffic flow style)`);
}

export async function initTraffic(viewerInstance) {
  viewer = viewerInstance;
  enabled = false;
  trafficMode = resolveTrafficMode();
  console.info(`[Traffic] Mode: ${trafficMode}`);

  if (SERVER_HEAVY_MODE) {
    subscribeServerSnapshot('traffic', {
      async onData(payload) {
        if (!enabled) return;
        await applyServerTrafficSnapshot(payload?.traffic ?? null);
      },
      onError(err) {
        if (!enabled) return;
        console.warn('[Traffic] Server snapshot failed:', err?.message ?? 'unknown');
      },
    });
  }

  return {
    async setEnabled(val) {
      enabled = val;

      if (enabled) {
        trafficMode = resolveTrafficMode();
        console.info(`[Traffic] Mode: ${trafficMode}`);
        console.info('[Traffic] Layer enabled');

        // Fetch roads for current viewport
        const rectangle = viewer.camera.computeViewRectangle();
        if (rectangle) {
          const bbox = {
            west: (rectangle.west * 180) / Math.PI,
            south: (rectangle.south * 180) / Math.PI,
            east: (rectangle.east * 180) / Math.PI,
            north: (rectangle.north * 180) / Math.PI
          };
          currentBbox = bbox;
          if (SERVER_HEAVY_MODE) {
            setServerSnapshotLayerEnabled('traffic', true);
          } else if (trafficMode === 'google-live') {
            await refreshGoogleTrafficForCurrentBbox();
            if (!roadPrimitives.length) {
              console.warn('[Traffic] Falling back to OSM simulation for this viewport');
              trafficMode = 'osm-sim';
            }
          }

          if (!SERVER_HEAVY_MODE && trafficMode === 'osm-sim') {
            refreshTrafficProfile();
            const roads = await fetchOSMRoads(bbox);
            if (roads.length > 0) {
              await attachTerrainHeights(roads);
              renderRoads(roads);
            }
          }

          if (refreshTimer) clearInterval(refreshTimer);
          if (!SERVER_HEAVY_MODE && trafficMode === 'google-live') {
            refreshTimer = setInterval(() => {
              refreshGoogleTrafficForCurrentBbox();
            }, GOOGLE_REFRESH_MS);
          } else if (!SERVER_HEAVY_MODE && trafficMode === 'osm-sim') {
            refreshTimer = setInterval(async () => {
              if (!enabled || !currentBbox) return;
              if (refreshTrafficProfile()) {
                const key = `${currentBbox.west}_${currentBbox.south}_${currentBbox.east}_${currentBbox.north}`;
                const cached = roadNetwork.get(key);
                if (cached?.roads?.length) renderRoads(cached.roads);
              }
            }, TRAFFIC_REBUILD_MINUTES * 60_000);
          }
        }
      } else {
        console.info('[Traffic] Layer disabled');
        setServerSnapshotLayerEnabled('traffic', false);
        lastTrafficSnapshotTs = 0;
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
        roadPrimitives.forEach(p => viewer.scene.primitives.remove(p));
        roadPrimitives = [];
      }
    },

    get count() {
      return currentRoadSegmentCount;
    }
  };
}
