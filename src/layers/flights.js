/**
 * File: src/layers/flights.js
 * Purpose: Live aircraft rendering, selection enrichment, and server-heavy snapshot integration.
 * Notes: Supports multiple providers with proxy-backed auth/data routing.
 * Last updated: 2026-03-13
 */

import * as Cesium from 'cesium';
import { setServerSnapshotLayerEnabled, subscribeServerSnapshot } from '../core/serverSnapshot.js';

const PROVIDER = (import.meta.env.VITE_FLIGHT_PROVIDER ?? 'opensky').toLowerCase();
const SERVER_HEAVY_MODE = (import.meta.env.VITE_SERVER_HEAVY_MODE ?? 'false').toLowerCase() === 'true';
const ACTIVE_PROVIDER = SERVER_HEAVY_MODE ? 'proxy' : PROVIDER;
const POLL_MS  = 10_000;
const PROXY_URL = '/api/localproxy/api/flights';
const NOFLY_GPS_URL = '/api/localproxy/api/nofly_gps';
const NOFLY_GPS_POLL_MS = 5 * 60_000;
const NOFLY_GPS_DEFAULT_MAX_HEIGHT_M = 18_000;
const ADSBOOL_BASE_URL = '/api/adsbool';
const AIRPLANESLIVE_BASE_URL = '/api/airplaneslive';

const OPENSKY_CLIENT_ID     = import.meta.env.VITE_OPENSKY_CLIENT_ID     ?? '';
const OPENSKY_CLIENT_SECRET = import.meta.env.VITE_OPENSKY_CLIENT_SECRET ?? '';
// Must go through Vite proxy; auth.opensky-network.org blocks direct browser
//     fetches with no CORS headers. The /api/opensky-auth proxy rewrites the host.
const OPENSKY_TOKEN_URL = '/api/opensky-auth/auth/realms/opensky-network/protocol/openid-connect/token';

// ── Aircraft icon SVGs — visually distinct top-down silhouettes ───────────────
// Each shape is clearly different at a glance. North = up (nose pointing up).

