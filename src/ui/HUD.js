/**
 * ui/HUD.js
 * Targeting reticle + rich aircraft info panel (adsb.lol style).
 *
 * Click panel fetches live enrichment from:
 *   - adsbdb.com  — registration, type, operator, route
 *   - hexdb.io    — fallback for registration + type
 */

import * as Cesium from 'cesium';
import { followEntity, stopFollow, isFollowing, followingLabel } from '../core/follow.js';
import { setFollowMode } from '../layers/flights.js';

export function initHUD(viewer) {
  drawReticle(viewer);
  initEntityPicker(viewer);

  // When follow is cancelled externally (user pans), update the panel button
  window.addEventListener('worldview:unfollow', () => {
    const btn = document.getElementById('follow-btn');
    if (btn) setFollowBtnState(btn, false);
  });
}

// ── Targeting reticle ─────────────────────────────────────────────────────────

function drawReticle(viewer) {
  const canvas  = viewer.canvas;
  const overlay = document.createElement('canvas');
  overlay.style.cssText = `
    position:fixed;inset:0;pointer-events:none;z-index:9;width:100%;height:100%;
  `;
  document.body.appendChild(overlay);

  function render() {
    overlay.width  = canvas.width;
    overlay.height = canvas.height;
    const ctx = overlay.getContext('2d');
    const cx  = overlay.width  / 2;
    const cy  = overlay.height / 2;
    const r = 22, gap = 5;

    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.strokeStyle = 'rgba(0,255,136,0.55)';
    ctx.lineWidth = 1;

    [[cx-r-gap,cy,cx-gap,cy],[cx+gap,cy,cx+r+gap,cy],
     [cx,cy-r-gap,cx,cy-gap],[cx,cy+gap,cx,cy+r+gap]].forEach(([x1,y1,x2,y2]) => {
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    });
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke();
    [0,Math.PI/2,Math.PI,3*Math.PI/2].forEach(a => {
      ctx.beginPath();
      ctx.moveTo(cx+(r-6)*Math.cos(a), cy+(r-6)*Math.sin(a));
      ctx.lineTo(cx+(r+4)*Math.cos(a), cy+(r+4)*Math.sin(a));
      ctx.stroke();
    });
  }
  window.addEventListener('resize', render);
  render();
}

// ── Entity picker + enriched panel ───────────────────────────────────────────

