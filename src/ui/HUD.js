/**
 * ui/HUD.js
 * Renders the targeting reticle crosshair on the canvas,
 * and handles click-to-inspect entity info panels.
 */

import * as Cesium from 'cesium';

export function initHUD(viewer) {
  drawReticle(viewer);
  initEntityPicker(viewer);
}

// ── Targeting reticle ────────────────────────────────────────────────────────

function drawReticle(viewer) {
  const canvas = viewer.canvas;

  // Overlay a transparent canvas on top of Cesium
  const overlay   = document.createElement('canvas');
  overlay.style.cssText = `
    position: fixed; inset: 0;
    pointer-events: none; z-index: 9;
    width: 100%; height: 100%;
  `;
  document.body.appendChild(overlay);

  function resize() {
    overlay.width  = canvas.width;
    overlay.height = canvas.height;
    render();
  }

  function render() {
    const ctx = overlay.getContext('2d');
    const cx  = overlay.width  / 2;
    const cy  = overlay.height / 2;
    const r   = 22;
    const gap = 5;

    ctx.clearRect(0, 0, overlay.width, overlay.height);

    ctx.strokeStyle = 'rgba(0,255,136,0.55)';
    ctx.lineWidth   = 1;

    // Cross hairs
    [[cx - r - gap, cy, cx - gap, cy],
     [cx + gap, cy, cx + r + gap, cy],
     [cx, cy - r - gap, cx, cy - gap],
     [cx, cy + gap, cx, cy + r + gap]].forEach(([x1,y1,x2,y2]) => {
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    });

    // Circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Corner ticks at cardinal angles
    const ticks = [0, Math.PI/2, Math.PI, 3*Math.PI/2];
    ticks.forEach(angle => {
      const x = cx + (r - 6) * Math.cos(angle);
      const y = cy + (r - 6) * Math.sin(angle);
      const x2 = cx + (r + 4) * Math.cos(angle);
      const y2 = cy + (r + 4) * Math.sin(angle);
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x2,y2); ctx.stroke();
    });
  }

  window.addEventListener('resize', resize);
  resize();
}

// ── Entity picker ────────────────────────────────────────────────────────────

function initEntityPicker(viewer) {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);

  // Create info panel element
  const panel = document.createElement('div');
  panel.id    = 'info-panel';
  panel.style.cssText = `
    position: fixed;
    top: 80px; right: 150px;
    background: rgba(0,0,0,0.8);
    border: 1px solid rgba(0,255,136,0.4);
    color: #00ff88;
    font-family: 'Share Tech Mono', monospace;
    font-size: 11px;
    line-height: 1.8;
    padding: 14px 18px;
    pointer-events: all;
    display: none;
    backdrop-filter: blur(8px);
    min-width: 220px;
    z-index: 20;
    letter-spacing: 0.06em;
  `;
  document.body.appendChild(panel);

  // Close button
  const close = document.createElement('div');
  close.textContent = '✕';
  close.style.cssText = `
    position: absolute; top: 8px; right: 12px;
    cursor: pointer; opacity: 0.5;
    font-size: 12px;
  `;
  close.addEventListener('click', () => { panel.style.display = 'none'; });
  panel.appendChild(close);

  handler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (!Cesium.defined(picked) || !picked.id) {
      panel.style.display = 'none';
      return;
    }

    const entity = picked.id;
    const props  = entity.properties;
    if (!props) return;

    const type = props.type?.getValue();
    let html   = '';

    if (type === 'flight') {
      const callsign = props.callsign?.getValue() ?? '–';
      const alt      = props.altitude?.getValue();
      const spd      = props.velocity?.getValue();
      html = `
        <div style="font-size:13px;font-weight:bold;margin-bottom:8px;letter-spacing:0.15em">
          ✈ ${callsign}
        </div>
        <div>ICAO: ${entity.id}</div>
        <div>ALT: ${alt ? (alt/1000).toFixed(1) + ' km' : '–'}</div>
        <div>SPD: ${spd ? Math.round(spd * 1.944) + ' kts' : '–'}</div>
        <div style="margin-top:8px;opacity:0.5;font-size:9px">LIVE · OPENSKY</div>
      `;
    } else if (type === 'satellite') {
      const name = props.name?.getValue() ?? entity.id;
      html = `
        <div style="font-size:13px;font-weight:bold;margin-bottom:8px;letter-spacing:0.15em;color:#00aaff">
          ◈ ${name}
        </div>
        <div style="opacity:0.7">ORBITAL TRACKING ACTIVE</div>
        <div style="margin-top:8px;opacity:0.5;font-size:9px">LIVE · CELESTRAK TLE</div>
      `;
    }

    if (html) {
      panel.innerHTML = html;
      panel.appendChild(close);
      panel.style.display = 'block';
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}