const SHAPES = {

  // HEAVY — wide double-deck fuselage, 4 engines under very wide swept wings
  // Represents: B747, B748, A380, A340, B777 (large widebody)
  heavy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="36" height="36">
    <g transform="translate(50,50)" fill="FILL" stroke="STROKE" stroke-width="1.2" stroke-linejoin="round">
      <!-- Fuselage — fat & long -->
      <ellipse cx="0" cy="-2" rx="5.5" ry="34" />
      <!-- Wide swept wings -->
      <path d="M-5,-8 L-44,18 L-42,24 L-5,10 Z"/>
      <path d="M5,-8 L44,18 L42,24 L5,10 Z"/>
      <!-- Inner engine pods under wings -->
      <ellipse cx="-22" cy="10" rx="4.5" ry="8" transform="rotate(-18,-22,10)"/>
      <ellipse cx="22" cy="10" rx="4.5" ry="8" transform="rotate(18,22,10)"/>
      <!-- Outer engine pods -->
      <ellipse cx="-34" cy="17" rx="3.5" ry="7" transform="rotate(-18,-34,17)"/>
      <ellipse cx="34" cy="17" rx="3.5" ry="7" transform="rotate(18,34,17)"/>
      <!-- Horizontal stabilisers -->
      <path d="M-4,28 L-22,38 L-21,42 L-4,34 Z"/>
      <path d="M4,28 L22,38 L21,42 L4,34 Z"/>
      <!-- Vertical tail (spine line) -->
      <line x1="0" y1="26" x2="0" y2="36" stroke-width="2.5"/>
    </g>
  </svg>`,

  // WIDEBODY — 2-engine widebody, moderately swept wings
  // Represents: B767, B787, A300, A330, A350
  widebody: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="32" height="32">
    <g transform="translate(50,50)" fill="FILL" stroke="STROKE" stroke-width="1.2" stroke-linejoin="round">
      <!-- Fuselage — medium-fat -->
      <ellipse cx="0" cy="-2" rx="4.5" ry="32"/>
      <!-- Swept wings, wider chord -->
      <path d="M-4.5,-6 L-40,16 L-38,22 L-4.5,8 Z"/>
      <path d="M4.5,-6 L40,16 L38,22 L4.5,8 Z"/>
      <!-- Engine pods, 1 per wing -->
      <ellipse cx="-26" cy="10" rx="4" ry="8" transform="rotate(-16,-26,10)"/>
      <ellipse cx="26" cy="10" rx="4" ry="8" transform="rotate(16,26,10)"/>
      <!-- Horizontal stabs -->
      <path d="M-4,26 L-20,36 L-19,40 L-4,31 Z"/>
      <path d="M4,26 L20,36 L19,40 L4,31 Z"/>
      <line x1="0" y1="25" x2="0" y2="34" stroke-width="2.5"/>
    </g>
  </svg>`,

  // JET — narrow-body, 2 engines under moderately swept wings
  // Represents: B737, A320, B757, E190 etc. — the most common type
  jet: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="28" height="28">
    <g transform="translate(50,50)" fill="FILL" stroke="STROKE" stroke-width="1.2" stroke-linejoin="round">
      <!-- Fuselage — slim -->
      <ellipse cx="0" cy="-2" rx="3.5" ry="30"/>
      <!-- Wings — swept, medium span -->
      <path d="M-3.5,-4 L-32,14 L-30,20 L-3.5,7 Z"/>
      <path d="M3.5,-4 L32,14 L30,20 L3.5,7 Z"/>
      <!-- Engine pods under wings -->
      <ellipse cx="-20" cy="8" rx="3.2" ry="7" transform="rotate(-14,-20,8)"/>
      <ellipse cx="20" cy="8" rx="3.2" ry="7" transform="rotate(14,20,8)"/>
      <!-- Stabilisers -->
      <path d="M-3,24 L-16,32 L-15,36 L-3,29 Z"/>
      <path d="M3,24 L16,32 L15,36 L3,29 Z"/>
      <line x1="0" y1="23" x2="0" y2="31" stroke-width="2.5"/>
    </g>
  </svg>`,

  // TURBOPROP — short fuselage, straight high wings, prominent circular prop discs
  // Represents: ATR-42/72, Dash-8, King Air, Saab 340
  turboprop: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="28" height="28">
    <g transform="translate(50,50)" fill="FILL" stroke="STROKE" stroke-width="1.2" stroke-linejoin="round">
      <!-- Fuselage — stubby -->
      <ellipse cx="0" cy="2" rx="4" ry="24"/>
      <!-- High straight wings — wider chord, less sweep -->
      <path d="M-4,-4 L-32,2 L-32,10 L-4,6 Z"/>
      <path d="M4,-4 L32,2 L32,10 L4,6 Z"/>
      <!-- Prop disc rings (the key visual differentiator!) -->
      <circle cx="-26" cy="4" r="8" fill="none" stroke="STROKE" stroke-width="1.5" opacity="0.8"/>
      <circle cx="26" cy="4" r="8" fill="none" stroke="STROKE" stroke-width="1.5" opacity="0.8"/>
      <!-- Prop cross hairs -->
      <line x1="-26" y1="-4" x2="-26" y2="12" stroke-width="1"/>
      <line x1="-34" y1="4" x2="-18" y2="4" stroke-width="1"/>
      <line x1="26" y1="-4" x2="26" y2="12" stroke-width="1"/>
      <line x1="18" y1="4" x2="34" y2="4" stroke-width="1"/>
      <!-- Small stabs -->
      <path d="M-3,18 L-14,24 L-13,27 L-3,22 Z"/>
      <path d="M3,18 L14,24 L13,27 L3,22 Z"/>
    </g>
  </svg>`,

  // HELICOPTER — distinctive rotor disc + elongated tail boom
  helicopter: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="30" height="30">
    <g transform="translate(50,50)" fill="FILL" stroke="STROKE" stroke-width="1.2" stroke-linejoin="round">
      <!-- Fuselage pod — fat oval -->
      <ellipse cx="0" cy="0" rx="10" ry="15"/>
      <!-- Main rotor disc — large circle, no fill -->
      <circle cx="0" cy="-2" r="30" fill="none" stroke="STROKE" stroke-width="1.5" opacity="0.6"/>
      <!-- Rotor blades cross -->
      <line x1="-30" y1="-2" x2="30" y2="-2" stroke-width="2" opacity="0.8"/>
      <line x1="0" y1="-32" x2="0" y2="28" stroke-width="2" opacity="0.8"/>
      <!-- Tail boom -->
      <rect x="-2" y="15" width="4" height="20" rx="1"/>
      <!-- Tail rotor -->
      <line x1="-8" y1="34" x2="8" y2="34" stroke-width="2.5"/>
    </g>
  </svg>`,

  // LIGHT — tiny high-wing piston, very short & stubby, straight wings
  // Represents: Cessna 172, Piper, Diamond etc.
  light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="22" height="22">
    <g transform="translate(50,50)" fill="FILL" stroke="STROKE" stroke-width="1.3" stroke-linejoin="round">
      <!-- Fuselage — very stubby -->
      <ellipse cx="0" cy="2" rx="3" ry="18"/>
      <!-- Straight high wings — long span, thin chord -->
      <path d="M-3,-2 L-34,0 L-34,5 L-3,3 Z"/>
      <path d="M3,-2 L34,0 L34,5 L3,3 Z"/>
      <!-- Single prop disc -->
      <circle cx="0" cy="-18" r="6" fill="none" stroke="STROKE" stroke-width="1.5" opacity="0.8"/>
      <!-- Tiny V-tail -->
      <path d="M-2,14 L-12,20 L-11,23 L-2,17 Z"/>
      <path d="M2,14 L12,20 L11,23 L2,17 Z"/>
    </g>
  </svg>`,

  // GENERIC — simple arrow for anything unclassified
  generic: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="24" height="24">
    <g transform="translate(50,50)" fill="FILL" stroke="STROKE" stroke-width="1.2" stroke-linejoin="round">
      <ellipse cx="0" cy="-2" rx="3.5" ry="28"/>
      <path d="M-3.5,-2 L-28,14 L-26,20 L-3.5,8 Z"/>
      <path d="M3.5,-2 L28,14 L26,20 L3.5,8 Z"/>
      <path d="M-3,22 L-14,30 L-13,33 L-3,26 Z"/>
      <path d="M3,22 L14,30 L13,33 L3,26 Z"/>
      <line x1="0" y1="21" x2="0" y2="30" stroke-width="2"/>
    </g>
  </svg>`,
};

// ── Type-code → shape lookup ──────────────────────────────────────────────────
// adsb.fi provides the "t" field (ICAO type designator e.g. "B738", "A320")
// This gives far more reliable shape selection than the ADS-B category byte.

const TYPE_HEAVY = new Set([
  'B741','B742','B743','B744','B748','B74D','B74R','B74S', // 747 variants
  'A380','A388',                                           // A380
  'A340','A342','A343','A345','A346',                      // A340
  'B777','B772','B773','B77L','B77W','B778','B779',        // 777
  'AN12','AN22','AN72','AN74','AN24','IL76','IL86','IL96', // Russian heavies
  'C5',  'C17', 'C141','C133',                            // Military heavies
]);

const TYPE_WIDEBODY = new Set([
  'B762','B763','B764','B767',                            // 767
  'B782','B783','B787','B788','B789','B78X',              // 787 Dreamliner
  'A306','A30B','A310',                                   // A300/310
  'A332','A333','A338','A339','A330',                     // A330
  'A350','A358','A359','A35K',                            // A350
  'DC10','MD11','L101','L1011',                           // older widebodies
]);

const TYPE_HELICOPTER = new Set([
  'H60','S61','S76','EC35','EC45','EC55','EC75','EC35',
  'B06','B212','B407','B412','B429','B47G','B505',
  'R22','R44','R66',
  'AS32','AS50','AS55','AS65',
  'AW09','AW19','AW13','AW16','AW17',
  'MD52','MD60','MD90',
  'A109','A119','A139','A169','A189',
  'UH1','UH60','CH47','CH53','CH54',
]);

const TYPE_TURBOPROP = new Set([
  'AT43','AT44','AT45','AT46','AT72','AT73','AT75','AT76', // ATR
  'DH8A','DH8B','DH8C','DH8D','DHC6','DHC7',              // Dash-8, Twin Otter
  'SF34','SB20',                                           // Saab
  'J328','J31','J32','J41',                                // Jetstream
  'C130','C160','P3','P180',                               // Military props
  'BE20','BE30','BE99','BE9L',                             // Beechcraft King Air
  'PC12','PC6T',                                           // Pilatus
  'L410','L610',
  'IL18','TU95',
]);

const TYPE_LIGHT = new Set([
  'C150','C152','C172','C182','C206','C208','C210',        // Cessna
  'PA24','PA28','PA31','PA34','PA44',                      // Piper
  'DA20','DA40','DA42','DA62',                             // Diamond
  'TB10','TB20','TB21',                                    // Tobago/Trinidad
  'SR20','SR22',                                           // Cirrus
  'M20P','M20T','M20V',                                    // Mooney
]);

// ── Aircraft classification → color ──────────────────────────────────────────
//   Commercial  = green   (#00e676)
//   Military    = red     (#f44336)
//   Other       = orange  (#ffa726)
//
// Classification uses (in priority order):
//   1. dbFlags bit 0 (military=1) from adsb.fi / ADSBex database
//   2. Known military ICAO hex ranges (AE0000–AFFFFF = US military, etc.)
//   3. Callsign pattern: IATA/ICAO airline prefix → commercial
//   4. Callsign pattern: military prefixes (RCH, RRR, CNV, etc.) → military

// Major military ICAO hex ranges (prefix matches)
// NOTE: Treat these as weak evidence unless reinforced by military dbFlags,
// callsign, or military-specific type code.
const MILITARY_HEX_PREFIXES = [
  'ae',           // United States military (AE0000–AFFFFF)
  '43c',          // United Kingdom military
  '3f4',          // Germany military
  '3a0',          // France military (Armée de l'air)
  // NOTE: '461' removed — this is Finland's civil ICAO block (460000–46FFFF), NOT Russia
  '7001', '7002', // China military
  '710',          // Japan JASDF
  '7c0',          // Australia military
  'c40',          // Canada military
  // NOTE: '4ca' removed — this is the entire Irish ICAO block (4C0000–4CFFFF),
  //       including all Aer Lingus/Ryanair/civilian EI- registrations.
  //       Irish Air Corps aircraft don't have a unique isolated prefix.
  '48c',          // Italy military
  '340',          // Spain military
];

// Military-specific airframe type codes.
const MILITARY_TYPE_PREFIXES = [
  'C17', 'C130', 'C135', 'KC', 'E3', 'E6', 'P8',
  'F15', 'F16', 'F18', 'F22', 'F35', 'B1', 'B2', 'B52',
  'A400', 'IL76', 'AN12', 'AN22', 'AN72', 'AN74',
];

// Well-known commercial airline ICAO 3-letter prefixes (callsign starts with these)
const AIRLINE_PREFIXES = new Set([
  'AAL','UAL','DAL','SWA','SKW','ASA','NKS','JBU','FFT','HAL',  // US majors
  'JIA','ENY','RPA','EDV','MXY','AAY','NKS','JBU','JZA','QXE',  // US/CA regional + ULCC
  'BAW','EZY','RYR','VIR','TOM','MON','LOG','TCX','EXS',        // UK
  'AFR','AEE','IBE','VLG','TAP','KLM','DLH','LFT','BEL','SWR',  // Europe
  'AUA','SAS','FIN','LOT','TAR','CSA','EWG','TUI','WZZ','NAX',  // Europe
  'UAE','ETD','QTR','SVA','ELY','MEA','THY','MSR','KAC',        // Middle East
  'QTR','UAE','ETD','ABY','FDB','JZR','AIZ','OMA','QJE',        // Gulf / ME low-cost
  'SIA','CPA','CES','CSN','MAS','THA','GIA','PAL','AIC','ANA',  // Asia
  'JAL','KAL','AAR','JNA','AIQ','IGO','AXB','VTI','CCA','HDA',  // Asia
  'CSH','CES','CSN','CHH','XAX','HVN','VJC','SJO','AMU','ALK',  // Asia
  'QFA','ANZ','JST','VOZ','RXA','QJE','QLK',                    // Pacific
  'ETH','KQA','SAA','RAM','TSC','MAU','DAH','RWD','EWA',        // Africa
  'TAM','GLO','AVA','LAN','AZU','BOA','CMP','AMX','VOI','VIV',  // Latin America
  'ARG','LPE','SKX','ACA','WJA','JBU','DAL','AAL','UAL',        // Americas interline
  'FDX','UPS','ABX','ATN','GTI',                                // Cargo
  'CJT','CLX','BOX','DHK','NCA','KAL','CKK','MNB','BCS',        // Cargo international
]);

// Known military callsign prefixes
const MILITARY_CALLSIGN_PREFIXES = [
  'RCH',  // US Air Mobility Command (Reach)
  'CNV',  // US Navy Convey
  'RRR',  // RAF tankers
  'IRON', // USAF
  'JAKE', 'SKULL','VIPER','KNIFE','GHOST','DEMON','REAPER',
  'NCO',  // NATO
  'GRZLY','VALOR','BLADE','SWORD','LANCE',
  'NATO',
  'ALLO', // French military
  'GAF',  // German Air Force
  'SHF',  // SHAPE
];

// OpenSky / ADS-B emitter category values that are strongly commercial-like.
// Source: OpenSky state vector category documentation.
const COMMERCIAL_NUMERIC_CATEGORIES = new Set([2, 3, 4, 5, 6]);

function normalizeCategory(cat) {
  if (typeof cat === 'number' && Number.isFinite(cat)) return cat;
  if (typeof cat === 'string') {
    const s = cat.trim().toUpperCase();
    // READSB-like providers often use A0..A7 strings.
    if (/^[AB][0-9]$/.test(s)) return s;
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isLikelyCommercialCallsign(cs) {
  if (!cs) return false;
  if (MILITARY_CALLSIGN_PREFIXES.some(p => cs.startsWith(p))) return false;

  // Typical airline format: 2-3 letter designator + flight number + optional 1-2 letter suffix.
  // Allow up to 2 suffix letters (e.g. EIN7AC, BAW234A).
  const m = cs.match(/^([A-Z]{2,3})(\d{1,4})([A-Z]{0,2})$/);
  if (!m) return false;

  const prefix = m[1];
  if (prefix.length === 3) return true; // Most ICAO operators are 3-letter codes
  return AIRLINE_PREFIXES.has(prefix);
}

function classifyAircraft(a) {
  const squawk = String(a.squawk ?? '').trim();
  const emergencyCode = ['7500', '7600', '7700'].includes(squawk);
  const emergencyFlag = String(a.emergency ?? '').toLowerCase();
  const isEmergency = emergencyCode || (emergencyFlag && emergencyFlag !== 'none');
  if (isEmergency) return 'emergency';

  if (a.onGround === true) return 'ground';

  // 1) Extract reusable evidence signals
  const cs = (a.callsign ?? '').toUpperCase().trim();
  const prefix3 = cs.slice(0, 3);
  const hasMilitaryCallsign = !!cs && MILITARY_CALLSIGN_PREFIXES.some(p => cs.startsWith(p));
  const hasCommercialCallsign = isLikelyCommercialCallsign(cs)
    || (!!cs && AIRLINE_PREFIXES.has(prefix3) && /\d/.test(cs));
  const category = normalizeCategory(a.category);
  const hasCommercialCategory = typeof category === 'number' && COMMERCIAL_NUMERIC_CATEGORIES.has(category);

  // 2) Strong direct signals
  if ((a.dbFlags ?? 0) & 1) return 'military';
  if (hasMilitaryCallsign) return 'military';
  if (hasCommercialCallsign || hasCommercialCategory) return 'commercial';

  // 3) Airframe evidence
  const typecode = (a.typecode ?? '').toUpperCase().trim();
  const hasMilitaryType = !!typecode && MILITARY_TYPE_PREFIXES.some(p => typecode.startsWith(p));
  if (hasMilitaryType) return 'military';

  // 4) Known military ICAO hex prefix (weak evidence). To reduce false
  // positives, do NOT use this if we already saw commercial category data.
  const hexLow = (a.id ?? '').toLowerCase();
  if (!hasCommercialCategory && MILITARY_HEX_PREFIXES.some(p => hexLow.startsWith(p))) {
    return 'military';
  }

  // 5) Fallback
  if (cs) {
    if (isLikelyCommercialCallsign(cs)) return 'commercial';
  }

  return 'commercial';
}

function classificationColor(classification) {
  switch ((classification ?? 'commercial').toLowerCase()) {
    case 'emergency': return '#ef4444';
    case 'military': return '#f97316';
    case 'ground': return '#6b7280';
    case 'commercial':
    default:
      return '#60a5fa';
  }
}

function aircraftColor(a) {
  return classificationColor(classifyAircraft(a));
}

// Keep for HUD panel badge (mirrors classification color)
function altitudeColor(altFt) { return '#00e676'; } // stub — no longer used for icons

// ── Shape selection — type code first, then ADS-B category, then altitude ─────

function getShape(a) {
  // 1. Type code (most reliable — adsb.fi "t" field stored as a.typecode)
  const tc = (a.typecode ?? '').toUpperCase().trim();
  if (tc) {
    if (TYPE_HELICOPTER.has(tc))  return 'helicopter';
    if (TYPE_HEAVY.has(tc))       return 'heavy';
    if (TYPE_WIDEBODY.has(tc))    return 'widebody';
    if (TYPE_TURBOPROP.has(tc))   return 'turboprop';
    if (TYPE_LIGHT.has(tc))       return 'light';
    // Regex catch-alls for type codes not in explicit sets
    // H prefix = helicopter (H60, H47, H53, H64, H72, H1, H2 etc.)
    if (/^H\d/.test(tc))                   return 'helicopter';
    // S prefix rotorcraft (S61, S76, S92 — Sikorsky)
    if (/^S(6|7|9)\d/.test(tc))            return 'helicopter';
    if (/^(EC|BO|BK|AS|AW|MD9)/.test(tc))  return 'helicopter';
    if (/^(B74|B77|A38|A34)/.test(tc))     return 'heavy';
    if (/^(B76|B78|A3[03]|A35)/.test(tc))  return 'widebody';
    if (/^(B7|A3|E1|E17|E19|C90|RJ|T3|F\d|MIG|SU\d)/.test(tc)) return 'jet';
  }

  // 2. ADS-B category byte
  const cat = (a.category ?? '').toUpperCase();
  if (cat === 'A7' || cat === 'B7')  return 'helicopter';
  if (cat === 'A5')                  return 'heavy';
  if (cat === 'A6')                  return 'jet';
  if (cat === 'A3' || cat === 'A4')  return 'jet';
  if (cat === 'A1')                  return 'light';
  if (cat === 'A2')                  return 'turboprop';

  // 3. Altitude proxy (last resort)
  const alt = a.altFt ?? 0;
  if (alt > 25000) return 'jet';
  if (alt > 5000)  return 'turboprop';
  if (alt > 0)     return 'light';
  return 'generic';
}

// ── Build a data URI for a given shape + color ────────────────────────────────

const svgCache = new Map();

// Contrasting glow color per aircraft class color
function glowColor(fillColor) {
  // Dark fills get a white glow; produce contrast against globe surface
  const dark = ['#f44336','#ab47bc','#ce93d8','#ef5350'];
  return dark.includes(fillColor) ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.95)';
}

function buildSvgUri(shape, color) {
  const key = `${shape}:${color}`;
  if (svgCache.has(key)) return svgCache.get(key);

  const glow   = glowColor(color);
  const rawSvg = SHAPES[shape] ?? SHAPES.generic;

  // Extract just the transform from the original <g> tag — strip fill/stroke placeholders
  const gTagMatch = rawSvg.match(/<g([^>]*)>/);
  const rawAttribs = gTagMatch ? gTagMatch[1] : ' transform="translate(50,50)"';
  // Keep only the transform attribute, discard fill/stroke/stroke-width from template
  const xformMatch = rawAttribs.match(/transform="([^"]+)"/);
  const xform      = xformMatch ? ` transform="${xformMatch[1]}"` : '';

  const innerMatch = rawSvg.match(/<g[^>]*>([\s\S]*?)<\/g>/);
  const inner      = innerMatch ? innerMatch[1] : '';

  const vb = (rawSvg.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 100 100';
  const w  = 320;
  const h  = 320;

  // Two clean paint passes sharing only the transform:
  //   Pass 1 — wide glow stroke, no fill (drawn behind)
  //   Pass 2 — filled shape with thin stroke (drawn on top)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${w}" height="${h}">
  <g${xform} fill="none" stroke="${glow}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">${inner}</g>
  <g${xform} fill="${color}" stroke="${glow}" stroke-width="1" stroke-linejoin="round">${inner}</g>
</svg>`;

  const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  svgCache.set(key, uri);
  return uri;
}


