/**
 * core/globe.js
 * Initialises the CesiumJS viewer and mounts Google Photorealistic 3D Tiles.
 *
 * Docs:
 *   https://cesium.com/learn/cesiumjs/ref-doc/Viewer.html
 *   https://developers.google.com/maps/documentation/tile/3d-tiles
 */

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// Google's 3D Tiles tileset URL
const GOOGLE_3D_TILES_URL =
  `https://tile.googleapis.com/v1/3dtiles/root.json?key=${GOOGLE_API_KEY}`;

export async function initGlobe(containerId) {
  // Point CesiumJS at its own static assets (handled by vite-plugin-cesium)
  window.CESIUM_BASE_URL = '/cesium';

  const viewer = new Cesium.Viewer(containerId, {
    // ── Disable all default Cesium UI chrome ──────────────────────────────
    animation:              false,
    baseLayerPicker:        false,
    fullscreenButton:       false,
    geocoder:               false,
    homeButton:             false,
    infoBox:                false,
    navigationHelpButton:   false,
    sceneModePicker:        false,
    selectionIndicator:     false,
    timeline:               false,
    vrButton:               false,

    // ── Imagery: turn off default Bing so 3D Tiles provides all visuals ───
    imageryProvider: false,

    // ── Scene settings ────────────────────────────────────────────────────
    scene3DOnly:          true,
    requestRenderMode:    false,   // continuous render for live data
    shadows:              false,   // perf
    terrainProvider:      new Cesium.EllipsoidTerrainProvider(),
  });

  // ── Scene tweaks ─────────────────────────────────────────────────────────
  const scene  = viewer.scene;
  const globe  = viewer.globe;

  globe.show                            = false; // 3D Tiles replaces the globe surface
  scene.skyBox.show                     = true;
  scene.backgroundColor                 = Cesium.Color.BLACK;
  scene.fog.enabled                     = false;
  scene.globe.enableLighting            = false;

  // Depth testing so buildings occlude correctly
  scene.globe.depthTestAgainstTerrain   = true;

  // Nicer anti-aliasing
  scene.postProcessStages.fxaa.enabled  = true;

  // ── Google Photorealistic 3D Tiles ────────────────────────────────────────
  if (!GOOGLE_API_KEY || GOOGLE_API_KEY === 'YOUR_GOOGLE_MAPS_API_KEY') {
    console.warn(
      '[WorldView] No Google Maps API key found.\n' +
      'Copy .env.example → .env and add VITE_GOOGLE_MAPS_API_KEY.\n' +
      'Falling back to Cesium World Terrain.'
    );
    // Fallback: standard Cesium World Terrain + Bing imagery
    viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
    viewer.imageryLayers.addImageryProvider(
      await Cesium.IonImageryProvider.fromAssetId(2)
    );
  } else {
    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(GOOGLE_3D_TILES_URL, {
        showCreditsOnScreen: true,
        maximumScreenSpaceError: 8,   // lower = sharper, higher = faster
      });

      viewer.scene.primitives.add(tileset);

      // Fit the tileset into view
      await viewer.zoomTo(tileset);

      console.info('[WorldView] Google Photorealistic 3D Tiles loaded ✓');
    } catch (err) {
      console.error('[WorldView] Failed to load Google 3D Tiles:', err);
      throw err;
    }
  }

  // ── Expose viewer globally for easy debugging ─────────────────────────────
  window.__wv_viewer = viewer;

  return viewer;
}
