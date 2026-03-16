/**
 * File: src/core/globe.js
 * Purpose: Creates the Cesium viewer and wires the configured globe/tiles provider.
 * Providers: Cesium ion, Google Photorealistic 3D Tiles, or MapTiler.
 * Last updated: 2026-03-13
 */

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

const PROVIDER     = (import.meta.env.VITE_MAP_PROVIDER        ?? 'cesium').toLowerCase();
const SERVER_HEAVY_MODE = (import.meta.env.VITE_SERVER_HEAVY_MODE ?? 'false').toLowerCase() === 'true';
const GOOGLE_KEY   =  import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '';
const CESIUM_TOKEN =  import.meta.env.VITE_CESIUM_ION_TOKEN    ?? '';
const MAPTILER_KEY =  import.meta.env.VITE_MAPTILER_API_KEY    ?? '';
const DAYNIGHT_ENABLED = (import.meta.env.VITE_DAYNIGHT_ENABLED ?? 'true').toLowerCase() !== 'false';
const DAYNIGHT_TIME_MODE = (import.meta.env.VITE_DAYNIGHT_TIME_MODE ?? 'realtime').toLowerCase();
const DAYNIGHT_TIME_MULTIPLIER = Number(import.meta.env.VITE_DAYNIGHT_TIME_MULTIPLIER ?? '240');
const DYNAMIC_LABELS_ENABLED = (import.meta.env.VITE_DYNAMIC_LABELS ?? 'true').toLowerCase() !== 'false';

const GOOGLE_TILESET_URL = SERVER_HEAVY_MODE
  ? '/api/localproxy/tiles/google/v1/3dtiles/root.json'
  : `https://tile.googleapis.com/v1/3dtiles/root.json?key=${GOOGLE_KEY}`;
const MAPTILER_TERRAIN_URL = SERVER_HEAVY_MODE
  ? '/api/localproxy/tiles/maptiler/tiles/terrain-quantized-mesh-v2/tiles.json'
  : `https://api.maptiler.com/tiles/terrain-quantized-mesh-v2/tiles.json?key=${MAPTILER_KEY}`;
const MAPTILER_SATELLITE_URL = SERVER_HEAVY_MODE
  ? '/api/localproxy/tiles/maptiler/tiles/satellite-v2/{z}/{x}/{y}.jpg'
  : `https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}`;

// ── Entry point ───────────────────────────────────────────────────────────────

export async function initGlobe(containerId) {
  // Set ion token before anything else
  if (CESIUM_TOKEN) {
    Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;
  } else {
    console.warn('[ShadowGrid] No VITE_CESIUM_ION_TOKEN set. Get a free token at https://ion.cesium.com');
  }

  switch (PROVIDER) {
    case 'google':   return initGoogle(containerId);
    case 'maptiler': return initMapTiler(containerId);
    case 'cesium':
    default:         return initCesiumIon(containerId);
  }
}

// ── Shared base viewer options ────────────────────────────────────────────────

function baseOptions() {
  return {
    animation:            false,
    baseLayerPicker:      false,
    fullscreenButton:     false,
    geocoder:             false,
    homeButton:           false,
    infoBox:              false,
    navigationHelpButton: false,
    sceneModePicker:      false,
    selectionIndicator:   false,
    timeline:             false,
    vrButton:             false,
    scene3DOnly:          true,
    requestRenderMode:    false,
    shadows:              false,
    // Suppress default imagery — each provider sets its own
    imageryProvider:      false,
  };
}