// ── 3-D GLB model builder (used only in follow mode) ─────────────────────────

function mergeMeshes(meshes) {
  let tv = 0, ti = 0;
  for (const m of meshes) { tv += m.verts.length; ti += m.idx.length; }
  const verts = new Float32Array(tv), idx = new Uint16Array(ti);
  let vo = 0, io = 0, vbase = 0;
  for (const m of meshes) {
    verts.set(m.verts, vo);
    for (const i of m.idx) idx[io++] = i + vbase;
    vbase += m.verts.length / 3; vo += m.verts.length;
  }
  return { verts, idx };
}

function buildJetGeometry() {
  const meshes = [];
  const rings = [[20,.10,.10],[16,.80,.90],[8,1.2,1.3],[0,1.3,1.4],[-10,1.2,1.2],[-16,.80,.90],[-20,.20,.50]];
  const S = 8;
  for (let r = 0; r < rings.length-1; r++) {
    const [x0,w0,h0] = rings[r], [x1,w1,h1] = rings[r+1];
    const v=[], ix=[];
    for (let i=0;i<S;i++){const a=(i/S)*Math.PI*2; v.push(x0,Math.sin(a)*h0,Math.cos(a)*w0);}
    for (let i=0;i<S;i++){const a=(i/S)*Math.PI*2; v.push(x1,Math.sin(a)*h1,Math.cos(a)*w1);}
    for (let i=0;i<S;i++){const j=(i+1)%S; ix.push(i,S+i,S+j,i,S+j,j);}
    meshes.push({verts:new Float32Array(v),idx:new Uint16Array(ix)});
  }
  const wT=[[8,.30,1.5],[-2,.80,24],[-6,.60,22],[-4,.05,1.2]];
  const wB=wT.map(([x,y,z])=>[x,y-.45,z]);
  const wA=[...wT,...wB.slice().reverse()];
  const wv=[],wi=[];
  for(const [x,y,z] of wA) wv.push(x,y,z);
  for(let i=1;i<wA.length-1;i++) wi.push(0,i,i+1);
  meshes.push({verts:new Float32Array(wv),idx:new Uint16Array(wi)});
  const wvL=new Float32Array(wv); for(let i=2;i<wvL.length;i+=3) wvL[i]=-wvL[i];
  meshes.push({verts:wvL,idx:new Uint16Array(wi)});
  for(const [ex,ey,ez] of [[2,-1,9],[2,-1,-9]]){
    const er=.55,el=5.5,es=8,ev=[],ei=[];
    for(let i=0;i<es;i++){const a=(i/es)*Math.PI*2; ev.push(ex+el/2,ey+Math.sin(a)*er,ez+Math.cos(a)*er);}
    for(let i=0;i<es;i++){const a=(i/es)*Math.PI*2; ev.push(ex-el/2,ey+Math.sin(a)*er,ez+Math.cos(a)*er);}
    for(let i=0;i<es;i++){const j=(i+1)%es; ei.push(i,es+i,es+j,i,es+j,j);}
    meshes.push({verts:new Float32Array(ev),idx:new Uint16Array(ei)});
  }
  const sT=[[-13,.30,1.3],[-17,.50,8],[-18,.35,7],[-15,.20,1.0]];
  const sA=[...sT,...sT.map(([x,y,z])=>[x,y-.25,z]).reverse()];
  const sv=[],si=[];
  for(const [x,y,z] of sA) sv.push(x,y,z);
  for(let i=1;i<sA.length-1;i++) si.push(0,i,i+1);
  meshes.push({verts:new Float32Array(sv),idx:new Uint16Array(si)});
  const svL=new Float32Array(sv); for(let i=2;i<svL.length;i+=3) svL[i]=-svL[i];
  meshes.push({verts:svL,idx:new Uint16Array(si)});
  meshes.push({
    verts:new Float32Array([-12,.5,.3,-19,7.5,.2,-19,7,-.2,-12,.5,-.3,-19,.5,.3,-19,.5,-.3]),
    idx:new Uint16Array([0,1,2,0,2,3,0,4,1,3,2,5]),
  });
  return mergeMeshes(meshes);
}

function buildHelicopterGeometry() {
  const meshes = [];

  // Main fuselage pod
  const rings = [[8,0.7,0.9],[4,1.3,1.5],[0,1.5,1.7],[-4,1.2,1.3],[-8,0.8,0.9]];
  const S = 10;
  for (let r = 0; r < rings.length - 1; r++) {
    const [x0,w0,h0] = rings[r], [x1,w1,h1] = rings[r + 1];
    const v = [], ix = [];
    for (let i = 0; i < S; i++) {
      const a = (i / S) * Math.PI * 2;
      v.push(x0, Math.sin(a) * h0, Math.cos(a) * w0);
    }
    for (let i = 0; i < S; i++) {
      const a = (i / S) * Math.PI * 2;
      v.push(x1, Math.sin(a) * h1, Math.cos(a) * w1);
    }
    for (let i = 0; i < S; i++) {
      const j = (i + 1) % S;
      ix.push(i, S + i, S + j, i, S + j, j);
    }
    meshes.push({ verts: new Float32Array(v), idx: new Uint16Array(ix) });
  }

  // Tail boom
  meshes.push({
    verts: new Float32Array([
      -7.5,-0.2,-0.25,  -22,-0.2,-0.25,  -22,0.2,-0.25,  -7.5,0.2,-0.25,
      -7.5,-0.2,0.25,   -22,-0.2,0.25,   -22,0.2,0.25,   -7.5,0.2,0.25,
    ]),
    idx: new Uint16Array([
      0,1,2, 0,2,3, 4,6,5, 4,7,6,
      0,4,5, 0,5,1, 3,2,6, 3,6,7,
      0,3,7, 0,7,4, 1,5,6, 1,6,2,
    ]),
  });

  // Main rotor mast and blades (flat cross)
  meshes.push({
    verts: new Float32Array([
      -0.2,1.3,-0.2, 0.2,1.3,-0.2, 0.2,3.2,-0.2, -0.2,3.2,-0.2,
      -0.2,1.3,0.2,  0.2,1.3,0.2,  0.2,3.2,0.2,  -0.2,3.2,0.2,
      -0.35,3.3,-16, 0.35,3.3,-16, 0.35,3.3,16, -0.35,3.3,16,
      -16,3.3,-0.35, 16,3.3,-0.35, 16,3.3,0.35, -16,3.3,0.35,
    ]),
    idx: new Uint16Array([
      0,1,2, 0,2,3, 4,6,5, 4,7,6,
      0,4,5, 0,5,1, 3,2,6, 3,6,7,
      8,9,10, 8,10,11,
      12,13,14, 12,14,15,
    ]),
  });

  // Tail rotor (small cross near tail end)
  meshes.push({
    verts: new Float32Array([
      -21.8,0.2,-2.4, -21.8,0.2,2.4, -22.2,0.2,2.4, -22.2,0.2,-2.4,
      -22.0,-2.2,-0.2, -22.0,2.2,-0.2, -22.0,2.2,0.2, -22.0,-2.2,0.2,
    ]),
    idx: new Uint16Array([
      0,1,2, 0,2,3,
      4,5,6, 4,6,7,
    ]),
  });

  return mergeMeshes(meshes);
}

