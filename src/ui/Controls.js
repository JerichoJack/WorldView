/**
 * ui/Controls.js
 * Wires up the layer toggle buttons and shader mode buttons.
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
          filterCollapsedState.set(layerName, isCollapsed);
        }
        return;
      }

      const layerName = btn.dataset.layer;
      const isActive = btn.classList.toggle('active');
      btn.classList.toggle('inactive', !isActive);

      const layer = layers[layerName];
      if (layer?.setEnabled) layer.setEnabled(isActive);

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

      // Show/hide filter container for this layer
      const filterContainer = btn.nextElementSibling;
      if (filterContainer?.classList.contains('filter-container')) {
        filterContainer.classList.toggle('visible', isActive);
        btn.classList.toggle('has-filters', isActive);
        // Keep the collapsed state if it was set previously
        if (!filterCollapsedState.has(layerName)) {
          filterCollapsedState.set(layerName, true); // Start collapsed by default
          filterContainer.classList.add('collapsed');
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
        } else if (prefix === 'flights-type') {
          layerName = 'flights';
          filterCategory = 'type';
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
      } else if (layerName === 'flights' && filterCategory === 'type') {
        layer?.setAircraftTypeFilter?.(filterType, isActive);
      } else {
        // Satellites classification filter
        layer?.setClassificationFilter?.(filterType, isActive);
      }
    });
  });

  // ── Shader modes ─────────────────────────────────────────────────────────
  document.querySelectorAll('.shader-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentMode) return;

      // Update button states
      document.querySelectorAll('.shader-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Apply visual mode
      applyShaderMode(viewer, mode);
      currentMode = mode;
    });
  });
}

function applyShaderMode(viewer, mode) {
  const body  = document.body;
  const scene = viewer.scene;

  // Remove all mode classes
  body.classList.remove('mode-nvg', 'mode-flir', 'mode-crt', 'mode-anime');

  // Clear any existing post-process stages we added
  if (scene._shadowgridStage) {
    scene.postProcessStages.remove(scene._shadowgridStage);
    scene._shadowgridStage = null;
  }

  switch (mode) {
    case 'normal':
      // Nothing — plain photorealistic
      break;

    case 'nvg':
      body.classList.add('mode-nvg');
      scene._shadowgridStage = scene.postProcessStages.add(
        buildNVGStage()
      );
      break;

    case 'flir':
      body.classList.add('mode-flir');
      scene._shadowgridStage = scene.postProcessStages.add(
        buildFLIRStage()
      );
      break;

    case 'crt':
      body.classList.add('mode-crt');
      scene._shadowgridStage = scene.postProcessStages.add(
        buildCRTStage()
      );
      break;

    case 'anime':
      body.classList.add('mode-anime');
      scene._shadowgridStage = scene.postProcessStages.add(
        buildAnimeStage()
      );
      break;
  }
}

// ── Shader stage builders ────────────────────────────────────────────────────

function buildNVGStage() {
  return new Cesium.PostProcessStage({
    name: 'nvg',
    fragmentShader: `
      uniform sampler2D colorTexture;
      in vec2 v_textureCoordinates;
      void main() {
        vec4 color = texture(colorTexture, v_textureCoordinates);
        float lum  = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        float amp  = lum * 2.2;
        // Green phosphor + noise grain
        float noise = fract(sin(dot(v_textureCoordinates, vec2(12.9898,78.233))) * 43758.5453);
        amp += (noise - 0.5) * 0.04;
        out_FragColor = vec4(0.0, amp, amp * 0.25, color.a);
      }
    `,
  });
}

function buildFLIRStage() {
  return new Cesium.PostProcessStage({
    name: 'flir',
    fragmentShader: `
      uniform sampler2D colorTexture;
      in vec2 v_textureCoordinates;

      vec3 ironbow(float t) {
        // Iron/hot palette approximation
        vec3 c;
        c.r = clamp(t * 3.0,       0.0, 1.0);
        c.g = clamp(t * 3.0 - 1.0, 0.0, 1.0);
        c.b = clamp(t * 3.0 - 2.0, 0.0, 1.0);
        return c;
      }

      void main() {
        vec4 color = texture(colorTexture, v_textureCoordinates);
        float lum  = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        // Invert so bright = hot (white), dark = cold (black → red → yellow)
        out_FragColor = vec4(ironbow(lum), color.a);
      }
    `,
  });
}

function buildCRTStage() {
  return new Cesium.PostProcessStage({
    name: 'crt',
    fragmentShader: `
      uniform sampler2D colorTexture;
      in vec2 v_textureCoordinates;

      void main() {
        // Barrel distortion
        vec2 uv  = v_textureCoordinates - 0.5;
        float r2 = dot(uv, uv);
        uv       = uv * (1.0 + 0.12 * r2);
        vec2 sampleUV = uv + 0.5;

        vec4 color = vec4(0.0);
        if (sampleUV.x >= 0.0 && sampleUV.x <= 1.0 &&
            sampleUV.y >= 0.0 && sampleUV.y <= 1.0) {
          color = texture(colorTexture, sampleUV);
        }

        // Phosphor scanlines
        float scanline = sin(sampleUV.y * 800.0) * 0.04;
        color.rgb      -= scanline;

        // Amber tint
        color.rgb      = mix(color.rgb, vec3(1.0, 0.65, 0.0), 0.15);

        // Vignette
        float vig = 1.0 - r2 * 1.8;
        color.rgb *= clamp(vig, 0.0, 1.0);

        out_FragColor = color;
      }
    `,
  });
}

function buildAnimeStage() {
  return new Cesium.PostProcessStage({
    name: 'anime',
    fragmentShader: `
      uniform sampler2D colorTexture;
      in vec2 v_textureCoordinates;

      void main() {
        vec2 uv     = v_textureCoordinates;
        vec2 texel  = vec2(1.0 / 1920.0, 1.0 / 1080.0);

        // Sobel edge detection
        vec3 tl = texture(colorTexture, uv + vec2(-1,-1)*texel).rgb;
        vec3 t  = texture(colorTexture, uv + vec2( 0,-1)*texel).rgb;
        vec3 tr = texture(colorTexture, uv + vec2( 1,-1)*texel).rgb;
        vec3 l  = texture(colorTexture, uv + vec2(-1, 0)*texel).rgb;
        vec3 r  = texture(colorTexture, uv + vec2( 1, 0)*texel).rgb;
        vec3 bl = texture(colorTexture, uv + vec2(-1, 1)*texel).rgb;
        vec3 b  = texture(colorTexture, uv + vec2( 0, 1)*texel).rgb;
        vec3 br = texture(colorTexture, uv + vec2( 1, 1)*texel).rgb;

        vec3 sobelX = -tl - 2.0*l - bl + tr + 2.0*r + br;
        vec3 sobelY = -tl - 2.0*t - tr + bl + 2.0*b + br;
        float edge  = length(sobelX) + length(sobelY);
        edge        = step(0.3, edge);

        // Cel-shade: quantize to 4 bands
        vec3 color  = texture(colorTexture, uv).rgb;
        color       = floor(color * 4.0) / 4.0;

        // Black outline
        color       = mix(color, vec3(0.0), edge);

        // Slight saturation boost
        float lum   = dot(color, vec3(0.299, 0.587, 0.114));
        color       = mix(vec3(lum), color, 1.6);

        out_FragColor = vec4(color, 1.0);
      }
    `,
  });
}
