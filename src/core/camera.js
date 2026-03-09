/**
 * core/camera.js
 * Sets up the initial camera position and navigation feel.
 * Exposes flyTo() for programmatic camera moves.
 */

import * as Cesium from 'cesium';

const DEFAULT_LON = parseFloat(import.meta.env.VITE_DEFAULT_LON ?? '-97.7431');
const DEFAULT_LAT = parseFloat(import.meta.env.VITE_DEFAULT_LAT ?? '30.2672');
const DEFAULT_ALT = parseFloat(import.meta.env.VITE_DEFAULT_ALT ?? '150000');

export function initCamera(viewer) {
  const camera = viewer.camera;

  // ── Initial position ─────────────────────────────────────────────────────
  camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(DEFAULT_LON, DEFAULT_LAT, DEFAULT_ALT),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch:   Cesium.Math.toRadians(-45),
      roll:    0.0,
    },
    duration: 3.0,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });

  // ── Screen-space event: update coords readout ────────────────────────────
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);

  handler.setInputAction((movement) => {
    const cartesian = viewer.camera.pickEllipsoid(
      movement.endPosition,
      viewer.scene.globe.ellipsoid
    );
    if (!cartesian) return;

    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lat   = Cesium.Math.toDegrees(carto.latitude).toFixed(5);
    const lon   = Cesium.Math.toDegrees(carto.longitude).toFixed(5);

    document.getElementById('coord-lat').textContent =
      `LAT ${lat > 0 ? '+' : ''}${lat}°`;
    document.getElementById('coord-lon').textContent =
      `LON ${lon > 0 ? '+' : ''}${lon}°`;
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // Altitude from actual camera height
  viewer.scene.postRender.addEventListener(() => {
    const altM = viewer.camera.positionCartographic.height;
    document.getElementById('coord-alt').textContent =
      `ALT ${(altM / 1000).toFixed(1)} km`;
  });

  return camera;
}

/**
 * Fly the camera to a named city or explicit coordinates.
 * @param {Cesium.Viewer} viewer
 * @param {{ lon: number, lat: number, alt?: number, heading?: number, pitch?: number }} opts
 */
export function flyTo(viewer, { lon, lat, alt = 1500, heading = 0, pitch = -30 }) {
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

/** Named city presets */
export const CITIES = {
  austin:  { lon: -97.7431, lat: 30.2672, alt:  8000 },
  london:  { lon:  -0.1276, lat: 51.5074, alt:  8000 },
  nyc:     { lon: -74.0060, lat: 40.7128, alt:  8000 },
  tokyo:   { lon: 139.6917, lat: 35.6895, alt:  8000 },
  dubai:   { lon:  55.2708, lat: 25.2048, alt:  8000 },
  globe:   { lon:   0,      lat: 20,      alt: 20_000_000 },
};