const JET_MESH  = buildJetGeometry();
const HELI_MESH = buildHelicopterGeometry();
const glbCache  = new Map();

function buildGlbUrl(shape, hexColor) {
  const key = `${shape}:${hexColor}`;
  if (glbCache.has(key)) return glbCache.get(key);

  const mesh = shape === 'helicopter' ? HELI_MESH : JET_MESH;
  const {verts,idx} = mesh;
  const hex=hexColor.replace('#','');
  const r=parseInt(hex.slice(0,2),16)/255, g=parseInt(hex.slice(2,4),16)/255, b=parseInt(hex.slice(4,6),16)/255;
  const vb=verts.buffer, ib=idx.buffer, vl=vb.byteLength, il=ib.byteLength, bl=vl+il;
  const bp=(4-(bl%4))%4, bcl=bl+bp;
  let mnX=Infinity,mnY=Infinity,mnZ=Infinity,mxX=-Infinity,mxY=-Infinity,mxZ=-Infinity;
  for(let i=0;i<verts.length;i+=3){
    mnX=Math.min(mnX,verts[i]);  mxX=Math.max(mxX,verts[i]);
    mnY=Math.min(mnY,verts[i+1]);mxY=Math.max(mxY,verts[i+1]);
    mnZ=Math.min(mnZ,verts[i+2]);mxZ=Math.max(mxZ,verts[i+2]);
  }
  const json=JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0,mode:4}]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[r,g,b,1],metallicFactor:.3,roughnessFactor:.5},doubleSided:true}],
    accessors:[
      {bufferView:0,componentType:5126,count:verts.length/3,type:'VEC3',min:[mnX,mnY,mnZ],max:[mxX,mxY,mxZ]},
      {bufferView:1,componentType:5123,count:idx.length,type:'SCALAR',min:[0],max:[verts.length/3-1]},
    ],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:vl,target:34962},{buffer:0,byteOffset:vl,byteLength:il,target:34963}],
    buffers:[{byteLength:bl}],
  });
  const jp=(4-(json.length%4))%4, js=json+' '.repeat(jp), jb=new TextEncoder().encode(js), jl=jb.length;
  const tl=12+8+jl+8+bcl, buf=new ArrayBuffer(tl), dv=new DataView(buf); let off=0;
  dv.setUint32(off,0x46546C67,true);off+=4; dv.setUint32(off,2,true);off+=4; dv.setUint32(off,tl,true);off+=4;
  dv.setUint32(off,jl,true);off+=4; dv.setUint32(off,0x4E4F534A,true);off+=4;
  new Uint8Array(buf,off,jl).set(jb);off+=jl;
  dv.setUint32(off,bcl,true);off+=4; dv.setUint32(off,0x004E4942,true);off+=4;
  new Uint8Array(buf,off,vl).set(new Uint8Array(vb));off+=vl;
  new Uint8Array(buf,off,il).set(new Uint8Array(ib));
  const url=URL.createObjectURL(new Blob([buf],{type:'model/gltf-binary'}));
  glbCache.set(key,url); return url;
}

const MODEL_SCALE = { heavy:1.4, widebody:1.2, jet:1.0, turboprop:.7, helicopter:.4, light:.25, generic:.9 };

const ICON_SIZE_PX = {
  heavy: 44,
  widebody: 40,
  jet: 36,
  turboprop: 34,
  helicopter: 34,
  light: 30,
  generic: 34,
};

// ── Aircraft type code → asset model filename mapping ────────────────────────
// Maps ICAO aircraft type codes to their corresponding .glb models in src/assets
// Examples: B739 → b739.glb, A320 → a320.glb
// Fallback uses procedural models if specific type is not found

const AIRCRAFT_MODEL_MAP = new Map([
  // Airbus narrow-body
  ['A318', 'a318.glb'],
  ['A319', 'a319.glb'],
  ['A320', 'a320.glb'],
  ['A321', 'a321.glb'],
  // Airbus wide-body
  ['A332', 'a332.glb'],
  ['A333', 'a333.glb'],
  ['A343', 'a343.glb'],
  ['A346', 'a346.glb'],
  ['A359', 'a359.glb'],
  ['A380', 'a380.glb'],
  // Boeing narrow-body
  ['B736', 'b736.glb'],
  ['B737', 'b737.glb'],
  ['B738', 'b738.glb'],
  ['B739', 'b739.glb'],
  // Boeing wide-body
  ['B744', 'b744.glb'],
  ['B748', 'b748.glb'],
  ['B752', 'b752.glb'],
  ['B753', 'b753.glb'],
  ['B762', 'b762.glb'],
  ['B763', 'b763.glb'],
  ['B764', 'b764.glb'],
  ['B772', 'b772.glb'],
  ['B773', 'b773.glb'],
  ['B788', 'b788.glb'],
  ['B789', 'b789.glb'],
  // Other commercial
  ['ATR42', 'atr42.glb'],
  ['BAE146', 'bae146.glb'],
  ['CRJ700', 'crj700.glb'],
  ['CRJ900', 'crj900.glb'],
  ['CS100', 'cs100.glb'],
  ['CS300', 'cs300.glb'],
  ['E170', 'e170.glb'],
  ['E190', 'e190.glb'],
  ['Q400', 'q400.glb'],
  // Cargo/Military
  ['AN225', 'an225.gltf'],
  ['BELUGA', 'beluga.glb'],
  // General aviation
  ['PA28', 'pa28.glb'],
  ['C172', 'pa28.glb'],
  ['ASK21', 'ask21.glb'],
]);

/**
 * Get the 3D model URL for an aircraft type.
 * First tries to load from /src/assets/{typecode}.glb, then falls back to procedural generation.
 * @param {string} typecode - ICAO aircraft type code (e.g. 'B739', 'A320')
 * @param {string} shape - Aircraft shape (jet, helicopter, etc.)
 * @param {string} color - Hex color code
 * @returns {string} URL to the model (either asset URL or data: URI for procedural model)
 */
function getAircraftModelUrl(typecode, shape, color) {
  if (!typecode) {
    // No type code, fall back to procedural
    return buildGlbUrl(shape, color);
  }

  const typecodeLower = typecode.toLowerCase();
  // Try direct match first
  const assetFilename = AIRCRAFT_MODEL_MAP.get(typecode.toUpperCase()) || 
                       AIRCRAFT_MODEL_MAP.get(typecode);
  
  if (assetFilename) {
    // Return the asset URL — Vite will handle the import
    return `/src/assets/${assetFilename}`;
  }

  // No specific asset found, fall back to procedural model
  console.debug(`[Flights] No asset model for ${typecode}, using procedural ${shape} model`);
  return buildGlbUrl(shape, color);
}

/**
 * Check if an aircraft type has a 3D model in the assets folder.
 * @param {string} typecode - ICAO aircraft type code
 * @returns {boolean} True if an asset model exists for this type
 */
export function hasAssetModel(typecode) {
  if (!typecode) return false;
  return AIRCRAFT_MODEL_MAP.has(typecode.toUpperCase());
}


// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, Cesium.Entity>} */
const entityMap = new Map();
const trackStateMap = new Map();
const trackPosPropMap = new Map();
// Enriched typecodes from HUD lookup (adsbdb/hexdb) keyed by lowercase ICAO hex.
// These survive update cycles (OpenSky never sends typecodes) and entity re-creation.
const enrichedTypecodeMap = new Map();

/**
 * Store a HUD-enriched typecode for an aircraft and update its entity property.
 * Called from HUD.js after fetchAircraftInfo resolves the type code.
 */
export function setEnrichedTypecode(icaoHex, typecode) {
  if (!icaoHex || !typecode) return;
  const key = icaoHex.toLowerCase();
  enrichedTypecodeMap.set(key, typecode.toUpperCase());
  // Update entity if it exists in the current viewport
  const entity = entityMap.get(key);
  if (entity?.properties?.typecode?.setValue) {
    entity.properties.typecode.setValue(typecode.toUpperCase());
  }
}
let enabled     = false;  // Start disabled by default
let oskToken    = null;
let oskTokenExp = 0;
let hideAllFlatIcons = false;
let flightFeedHealthy = true;
let hasPublishedFlightOk = false;
let lastFlightStatusKey = '';
let flightZonesDataSource = null;
let noflyGpsPollTimer = null;
let noflyGpsPayloadCache = null;

const FLIGHT_ZONE_AGE_RULES = { fadeMs: 6 * 60 * 60 * 1000, expireMs: 48 * 60 * 60 * 1000 };

// Aircraft classification filter state — Tarsyu-style categories
const aircraftClassificationFilters = {
  commercial: true,
  military: true,
  emergency: true,
  ground: true,
};

const flightZoneFilters = {
  gps: true,
  airspace: true,
};

/**
 * Returns true if at least one aircraft classification is active.
 * When false, there is no point fetching flight data from the proxy.
 */
function isAnyClassificationActive() {
  return Object.values(aircraftClassificationFilters).some(Boolean);
}

/**
 * Determine if a flight entity should be visible based on enabled state and filters
 */
function shouldShowFlight(aircraftClassification) {
  if (!enabled) return false;
  const classKey = (aircraftClassification ?? 'commercial').toLowerCase();
  return aircraftClassificationFilters[classKey];
}

