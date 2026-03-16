/**
 * File: src/ui/Controls.js
 * Purpose: Wires layer controls, filter toggles, and display mode interactions.
 * Last updated: 2026-03-13
 */

let currentMode = 'normal';
const SERVER_HEAVY_MODE = ((import.meta.env.VITE_SERVER_HEAVY_MODE ?? 'false').toLowerCase() === 'true');

// Track collapsed state for filter containers
const filterCollapsedState = new Map();

function setSatelliteFilterButtonsActive(active) {
  const satFilterButtons = document.querySelectorAll('.filter-btn[data-filter^="satellites:"]');
  satFilterButtons.forEach((filterBtn) => {
    filterBtn.classList.toggle('active', active);
    filterBtn.classList.toggle('inactive', !active);
  });
}

function setFlightClassificationButtonsActive(active) {
  const flightClassButtons = document.querySelectorAll('.filter-btn[data-filter^="flights-classification:"], .filter-btn[data-filter^="flights-overlay:"]');
  flightClassButtons.forEach((filterBtn) => {
    filterBtn.classList.toggle('active', active);
    filterBtn.classList.toggle('inactive', !active);
  });
}

export function initControls(viewer, layers) {
  if (SERVER_HEAVY_MODE) {
    setSatelliteFilterButtonsActive(false);
  }

  // ── Layer toggles ────────────────────────────────────────────────────────
  document.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Check if click was on the collapse chevron
      const chevron = btn.querySelector('.collapse-chevron');
      if (e.target === chevron) {
        e.stopPropagation();
        const layerName = btn.dataset.layer;
        const filterContainer = btn.nextElementSibling;
        if (filterContainer?.classList.contains('filter-container')) {
          const isCollapsed = filterContainer.classList.toggle('collapsed');
          btn.classList.toggle('collapsed', isCollapsed);
          filterCollapsedState.set(layerName, isCollapsed);
        }
        return;
      }

      const layerName = btn.dataset.layer;
      const isActive = btn.classList.toggle('active');
      btn.classList.toggle('inactive', !isActive);

      const layer = layers[layerName];
      if (layer?.setEnabled) layer.setEnabled(isActive);

      window.dispatchEvent(new CustomEvent('shadowgrid:layer-toggle', {
        detail: { layer: layerName, active: isActive },
      }));

      if (SERVER_HEAVY_MODE && layerName === 'satellites' && isActive) {
        // In heavy mode start with no categories enabled so operators opt-in.
        setSatelliteFilterButtonsActive(false);
        const satFilterButtons = document.querySelectorAll('.filter-btn[data-filter^="satellites:"]');
        satFilterButtons.forEach((filterBtn) => {
          const [, filterType] = (filterBtn.dataset.filter ?? '').split(':');
          if (filterType) {
            layer?.setClassificationFilter?.(filterType, false);
          }
        });
      }

      if (layerName === 'flights' && isActive) {
        // Start Air Traffic classifications disabled so operators opt-in.
        setFlightClassificationButtonsActive(false);

        const flightClassButtons = document.querySelectorAll('.filter-btn[data-filter^="flights-classification:"]');
        flightClassButtons.forEach((filterBtn) => {
          const [, filterType] = (filterBtn.dataset.filter ?? '').split(':');
          if (filterType) {
            layer?.setAircraftClassificationFilter?.(filterType, false);
          }
        });

        const flightOverlayButtons = document.querySelectorAll('.filter-btn[data-filter^="flights-overlay:"]');
        flightOverlayButtons.forEach((filterBtn) => {
          const [, filterType] = (filterBtn.dataset.filter ?? '').split(':');
          if (filterType) {
            layer?.setFlightZoneFilter?.(filterType, false);
          }
        });
      }

      // Show/hide filter container for this layer
      const filterContainer = btn.nextElementSibling;
      if (filterContainer?.classList.contains('filter-container')) {
        filterContainer.classList.toggle('visible', isActive);
        btn.classList.toggle('has-filters', isActive);
        if (isActive) {
          // Auto-expand options for expandable active layers.
          filterContainer.classList.remove('collapsed');
          btn.classList.remove('collapsed');
          filterCollapsedState.set(layerName, false);
        } else {
          // Keep collapsed state remembered while hidden.
          const isCollapsed = filterCollapsedState.get(layerName) ?? false;
          filterContainer.classList.toggle('collapsed', isCollapsed);
          btn.classList.toggle('collapsed', isCollapsed);
        }
      }
    });
  });

  // ── Classification/type filters ──────────────────────────────────────────
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      
      const filterSpec = btn.dataset.filter; // e.g., "satellites:military" or "flights-classification:military"
      let layerName, filterType, filterCategory;
      
      // Handle new format: "flights-classification:military" or "satellites:military"
      if (filterSpec.includes('-')) {
        const parts = filterSpec.split(':');
        const prefix = parts[0]; // e.g., "flights-classification"
        filterType = parts[1]; // e.g., "military"
        
        if (prefix === 'flights-classification') {
          layerName = 'flights';
          filterCategory = 'classification';
        } else if (prefix === 'flights-overlay') {
          layerName = 'flights';
          filterCategory = 'overlay';
        }
      } else {
        // Old satellite format: "satellites:military"
        const parts = filterSpec.split(':');
        layerName = parts[0];
        filterType = parts[1];
      }
      
      const isActive = btn.classList.toggle('active');
      btn.classList.toggle('inactive', !isActive);

      const layer = layers[layerName];
      if (layerName === 'flights' && filterCategory === 'classification') {
        layer?.setAircraftClassificationFilter?.(filterType, isActive);
      } else if (layerName === 'flights' && filterCategory === 'overlay') {
        layer?.setFlightZoneFilter?.(filterType, isActive);
      } else {
        // Satellites classification filter
        layer?.setClassificationFilter?.(filterType, isActive);
      }
    });
  });

  // ── Shader modes (Filters menu) ─────────────────────────────────────────
  const setFiltersMenuOpen = (isOpen) => {
    const filtersMenu = document.getElementById('hud-filters-menu');
    const filtersToggle = document.getElementById('hud-filters-toggle');
    if (!filtersMenu || !filtersToggle) return;
    filtersMenu.style.display = isOpen ? 'flex' : 'none';
    filtersToggle.textContent = isOpen ? 'Filters ▴' : 'Filters ▾';
  };

  const setLayersMenuOpen = (isOpen) => {
    const layersMenu = document.getElementById('hud-layers-menu');
    const layersToggle = document.getElementById('hud-layers-toggle');
    if (!layersMenu || !layersToggle) return;
    layersMenu.style.display = isOpen ? 'block' : 'none';
    layersToggle.textContent = isOpen ? 'Layers ▴' : 'Layers ▾';
  };

  setFiltersMenuOpen(false);

  document.addEventListener('click', (e) => {
    const filtersMenu = document.getElementById('hud-filters-menu');
    const filtersRoot = e.target.closest('#hud-filters');
    const toggleBtn = e.target.closest('#hud-filters-toggle');
    const shaderBtn = e.target.closest('.shader-option-btn');
    const layersMenu = document.getElementById('hud-layers-menu');
    const layersRoot = e.target.closest('#hud-layers');
    const layersToggleBtn = e.target.closest('#hud-layers-toggle');

    if (layersToggleBtn) {
      e.stopPropagation();
      const isOpen = !!layersMenu && layersMenu.style.display !== 'none';
      setLayersMenuOpen(!isOpen);
      return;
    }

    if (toggleBtn) {
      e.stopPropagation();
      const isOpen = !!filtersMenu && filtersMenu.style.display !== 'none';
      setFiltersMenuOpen(!isOpen);
      return;
    }

    if (shaderBtn) {
      e.stopPropagation();
      const mode = shaderBtn.dataset.mode;
      if (!mode) return;

      document.querySelectorAll('.shader-option-btn').forEach((btn) => {
        const isActive = btn === shaderBtn;
        btn.classList.toggle('active', isActive);
        btn.style.color = isActive ? 'rgba(0,255,136,0.85)' : 'rgba(0,255,136,0.65)';
        btn.style.borderColor = isActive ? 'rgba(0,255,136,0.6)' : 'rgba(0,255,136,0.2)';
        btn.style.background = isActive ? 'rgba(0,255,136,0.16)' : 'rgba(0,0,0,0.48)';
      });

      applyShaderMode(viewer, mode);
      currentMode = mode;
      setFiltersMenuOpen(false);
      return;
    }

    if (filtersMenu && filtersMenu.style.display !== 'none' && !filtersRoot) {
      setFiltersMenuOpen(false);
    }

    if (layersMenu && layersMenu.style.display !== 'none' && !layersRoot) {
      setLayersMenuOpen(false);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setFiltersMenuOpen(false);
      setLayersMenuOpen(false);
    }
  });
}

function applyShaderMode(viewer, mode) {
  const body  = document.body;
  const scene = viewer.scene;
  const managedStages = new Set(['nvg', 'flir', 'crt']);

  // Remove all mode classes
  body.classList.remove('mode-nvg', 'mode-flir', 'mode-crt');

  // Clear any existing post-process stages we added.
  for (let i = scene.postProcessStages.length - 1; i >= 0; i -= 1) {
    const stage = scene.postProcessStages.get(i);
    if (managedStages.has(stage?.name)) {
      scene.postProcessStages.remove(stage);
    }
  }

  // Backward compatibility cleanup for the last applied stage pointer.
  if (scene._shadowgridStage) {
    scene.postProcessStages.remove(scene._shadowgridStage);
    scene._shadowgridStage = null;
  }

  switch (mode) {
    case 'normal':
      // Nothing — plain photorealistic, return to default Cesium rendering if coming from another mode
      break;

    case 'nvg':
      body.classList.add('mode-nvg');
      break;

    case 'flir':
      body.classList.add('mode-flir');
      break;

    case 'crt':
      body.classList.add('mode-crt');
      break;
  }
}
