/**
 * File: src/main.js
 * Purpose: Application bootstrap sequence for globe, layers, controls, and HUD.
 * Last updated: 2026-03-13
 */

import { initGlobe } from './core/globe.js';
import { initCamera } from './core/camera.js';
import { initFlights } from './layers/flights.js';
import { initSatellites } from './layers/satellites.js';
import { initTraffic } from './layers/traffic.js';
import { initMarineTraffic } from './layers/marineTraffic.js';
import { initCCTV } from './layers/cctv.js';
import { initInternet } from './layers/intrenet.js';
import { initAirspace } from './layers/airspace.js';
import { initControls } from './ui/Controls.js';
import { initHUD, updateHUDCounts } from './ui/HUD.js';
import { initCitySearch } from './ui/citySearch.js';
import { registerServerSnapshotViewer } from './core/serverSnapshot.js';
// startClock removed — HUD.js owns the UTC clock now

// ── Boot sequence ──────────────────────────────────────────────────────────

async function boot() {
  const steps = [
    { label: 'Initializing 3D Tiles…',       pct: 10 },
    { label: 'Loading photorealistic globe…', pct: 30 },
    { label: 'Connecting flight feeds…',      pct: 50 },
    { label: 'Propagating satellite orbits…', pct: 65 },
    { label: 'Initializing street traffic…',  pct: 75 },
    { label: 'Initializing CCTV layer…',      pct: 85 },
    { label: 'Loading GPS, Flight Restrictions, and Internet overlays…',     pct: 90 },
    { label: 'Mounting HUD…',                 pct: 92 },
    { label: 'System nominal.',               pct: 100 },
  ];

  const loadBar    = document.getElementById('load-bar');
  const loadStatus = document.getElementById('load-status');

  function setProgress(pct, label) {
    loadBar.style.width    = pct + '%';
    loadStatus.textContent = label;
  }

  // Step 1 – Globe
  setProgress(steps[0].pct, steps[0].label);
  const viewer = await initGlobe('cesium-container');
  registerServerSnapshotViewer(viewer);

  // Step 2 – Camera
  setProgress(steps[1].pct, steps[1].label);
  await initCamera(viewer);

  // Step 3 – Flights
  setProgress(steps[2].pct, steps[2].label);
  const flights = await initFlights(viewer);
  flights?.setEnabled(false);  // Start with flights hidden

  // Step 4 – Satellites
  setProgress(steps[3].pct, steps[3].label);
  const satellites = await initSatellites(viewer);
  satellites?.setEnabled(false);  // Start with satellites hidden

  // Step 5 – Traffic
  setProgress(steps[4].pct, steps[4].label);
  const traffic = await initTraffic(viewer);
  traffic?.setEnabled(false);  // Start with traffic hidden

  // Step 5.5 – Marine Traffic
  const marineTraffic = await initMarineTraffic(viewer);
  marineTraffic?.setEnabled(false);  // Start with marine traffic hidden

  // Step 6 – CCTV
  setProgress(steps[5].pct, steps[5].label);
  const cctv = await initCCTV(viewer);
  cctv?.setEnabled(false);  // Start with CCTV hidden

  // Step 7 – Internet blackout overlays
  setProgress(steps[6].pct, steps[6].label);
  const internet = await initInternet(viewer);
  internet?.setEnabled(false); // Internet layer starts hidden

  const airspace = await initAirspace(viewer);
  airspace?.setEnabled(false); // Air Space layer starts hidden

  // Step 8 – UI
  setProgress(steps[7].pct, steps[7].label);
  initControls(viewer, { flights, satellites, traffic, marineTraffic, cctv, internet, airspace });

  initHUD(viewer);
  initCitySearch(viewer);

  // Step 9 – Done — hide loading screen
  setProgress(steps[8].pct, steps[8].label);
  await new Promise(r => setTimeout(r, 600));
  document.getElementById('loading').classList.add('hidden');

  // ── Live count feed → HUD status panel ──────────────────────────────────
  // Push aircraft + satellite + total-object counts every 5 s.
  setInterval(() => {
    const aircraftCount   = flights?.count   ?? 0;
    const satelliteCount  = satellites?.count ?? 0;
    const trafficCount    = traffic?.count    ?? 0;
    const cctvCount       = cctv?.count       ?? 0;
    const totalObjects    = viewer.entities.values.length;
    updateHUDCounts({
      aircraft:   aircraftCount,
      satellites: satelliteCount,
      traffic:    trafficCount,
      cctv:       cctvCount,
      objects:    totalObjects,
    });
  }, 5000);

  // Fire once immediately so it's not blank at startup
  updateHUDCounts({
    aircraft:   flights?.count   ?? 0,
    satellites: satellites?.count ?? 0,
    traffic:    traffic?.count    ?? 0,
    cctv:       cctv?.count       ?? 0,
    objects:    viewer.entities.values.length,
  });
}

boot().catch(err => {
  console.error('[ShadowGrid] Boot failed:', err);
  document.getElementById('load-status').textContent = 'Error: ' + err.message;
  document.getElementById('load-bar').style.background = '#ff3333';
});