const EARTH_RADIUS_M = 6378137;
const KTS_TO_MPS = 0.514444;
const FTMIN_TO_MPS = 0.00508;
const MAX_PREDICT_SECONDS = 45;

function iconRotationFromHeading(headingDeg = 0) {
  // Billboard rotation is clockwise from north when alignedAxis is UNIT_Z.
  return Cesium.Math.toRadians(-(headingDeg ?? 0));
}

function publishSystemStatus(msg, level = 'ok', key = `${level}:${msg}`) {
  if (lastFlightStatusKey === key) return;
  lastFlightStatusKey = key;
  if (typeof window === 'undefined') return;

  const ts = Date.now();
  window.__shadowgridSystemStatus = { msg, level, key, source: 'flights', ts };
  window.__shadowgridSubsystemStatus = {
    ...(window.__shadowgridSubsystemStatus ?? {}),
    flights: { msg, level, key, ts },
  };

  window.dispatchEvent(new CustomEvent('shadowgrid:system-status', {
    detail: { msg, level, source: 'flights', key, ts },
  }));
}

function applyFlatIconVisibility() {
  for (const [id, entity] of entityMap) {
    const state = trackStateMap.get(id);
    const aircraftClassification = state?.aircraftClassification ?? 'commercial';
    const shouldShow = shouldShowFlight(aircraftClassification) && !hideAllFlatIcons;
    if (entity.billboard) {
      entity.billboard.show = new Cesium.ConstantProperty(shouldShow);
    }
    if (entity.label) {
      entity.label.show = new Cesium.ConstantProperty(shouldShow);
    }
  }
}

function flattenPoints(points) {
  const out = [];
  for (const [lon, lat] of points) out.push(lon, lat);
  return out;
}

function flattenClosedPoints(points) {
  if (!points.length) return [];
  return flattenPoints([...points, points[0]]);
}

function normalizeZonePoints(points) {
  if (!Array.isArray(points)) return [];
  const filtered = points
    .map(([lon, lat]) => [Number(lon), Number(lat)])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (filtered.length > 1) {
    const [firstLon, firstLat] = filtered[0];
    const [lastLon, lastLat] = filtered[filtered.length - 1];
    if (firstLon === lastLon && firstLat === lastLat) filtered.pop();
  }
  return filtered;
}

function parseZoneTime(value) {
  const ts = Date.parse(value ?? '');
  return Number.isFinite(ts) ? ts : null;
}

function computeFlightZoneOpacity(zone, nowMs) {
  const startsAt = parseZoneTime(zone.startsAt);
  const endsAt = parseZoneTime(zone.endsAt);
  const observedAt = parseZoneTime(zone.updatedAt) ?? parseZoneTime(zone.observedAt) ?? startsAt;

  if (startsAt && startsAt > nowMs) return 0;
  if (endsAt && nowMs <= endsAt) return 1;
  if (!observedAt) return 1;

  const ageMs = Math.max(0, nowMs - observedAt);
  if (ageMs <= FLIGHT_ZONE_AGE_RULES.fadeMs) return 1;
  if (ageMs >= FLIGHT_ZONE_AGE_RULES.expireMs) return 0;
  return 1 - ((ageMs - FLIGHT_ZONE_AGE_RULES.fadeMs) / (FLIGHT_ZONE_AGE_RULES.expireMs - FLIGHT_ZONE_AGE_RULES.fadeMs));
}

function buildZoneWindowLabel(zone) {
  const startsAt = zone.startsAt ? new Date(zone.startsAt).toISOString() : null;
  const endsAt = zone.endsAt ? new Date(zone.endsAt).toISOString() : null;
  const updatedAt = zone.updatedAt ? new Date(zone.updatedAt).toISOString() : null;
  if (startsAt && endsAt) return `${startsAt} to ${endsAt}`;
  if (updatedAt) return `Updated ${updatedAt}`;
  return 'Unknown window';
}

function reserveFlightZoneId(baseId, usedIds) {
  const seed = String(baseId ?? 'zone');
  const base = `zone-${seed}`;
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }
  let counter = 2;
  while (usedIds.has(`${base}-${counter}`)) counter += 1;
  const unique = `${base}-${counter}`;
  usedIds.add(unique);
  return unique;
}

function addFlightRestrictionZone(zone, nowMs, maxHeight, usedIds) {
  const points = normalizeZonePoints(zone.points);
  const opacity = computeFlightZoneOpacity(zone, nowMs);
  if (points.length < 3 || opacity <= 0 || !flightZonesDataSource) return;

  const source = String(zone.source ?? '').toLowerCase();
  const isSafeAirspace = source.includes('safe airspace') || String(zone.zoneType ?? '').toLowerCase() === 'safeairspace';
  const severity = String(zone.severity ?? '').toLowerCase();
  const isHigh = severity === 'high';
  const displaySeverity = isHigh ? 'restricted airspace' : (zone.severity ?? 'medium');
  const ffaEvenColor = Cesium.Color.fromCssColorString(isHigh ? '#ff3b30' : '#ff7f73').withAlpha(0.34 * opacity);
  const ffaOddColor = Cesium.Color.fromCssColorString('#ffd4cd').withAlpha(0.08 * opacity);
  const faaOutline = Cesium.Color.fromCssColorString(isHigh ? '#ff655c' : '#ff9f96').withAlpha(0.92 * opacity);
  const safeAirspaceCss = severity === 'high'
    ? '#ea283c'
    : (severity === 'medium' ? '#ff8b00' : '#ffce00');
  const safeAirspaceFill = Cesium.Color.fromCssColorString(safeAirspaceCss).withAlpha((severity === 'high' ? 0.24 : 0.2) * opacity);
  const safeAirspaceOutline = Cesium.Color.fromCssColorString(safeAirspaceCss).withAlpha(0.95 * opacity);
  const material = isSafeAirspace
    ? safeAirspaceFill
    : new Cesium.StripeMaterialProperty({
      evenColor: ffaEvenColor,
      oddColor: ffaOddColor,
      repeat: 18,
      offset: 0.2,
      orientation: Cesium.StripeOrientation.VERTICAL,
    });
  const outline = isSafeAirspace ? safeAirspaceOutline : faaOutline;
  const zoneSeverity = isSafeAirspace ? (zone.severity ?? 'low') : displaySeverity;

  flightZonesDataSource.entities.add({
    id: reserveFlightZoneId(zone.id, usedIds),
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray(flattenPoints(points)),
      height: 0,
      extrudedHeight: maxHeight,
      material,
      outline: false,
    },
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(flattenClosedPoints(points)),
      width: isSafeAirspace ? 3 : 2,
      clampToGround: true,
      material: outline,
    },
    properties: {
      type: 'zone',
      domain: 'flight',
      id: zone.id,
      name: zone.name,
      zoneType: zone.zoneType ?? 'tfr',
      severity: zoneSeverity,
      source: zone.source ?? 'FAA',
      status: zone.status ?? 'active',
      activeWindowUtc: buildZoneWindowLabel(zone),
      summary: zone.summary ?? '',
    },
  });
}

function addGpsInterferenceZone(zone, nowMs, maxHeight, usedIds) {
  const points = normalizeZonePoints(zone.points);
  const opacity = computeFlightZoneOpacity(zone, nowMs);
  if (points.length < 3 || opacity <= 0 || !flightZonesDataSource) return;

  const fill = Cesium.Color.fromCssColorString(zone.severity === 'high' ? '#ff3b30' : '#ffd54a').withAlpha((zone.severity === 'high' ? 0.22 : 0.18) * opacity);
  const outline = Cesium.Color.fromCssColorString(zone.severity === 'high' ? '#ff746c' : '#ffe17c').withAlpha(0.92 * opacity);

  flightZonesDataSource.entities.add({
    id: reserveFlightZoneId(zone.id, usedIds),
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray(flattenPoints(points)),
      height: Number(zone.floorMeters ?? 0),
      extrudedHeight: Number(zone.ceilingMeters ?? maxHeight),
      material: fill,
      outline: false,
    },
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(flattenClosedPoints(points)),
      width: 2,
      clampToGround: true,
      material: outline,
    },
    properties: {
      type: 'zone',
      domain: 'flight',
      id: zone.id,
      name: zone.name,
      zoneType: zone.zoneType ?? 'gps',
      severity: zone.severity ?? 'medium',
      source: zone.source ?? 'GPSJam',
      status: zone.status ?? 'active',
      activeWindowUtc: buildZoneWindowLabel(zone),
      summary: zone.summary ?? '',
    },
  });
}

function syncFlightZoneVisibility() {
  if (flightZonesDataSource) flightZonesDataSource.show = enabled;
}

function renderFlightZones(payload) {
  noflyGpsPayloadCache = payload;
  if (!flightZonesDataSource) return;

  const nowMs = Date.now();
  const maxHeight = Number(payload?.maxFlightHeightMeters ?? NOFLY_GPS_DEFAULT_MAX_HEIGHT_M);
  const usedIds = new Set();
  flightZonesDataSource.entities.removeAll();

  if (flightZoneFilters.airspace) {
    for (const zone of payload?.flightRestrictions ?? []) {
      addFlightRestrictionZone(zone, nowMs, maxHeight, usedIds);
    }
  }
  if (flightZoneFilters.gps) {
    for (const zone of payload?.gpsInterference ?? []) {
      addGpsInterferenceZone(zone, nowMs, maxHeight, usedIds);
    }
  }

  syncFlightZoneVisibility();
}

function noflyGpsUrlForViewer(viewer) {
  if (!viewer) return NOFLY_GPS_URL;
  const bounds = getViewportBounds(viewer);
  if (!bounds) return NOFLY_GPS_URL;
  const boundsStr = [bounds.minLon, bounds.minLat, bounds.maxLon, bounds.maxLat]
    .map(v => Number(v).toFixed(4))
    .join(',');
  return `${NOFLY_GPS_URL}?bounds=${encodeURIComponent(boundsStr)}`;
}

