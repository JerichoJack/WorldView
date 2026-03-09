/**
 * layers/flights.js
 * Polls OpenSky Network every 15 s and renders live aircraft as
 * billboard icons with callsign + altitude labels.
 *
 * OpenSky REST API: https://openskynetwork.github.io/opensky-api/rest.html
 */

import * as Cesium from 'cesium';

const OPENSKY_URL = '/api/opensky/api/states/all';
const POLL_MS     = 15_000;

// Minimal aircraft icon as a data URI (white arrow)
const AIRCRAFT_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M12 2L8 10H3l4 3-1.5 7L12 16l6.5 4L17 13l4-3h-5z"/></svg>`;

/** @type {Map<string, Cesium.Entity>} */
const entityMap = new Map();
let   enabled   = true;
let   pollTimer = null;

export async function initFlights(viewer) {
  await fetchAndRender(viewer);
  pollTimer = setInterval(() => {
    if (enabled) fetchAndRender(viewer);
  }, POLL_MS);

  return {
    setEnabled(val) {
      enabled = val;
      entityMap.forEach(e => { e.show = val; });
    },
    get count() { return entityMap.size; },
  };
}

async function fetchAndRender(viewer) {
  try {
    const url  = buildUrl();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`OpenSky ${resp.status}`);
    const data = await resp.json();

    const states = data.states ?? [];
    const seen   = new Set();

    for (const s of states) {
      const [icao24, callsign, , , , lon, lat, baroAlt, onGround, velocity, heading] = s;

      if (!lon || !lat || onGround) continue;

      const id  = icao24.trim();
      seen.add(id);
      const alt = (baroAlt ?? 10_000);

      if (entityMap.has(id)) {
        // Update existing entity
        const entity = entityMap.get(id);
        entity.position = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
        if (entity.billboard) {
          entity.billboard.rotation = Cesium.Math.toRadians(-(heading ?? 0));
        }
      } else {
        // Create new entity
        const entity = viewer.entities.add({
          id,
          position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
          billboard: {
            image:             AIRCRAFT_SVG,
            width:             18,
            height:            18,
            rotation:          Cesium.Math.toRadians(-(heading ?? 0)),
            alignedAxis:       Cesium.Cartesian3.UNIT_Z,
            scaleByDistance:   new Cesium.NearFarScalar(1e4, 1.5, 3e6, 0.4),
            translucencyByDistance: new Cesium.NearFarScalar(1e4, 1, 2e6, 0.6),
            color:             Cesium.Color.fromCssColorString('#00ff88'),
          },
          label: {
            text:              (callsign ?? '').trim() || id,
            font:              '10px "Share Tech Mono", monospace',
            fillColor:         Cesium.Color.fromCssColorString('#00ff88'),
            outlineColor:      Cesium.Color.BLACK,
            outlineWidth:      2,
            style:             Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset:       new Cesium.Cartesian2(12, -6),
            scaleByDistance:   new Cesium.NearFarScalar(1e4, 1, 1e6, 0),
            translucencyByDistance: new Cesium.NearFarScalar(1e4, 1, 5e5, 0),
          },
          properties: { type: 'flight', callsign, velocity, altitude: alt },
        });
        entityMap.set(id, entity);
      }
    }

    // Remove departed aircraft
    for (const [id, entity] of entityMap) {
      if (!seen.has(id)) {
        viewer.entities.remove(entity);
        entityMap.delete(id);
      }
    }

    console.debug(`[Flights] ${entityMap.size} aircraft rendered`);
  } catch (err) {
    console.warn('[Flights] Fetch failed:', err.message);
  }
}

function buildUrl() {
  const user = import.meta.env.VITE_OPENSKY_USERNAME;
  const pass = import.meta.env.VITE_OPENSKY_PASSWORD;
  if (user && pass) {
    return `https://${user}:${pass}@opensky-network.org/api/states/all`;
  }
  return OPENSKY_URL;
}