function applySceneSettings(viewer) {
  const scene = viewer.scene;
  scene.backgroundColor                = Cesium.Color.BLACK;
  scene.fog.enabled                    = false;
  scene.globe.enableLighting           = DAYNIGHT_ENABLED;
  scene.globe.dynamicAtmosphereLighting = DAYNIGHT_ENABLED;
  scene.globe.dynamicAtmosphereLightingFromSun = DAYNIGHT_ENABLED;
  scene.globe.showGroundAtmosphere     = DAYNIGHT_ENABLED;
  scene.skyAtmosphere.show             = DAYNIGHT_ENABLED;
  scene.globe.depthTestAgainstTerrain  = true;
  scene.postProcessStages.fxaa.enabled = true;

  if (DAYNIGHT_ENABLED) {
    // Use real UTC by default so the terminator matches current time accurately.
    // Optional cinematic mode can be enabled via env vars when desired.
    if (DAYNIGHT_TIME_MODE === 'accelerated') {
      viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
      viewer.clock.multiplier = Number.isFinite(DAYNIGHT_TIME_MULTIPLIER)
        ? DAYNIGHT_TIME_MULTIPLIER
        : 240;
      viewer.clock.shouldAnimate = true;
    } else {
      viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK;
      viewer.clock.multiplier = 1;
      viewer.clock.shouldAnimate = true;
      viewer.clock.currentTime = Cesium.JulianDate.now();
    }
  }

  // ── Google Earth-style camera controls ───────────────────────────────────
  const ctrl = viewer.scene.screenSpaceCameraController;

  // Left-drag = pan (translate across the surface) — Google Earth default
  ctrl.tiltEventTypes = [
    Cesium.CameraEventType.RIGHT_DRAG,           // right-drag = tilt/orbit
    { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.CTRL },
  ];
  ctrl.rotateEventTypes = [
    Cesium.CameraEventType.LEFT_DRAG,
  ];
  ctrl.translateEventTypes = [
    Cesium.CameraEventType.MIDDLE_DRAG,
  ];
  // WHEEL is handled manually below so zoom targets the crosshair (screen centre),
  // not the mouse cursor position. Pinch and shift-drag remain Cesium-native.
  ctrl.zoomEventTypes = [
    Cesium.CameraEventType.PINCH,                // pinch = zoom (touch)
    { eventType: Cesium.CameraEventType.RIGHT_DRAG, modifier: Cesium.KeyboardEventModifier.SHIFT },
  ];
  ctrl.lookEventTypes = [
    { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.SHIFT },
  ];

  // Feel tuning — snappier zoom, smoother pan inertia
  ctrl.inertiaSpin          = 0.5;
  ctrl.inertiaTranslate     = 0.75;
  ctrl.inertiaZoom          = 0.2;
  ctrl.minimumZoomDistance  = 100;    // don't go below 100 m
  ctrl.maximumZoomDistance  = 2.0e7; // don't zoom out past ~20 000 km
  ctrl.enableCollisionDetection = true;

  // ── Crosshair-centred scroll zoom ─────────────────────────────────────────
  // camera.zoomIn/Out moves along the camera direction (= toward screen centre),
  // giving crosshair-locked zoom regardless of where the cursor sits.
  viewer.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const camera = viewer.camera;
    const height = camera.positionCartographic?.height ?? 1_000;
    // Normalise deltaY: browsers report in pixels (mode 0), lines (1), or pages (2)
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 20;
    if (e.deltaMode === 2) delta *= 400;
    // Zoom ~15 % of current altitude per standard scroll click
    const amount = Math.abs(delta) * height * 0.0015;
    if (delta < 0) {
      if (height > ctrl.minimumZoomDistance) camera.zoomIn(amount);
    } else {
      if (height < ctrl.maximumZoomDistance) camera.zoomOut(amount);
    }
  }, { passive: false });
}


// ── Labels + borders overlay ──────────────────────────────────────────────────
// Adds a transparent country/city labels + borders layer on top of any base imagery.
// Uses Cesium ion asset 3812 (Cesium OSM Labels) — free, no extra key needed.

async function addLabelsOverlay(viewer) {
  if (!DYNAMIC_LABELS_ENABLED) {
    console.info('[ShadowGrid] Dynamic labels disabled by VITE_DYNAMIC_LABELS=false');
    return;
  }

  try {
    // Use one adaptive label source (which naturally increases detail by zoom)
    // and toggle visibility by altitude to avoid overloading lower-end GPUs.
    const boundaries = viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url:    'https://tiles.stadiamaps.com/tiles/stamen_toner_lines/{z}/{x}/{y}.png',
        credit: '© Stadia Maps © Stamen Design © OpenStreetMap contributors',
        minimumLevel: 2,
        maximumLevel: 16,
      })
    );

    const adaptiveLabels = viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url:    'https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png',
        credit: '© OpenStreetMap contributors © CARTO',
        minimumLevel: 0,
        maximumLevel: 20,
      })
    );

    const LABEL_HEIGHT = {
      hideAllAbove:      9_000_000,
      showBoundariesBelow: 4_500_000,
      showLabelsBelow:     2_000_000,
    };

    let orbitalSuppressed = false;

    function syncLabelVisibility() {
      const h = viewer.camera.positionCartographic?.height ?? Number.POSITIVE_INFINITY;
      const allowAny = h <= LABEL_HEIGHT.hideAllAbove;
      const visible = allowAny && !orbitalSuppressed;

      boundaries.show = visible && h <= LABEL_HEIGHT.showBoundariesBelow;
      adaptiveLabels.show = visible && h <= LABEL_HEIGHT.showLabelsBelow;

      // Fade in labels as the camera gets closer for smoother transitions.
      if (adaptiveLabels.show) {
        const fadeRange = 350_000;
        const start = LABEL_HEIGHT.showLabelsBelow;
        const t = Cesium.Math.clamp((start - h) / fadeRange, 0, 1);
        adaptiveLabels.alpha = 0.4 + 0.6 * t;
      }
    }

    window.addEventListener('shadowgrid:camera-orbital-mode', (ev) => {
      orbitalSuppressed = !!ev?.detail?.enabled;
      syncLabelVisibility();
    });

    viewer.camera.changed.addEventListener(syncLabelVisibility);
    viewer.camera.moveEnd.addEventListener(syncLabelVisibility);
    syncLabelVisibility();

    console.info('[ShadowGrid] Dynamic labels overlay added ✓');
  } catch (err) {
    console.warn('[ShadowGrid] Labels overlay unavailable:', err.message);
  }
}