async function refreshFlightZones(viewer) {
  try {
    const response = await fetch(noflyGpsUrlForViewer(viewer));
    if (!response.ok) throw new Error(`nofly_gps ${response.status}`);
    const payload = await response.json();
    renderFlightZones(payload);
  } catch (error) {
    console.warn('[Flights] No-fly/GPS refresh failed:', error);
    if (noflyGpsPayloadCache) renderFlightZones(noflyGpsPayloadCache);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initFlights(viewer) {
  console.info(`[Flights] Provider: ${ACTIVE_PROVIDER}${SERVER_HEAVY_MODE ? ' (server-heavy mode)' : ''}`);

  // Defer the first fetch until the camera finishes its opening flyTo — before
  // that, getViewportBounds() returns null and providers reject lat/0/lon/0.
  // We wait for the camera's moveEnd event (fires when flyTo completes), with a
  // 6 s safety timeout in case the event never fires (e.g. no animation).
  await new Promise(resolve => {
    const timeout = setTimeout(resolve, 6000);
    viewer.camera.moveEnd.addEventListener(function onMoveEnd() {
      viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      clearTimeout(timeout);
      resolve();
    });
  });

  flightZonesDataSource = new Cesium.CustomDataSource('nofly-gps-zones');
  await viewer.dataSources.add(flightZonesDataSource);
  syncFlightZoneVisibility();
  await refreshFlightZones(viewer);
  if (noflyGpsPollTimer) {
    window.clearInterval(noflyGpsPollTimer);
  }
  noflyGpsPollTimer = window.setInterval(() => {
    if (enabled) refreshFlightZones(viewer);
  }, NOFLY_GPS_POLL_MS);

  if (SERVER_HEAVY_MODE) {
    subscribeServerSnapshot('flights', {
      onData(payload) {
        if (!enabled) return;

        try {
          const aircraft = mapProxyAircraft(payload?.flights?.aircraft ?? []);
          renderAircraft(viewer, aircraft);

          if (!flightFeedHealthy) {
            publishSystemStatus('● FLIGHT FEED RECOVERED · SERVER SNAPSHOT', 'ok', 'flights:recovered:server-snapshot');
          } else if (!hasPublishedFlightOk) {
            publishSystemStatus('● FLIGHT FEED OK · SERVER SNAPSHOT', 'ok', 'flights:ok:server-snapshot');
            hasPublishedFlightOk = true;
          }
          flightFeedHealthy = true;
        } catch (err) {
          console.warn('[Flights] Server snapshot apply failed:', err.message);
        }
      },
      onError(err) {
        console.warn('[Flights] Server snapshot failed:', err?.message ?? 'unknown');
        publishSystemStatus(`⚠ FLIGHT FEED ERROR · SERVER SNAPSHOT · ${err?.message ?? 'request failed'}`, 'error', `flights:error:server-snapshot:${err?.message ?? 'unknown'}`);
        flightFeedHealthy = false;
      },
    });

    return {
      setEnabled(val) {
        enabled = val;
        setServerSnapshotLayerEnabled('flights', enabled && isAnyClassificationActive());
        syncFlightZoneVisibility();
        if (enabled) refreshFlightZones(viewer);
        entityMap.forEach((e, icaoHex) => {
          const state = trackStateMap.get(icaoHex);
          const aircraftClassification = state?.aircraftClassification ?? 'commercial';
          e.show = shouldShowFlight(aircraftClassification);
        });
        applyFlatIconVisibility();
      },
      setAircraftClassificationFilter(classification, filterEnabled) {
        const classKey = (classification ?? 'commercial').toLowerCase();
        if (classKey in aircraftClassificationFilters) {
          aircraftClassificationFilters[classKey] = filterEnabled;
          entityMap.forEach((e, icaoHex) => {
            const state = trackStateMap.get(icaoHex);
            const aircraftClassification = state?.aircraftClassification ?? 'commercial';
            e.show = shouldShowFlight(aircraftClassification);
          });
          applyFlatIconVisibility();
          // Enable or suspend proxy polling based on whether any classification is still active.
          setServerSnapshotLayerEnabled('flights', enabled && isAnyClassificationActive());
        }
      },
      setFlightZoneFilter(zoneType, filterEnabled) {
        const zoneKey = (zoneType ?? '').toLowerCase();
        if (zoneKey in flightZoneFilters) {
          flightZoneFilters[zoneKey] = !!filterEnabled;
          if (noflyGpsPayloadCache) {
            renderFlightZones(noflyGpsPayloadCache);
          } else if (enabled) {
            refreshFlightZones(viewer);
          }
        }
      },
      get count()    { return entityMap.size; },
      get provider() { return ACTIVE_PROVIDER; },
    };
  }

  await fetchAndRender(viewer);
  setInterval(() => { if (enabled && isAnyClassificationActive()) fetchAndRender(viewer); }, POLL_MS);

  window.addEventListener('shadowgrid:follow', () => {
    hideAllFlatIcons = true;
    applyFlatIconVisibility();
  });

  window.addEventListener('shadowgrid:unfollow', () => {
    hideAllFlatIcons = false;
    applyFlatIconVisibility();
  });

  return {
    setEnabled(val) {
      enabled = val;
      syncFlightZoneVisibility();
      if (enabled) refreshFlightZones(viewer);
      entityMap.forEach((e, icaoHex) => {
        const state = trackStateMap.get(icaoHex);
        const aircraftClassification = state?.aircraftClassification ?? 'commercial';
        e.show = shouldShowFlight(aircraftClassification);
      });
      applyFlatIconVisibility();
    },
    setAircraftClassificationFilter(classification, filterEnabled) {
      const classKey = (classification ?? 'commercial').toLowerCase();
      if (classKey in aircraftClassificationFilters) {
        aircraftClassificationFilters[classKey] = filterEnabled;
        // Update visibility of all entities
        entityMap.forEach((e, icaoHex) => {
          const state = trackStateMap.get(icaoHex);
          const aircraftClassification = state?.aircraftClassification ?? 'commercial';
          e.show = shouldShowFlight(aircraftClassification);
        });
        applyFlatIconVisibility();
        // Trigger an immediate fetch when re-enabling after all were off; suppress
        // the poll interval when all classifications are inactive to save API quota.
        if (enabled) {
          if (filterEnabled && isAnyClassificationActive()) fetchAndRender(viewer);
        }
      }
    },
    setFlightZoneFilter(zoneType, filterEnabled) {
      const zoneKey = (zoneType ?? '').toLowerCase();
      if (zoneKey in flightZoneFilters) {
        flightZoneFilters[zoneKey] = !!filterEnabled;
        if (noflyGpsPayloadCache) {
          renderFlightZones(noflyGpsPayloadCache);
        } else if (enabled) {
          refreshFlightZones(viewer);
        }
      }
    },
    get count()    { return entityMap.size; },
    get provider() { return ACTIVE_PROVIDER; },
  };
}

/**
 * Switch an aircraft between normal flat SVG view and follow 3D-model view.
 * Called from HUD.js when follow starts/stops.
 */
export function setFollowMode(icaoHex, active) {
  const entity = entityMap.get(icaoHex.toLowerCase());
  if (!entity) return;

  if (active) {
    hideAllFlatIcons = true;
    // Derive color from stored properties so military/commercial/other colors match
    const classification = entity.properties?.classification?.getValue?.() ?? 'commercial';
    const color    = classificationColor(classification);
    const category = entity.properties?.category?.getValue?.() ?? '';
    const typecode = entity.properties?.typecode?.getValue?.() ?? '';
    const shape    = getShape({ category, typecode });
    
    // Get model URL: uses asset if available, falls back to procedural
    const modelUrl = getAircraftModelUrl(typecode, shape, color);
    
    // Determine if this is an asset model or procedural model
    const isAssetModel = modelUrl.startsWith('/src/assets/');
    
    const scale    = MODEL_SCALE[shape] ?? MODEL_SCALE.generic;
    const cesColor = Cesium.Color.fromCssColorString(color);

    // Create dynamic orientation property that continuously follows heading as aircraft updates
    entity.orientation = new Cesium.CallbackProperty(() => {
      const heading = entity.properties?.heading?.getValue?.() ?? 0;
      const pos     = entity.position?.getValue?.(Cesium.JulianDate.now());
      if (pos) {
        // Asset models need 90° offset to correct their axis orientation
        const headingOffset = isAssetModel ? 90 : 0;
        const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(heading + headingOffset), 0, 0);
        return Cesium.Transforms.headingPitchRollQuaternion(pos, hpr);
      }
      return Cesium.Quaternion.IDENTITY;
    }, false);

    // Attach the 3-D model and hide the flat SVG icon
    // Asset models: use original colors from the model (no tinting)
    // Procedural models: apply military/commercial/other classification colors
    const modelGraphicsProps = {
      uri:              new Cesium.ConstantProperty(modelUrl),
      scale:            new Cesium.ConstantProperty(scale),
      maximumScale:     new Cesium.ConstantProperty(scale),
      minimumPixelSize: new Cesium.ConstantProperty(12),
      shadows:          new Cesium.ConstantProperty(Cesium.ShadowMode.DISABLED),
      silhouetteColor:  new Cesium.ConstantProperty(Cesium.Color.BLACK),
      silhouetteSize:   new Cesium.ConstantProperty(1.0),
      show:             new Cesium.ConstantProperty(true),
    };
    
    // Only apply color tinting to procedural models (asset models keep their original colors)
    if (!isAssetModel) {
      modelGraphicsProps.color            = new Cesium.ConstantProperty(cesColor);
      modelGraphicsProps.colorBlendMode   = new Cesium.ConstantProperty(Cesium.ColorBlendMode.MIX);
      modelGraphicsProps.colorBlendAmount = new Cesium.ConstantProperty(0.5);
    }

    entity.model = new Cesium.ModelGraphics(modelGraphicsProps);
    
    if (entity.billboard) entity.billboard.show = new Cesium.ConstantProperty(false);
    if (entity.label) entity.label.show = new Cesium.ConstantProperty(false);
    applyFlatIconVisibility();

  } else {
    hideAllFlatIcons = false;
    // Restore SVG icon, hide model
    if (entity.billboard) entity.billboard.show = new Cesium.ConstantProperty(enabled);
    if (entity.label) entity.label.show = new Cesium.ConstantProperty(enabled);
    if (entity.model)     entity.model.show     = new Cesium.ConstantProperty(false);
    entity.orientation = undefined;
    applyFlatIconVisibility();
  }
}

// ── Viewport bounds ───────────────────────────────────────────────────────────

function getViewportBounds(viewer) {
  try {
    const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    if (!rect) return null;
    const toDeg = Cesium.Math.toDegrees;
    return {
      minLon: toDeg(rect.west),
      minLat: toDeg(rect.south),
      maxLon: toDeg(rect.east),
      maxLat: toDeg(rect.north),
    };
  } catch { return null; }
}

// ── Fetch dispatch ────────────────────────────────────────────────────────────

async function fetchAndRender(viewer) {
  try {
    const bounds   = getViewportBounds(viewer);
    const aircraft = await fetchAircraft(bounds);
    renderAircraft(viewer, aircraft);

    if (!flightFeedHealthy) {
      publishSystemStatus(`● FLIGHT FEED RECOVERED · ${ACTIVE_PROVIDER.toUpperCase()}`, 'ok', `flights:recovered:${ACTIVE_PROVIDER}`);
    } else if (!hasPublishedFlightOk) {
      publishSystemStatus(`● FLIGHT FEED OK · ${ACTIVE_PROVIDER.toUpperCase()}`, 'ok', `flights:ok:${ACTIVE_PROVIDER}`);
      hasPublishedFlightOk = true;
    }
    flightFeedHealthy = true;
  } catch (err) {
    console.warn(`[Flights] Fetch failed (${ACTIVE_PROVIDER}):`, err.message);
    publishSystemStatus(`⚠ FLIGHT FEED ERROR · ${ACTIVE_PROVIDER.toUpperCase()} · ${err?.message ?? 'request failed'}`, 'error', `flights:error:${ACTIVE_PROVIDER}:${err?.message ?? 'unknown'}`);
    flightFeedHealthy = false;
  }
}

async function fetchAircraft(bounds) {
  switch (ACTIVE_PROVIDER) {
    case 'airplaneslive': {
      try {
        return await fetchReadsbLike(AIRPLANESLIVE_BASE_URL, bounds, 'airplanes.live');
      } catch (err) {
        console.warn('[Flights] airplanes.live unavailable, falling back to adsb.lol:', err.message);
        publishSystemStatus('⚠ AIRPLANES.LIVE UNAVAILABLE · USING ADSB.LOL FALLBACK', 'warn', 'flights:airplaneslive-fallback');
        return fetchReadsbLike(ADSBOOL_BASE_URL, bounds, 'adsb.lol');
      }
    }
    case 'adsbool':       return fetchReadsbLike(ADSBOOL_BASE_URL, bounds, 'adsb.lol');
    case 'opensky': return fetchOpenSky();
    case 'proxy':
    default:        return fetchProxy(bounds);
  }
}

function boundsToQueryCenter(bounds) {
  if (!bounds) return null;

  const minLon = Number(bounds.minLon);
  const minLat = Number(bounds.minLat);
  const maxLon = Number(bounds.maxLon);
  const maxLat = Number(bounds.maxLat);

  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;

  let lonSpan = maxLon - minLon;
  if (lonSpan < 0) lonSpan += 360;
  const latSpan = Math.max(0, maxLat - minLat);

  let centerLon = minLon + lonSpan / 2;
  if (centerLon > 180) centerLon -= 360;
  const centerLat = minLat + latSpan / 2;

  // Approximate viewport diagonal and convert to nautical miles.
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.max(Math.cos(centerLat * Math.PI / 180), 0.1);
  const diagKm = Math.hypot(latSpan * kmPerDegLat, lonSpan * kmPerDegLon);
  const radiusNm = Math.min(250, Math.max(75, Math.round((diagKm / 1.852) * 0.6)));

  return {
    lat: centerLat,
    lon: centerLon,
    distNm: radiusNm,
  };
}

async function fetchReadsbLike(baseUrl, bounds, providerLabel) {
  const query = boundsToQueryCenter(bounds);
  // If bounds aren't available yet (camera still initialising), skip this cycle
  // rather than sending lat/0/lon/0 which most providers reject with 404.
  if (!query) return [];

  // Provider compatibility: some READSB-style APIs use /v2/lat/.../lon/.../dist/...
  // while others expose /v2/point/{lat}/{lon}/{dist}. Try both before failing.
  const candidateUrls = [
    `${baseUrl}/v2/lat/${query.lat.toFixed(4)}/lon/${query.lon.toFixed(4)}/dist/${query.distNm}`,
    `${baseUrl}/v2/point/${query.lat.toFixed(4)}/${query.lon.toFixed(4)}/${query.distNm}`,
  ];

  let data = null;
  let lastError = null;
  for (const url of candidateUrls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        lastError = new Error(`${providerLabel} ${resp.status}`);
        continue;
      }
      data = await resp.json();
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!data) throw lastError ?? new Error(`${providerLabel} unavailable`);

  const aircraft = data.aircraft ?? data.ac ?? [];

  const numOr = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return aircraft
    .filter(a => Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lon)))
    .map(a => {
      const onGround = a.alt_baro === 'ground' || a.gnd === true || a.on_ground === true;
      const altFt = onGround ? 0 : numOr(a.alt_baro ?? a.alt_geom, 0);
      return {
      id:       (a.hex ?? '').toLowerCase(),
      callsign: (a.flight ?? a.r ?? '').trim(),
      lat:      a.lat,
      lon:      a.lon,
      altFt,
      heading:  numOr(a.track ?? a.true_heading, 0),
      kts:      numOr(a.gs, 0),
      category: a.category ?? '',
      typecode: (a.t ?? a.type ?? '').toUpperCase(),
      squawk:   a.squawk ?? '',
      emergency: a.emergency ?? 'none',
      onGround,
      dbFlags:  a.dbFlags ?? 0,
      vert:     numOr(a.baro_rate ?? a.geom_rate, 0),
    };
    })
    .filter(a => a.id);
}