function initEntityPicker(viewer) {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);

  // ── Panel DOM ──────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'info-panel';
  Object.assign(panel.style, {
    position:       'fixed',
    top:            '80px',
    right:          '16px',
    background:     'rgba(4,10,18,0.92)',
    border:         '1px solid rgba(0,255,136,0.35)',
    color:          '#e0ffe8',
    fontFamily:     '"Share Tech Mono", monospace',
    fontSize:       '11px',
    lineHeight:     '1.75',
    padding:        '0',
    pointerEvents:  'all',
    display:        'none',
    backdropFilter: 'blur(10px)',
    width:          '280px',
    zIndex:         '20',
    borderRadius:   '4px',
    overflow:       'hidden',
    boxShadow:      '0 4px 32px rgba(0,0,0,0.7)',
  });
  document.body.appendChild(panel);

  // ── Click handler ──────────────────────────────────────────────────────────
  handler.setInputAction(async (click) => {
    const picked = viewer.scene.pick(click.position);
    if (!Cesium.defined(picked) || !picked.id) { panel.style.display = 'none'; return; }

    const entity = picked.id;
    const props  = entity.properties;
    if (!props) return;

    const type = props.type?.getValue();

    if (type === 'flight') {
      const icao     = (props.icao?.getValue() ?? String(entity.id).replace('flight-','')).toUpperCase();
      const callsign = (props.callsign?.getValue() ?? '').trim() || icao;
      const altFt    = props.altFt?.getValue() ?? 0;
      const kts      = props.kts?.getValue()   ?? 0;
      const heading  = props.heading?.getValue() ?? 0;
      const squawk   = props.squawk?.getValue() ?? '';
      const vert     = props.vert?.getValue()   ?? 0;
      const dbFlags  = props.dbFlags?.getValue()  ?? 0;
      const provider = (props.provider?.getValue() ?? 'adsb').toUpperCase();
      // Live type code from ADS-B feed (e.g. "B38M") — available immediately, no lookup needed
      const liveTypecode = (props.typecode?.getValue() ?? '').toUpperCase() || null;

      // Show a loading state immediately, pre-filled with live ADS-B data we already have
      panel.style.display = 'block';
      renderPanel(panel, { icao, callsign, altFt, kts, heading, squawk, vert, provider, dbFlags,
        typecode: liveTypecode, loading: true }, viewer, entity);

      // Fetch enrichment in background
      const info = await fetchAircraftInfo(icao.toLowerCase(), callsign);
      // Keep live typecode if enrichment didn't return one
      if (!info.typecode && liveTypecode) info.typecode = liveTypecode;
      renderPanel(panel, { icao, callsign, altFt, kts, heading, squawk, vert, provider, dbFlags, ...info }, viewer, entity);

    } else if (type === 'satellite') {
      const name     = props.name?.getValue() ?? entity.id;
      const provider = (props.provider?.getValue() ?? 'celestrak').toUpperCase();
      panel.style.display = 'block';
      panel.innerHTML = satelliteHtml(name, provider);
      wireFollowButton(panel, viewer, entity, name, 'satellite');
      wirePanelClose(panel);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

// ── Enrichment fetcher ────────────────────────────────────────────────────────

// Aircraft static info cached by ICAO (reg, type, operator — doesn't change)
const aircraftCache = new Map();
// Route cached by callsign (changes per flight — short TTL)
const routeCache    = new Map(); // callsign → { route, operator, ts }
const ROUTE_TTL     = 5 * 60 * 1000; // 5 minutes

async function fetchAircraftInfo(icao, callsign) {
  const info = { registration: null, typecode: null, typeDesc: null, operator: null, route: null, country: null, year: null };

  // ── 1. Static aircraft info (cached permanently per ICAO) ──────────────────
  if (aircraftCache.has(icao)) {
    Object.assign(info, aircraftCache.get(icao));
  } else {
    // Try adsbdb.com first
    try {
      const r = await fetch(`https://api.adsbdb.com/v0/aircraft/${icao}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        const a = d.response?.aircraft;
        if (a) {
          // type_code = ICAO designator (e.g. "B38M"), manufacturer + type_longname = full name
          info.typecode     = a.type_code ?? null;
          const mfr  = a.manufacturer  ?? '';
          const long = a.type_longname ?? '';
          // e.g. "B38M · Boeing 737 MAX 8"
          const fullName = [mfr, long].filter(Boolean).join(' ');
          info.typeDesc = (info.typecode && fullName)
            ? `${info.typecode} · ${fullName}`
            : (fullName || info.typecode || null);
          info.registration = a.registration ?? null;
          info.operator     = a.registered_owner ?? null;
          info.country      = a.registered_owner_country_iso_name ?? null;
          info.year         = a.year_built ?? null;
        }
      }
    } catch { /* ignore */ }

    // Fallback: hexdb.io
    if (!info.registration) {
      try {
        const r = await fetch(`https://hexdb.io/api/v1/aircraft/${icao}`, { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const d = await r.json();
          info.registration = d.Registration    ?? null;
          if (!info.typecode)  info.typecode  = d.ICAOTypeCode ?? null;
          // Build typeDesc from hexdb fields if not already set
          const hexType = d.Type ?? null;
          if (!info.typeDesc && hexType) {
            info.typeDesc = (info.typecode && hexType !== info.typecode)
              ? `${info.typecode} · ${hexType}`
              : hexType;
          }
          if (!info.operator)  info.operator   = d.RegisteredOwners ?? null;
          if (!info.country)   info.country    = d.Country ?? null;
        }
      } catch { /* ignore */ }
    }

    aircraftCache.set(icao, { ...info });
  }

  // ── 2. Live route lookup by callsign (short TTL cache) ────────────────────
  // Routes change per flight so we cache by callsign with a 5-min TTL,
  // NOT by ICAO (which would show yesterday's route for today's flight).
  if (callsign && callsign.length >= 4) {
    const cached = routeCache.get(callsign);
    if (cached && Date.now() - cached.ts < ROUTE_TTL) {
      info.route    = cached.route;
      if (!info.operator) info.operator = cached.operator;
    } else {
      try {
        const r = await fetch(`https://api.adsbdb.com/v0/callsign/${callsign}`, { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const d  = await r.json();
          const fl = d.response?.flightroute;
          if (fl) {
            const orig = fl.origin?.iata_code      ?? fl.origin?.icao_code      ?? '';
            const dest = fl.destination?.iata_code ?? fl.destination?.icao_code ?? '';
            info.route = (orig && dest) ? `${orig} → ${dest}` : null;
            const airline = fl.airline?.name ?? null;
            if (!info.operator && airline) info.operator = airline;
            routeCache.set(callsign, { route: info.route, operator: airline, ts: Date.now() });
          }
        }
      } catch { /* ignore */ }
    }
  }

  return info;
}

// ── Panel renderer ────────────────────────────────────────────────────────────

function renderPanel(panel, data, viewer, entity) {
  const {
    icao, callsign, altFt, kts, heading, squawk, vert, provider, dbFlags,
    registration, typecode, typeDesc, operator, route, country, year, loading
  } = data;

  const altFtStr   = altFt  ? `${Math.round(altFt).toLocaleString()} ft`  : '–';
  const altKm      = altFt  ? `${(altFt*0.3048/1000).toFixed(1)} km`      : '';
  const spdStr     = kts    ? `${Math.round(kts)} kts · ${Math.round(kts*1.852)} km/h` : '–';
  const hdgStr     = heading ? `${Math.round(heading)}°`                  : '–';
  const vsStr      = vert   ? `${vert > 0 ? '↑' : '↓'} ${Math.abs(Math.round(vert)).toLocaleString()} ft/min` : 'level';
  const acColor    = aircraftClassColor(dbFlags, callsign);
  const acLabel    = aircraftClassLabel(dbFlags, callsign);
  const typeDisplay = typecode
    ? (typeDesc && typeDesc !== typecode ? `${typecode} · ${typeDesc}` : typecode)
    : typeDesc;

  const row = (label, val, dim = false) => val
    ? `<tr><td style="opacity:0.5;padding-right:12px;white-space:nowrap">${label}</td><td style="${dim?'opacity:0.65':''}font-weight:500">${val}</td></tr>`
    : '';

  const adsbLolLink = `https://adsb.lol/?icao=${icao.toLowerCase()}`;
  const fr24Link    = registration ? `https://www.flightradar24.com/${registration}` : null;

  panel.innerHTML = `
    <div style="background:rgba(0,0,0,0.3);padding:12px 16px;border-bottom:1px solid ${acColor}44;border-left:3px solid ${acColor}">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:20px;color:${acColor}">✈</span>
        <div>
          <div style="font-size:15px;font-weight:bold;letter-spacing:0.12em;color:#fff">
            ${callsign !== icao ? callsign : (registration ?? icao)}
          </div>
          <div style="opacity:0.55;font-size:10px;margin-top:1px">${icao} ${registration ? '· ' + registration : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-left:auto">
          <span style="font-size:9px;font-weight:bold;color:${acColor};border:1px solid ${acColor}55;padding:2px 6px;border-radius:3px;letter-spacing:0.1em">${acLabel}</span>
          <span style="cursor:pointer;opacity:0.5;font-size:14px" id="panel-close">✕</span>
        </div>
      </div>
    </div>

    <div style="padding:10px 16px">
      ${loading ? `<div style="opacity:0.45;font-size:10px;margin-bottom:8px">Fetching aircraft data...</div>` : ''}

      <table style="width:100%;border-collapse:collapse;font-size:11px">
        ${row('Type',     typeDisplay)}
        ${row('Operator', operator)}
        ${row('Country',  country)}
        ${row('Filed Route', route)}
        ${row('Year',     year)}
      </table>

      <div style="margin:10px 0;border-top:1px solid rgba(0,255,136,0.1)"></div>

      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <tr>
          <td style="opacity:0.5;padding-right:12px">Altitude</td>
          <td><span style="font-weight:bold">${altFtStr}</span>${altKm ? ` <span style="opacity:0.5">${altKm}</span>` : ''}</td>
        </tr>
        ${row('Speed',    spdStr)}
        ${row('Heading',  hdgStr)}
        ${row('Vert. Rate', vsStr)}
        ${row('Squawk',   squawk || null)}
      </table>

      <div style="margin:10px 0;border-top:1px solid rgba(0,255,136,0.1)"></div>

      <div style="display:flex;gap:8px;font-size:10px;align-items:center">
        <a href="${adsbLolLink}" target="_blank" style="color:#00ff88;opacity:0.7;text-decoration:none">
          ↗ adsb.lol
        </a>
        ${fr24Link ? `<a href="${fr24Link}" target="_blank" style="color:#00ff88;opacity:0.7;text-decoration:none">↗ FlightRadar24</a>` : ''}
        <span style="margin-left:auto;opacity:0.3;font-size:9px">LIVE · ${provider}</span>
      </div>

      <div style="margin-top:10px">
        <button id="follow-btn" style="
          width:100%;padding:6px 0;border-radius:3px;cursor:pointer;
          font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:0.1em;
          border:1px solid ${acColor}66;background:transparent;color:${acColor}bb;
          transition:all 0.15s ease;
        ">◎ FOLLOW</button>
      </div>
    </div>
  `;

  wirePanelClose(panel);
  wireFollowButton(panel, viewer, entity, callsign, 'flight');
}

// ── Shared panel helpers ──────────────────────────────────────────────────────

function wirePanelClose(panel) {
  document.getElementById('panel-close')?.addEventListener('click', () => {
    stopFollow();
    panel.style.display = 'none';
  });
}

function wireFollowButton(panel, viewer, entity, label, type) {
  const btn = document.getElementById('follow-btn');
  if (!btn) return;

  // Extract the raw icao hex from entity id (strip 'flight-' prefix)
  const icaoHex = type === 'flight'
    ? String(entity.id).replace(/^flight-/, '')
    : null;

  // Reflect current follow state on open
  const alreadyFollowing = isFollowing() && followingLabel() === label;
  setFollowBtnState(btn, alreadyFollowing);

  btn.addEventListener('click', () => {
    if (isFollowing() && followingLabel() === label) {
      // ── UNFOLLOW ──────────────────────────────────────────────────────────
      if (icaoHex) setFollowMode(icaoHex, false);
      stopFollow(false, true);
      setFollowBtnState(btn, false);
    } else {
      // ── FOLLOW ────────────────────────────────────────────────────────────
      if (icaoHex) setFollowMode(icaoHex, true);

      followEntity(viewer, entity, {
        label,
        type,
        onStop: () => {
          // Called if follow is cancelled by user panning away
          if (icaoHex) setFollowMode(icaoHex, false);
          const b = document.getElementById('follow-btn');
          if (b) setFollowBtnState(b, false);
        },
      });
      setFollowBtnState(btn, true);
    }
  });
}

function setFollowBtnState(btn, active) {
  if (active) {
    btn.textContent    = '⊙ UNFOLLOW';
    btn.style.background  = 'rgba(255,80,80,0.12)';
    btn.style.color       = '#ff6060';
    btn.style.borderColor = '#ff606066';
  } else {
    btn.textContent    = '◎ FOLLOW';
    btn.style.background  = 'transparent';
    btn.style.color       = '#00ff8899';
    btn.style.borderColor = '#00ff8844';
  }
}

function satelliteHtml(name, provider) {
  return `
    <div style="background:rgba(0,170,255,0.1);padding:12px 16px;border-bottom:1px solid rgba(0,170,255,0.2)">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:18px">◈</span>
        <div style="font-size:14px;font-weight:bold;letter-spacing:0.1em;color:#00aaff">${name}</div>
        <div style="margin-left:auto;cursor:pointer;opacity:0.5" id="panel-close">✕</div>
      </div>
    </div>
    <div style="padding:12px 16px;font-size:11px">
      <div style="opacity:0.6;margin-bottom:10px">
        Orbital tracking active<br>
        <span style="opacity:0.5;font-size:9px">TLE · ${provider}</span>
      </div>
      <button id="follow-btn" style="
        width:100%;padding:6px 0;border-radius:3px;cursor:pointer;
        font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:0.1em;
        border:1px solid #00aaff44;background:transparent;color:#00aaffbb;
        transition:all 0.15s ease;
      ">◎ FOLLOW</button>
    </div>
  `;
}

// Classification colors — must match flights.js
function aircraftClassColor(dbFlags, callsign) {
  if ((dbFlags ?? 0) & 1) return '#f44336'; // military — red
  const cs = (callsign ?? '').toUpperCase();
  if (/^[A-Z]{2,3}\d{1,4}[A-Z]?$/.test(cs)) return '#00e676'; // commercial — green
  return '#ffa726'; // other — orange
}
function aircraftClassLabel(dbFlags, callsign) {
  if ((dbFlags ?? 0) & 1) return 'MILITARY';
  const cs = (callsign ?? '').toUpperCase();
  if (/^[A-Z]{2,3}\d{1,4}[A-Z]?$/.test(cs)) return 'COMMERCIAL';
  return 'OTHER';
}
// stub kept for any leftover references
function altitudeColor() { return '#00e676'; }