// ── Provider: Cesium ion ──────────────────────────────────────────────────────

async function initCesiumIon(containerId) {
  console.info('[ShadowGrid] Provider: Cesium ion');

  // Resolve terrain BEFORE constructing Viewer — avoids the async-in-constructor hang
  let terrainProvider;
  try {
    terrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1, {
      requestWaterMask:     true,
      requestVertexNormals: true,
    });
  } catch (err) {
    console.warn('[ShadowGrid] World Terrain failed, using ellipsoid:', err.message);
    terrainProvider = new Cesium.EllipsoidTerrainProvider();
  }

  const viewer = new Cesium.Viewer(containerId, {
    ...baseOptions(),
    terrainProvider,
  });

  applySceneSettings(viewer);

  // Add Bing satellite imagery
  try {
    const bing = await Cesium.IonImageryProvider.fromAssetId(2);
    viewer.imageryLayers.addImageryProvider(bing);
  } catch (err) {
    console.warn('[ShadowGrid] Bing imagery unavailable:', err.message);
    // Fallback to OpenStreetMap so the globe isn't blank
    viewer.imageryLayers.addImageryProvider(
      new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
    );
  }

  // Labels + borders overlay (on top of satellite)
  await addLabelsOverlay(viewer);

  // OSM 3D Buildings
  try {
    const osm = await Cesium.createOsmBuildingsAsync();
    viewer.scene.primitives.add(osm);
  } catch (err) {
    console.warn('[ShadowGrid] OSM Buildings unavailable:', err.message);
  }

  window.__wv_viewer = viewer;
  console.info('[ShadowGrid] Cesium ion ready ✓');
  return viewer;
}

// ── Provider: Google Photorealistic 3D Tiles ──────────────────────────────────

async function initGoogle(containerId) {
  if (!GOOGLE_KEY) {
    console.warn('[ShadowGrid] No VITE_GOOGLE_MAPS_API_KEY — falling back to Cesium ion.');
    return initCesiumIon(containerId);
  }

  console.info('[ShadowGrid] Provider: Google Photorealistic 3D Tiles');

  const viewer = new Cesium.Viewer(containerId, {
    ...baseOptions(),
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  });

  applySceneSettings(viewer);
  viewer.scene.globe.show = false; // 3D Tiles replace the globe surface

  try {
    Cesium.RequestScheduler.requestsByServer['tile.googleapis.com:443'] = 18;
    const tileset = await Cesium.Cesium3DTileset.fromUrl(GOOGLE_TILESET_URL, {
      showCreditsOnScreen:     true,
      maximumScreenSpaceError: 8,
    });
    viewer.scene.primitives.add(tileset);
    await viewer.zoomTo(tileset);
    console.info('[ShadowGrid] Google 3D Tiles ready ✓');
  } catch (err) {
    console.error('[ShadowGrid] Google 3D Tiles failed — falling back to Cesium ion:', err.message);
    viewer.scene.globe.show = true;
    return initCesiumIon(containerId);
  }

  window.__wv_viewer = viewer;
  return viewer;
}

// ── Provider: MapTiler ────────────────────────────────────────────────────────

async function initMapTiler(containerId) {
  if (!MAPTILER_KEY) {
    console.warn('[ShadowGrid] No VITE_MAPTILER_API_KEY — falling back to Cesium ion.');
    return initCesiumIon(containerId);
  }

  console.info('[ShadowGrid] Provider: MapTiler');

  // Resolve terrain before Viewer construction
  let terrainProvider;
  try {
    terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(MAPTILER_TERRAIN_URL, {
      requestVertexNormals: true,
    });
  } catch (err) {
    console.warn('[ShadowGrid] MapTiler terrain failed — falling back to Cesium ion:', err.message);
    return initCesiumIon(containerId);
  }

  const viewer = new Cesium.Viewer(containerId, {
    ...baseOptions(),
    terrainProvider,
  });

  applySceneSettings(viewer);

  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({
      url:          MAPTILER_SATELLITE_URL,
      credit:       '© MapTiler © OpenStreetMap contributors',
      minimumLevel: 0,
      maximumLevel: 20,
      tileWidth:    256,
      tileHeight:   256,
    })
  );

  await addLabelsOverlay(viewer);

  window.__wv_viewer = viewer;
  console.info('[ShadowGrid] MapTiler ready ✓');
  return viewer;
}