// ── Provider: local proxy ─────────────────────────────────────────────────────

async function fetchProxy(bounds) {
  let url = PROXY_URL;
  if (bounds) {
    const { minLon, minLat, maxLon, maxLat } = bounds;
    url += `?bounds=${minLon.toFixed(4)},${minLat.toFixed(4)},${maxLon.toFixed(4)},${maxLat.toFixed(4)}`;
  }
  if (SERVER_HEAVY_MODE) {
    url += bounds ? '&mode=heavy' : '?mode=heavy';
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Proxy ${resp.status} — is server/proxy.mjs running?`);
  const data = await resp.json();
  const aircraft = mapProxyAircraft(data.aircraft ?? []);
  console.info(`[Flights] ${aircraft.length} aircraft in viewport`);
  return aircraft;
}

function mapProxyAircraft(aircraft) {
  const numOr = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return aircraft
    .filter(a => Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lon)))
    .map(a => {
      const onGround = a.alt_baro === 'ground' || a.gnd === true || a.on_ground === true;
      const altFt = onGround ? 0 : numOr(a.alt_baro ?? a.alt_geom, 0);
      return {
      id:       (a.hex ?? '').toLowerCase(),
      callsign: (a.flight ?? a.r ?? '').trim(),
      lat:      a.lat,
      lon:      a.lon,
      altFt,
      heading:  numOr(a.track ?? a.true_heading, 0),
      kts:      numOr(a.gs, 0),
      category: a.category ?? '',
      typecode: (a.t ?? a.type ?? '').toUpperCase(),
      squawk:   a.squawk ?? '',
      emergency: a.emergency ?? 'none',
      onGround,
      dbFlags:  a.dbFlags ?? 0,
      vert:     numOr(a.baro_rate ?? a.geom_rate, 0),
    };
    })
    .filter(a => a.id);
}

// ── Provider: OpenSky ─────────────────────────────────────────────────────────

async function fetchOpenSky() {
  const token   = await getOpenSkyToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  // Request extended state vectors so index 17 (emitter category) is present.
  const resp    = await fetch('/api/opensky/api/states/all?extended=1', { headers });
  if (!resp.ok) throw new Error(`OpenSky ${resp.status}`);
  const data = await resp.json();
  return (data.states ?? [])
    .filter(s => Number.isFinite(Number(s[5])) && Number.isFinite(Number(s[6])))
    .map(s => ({
      id:       s[0].trim(),
      callsign: (s[1] ?? '').trim(),
      lat:      s[6],
      lon:      s[5],
      altFt:    s[8] ? 0 : (s[7] ?? 3000) * 3.281,
      heading:  s[10] ?? 0,
      kts:      (s[9] ?? 0) * 1.944,
      category: Number.isFinite(Number(s[17])) ? Number(s[17]) : null,
      squawk:   s[14] ?? '',
      emergency: ['7500', '7600', '7700'].includes(String(s[14] ?? '').trim()) ? String(s[14]).trim() : 'none',
      onGround: s[8] === true,
      vert:     (s[11] ?? 0) * 196.85,  // m/s → ft/min
    }));
}

async function getOpenSkyToken() {
  if (!OPENSKY_CLIENT_ID || !OPENSKY_CLIENT_SECRET) return null;
  if (oskToken && Date.now() < oskTokenExp) return oskToken;
  try {
    const resp = await fetch(OPENSKY_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type: 'client_credentials',
        client_id:  OPENSKY_CLIENT_ID,
        client_secret: OPENSKY_CLIENT_SECRET,
      }),
    });
    if (!resp.ok) throw new Error(`Token ${resp.status}`);
    const d     = await resp.json();
    oskToken    = d.access_token;
    oskTokenExp = Date.now() + (d.expires_in - 60) * 1000;
    return oskToken;
  } catch (err) {
    console.warn('[Flights] OpenSky token refresh failed:', err.message);
    return null;
  }
}

function updateTrackState(id, a) {
  const shape = getShape(a);  // Get the aircraft shape/type
  const classification = classifyAircraft(a);  // Get military/commercial/other
  trackStateMap.set(id, {
    aircraftType: shape,  // Store aircraft type for filtering
    aircraftClassification: classification,  // Store classification for filtering
    latRad: Cesium.Math.toRadians(a.lat),
    lonRad: Cesium.Math.toRadians(a.lon),
    altM: Math.max(0, a.altFt * 0.3048),
    headingRad: Cesium.Math.toRadians(a.heading ?? 0),
    speedMps: Math.max(0, (a.kts ?? 0) * KTS_TO_MPS),
    vertMps: (a.vert ?? 0) * FTMIN_TO_MPS,
    baseTimeSec: Date.now() / 1000,
  });
}

function predictTrackState(state) {
  const nowSec = Date.now() / 1000;
  const dt = Math.min(MAX_PREDICT_SECONDS, Math.max(0, nowSec - state.baseTimeSec));

  const dist = state.speedMps * dt;
  if (dist < 0.01) {
    return {
      latRad: state.latRad,
      lonRad: state.lonRad,
      altM: Math.max(0, state.altM + state.vertMps * dt),
    };
  }

  const ad = dist / EARTH_RADIUS_M;
  const sinLat1 = Math.sin(state.latRad);
  const cosLat1 = Math.cos(state.latRad);
  const sinAd = Math.sin(ad);
  const cosAd = Math.cos(ad);
  const sinBrg = Math.sin(state.headingRad);
  const cosBrg = Math.cos(state.headingRad);

  const latRad = Math.asin(sinLat1 * cosAd + cosLat1 * sinAd * cosBrg);
  const lonRad = state.lonRad + Math.atan2(
    sinBrg * sinAd * cosLat1,
    cosAd - sinLat1 * Math.sin(latRad)
  );

  return {
    latRad,
    lonRad: Cesium.Math.zeroToTwoPi(lonRad),
    altM: Math.max(0, state.altM + state.vertMps * dt),
  };
}

function getTrackPositionProperty(id) {
  if (trackPosPropMap.has(id)) return trackPosPropMap.get(id);
  const scratch = new Cesium.Cartesian3();
  const prop = new Cesium.CallbackPositionProperty((time, result) => {
    const state = trackStateMap.get(id);
    if (!state) return result ?? scratch;
    const p = predictTrackState(state);
    return Cesium.Cartesian3.fromRadians(p.lonRad, p.latRad, p.altM, undefined, result ?? scratch);
  }, false);
  trackPosPropMap.set(id, prop);
  return prop;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderAircraft(viewer, aircraft) {
  const setProp = (bag, key, value) => {
    const p = bag?.[key];
    if (p?.setValue) p.setValue(value);
    else if (bag) bag[key] = value;
  };

  const seen = new Set();

  for (const a of aircraft) {
    if (!a.id) continue;
    seen.add(a.id);
    updateTrackState(a.id, a);

    const altMetres = a.altFt * 0.3048;
    const color     = aircraftColor(a);
    const shape     = getShape(a);
    const classification = classifyAircraft(a);  // Get classification for visibility
    const icon      = buildSvgUri(shape, color);
    const iconSizePx = ICON_SIZE_PX[shape] ?? ICON_SIZE_PX.generic;
    const cesColor  = Cesium.Color.fromCssColorString(color);

    if (entityMap.has(a.id)) {
      const entity = entityMap.get(a.id);
      entity.position = getTrackPositionProperty(a.id);
      // Re-check visibility on every update to respect current filters
      entity.show = shouldShowFlight(classification);
      if (entity.billboard) {
        // Check if this aircraft is currently selected (has glow enabled)
        const useGlow = selectedFlightId === a.id;
        const iconToUse = useGlow ? buildGlowSvgUri(shape, color) : icon;
        entity.billboard.image    = new Cesium.ConstantProperty(iconToUse);
        entity.billboard.width    = new Cesium.ConstantProperty(iconSizePx);
        entity.billboard.height   = new Cesium.ConstantProperty(iconSizePx);
        entity.billboard.rotation = new Cesium.ConstantProperty(iconRotationFromHeading(a.heading));
      }
      // Update stored props for HUD
      if (entity.properties) {
        setProp(entity.properties, 'callsign', a.callsign);
        setProp(entity.properties, 'altFt', a.altFt);
        setProp(entity.properties, 'kts', a.kts);
        setProp(entity.properties, 'heading', a.heading);
        setProp(entity.properties, 'squawk', a.squawk);
        setProp(entity.properties, 'emergency', a.emergency ?? 'none');
        setProp(entity.properties, 'onGround', !!a.onGround);
        setProp(entity.properties, 'dbFlags', a.dbFlags);
        setProp(entity.properties, 'vert', a.vert);
        setProp(entity.properties, 'category', a.category);
        // Only overwrite typecode from the feed if the feed actually has one.
        // Preserve any HUD-enriched value when the provider (e.g. OpenSky) sends nothing.
        const effectiveTypecode = a.typecode || enrichedTypecodeMap.get(a.id) || '';
        setProp(entity.properties, 'typecode', effectiveTypecode);
        setProp(entity.properties, 'classification', classification);
      }
    } else {
      const entity = viewer.entities.add({
        id:       `flight-${a.id}`,
        position: getTrackPositionProperty(a.id),
        show:     shouldShowFlight(classification),
        billboard: {
          image:                    icon,
          width:                    iconSizePx,
          height:                   iconSizePx,
          rotation:                 iconRotationFromHeading(a.heading),
          alignedAxis:              Cesium.Cartesian3.UNIT_Z,
          scaleByDistance:          new Cesium.NearFarScalar(1e3, 1.6, 8e6, 0.65),
          color:                    Cesium.Color.WHITE,
          disableDepthTestDistance: 5e6,
          show:                     shouldShowFlight(classification) && !hideAllFlatIcons,
        },
        label: {
          text:                     a.callsign || a.id.toUpperCase(),
          font:                     '10px "Share Tech Mono", monospace',
          fillColor:                cesColor,
          outlineColor:             Cesium.Color.BLACK,
          outlineWidth:             2,
          style:                    Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:              new Cesium.Cartesian2(16, -10),
          scaleByDistance:          new Cesium.NearFarScalar(1e3, 1.0, 3e6, 0),
          translucencyByDistance:   new Cesium.NearFarScalar(1e3, 1.0, 2e6, 0),
          disableDepthTestDistance: 5e6,
          show:                     shouldShowFlight(classification) && !hideAllFlatIcons,
        },
        properties: {
          type:           'flight',
          icao:           a.id,
          callsign:       a.callsign,
          altFt:          a.altFt,
          kts:            a.kts,
          heading:        a.heading,
          squawk:         a.squawk,
          emergency:      a.emergency ?? 'none',
          onGround:       !!a.onGround,
          dbFlags:        a.dbFlags,
          vert:           a.vert,
          category:       a.category,
          typecode:       a.typecode || enrichedTypecodeMap.get(a.id) || '',
          provider:       ACTIVE_PROVIDER,
          classification: classification,
        },
      });
      entityMap.set(a.id, entity);
    }
  }

  // Remove aircraft that left viewport
  for (const [id, entity] of entityMap) {
    if (!seen.has(id)) {
      viewer.entities.remove(entity);
      entityMap.delete(id);
      trackStateMap.delete(id);
      trackPosPropMap.delete(id);
    }
  }

  console.info(`[Flights] Rendering ${entityMap.size} aircraft`);
}

// ── Glow effect for selected flight ───────────────────────────────────────────

let selectedFlightId = null;
const glowSvgCache = new Map();

function getContrastingGlowColor(fillColor) {
  // Return a contrasting color for the glow based on the fill color
  const colorMap = {
    '#f44336': '#00ff88', // military red → bright green
    '#00e676': '#ff8800', // commercial green → orange
    '#ffa726': '#00b8ff', // other orange → cyan
  };
  return colorMap[fillColor] || '#00ff88'; // default to bright green
}

function buildGlowSvgUri(shape, color) {
  const key = `${shape}:${color}:glow`;
  if (glowSvgCache.has(key)) return glowSvgCache.get(key);

  const glowCol = getContrastingGlowColor(color);
  const rawSvg  = SHAPES[shape] ?? SHAPES.generic;

  // Extract transform from original
  const gTagMatch = rawSvg.match(/<g([^>]*)>/);
  const rawAttribs = gTagMatch ? gTagMatch[1] : ' transform="translate(50,50)"';
  const xformMatch = rawAttribs.match(/transform="([^"]+)"/);
  const xform      = xformMatch ? ` transform="${xformMatch[1]}"` : '';

  const innerMatch = rawSvg.match(/<g[^>]*>([\s\S]*?)<\/g>/);
  const inner      = innerMatch ? innerMatch[1] : '';

  const vb = (rawSvg.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 100 100';
  const w  = 320;
  const h  = 320;

  // Create animated glow with pulsing effect
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${w}" height="${h}">
  <defs>
    <style>
      @keyframes pulse-glow {
        0%, 100% { r: 50%; opacity: 0.4; }
        50% { r: 65%; opacity: 0.8; }
      }
    </style>
    <filter id="glow-filter" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <!-- Animated pulsing glow rings -->
  <circle cx="50" cy="50" r="40" fill="none" stroke="${glowCol}" stroke-width="2" opacity="0.6">
    <animate attributeName="r" values="40;55;40" dur="1.5s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="0.8;0.2;0.8" dur="1.5s" repeatCount="indefinite"/>
  </circle>
  <circle cx="50" cy="50" r="35" fill="none" stroke="${glowCol}" stroke-width="1.5" opacity="0.4">
    <animate attributeName="r" values="35;50;35" dur="2s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="0.6;0.15;0.6" dur="2s" repeatCount="indefinite"/>
  </circle>
  <!-- Aircraft shape with enhanced glow -->
  <g${xform} fill="${color}" stroke="${glowCol}" stroke-width="2.5" stroke-linejoin="round" filter="url(#glow-filter)">${inner}</g>
</svg>`;

  const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  glowSvgCache.set(key, uri);
  return uri;
}

export function setFlightGlow(icaoHex, active) {
  const id = icaoHex.toLowerCase();
  const entity = entityMap.get(id);
  if (!entity) return;

  if (active) {
    selectedFlightId = id;
    // Get current color and shape from stored properties
    const classification = entity.properties?.classification?.getValue?.() ?? 'commercial';
    const color    = classificationColor(classification);
    const category = entity.properties?.category?.getValue?.() ?? '';
    const typecode = entity.properties?.typecode?.getValue?.() ?? '';
    const shape    = getShape({ category, typecode });

    // Build glowing SVG and apply it
    const glowIcon = buildGlowSvgUri(shape, color);
    if (entity.billboard) {
      entity.billboard.image = new Cesium.ConstantProperty(glowIcon);
    }
  } else {
    if (selectedFlightId === id) selectedFlightId = null;
    // Restore normal icon
    const classification = entity.properties?.classification?.getValue?.() ?? 'commercial';
    const color    = classificationColor(classification);
    const category = entity.properties?.category?.getValue?.() ?? '';
    const typecode = entity.properties?.typecode?.getValue?.() ?? '';
    const shape    = getShape({ category, typecode });

    const normalIcon = buildSvgUri(shape, color);
    if (entity.billboard) {
      entity.billboard.image = new Cesium.ConstantProperty(normalIcon);
    }
  }
}