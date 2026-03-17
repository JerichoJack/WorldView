/**
 * server/proxy.mjs
 * ShadowGrid flight data proxy — viewport-aware, on-demand hub fetching.
 *
 * The browser sends the visible bounding box with each request:
 *   GET /api/flights?bounds=minLon,minLat,maxLon,maxLat
 *
 * The proxy computes which 250nm-radius hubs overlap that bbox, fetches only
 * those hubs from opendata.adsb.fi, merges results into a persistent DB, and
 * returns the full DB snapshot filtered to the bbox.
 *
 * Hub results are cached individually per hub (TTL: 12s) so panning doesn't
 * re-fetch hubs that were just queried. The DB also retains aircraft globally
 * so previously-seen aircraft outside the viewport are preserved for when the
 * user pans back.
 *
 * Start:  node server/proxy.mjs
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import * as satellite from 'satellite.js';
import { cellToBoundary } from 'h3-js';
import { feature as topojsonFeature } from 'topojson-client';

const PORT       = 3001;
const RADIUS_NM  = 250;
const RADIUS_DEG = RADIUS_NM / 60;   // ~4.17 degrees
const SERVER_HEAVY_MODE = /^(1|true|yes)$/i.test(
  process.env.SHADOWGRID_SERVER_HEAVY ?? process.env.SHADOWGRID_SERVER_MODE ?? ''
);
const HUB_TTL    = SERVER_HEAVY_MODE ? 8_000 : 12_000;    // ms — don't re-fetch a hub more often than this
const STALE_MS   = SERVER_HEAVY_MODE ? 300_000 : 120_000; // keep aircraft longer in heavy mode
const MAX_CONC   = SERVER_HEAVY_MODE ? 24 : 12;           // max concurrent hub fetches per request

const HEADERS = { 'User-Agent': 'ShadowGrid/0.1 (github.com/JerichoJack/ShadowGrid)' };

function loadDotEnvVars() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return new Map();
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  const out = new Map();
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const key = s.slice(0, i).trim();
    const val = s.slice(i + 1).trim();
    out.set(key, val);
  }
  return out;
}

const DOTENV_VARS = loadDotEnvVars();
const GOOGLE_ROUTES_KEY = process.env.VITE_GOOGLE_MAPS_API_KEY || DOTENV_VARS.get('VITE_GOOGLE_MAPS_API_KEY') || '';
const BACKEND_FLIGHT_PROVIDER = (process.env.VITE_FLIGHT_PROVIDER || DOTENV_VARS.get('VITE_FLIGHT_PROVIDER') || 'opensky').toLowerCase();
const BACKEND_SATELLITE_PROVIDER = (process.env.VITE_SATELLITE_PROVIDER || DOTENV_VARS.get('VITE_SATELLITE_PROVIDER') || 'celestrak').toLowerCase();
const BACKEND_SATELLITE_IMAGERY_PROVIDER = (
  process.env.VITE_SATELLITE_IMAGERY_PROVIDER
  || DOTENV_VARS.get('VITE_SATELLITE_IMAGERY_PROVIDER')
  || process.env.SATELLITE_IMAGERY_PROVIDER
  || DOTENV_VARS.get('SATELLITE_IMAGERY_PROVIDER')
  // Backward-compat fallback: older setups may have used VITE_SATELLITE_PROVIDER.
  || process.env.VITE_SATELLITE_PROVIDER
  || DOTENV_VARS.get('VITE_SATELLITE_PROVIDER')
  || ''
).toLowerCase();
const BACKEND_TRAFFIC_PROVIDER = (process.env.VITE_TRAFFIC_PROVIDER || DOTENV_VARS.get('VITE_TRAFFIC_PROVIDER') || 'auto').toLowerCase();
const BACKEND_MARINE_PROVIDER = (process.env.VITE_MARINE_PROVIDER || DOTENV_VARS.get('VITE_MARINE_PROVIDER') || 'auto').toLowerCase();
const OPENSKY_CLIENT_ID = process.env.VITE_OPENSKY_CLIENT_ID || DOTENV_VARS.get('VITE_OPENSKY_CLIENT_ID') || '';
const OPENSKY_CLIENT_SECRET = process.env.VITE_OPENSKY_CLIENT_SECRET || DOTENV_VARS.get('VITE_OPENSKY_CLIENT_SECRET') || '';
const SPACETRACK_USER = process.env.VITE_SPACETRACK_USERNAME || DOTENV_VARS.get('VITE_SPACETRACK_USERNAME') || '';
const SPACETRACK_PASS = process.env.VITE_SPACETRACK_PASSWORD || DOTENV_VARS.get('VITE_SPACETRACK_PASSWORD') || '';
const N2YO_KEY = process.env.VITE_N2YO_API_KEY || DOTENV_VARS.get('VITE_N2YO_API_KEY') || '';
const AIS_PROXY_URL = process.env.VITE_MARINE_AIS_PROXY_URL || DOTENV_VARS.get('VITE_MARINE_AIS_PROXY_URL') || '';
const AIS_PROXY_KEY = process.env.VITE_MARINE_AIS_PROXY_KEY || DOTENV_VARS.get('VITE_MARINE_AIS_PROXY_KEY') || '';
const SENTINEL_HUB_INSTANCE_ID = process.env.SENTINEL_HUB_INSTANCE_ID || process.env.VITE_SENTINEL_HUB_INSTANCE_ID || DOTENV_VARS.get('SENTINEL_HUB_INSTANCE_ID') || DOTENV_VARS.get('VITE_SENTINEL_HUB_INSTANCE_ID') || '';
const SENTINEL_HUB_TRUE_COLOR_LAYER = process.env.SENTINEL_HUB_TRUE_COLOR_LAYER || process.env.VITE_SENTINEL_HUB_TRUE_COLOR_LAYER || DOTENV_VARS.get('SENTINEL_HUB_TRUE_COLOR_LAYER') || DOTENV_VARS.get('VITE_SENTINEL_HUB_TRUE_COLOR_LAYER') || 'TRUE_COLOR';
const SENTINEL_HUB_FALSE_COLOR_LAYER = process.env.SENTINEL_HUB_FALSE_COLOR_LAYER || process.env.VITE_SENTINEL_HUB_FALSE_COLOR_LAYER || DOTENV_VARS.get('SENTINEL_HUB_FALSE_COLOR_LAYER') || DOTENV_VARS.get('VITE_SENTINEL_HUB_FALSE_COLOR_LAYER') || SENTINEL_HUB_TRUE_COLOR_LAYER;
const COPERNICUS_DATASPACE_INSTANCE_ID = process.env.COPERNICUS_DATASPACE_INSTANCE_ID || DOTENV_VARS.get('COPERNICUS_DATASPACE_INSTANCE_ID') || '';
const COPERNICUS_DATASPACE_TRUE_COLOR_LAYER = process.env.COPERNICUS_DATASPACE_TRUE_COLOR_LAYER || DOTENV_VARS.get('COPERNICUS_DATASPACE_TRUE_COLOR_LAYER') || 'TRUE_COLOR';
const COPERNICUS_DATASPACE_FALSE_COLOR_LAYER = process.env.COPERNICUS_DATASPACE_FALSE_COLOR_LAYER || DOTENV_VARS.get('COPERNICUS_DATASPACE_FALSE_COLOR_LAYER') || COPERNICUS_DATASPACE_TRUE_COLOR_LAYER;
const SATELLITE_MAX_PER_CATEGORY = Math.max(parseInt(process.env.VITE_SATELLITE_MAX_PER_CATEGORY || DOTENV_VARS.get('VITE_SATELLITE_MAX_PER_CATEGORY') || DOTENV_VARS.get('VITE_SATELLITE_MAX_OBJECTS') || '500', 10) || 500, 1);

// ── Satellite snapshot cache (server-side propagation mode) ─────────────────
const SAT_CATALOG_TTL_MS = 10 * 60_000;
const SAT_SNAPSHOT_POLL_TIMEOUT_MS = 8000;
const SAT_SNAPSHOT_TTL_MS = 5_000;
const TRAFFIC_SNAPSHOT_TTL_MS = 45_000;
const MARINE_SNAPSHOT_TTL_MS = 30_000;
const FLIGHT_SNAPSHOT_TTL_MS = SERVER_HEAVY_MODE ? 3_000 : 1_500;
const CAMERA_MANIFEST_TTL_MS = 10 * 60_000;
const CAMERA_TILE_CACHE_TTL_MS = 15 * 60_000;
const CAMERA_SNAPSHOT_TTL_MS = 8_000;
const OVERLAY_SNAPSHOT_TTL_MS = 5 * 60_000;
const OVERLAY_MAX_FLIGHT_HEIGHT_M = 18_000;
const FAA_TFR_WFS_URL = 'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=300&outputFormat=application/json&srsname=EPSG:4326';
const FAA_TFR_LIST_URL = 'https://tfr.faa.gov/tfrapi/getTfrList';
const SAFE_AIRSPACE_MAP_URL = 'https://safeairspace.net/map/';
const GPSJAM_MANIFEST_URL = 'https://gpsjam.org/data/manifest.csv';
const GPSJAM_DATA_BASE_URL = 'https://gpsjam.org/data';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];
const IODA_API_BASE_URL = 'https://api.ioda.inetintel.cc.gatech.edu/v2';
const IODA_BLACKOUT_LOOKBACK_SEC = 24 * 60 * 60;
const IODA_COUNTRY_SUMMARY_LIMIT = 300;
const IODA_EVENT_ENRICH_LIMIT = 24;
const SNAPSHOT_BOUNDS_GRID_DEG = 0.25;
const CAMERA_MAX_POINTS = Math.max(parseInt(process.env.SHADOWGRID_CAMERA_MAX_POINTS ?? '6000', 10) || 6000, 1);
const CACHE_DIR = path.resolve(process.cwd(), 'server', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'world-snapshot-cache.json');
const TILE_CACHE_DIR = path.join(CACHE_DIR, 'tile-http');
const CAMERA_STREAM_DIR = path.join(CACHE_DIR, 'camera-streams');
const TILE_CACHE_TTL_MS = 12 * 60 * 60_000;
const TILE_CACHE_STALE_MS = 7 * 24 * 60 * 60_000;
const CAMERA_STREAM_IDLE_MS = 2 * 60_000;
const CAMERA_STREAM_BOOT_TIMEOUT_MS = 8_000;
const NASA_GIBS_WMS_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
const SENTINEL_HUB_WMS_URL = SENTINEL_HUB_INSTANCE_ID
  ? `https://services.sentinel-hub.com/ogc/wms/${SENTINEL_HUB_INSTANCE_ID}`
  : '';
const COPERNICUS_DATASPACE_WMS_URL = COPERNICUS_DATASPACE_INSTANCE_ID
  ? `https://sh.dataspace.copernicus.eu/ogc/wms/${COPERNICUS_DATASPACE_INSTANCE_ID}`
  : '';
const SATELLITE_PREVIEW_IMAGE_SIZE = 768;
let satCatalogTs = 0;
/** @type {Array<{id:string,name:string,line1:string,line2:string,satrec:any,meta:any,category:string}>} */
let satCatalog = [];
let satCatalogSource = 'unknown';
let satSnapshotCache = { ts: 0, points: [], source: 'unknown', maxCount: 0, perCategory: SATELLITE_MAX_PER_CATEGORY, categoryKey: 'all' };
let openSkyToken = '';
let openSkyTokenExp = 0;
const tileFetchInFlight = new Map();
const cameraStreamSessions = new Map();
let cameraStreamCleanupTimer = null;
let ffmpegChecked = false;
let ffmpegAvailable = false;

const N2YO_SNAPSHOT_TTL_MS = 120_000;
const N2YO_SAMPLE_POINTS = [
  { lat: 0, lon: 0 },
  { lat: 0, lon: 90 },
  { lat: 0, lon: -90 },
  { lat: 45, lon: 0 },
  { lat: -45, lon: 0 },
  { lat: 45, lon: 120 },
  { lat: -45, lon: -120 },
  { lat: 60, lon: 60 },
  { lat: -60, lon: -60 },
];

/** @type {Map<string, {ts:number, payload:any}>} */
const flightSnapshotCache = new Map();
/** @type {Map<string, {ts:number, payload:any}>} */
const trafficSnapshotCache = new Map();
/** @type {Map<string, {ts:number, payload:any}>} */
const marineSnapshotCache = new Map();

/** @type {{ts:number, tileDeg:number, tiles:Array<{key:string,lat:number,lng:number,count:number}>}} */
let cameraManifestCache = { ts: 0, tileDeg: 5, tiles: [] };
/** @type {Map<string, {ts:number, cameras:Array<any>}>} */
const cameraTileCache = new Map();
/** @type {Map<string, {ts:number, payload:any}>} */
const cameraSnapshotCache = new Map();
/** @type {Map<string, {ts:number, payload:any}>} */
const overlaySnapshotCache = new Map();

let cacheWriteTimer = null;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function ensureTileCacheDir() {
  if (!fs.existsSync(TILE_CACHE_DIR)) {
    fs.mkdirSync(TILE_CACHE_DIR, { recursive: true });
  }
}

function ensureCameraStreamDir() {
  if (!fs.existsSync(CAMERA_STREAM_DIR)) {
    fs.mkdirSync(CAMERA_STREAM_DIR, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeIsoDate(value) {
  const fallback = new Date().toISOString().slice(0, 10);
  if (!value) return fallback;
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) return fallback;
  return parsed.toISOString().slice(0, 10);
}

function canonicalizeBandExpression(value) {
  return String(value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .join(',');
}

const SATELLITE_ALLOWED_SOURCES = new Set(['auto', 'nasa-gibs', 'sentinel-hub', 'copernicus-dataspace', 'basemap']);

const SATELLITE_COLLECTION_BAND_ALLOWLIST = new Map([
  ['COPERNICUS/S2_SR_HARMONIZED', new Set(['B4,B3,B2', 'B8,B4,B3', 'B12,B8,B4', 'B11,B8,B2'])],
  ['COPERNICUS/S2_HARMONIZED', new Set(['B4,B3,B2', 'B8,B4,B3', 'B12,B8,B4', 'B11,B8,B2'])],
  ['COPERNICUS/S1_GRD', new Set(['VV', 'VH', 'VV,VH'])],
  ['COPERNICUS/S3/OLCI', new Set(['Oa08_radiance,Oa06_radiance,Oa04_radiance', 'Oa17_radiance,Oa08_radiance,Oa06_radiance', 'Oa21_radiance,Oa17_radiance,Oa08_radiance'])],
  ['COPERNICUS/S5P/OFFL/L3_NO2', new Set(['tropospheric_NO2_column_number_density'])],
  ['COPERNICUS/S5P/OFFL/L3_CO', new Set(['CO_column_number_density'])],
  ['COPERNICUS/S5P/OFFL/L3_SO2', new Set(['SO2_column_number_density'])],
  ['COPERNICUS/S5P/OFFL/L3_CH4', new Set(['CH4_column_volume_mixing_ratio_dry_air'])],
  ['COPERNICUS/S5P/OFFL/L3_AER_AI', new Set(['absorbing_aerosol_index'])],
  ['LANDSAT/LC09/C02/T1_L2', new Set(['SR_B4,SR_B3,SR_B2', 'SR_B5,SR_B4,SR_B3', 'SR_B6,SR_B5,SR_B4', 'SR_B6,SR_B5,SR_B2'])],
  ['LANDSAT/LC08/C02/T1_L2', new Set(['SR_B4,SR_B3,SR_B2', 'SR_B5,SR_B4,SR_B3', 'SR_B6,SR_B5,SR_B4', 'SR_B6,SR_B5,SR_B2'])],
  ['LANDSAT/LE07/C02/T1_L2', new Set(['SR_B3,SR_B2,SR_B1', 'SR_B4,SR_B3,SR_B2', 'SR_B5,SR_B4,SR_B3', 'SR_B5,SR_B4,SR_B2'])],
  ['LANDSAT/LT05/C02/T1_L2', new Set(['SR_B3,SR_B2,SR_B1', 'SR_B4,SR_B3,SR_B2', 'SR_B5,SR_B4,SR_B3', 'SR_B5,SR_B4,SR_B2'])],
  ['LANDSAT/LC09/C02/T1_TOA', new Set(['B4,B3,B2', 'B5,B4,B3', 'B6,B5,B4', 'B6,B5,B2'])],
  ['LANDSAT/LC08/C02/T1_TOA', new Set(['B4,B3,B2', 'B5,B4,B3', 'B6,B5,B4', 'B6,B5,B2'])],
  ['MODIS/061/MOD09GA', new Set(['sur_refl_b01,sur_refl_b04,sur_refl_b03', 'sur_refl_b02,sur_refl_b01,sur_refl_b04', 'sur_refl_b06,sur_refl_b02,sur_refl_b01', 'sur_refl_b06,sur_refl_b02,sur_refl_b04'])],
  ['MODIS/061/MYD09GA', new Set(['sur_refl_b01,sur_refl_b04,sur_refl_b03', 'sur_refl_b02,sur_refl_b01,sur_refl_b04', 'sur_refl_b06,sur_refl_b02,sur_refl_b01', 'sur_refl_b06,sur_refl_b02,sur_refl_b04'])],
  ['MODIS/061/MOD09GQ', new Set(['sur_refl_b01,sur_refl_b02,sur_refl_b01', 'sur_refl_b02,sur_refl_b01,sur_refl_b02'])],
  ['MODIS/061/MOD13Q1', new Set(['NDVI', 'EVI'])],
  ['MODIS/061/MOD11A2', new Set(['LST_Day_1km', 'LST_Night_1km'])],
  ['MODIS/061/MOD14A1', new Set(['FireMask', 'MaxFRP'])],
  ['MODIS/061/MOD10A1', new Set(['NDSI_Snow_Cover', 'NDSI_Snow_Cover_Basic_QA'])],
  ['MODIS/061/MCD43A4', new Set(['Nadir_Reflectance_Band1,Nadir_Reflectance_Band4,Nadir_Reflectance_Band3', 'Nadir_Reflectance_Band2,Nadir_Reflectance_Band1,Nadir_Reflectance_Band4', 'Nadir_Reflectance_Band6,Nadir_Reflectance_Band2,Nadir_Reflectance_Band1', 'Nadir_Reflectance_Band6,Nadir_Reflectance_Band2,Nadir_Reflectance_Band4'])],
  ['NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG', new Set(['avg_rad'])],
  ['NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG', new Set(['avg_rad'])],
  ['NASA/VIIRS/VNP46A1', new Set(['DNB_BRDF_Corrected_NTL'])],
  ['NOAA/VIIRS/001/VNP09GA', new Set(['M5,M4,M3', 'M7,M5,M4', 'M11,M7,M5', 'M11,M7,M4'])],
  ['NOAA/VIIRS/001/VNP13A1', new Set(['NDVI', 'EVI', 'EVI2'])],
  ['NOAA/GOES/16/MCMIPF', new Set(['CMI_C02,CMI_C02,CMI_C01', 'CMI_C03,CMI_C02,CMI_C01', 'CMI_C13,CMI_C07,CMI_C02', 'CMI_C02', 'CMI_C08', 'CMI_C13'])],
  ['NOAA/GOES/17/MCMIPF', new Set(['CMI_C02,CMI_C02,CMI_C01', 'CMI_C03,CMI_C02,CMI_C01', 'CMI_C13,CMI_C07,CMI_C02', 'CMI_C02', 'CMI_C13'])],
  ['NOAA/GOES/18/MCMIPF', new Set(['CMI_C02,CMI_C02,CMI_C01', 'CMI_C03,CMI_C02,CMI_C01', 'CMI_C13,CMI_C07,CMI_C02', 'CMI_C02', 'CMI_C13'])],
  ['ASTER/AST_L1T_003', new Set(['B3N,B02,B01', 'B04,B3N,B02', 'B3N', 'B04,B05,B06', 'B10,B11,B12'])],
  ['NASA/ASTER_GED/AG100_003', new Set(['elevation', 'emissivity_mean', 'temperature'])],
]);

function getSatelliteCredentialSetupHint() {
  return [
    'Set SENTINEL_HUB_INSTANCE_ID in server .env (or environment).',
    'Optionally set SENTINEL_HUB_TRUE_COLOR_LAYER and SENTINEL_HUB_FALSE_COLOR_LAYER.',
    'Create/get credentials from Sentinel Hub Dashboard: https://apps.sentinel-hub.com/dashboard/',
  ].join(' ');
}

function getCopernicusDataspaceSetupHint() {
  return [
    'Set COPERNICUS_DATASPACE_INSTANCE_ID in server .env (or environment).',
    'Optionally set COPERNICUS_DATASPACE_TRUE_COLOR_LAYER and COPERNICUS_DATASPACE_FALSE_COLOR_LAYER.',
    'Create/get your free Copernicus Data Space Browser instance from: https://dataspace.copernicus.eu/',
  ].join(' ');
}

function getCollectionBackendPolicy(collectionId) {
  const id = String(collectionId || '').trim().toUpperCase();

  if (id.startsWith('COPERNICUS/S5P/')) {
    return {
      authority: 'ESA Copernicus / Sentinel-5P',
      preferredBackend: 'nasa-gibs', // changed from 'copernicus-dataspace' for troubleshooting
      allowedSources: ['auto', 'nasa-gibs', 'copernicus-dataspace', 'sentinel-hub', 'basemap'], // added 'nasa-gibs' for troubleshooting
      requiresRemoteCredentials: true,
    };
  }
  if (id.startsWith('COPERNICUS/')) {
    return {
      authority: 'ESA Copernicus',
      preferredBackend: 'nasa-gibs', // changed from 'copernicus-dataspace' for troubleshooting
      allowedSources: ['auto', 'nasa-gibs', 'copernicus-dataspace', 'sentinel-hub', 'basemap'], // added 'nasa-gibs' for troubleshooting
      requiresRemoteCredentials: true,
    };
  }
  if (id.startsWith('LANDSAT/')) {
    return {
      authority: 'NASA / USGS',
      preferredBackend: 'nasa-gibs', // changed from 'copernicus-dataspace' for troubleshooting
      allowedSources: ['auto', 'nasa-gibs', 'copernicus-dataspace', 'sentinel-hub', 'basemap'], // added 'nasa-gibs' for troubleshooting
      requiresRemoteCredentials: true,
    };
  }
  if (id === 'MODIS/061/MOD09GA' || id === 'MODIS/061/MYD09GA' || id === 'MODIS/061/MOD09GQ' || id === 'MODIS/061/MOD13Q1' || id === 'MODIS/061/MOD11A2' || id === 'MODIS/061/MOD14A1' || id === 'MODIS/061/MOD10A1' || id === 'MODIS/061/MCD43A4') {
    return {
      authority: 'NASA',
      preferredBackend: 'nasa-gibs',
      allowedSources: ['auto', 'nasa-gibs', 'copernicus-dataspace', 'sentinel-hub', 'basemap'],
      requiresRemoteCredentials: false,
    };
  }
  if (id === 'NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG' || id === 'NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG') {
    return {
      authority: 'NOAA VIIRS',
      preferredBackend: 'nasa-gibs',
      allowedSources: ['auto', 'nasa-gibs', 'copernicus-dataspace', 'sentinel-hub', 'basemap'],
      requiresRemoteCredentials: false,
    };
  }
  if (id === 'NASA/VIIRS/VNP46A1') {
    return {
      authority: 'NASA VIIRS Black Marble',
      preferredBackend: 'nasa-gibs',
      allowedSources: ['auto', 'nasa-gibs', 'copernicus-dataspace', 'sentinel-hub', 'basemap'],
      requiresRemoteCredentials: false,
    };
  }
  if (id.startsWith('NOAA/VIIRS/')) {
    return {
      authority: 'NASA VIIRS',
      preferredBackend: 'nasa-gibs',
      allowedSources: ['auto', 'nasa-gibs', 'copernicus-dataspace', 'sentinel-hub', 'basemap'],
      requiresRemoteCredentials: false,
    };
  }
  if (id.startsWith('NOAA/GOES/')) {
    return {
      authority: 'NOAA GOES',
      preferredBackend: 'nasa-gibs',
      allowedSources: ['auto', 'nasa-gibs', 'copernicus-dataspace', 'sentinel-hub', 'basemap'],
      requiresRemoteCredentials: false,
    };
  }
  if (id === 'ASTER/AST_L1T_003') {
    return {
      authority: 'NASA / METI ASTER',
      preferredBackend: 'nasa-gibs', // changed from 'copernicus-dataspace' for troubleshooting
      allowedSources: ['auto', 'nasa-gibs', 'copernicus-dataspace', 'sentinel-hub', 'basemap'], // added 'nasa-gibs' for troubleshooting
      requiresRemoteCredentials: true,
    };
  }
  if (id === 'NASA/ASTER_GED/AG100_003') {
    return {
      authority: 'NASA ASTER',
      preferredBackend: 'nasa-gibs', // changed from 'copernicus-dataspace' for troubleshooting
      allowedSources: ['auto', 'nasa-gibs', 'copernicus-dataspace', 'sentinel-hub', 'basemap'], // added 'nasa-gibs' for troubleshooting
      requiresRemoteCredentials: true,
    };
  }

  return {
    authority: 'Unknown',
    preferredBackend: 'nasa-gibs',
    allowedSources: ['auto', 'nasa-gibs', 'sentinel-hub', 'copernicus-dataspace', 'basemap'],
    requiresRemoteCredentials: false,
  };
}

function validateSatelliteImageryRequest({ lat, lon, date, source, collectionId, bands }) {
  const safeSource = String(source ?? 'auto').trim().toLowerCase();
  if (!SATELLITE_ALLOWED_SOURCES.has(safeSource)) {
    return { ok: false, error: `Invalid source '${safeSource}'. Allowed values: auto, nasa-gibs, sentinel-hub, copernicus-dataspace, basemap.` };
  }

  const safeCollectionId = String(collectionId ?? '').trim();
  if (!SATELLITE_COLLECTION_BAND_ALLOWLIST.has(safeCollectionId)) {
    return { ok: false, error: `Unsupported collection '${safeCollectionId}'.` };
  }

  const policy = getCollectionBackendPolicy(safeCollectionId);
  if (!policy.allowedSources.includes(safeSource)) {
    return { ok: false, error: `Collection '${safeCollectionId}' must use source '${policy.preferredBackend}' (or auto/basemap).` };
  }

  if (policy.requiresRemoteCredentials) {
    const hasCopernicus = Boolean(COPERNICUS_DATASPACE_WMS_URL);
    const hasSentinel = Boolean(SENTINEL_HUB_WMS_URL);
    if (safeSource === 'copernicus-dataspace' && !hasCopernicus) {
      return {
        ok: false,
        error: `Collection '${safeCollectionId}' requires Copernicus Data Space credentials for source copernicus-dataspace. ${getCopernicusDataspaceSetupHint()}`,
      };
    }
    if (safeSource === 'sentinel-hub' && !hasSentinel) {
      return {
        ok: false,
        error: `Collection '${safeCollectionId}' requires Sentinel Hub credentials for source sentinel-hub. ${getSatelliteCredentialSetupHint()}`,
      };
    }
    if (safeSource === 'auto' && !hasCopernicus && !hasSentinel) {
      return {
        ok: false,
        error: `Collection '${safeCollectionId}' requires either Copernicus Data Space or Sentinel Hub credentials. ${getCopernicusDataspaceSetupHint()} ${getSatelliteCredentialSetupHint()}`,
      };
    }
  }

  const safeBands = canonicalizeBandExpression(bands);
  if (!safeBands) {
    return { ok: false, error: 'Bands is required.' };
  }

  const allowedBands = SATELLITE_COLLECTION_BAND_ALLOWLIST.get(safeCollectionId);
  if (!allowedBands.has(safeBands)) {
    return { ok: false, error: `Bands '${safeBands}' are not valid for collection '${safeCollectionId}'.` };
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { ok: false, error: 'lat/lon out of range. Expected lat [-90..90], lon [-180..180].' };
  }

  const rawDate = String(date ?? '').trim();
  let safeDate = normalizeIsoDate(rawDate);
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return { ok: false, error: `Date '${rawDate}' must be in YYYY-MM-DD format.` };
    }
    const parsed = new Date(rawDate);
    if (!Number.isFinite(parsed.getTime())) {
      return { ok: false, error: `Date '${rawDate}' is invalid.` };
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    if (rawDate > todayIso) {
      return { ok: false, error: `Date '${rawDate}' cannot be in the future.` };
    }
    safeDate = rawDate;
  }

  return {
    ok: true,
    value: {
      lat,
      lon,
      date: safeDate,
      source: safeSource,
      collectionId: safeCollectionId,
      bands: safeBands,
      backendPolicy: policy,
    },
  };
}

function computeImageryRectangle(lat, lon, radiusKm = 80) {
  const safeLat = clamp(Number(lat) || 0, -85, 85);
  const safeLon = ((((Number(lon) || 0) + 180) % 360) + 360) % 360 - 180;
  const latDelta = radiusKm / 111;
  const cosLat = Math.max(Math.cos((safeLat * Math.PI) / 180), 0.2);
  const lonDelta = radiusKm / (111 * cosLat);
  return {
    west: clamp(safeLon - lonDelta, -180, 180),
    south: clamp(safeLat - latDelta, -85, 85),
    east: clamp(safeLon + lonDelta, -180, 180),
    north: clamp(safeLat + latDelta, -85, 85),
  };
}

function getImageryIntent(collectionId, bands) {
  const collection = String(collectionId || '').toUpperCase();
  const normalizedBands = String(bands || '').toUpperCase().replace(/\s+/g, '');
  const falseColor = normalizedBands.includes('B8') || normalizedBands.includes('B11') || normalizedBands.includes('SR_B5');
  const prefersSentinelHub = collection.includes('COPERNICUS') || collection.includes('S2');
  const prefersLandsat = collection.includes('LANDSAT') || collection.includes('LC08') || collection.includes('LC09');
  return { falseColor, prefersSentinelHub, prefersLandsat };
}

function getConfiguredSatelliteProvider() {
  const provider = String(BACKEND_SATELLITE_IMAGERY_PROVIDER || '').trim().toLowerCase();
  if (provider === 'nasa-gibs') return 'nasa-gibs';
  if (provider === 'sentinel-hub') return 'sentinel-hub';
  if (provider === 'copernicus-dataspace') return 'copernicus-dataspace';
  return null;
}

function getNasaGibsLayerCandidates(collectionId, bands) {
  const id = String(collectionId || '').toUpperCase();
  const normalizedBands = String(bands || '').toUpperCase().replace(/\s+/g, '');
  const falseColor = normalizedBands.includes('B8') || normalizedBands.includes('B11') || normalizedBands.includes('SR_B5');

  if (id === 'NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG' || id === 'NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG' || id === 'NASA/VIIRS/VNP46A1') {
    return [
      {
        layer: 'VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance',
        note: id === 'NASA/VIIRS/VNP46A1'
          ? 'NASA GIBS VIIRS gap-filled night radiance composite (VNP46A1-compatible mapping).'
          : 'NASA GIBS VIIRS gap-filled night radiance composite.',
        bandNote: id === 'NASA/VIIRS/VNP46A1'
          ? 'Requested VNP46A1 night-lights band mapped to VIIRS gap-filled night-radiance imagery.'
          : 'Requested radiance mapped to VIIRS gap-filled night-radiance imagery.',
      },
      {
        layer: 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance',
        note: 'NASA GIBS VIIRS Day/Night Band at-sensor radiance composite.',
        bandNote: 'Fallback mapped to VIIRS Day/Night Band at-sensor radiance imagery.',
      },
      {
        layer: 'VIIRS_Black_Marble',
        note: 'NASA GIBS VIIRS Black Marble legacy annual composite.',
        bandNote: 'Final fallback mapped to legacy Black Marble annual imagery (limited dates).',
      },
    ];
  }

  if (id === 'MODIS/061/MYD09GA') {
    return [
      {
        layer: falseColor ? 'MODIS_Aqua_CorrectedReflectance_Bands721' : 'MODIS_Aqua_CorrectedReflectance_TrueColor',
        note: falseColor ? 'NASA GIBS MODIS Aqua false-color composite.' : 'NASA GIBS MODIS Aqua true-color daily composite.',
        bandNote: falseColor ? 'Requested false-color bands mapped to MODIS Aqua Bands 7-2-1.' : 'Requested bands mapped to NASA GIBS MODIS Aqua true-color imagery.',
      },
      {
        layer: falseColor ? 'MODIS_Terra_CorrectedReflectance_Bands367' : 'MODIS_Terra_CorrectedReflectance_TrueColor',
        note: falseColor ? 'NASA GIBS MODIS Terra false-color fallback composite.' : 'NASA GIBS MODIS Terra true-color fallback composite.',
        bandNote: falseColor ? 'Fell back to MODIS Terra false-color layer.' : 'Fell back to MODIS Terra true-color layer.',
      },
    ];
  }

  if (id.startsWith('NOAA/GOES/16/')) {
    return [
      {
        layer: 'GOES-East_ABI_GeoColor',
        note: 'NASA GIBS GOES-East ABI GeoColor composite.',
        bandNote: 'Requested GOES bands mapped to ABI GeoColor imagery.',
      },
    ];
  }

  if (id.startsWith('NOAA/GOES/17/') || id.startsWith('NOAA/GOES/18/')) {
    return [
      {
        layer: 'GOES-West_ABI_GeoColor',
        note: 'NASA GIBS GOES-West ABI GeoColor composite.',
        bandNote: 'Requested GOES bands mapped to ABI GeoColor imagery.',
      },
    ];
  }

  if (id.startsWith('NOAA/VIIRS/')) {
    return [
      {
        layer: falseColor ? 'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1' : 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
        note: falseColor ? 'NASA GIBS VIIRS SNPP false-color composite.' : 'NASA GIBS VIIRS SNPP true-color daily composite.',
        bandNote: falseColor ? 'Requested bands mapped to VIIRS M11-I2-I1 false-color imagery.' : 'Requested bands mapped to VIIRS SNPP true-color imagery.',
      },
      {
        layer: falseColor ? 'MODIS_Terra_CorrectedReflectance_Bands367' : 'MODIS_Terra_CorrectedReflectance_TrueColor',
        note: falseColor ? 'NASA GIBS MODIS false-color fallback composite.' : 'NASA GIBS MODIS true-color fallback composite.',
        bandNote: falseColor ? 'Fell back to MODIS false-color layer.' : 'Fell back to MODIS true-color layer.',
      },
    ];
  }

  return [
    {
      layer: falseColor ? 'MODIS_Terra_CorrectedReflectance_Bands367' : 'MODIS_Terra_CorrectedReflectance_TrueColor',
      note: falseColor ? 'NASA GIBS MODIS false-color composite.' : 'NASA GIBS MODIS true-color daily composite.',
      bandNote: falseColor ? 'Requested false-color bands mapped to MODIS Bands 3-6-7.' : 'Requested bands mapped to NASA GIBS true-color imagery.',
    },
  ];
}

function pickSatelliteSourceOrder(source, collectionId, bands) {
  const requested = String(source || 'auto').toLowerCase();
  const policy = getCollectionBackendPolicy(collectionId);
  if (requested === 'basemap') return ['basemap'];
  if (requested === 'nasa-gibs') return ['nasa-gibs', 'basemap'];
  if (requested === 'sentinel-hub') return ['sentinel-hub', 'basemap'];
  if (requested === 'copernicus-dataspace') return ['copernicus-dataspace', 'basemap'];

  const autoOrder = [];
  const configuredProvider = getConfiguredSatelliteProvider();
  const canUseCopernicus = Boolean(COPERNICUS_DATASPACE_WMS_URL);
  const canUseSentinel = Boolean(SENTINEL_HUB_WMS_URL);

  if (configuredProvider === 'copernicus-dataspace' && canUseCopernicus) {
    autoOrder.push('copernicus-dataspace');
  }
  if (configuredProvider === 'sentinel-hub' && canUseSentinel) {
    autoOrder.push('sentinel-hub');
  }
  if (configuredProvider === 'nasa-gibs') {
    autoOrder.push('nasa-gibs');
  }

  if (policy.preferredBackend === 'copernicus-dataspace') {
    if (canUseCopernicus) autoOrder.push('copernicus-dataspace');
    if (canUseSentinel) autoOrder.push('sentinel-hub');
  } else if (policy.preferredBackend === 'sentinel-hub') {
    if (canUseSentinel) autoOrder.push('sentinel-hub');
    if (canUseCopernicus) autoOrder.push('copernicus-dataspace');
  } else {
    autoOrder.push(policy.preferredBackend);
    if (canUseCopernicus) autoOrder.push('copernicus-dataspace');
    if (canUseSentinel) autoOrder.push('sentinel-hub');
  }

  autoOrder.push('nasa-gibs');

  autoOrder.push('basemap');
  return [...new Set(autoOrder)];
}

function buildWmsPreviewUrl(baseUrl, { layer, rectangle, date, format = 'image/jpeg', width = SATELLITE_PREVIEW_IMAGE_SIZE, height = SATELLITE_PREVIEW_IMAGE_SIZE }) {
  const url = new URL(baseUrl);
  url.searchParams.set('SERVICE', 'WMS');
  url.searchParams.set('REQUEST', 'GetMap');
  url.searchParams.set('VERSION', '1.3.0');
  url.searchParams.set('LAYERS', layer);
  url.searchParams.set('STYLES', '');
  url.searchParams.set('FORMAT', format);
  url.searchParams.set('TRANSPARENT', 'false');
  url.searchParams.set('WIDTH', String(width));
  url.searchParams.set('HEIGHT', String(height));
  url.searchParams.set('CRS', 'EPSG:4326');
  url.searchParams.set('BBOX', `${rectangle.south},${rectangle.west},${rectangle.north},${rectangle.east}`);
  if (date) {
    url.searchParams.set('TIME', date);
  }
  return url.toString();
}

async function verifyPreviewUrl(url) {
  const resp = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    throw new Error(`preview fetch ${resp.status}`);
  }
  await resp.arrayBuffer();
}

async function buildNasaGibsPreview({ lat, lon, date, collectionId, bands }) {
  const rectangle = computeImageryRectangle(lat, lon, 120);
  const isoDate = normalizeIsoDate(date);
  const candidates = getNasaGibsLayerCandidates(collectionId, bands);
  const failures = [];

  for (const candidate of candidates) {
    try {
      const previewUrl = buildWmsPreviewUrl(NASA_GIBS_WMS_URL, { layer: candidate.layer, rectangle, date: isoDate });
      await verifyPreviewUrl(previewUrl);
      return {
        provider: 'nasa-gibs',
        providerLabel: 'NASA GIBS',
        previewUrl,
        rectangle,
        date: isoDate,
        note: candidate.note,
        bandNote: candidate.bandNote,
      };
    } catch (err) {
      failures.push(`${candidate.layer}: ${err?.message ?? 'failed'}`);
    }
  }

  throw new Error(`NASA GIBS preview failed for '${collectionId}'. ${failures.join(' | ')}`);
}

async function buildSentinelHubPreview({ lat, lon, date, collectionId, bands }) {
  if (!SENTINEL_HUB_WMS_URL) {
    throw new Error('Sentinel Hub is not configured on the server');
  }
  const rectangle = computeImageryRectangle(lat, lon, 60);
  const isoDate = normalizeIsoDate(date);
  const { falseColor } = getImageryIntent(collectionId, bands);
  const layer = falseColor ? SENTINEL_HUB_FALSE_COLOR_LAYER : SENTINEL_HUB_TRUE_COLOR_LAYER;
  const previewUrl = buildWmsPreviewUrl(SENTINEL_HUB_WMS_URL, { layer, rectangle, date: `${isoDate}/${isoDate}` });
  await verifyPreviewUrl(previewUrl);
  return {
    provider: 'sentinel-hub',
    providerLabel: 'Sentinel Hub',
    previewUrl,
    rectangle,
    date: isoDate,
    note: `Sentinel Hub WMS layer ${layer}.`,
    bandNote: falseColor
      ? 'Sentinel Hub false-color layer requested.'
      : 'Sentinel Hub true-color layer requested.',
  };
}

async function buildCopernicusDataspacePreview({ lat, lon, date, collectionId, bands }) {
  if (!COPERNICUS_DATASPACE_WMS_URL) {
    throw new Error('Copernicus Data Space is not configured on the server');
  }
  const rectangle = computeImageryRectangle(lat, lon, 60);
  const isoDate = normalizeIsoDate(date);
  const { falseColor } = getImageryIntent(collectionId, bands);
  const layer = falseColor ? COPERNICUS_DATASPACE_FALSE_COLOR_LAYER : COPERNICUS_DATASPACE_TRUE_COLOR_LAYER;
  const previewUrl = buildWmsPreviewUrl(COPERNICUS_DATASPACE_WMS_URL, { layer, rectangle, date: `${isoDate}/${isoDate}` });
  await verifyPreviewUrl(previewUrl);
  return {
    provider: 'copernicus-dataspace',
    providerLabel: 'Copernicus Data Space',
    previewUrl,
    rectangle,
    date: isoDate,
    note: `Copernicus Data Space WMS layer ${layer}.`,
    bandNote: falseColor
      ? 'Copernicus Data Space false-color layer requested.'
      : 'Copernicus Data Space true-color layer requested.',
  };
}

async function resolveSatelliteImageryPreview({ lat, lon, date, source, collectionId, bands }) {
  const order = pickSatelliteSourceOrder(source, collectionId, bands);
  const backendPolicy = getCollectionBackendPolicy(collectionId);
  const failures = [];
  for (const candidate of order) {
    try {
      if (candidate === 'copernicus-dataspace') {
        const payload = await buildCopernicusDataspacePreview({ lat, lon, date, collectionId, bands });
        return { ...payload, backendPolicy, requestedSource: String(source || 'auto').toLowerCase(), fallbackCount: failures.length, failures };
      }
      if (candidate === 'nasa-gibs') {
        const payload = await buildNasaGibsPreview({ lat, lon, date, collectionId, bands });
        return { ...payload, backendPolicy, requestedSource: String(source || 'auto').toLowerCase(), fallbackCount: failures.length, failures };
      }
      if (candidate === 'sentinel-hub') {
        const payload = await buildSentinelHubPreview({ lat, lon, date, collectionId, bands });
        return { ...payload, backendPolicy, requestedSource: String(source || 'auto').toLowerCase(), fallbackCount: failures.length, failures };
      }
      if (candidate === 'basemap') {
        return {
          provider: 'basemap',
          providerLabel: 'Globe Basemap',
          backendPolicy,
          requestedSource: String(source || 'auto').toLowerCase(),
          previewUrl: null,
          rectangle: computeImageryRectangle(lat, lon, 90),
          date: normalizeIsoDate(date),
          note: 'Fell back to the existing globe basemap because no remote imagery provider responded.',
          bandNote: 'Basemap fallback does not use the Collection/Bands inputs.',
          fallbackCount: failures.length,
          failures,
        };
      }
    } catch (err) {
      failures.push({ provider: candidate, message: err?.message ?? `${candidate} failed` });
    }
  }
  throw new Error(failures.map(item => `${item.provider}: ${item.message}`).join(' | ') || 'No satellite imagery providers available');
}

function guessMimeByName(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (n.endsWith('.ts')) return 'video/mp2t';
  if (n.endsWith('.m4s')) return 'video/iso.segment';
  if (n.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

async function ensureFfmpegAvailable() {
  if (ffmpegChecked) return ffmpegAvailable;
  ffmpegChecked = true;
  ffmpegAvailable = await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
  return ffmpegAvailable;
}

function startCameraStreamCleanupLoop() {
  if (cameraStreamCleanupTimer) return;
  cameraStreamCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of cameraStreamSessions.entries()) {
      if ((now - s.lastAccess) < CAMERA_STREAM_IDLE_MS) continue;
      try { s.proc?.kill('SIGTERM'); } catch {}
      try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
      cameraStreamSessions.delete(id);
    }
  }, 30_000);
  cameraStreamCleanupTimer.unref?.();
}

function cameraSessionIdForUrl(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function rewriteM3u8Playlist(playlistText, sourceUrl) {
  return String(playlistText)
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      try {
        const absolute = new URL(t, sourceUrl).toString();
        return `/api/localproxy/api/cameras/stream?url=${encodeURIComponent(absolute)}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

function ensureRtmpSession(sourceUrl) {
  ensureCameraStreamDir();
  startCameraStreamCleanupLoop();

  const id = cameraSessionIdForUrl(sourceUrl);
  const existing = cameraStreamSessions.get(id);
  if (existing && existing.proc && !existing.proc.killed) {
    existing.lastAccess = Date.now();
    return existing;
  }

  const dir = path.join(CAMERA_STREAM_DIR, id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });

  const playlistPath = path.join(dir, 'index.m3u8');
  const ffArgs = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourceUrl,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    playlistPath,
  ];

  const proc = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr?.on('data', () => {});
  proc.on('exit', () => {
    const s = cameraStreamSessions.get(id);
    if (s && s.proc === proc) s.proc = null;
  });

  const session = {
    id,
    url: sourceUrl,
    dir,
    playlistPath,
    proc,
    lastAccess: Date.now(),
  };
  cameraStreamSessions.set(id, session);
  return session;
}

async function waitForPlaylist(playlistPath, timeoutMs = CAMERA_STREAM_BOOT_TIMEOUT_MS) {
  const t0 = Date.now();
  while ((Date.now() - t0) < timeoutMs) {
    if (fs.existsSync(playlistPath)) {
      try {
        const st = fs.statSync(playlistPath);
        if (st.size > 0) return true;
      } catch {}
    }
    await sleep(250);
  }
  return false;
}

async function handleCameraStreamProxy(queryParams, res) {
  const sourceUrl = queryParams.get('url') || '';
  if (!sourceUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing url query param' }));
    return;
  }

  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid source url' }));
    return;
  }

  const protocol = parsed.protocol.replace(':', '').toLowerCase();

  if (protocol === 'http' || protocol === 'https') {
    const upstream = await fetch(sourceUrl, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });

    if (!upstream.ok) {
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `upstream ${upstream.status}` }));
      return;
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const isM3u8 = contentType.includes('mpegurl') || /\.m3u8(\?|$)/i.test(sourceUrl);
    if (isM3u8) {
      const text = await upstream.text();
      const rewritten = rewriteM3u8Playlist(text, sourceUrl);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store, max-age=0',
      });
      res.end(rewritten);
      return;
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': contentType || guessMimeByName(parsed.pathname),
      'Cache-Control': 'no-store, max-age=0',
    });
    res.end(body);
    return;
  }

  if (protocol === 'rtmp' || protocol === 'rtsp' || protocol === 'mms') {
    const hasFfmpeg = await ensureFfmpegAvailable();
    if (!hasFfmpeg) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ffmpeg not available on server for RTMP/RTSP conversion' }));
      return;
    }

    const session = ensureRtmpSession(sourceUrl);
    session.lastAccess = Date.now();
    const ready = await waitForPlaylist(session.playlistPath);
    if (!ready) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'transcoder warming up' }));
      return;
    }

    const raw = fs.readFileSync(session.playlistPath, 'utf8');
    const rewritten = raw
      .split(/\r?\n/)
      .map((line) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        return `/api/localproxy/api/cameras/hls/${session.id}/${encodeURIComponent(t)}`;
      })
      .join('\n');

    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store, max-age=0',
    });
    res.end(rewritten);
    return;
  }

  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: `unsupported protocol: ${protocol}` }));
}

async function handleCameraHlsSegment(urlPath, res) {
  const m = urlPath.match(/^\/api\/cameras\/hls\/([^/]+)\/(.+)$/);
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const [, sessionId, encodedFile] = m;
  const session = cameraStreamSessions.get(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'stream session expired' }));
    return;
  }
  session.lastAccess = Date.now();

  const fileName = decodeURIComponent(encodedFile || '');
  if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid segment path' }));
    return;
  }

  const filePath = path.join(session.dir, fileName);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'segment not found' }));
    return;
  }

  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': guessMimeByName(fileName),
    'Cache-Control': 'no-store, max-age=0',
  });
  res.end(body);
}

async function handleCameraStreamHealth(res) {
  const hasFfmpeg = await ensureFfmpegAvailable();
  const now = Date.now();
  const activeSessions = [...cameraStreamSessions.values()].map((s) => ({
    id: s.id,
    protocol: (() => {
      try { return new URL(s.url).protocol.replace(':', ''); } catch { return 'unknown'; }
    })(),
    alive: !!(s.proc && !s.proc.killed),
    idleMs: Math.max(0, now - (s.lastAccess || now)),
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    ffmpegAvailable: hasFfmpeg,
    activeSessionCount: activeSessions.length,
    activeSessions,
    ts: now,
  }));
}

function tileCachePaths(cacheKey) {
  return {
    metaPath: path.join(TILE_CACHE_DIR, `${cacheKey}.json`),
    bodyPath: path.join(TILE_CACHE_DIR, `${cacheKey}.bin`),
  };
}

function readTileCache(cacheKey, maxAgeMs = TILE_CACHE_TTL_MS) {
  const { metaPath, bodyPath } = tileCachePaths(cacheKey);
  if (!fs.existsSync(metaPath) || !fs.existsSync(bodyPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const ts = Number(meta?.ts);
    if (!Number.isFinite(ts)) return null;
    const ageMs = Date.now() - ts;
    if (ageMs > maxAgeMs) return null;
    const body = fs.readFileSync(bodyPath);
    return { ...meta, body, ageMs };
  } catch {
    return null;
  }
}

function writeTileCache(cacheKey, payload) {
  try {
    ensureTileCacheDir();
    const { metaPath, bodyPath } = tileCachePaths(cacheKey);
    const meta = {
      ts: Date.now(),
      status: payload.status,
      contentType: payload.contentType || 'application/octet-stream',
      cacheControl: payload.cacheControl || 'public, max-age=300',
      contentLength: payload.body?.byteLength ?? payload.body?.length ?? 0,
      sourceUrl: payload.sourceUrl,
    };
    fs.writeFileSync(bodyPath, payload.body);
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  } catch (err) {
    console.warn(`[proxy] Tile cache write failed: ${err?.message ?? 'unknown'}`);
  }
}

function sendBinaryResponse(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function buildGoogleTileUrl(urlPath, queryParams) {
  if (!GOOGLE_ROUTES_KEY) {
    throw new Error('Google Maps API key missing on server');
  }

  const upstreamPath = urlPath.slice('/tiles/google/'.length);
  if (!upstreamPath) throw new Error('google tile path missing');

  const upstream = new URL(`https://tile.googleapis.com/${upstreamPath}`);
  for (const [key, value] of queryParams.entries()) {
    if (!key || key.toLowerCase() === 'key') continue;
    upstream.searchParams.set(key, value);
  }
  upstream.searchParams.set('key', GOOGLE_ROUTES_KEY);
  return upstream.toString();
}

function buildMapTilerTileUrl(urlPath, queryParams) {
  const key = process.env.VITE_MAPTILER_API_KEY || DOTENV_VARS.get('VITE_MAPTILER_API_KEY') || '';
  if (!key) {
    throw new Error('MapTiler API key missing on server');
  }

  const upstreamPath = urlPath.slice('/tiles/maptiler/'.length);
  if (!upstreamPath) throw new Error('maptiler tile path missing');

  const upstream = new URL(`https://api.maptiler.com/${upstreamPath}`);
  for (const [k, value] of queryParams.entries()) {
    if (!k || k.toLowerCase() === 'key') continue;
    upstream.searchParams.set(k, value);
  }
  upstream.searchParams.set('key', key);
  return upstream.toString();
}

async function fetchAndCacheTile(upstreamUrl, cacheKey) {
  const cached = readTileCache(cacheKey, TILE_CACHE_TTL_MS);
  if (cached) return { ...cached, cacheHit: true, stale: false };

  const stale = readTileCache(cacheKey, TILE_CACHE_STALE_MS);
  const inFlight = tileFetchInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const upstreamResp = await fetch(upstreamUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(20_000),
      });
      if (!upstreamResp.ok) {
        throw new Error(`tile upstream ${upstreamResp.status}`);
      }

      const arrayBuffer = await upstreamResp.arrayBuffer();
      const body = Buffer.from(arrayBuffer);
      const contentType = upstreamResp.headers.get('content-type') || 'application/octet-stream';
      const cacheControl = upstreamResp.headers.get('cache-control') || 'public, max-age=300';
      const payload = {
        status: 200,
        contentType,
        cacheControl,
        body,
        sourceUrl: upstreamUrl,
      };
      writeTileCache(cacheKey, payload);
      return { ...payload, cacheHit: false, stale: false, ageMs: 0 };
    } catch (err) {
      if (stale) {
        return { ...stale, cacheHit: true, stale: true };
      }
      throw err;
    } finally {
      tileFetchInFlight.delete(cacheKey);
    }
  })();

  tileFetchInFlight.set(cacheKey, promise);
  return promise;
}

async function handleTileProxy(urlPath, queryParams, res) {
  let upstreamUrl;
  if (urlPath.startsWith('/tiles/google/')) {
    upstreamUrl = buildGoogleTileUrl(urlPath, queryParams);
  } else if (urlPath.startsWith('/tiles/maptiler/')) {
    upstreamUrl = buildMapTilerTileUrl(urlPath, queryParams);
  } else {
    return false;
  }

  const cacheKey = crypto.createHash('sha1').update(upstreamUrl).digest('hex');
  const result = await fetchAndCacheTile(upstreamUrl, cacheKey);
  sendBinaryResponse(res, result.status ?? 200, {
    'Content-Type': result.contentType || 'application/octet-stream',
    'Content-Length': String(result.body.length),
    'Cache-Control': result.cacheControl || 'public, max-age=300',
    'X-ShadowGrid-Tile-Cache': result.cacheHit ? (result.stale ? 'STALE' : 'HIT') : 'MISS',
    'X-ShadowGrid-Tile-Age-Ms': `${Math.max(0, Math.floor(result.ageMs ?? 0))}`,
  }, result.body);
  return true;
}

function scheduleCacheWrite() {
  if (cacheWriteTimer) return;
  cacheWriteTimer = setTimeout(() => {
    cacheWriteTimer = null;
    try {
      ensureCacheDir();
      const out = {
        ts: Date.now(),
        flights: [...flightSnapshotCache.entries()].slice(0, 64),
        traffic: [...trafficSnapshotCache.entries()].slice(0, 64),
        marine: [...marineSnapshotCache.entries()].slice(0, 64),
        satellites: satSnapshotCache,
      };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(out));
    } catch (err) {
      console.warn(`[proxy] Cache write failed: ${err?.message ?? 'unknown'}`);
    }
  }, 400);
}

function loadSnapshotCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [key, value] of data.flights ?? []) {
      if (value?.payload && Number.isFinite(value?.ts)) {
        flightSnapshotCache.set(key, value);
      }
    }
    for (const [key, value] of data.traffic ?? []) {
      if (value?.payload && Number.isFinite(value?.ts)) {
        trafficSnapshotCache.set(key, value);
      }
    }
    for (const [key, value] of data.marine ?? []) {
      if (value?.payload && Number.isFinite(value?.ts)) {
        marineSnapshotCache.set(key, value);
      }
    }
    if (data?.satellites?.payload && Number.isFinite(data?.satellites?.ts)) {
      satSnapshotCache = data.satellites;
    } else if (data?.satellites?.points && Number.isFinite(data?.satellites?.ts)) {
      satSnapshotCache = data.satellites;
    }
  } catch (err) {
    console.warn(`[proxy] Cache load failed: ${err?.message ?? 'unknown'}`);
  }
}

function quantize(value, step = SNAPSHOT_BOUNDS_GRID_DEG) {
  return Math.round(value / step) * step;
}

function normalizeBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  const [minLonRaw, minLatRaw, maxLonRaw, maxLatRaw] = bounds.map(Number);
  if (![minLonRaw, minLatRaw, maxLonRaw, maxLatRaw].every(Number.isFinite)) return null;
  const minLon = Math.max(-180, Math.min(180, minLonRaw));
  const maxLon = Math.max(-180, Math.min(180, maxLonRaw));
  const minLat = Math.max(-90, Math.min(90, minLatRaw));
  const maxLat = Math.max(-90, Math.min(90, maxLatRaw));
  return [Math.min(minLon, maxLon), Math.min(minLat, maxLat), Math.max(minLon, maxLon), Math.max(minLat, maxLat)];
}

function boundsCacheKey(bounds, fallback = 'global') {
  const b = normalizeBounds(bounds);
  if (!b) return fallback;
  const [minLon, minLat, maxLon, maxLat] = b;
  return `${quantize(minLon).toFixed(2)},${quantize(minLat).toFixed(2)},${quantize(maxLon).toFixed(2)},${quantize(maxLat).toFixed(2)}`;
}

async function ensureCameraManifest() {
  const now = Date.now();
  if (cameraManifestCache.tiles.length && (now - cameraManifestCache.ts) < CAMERA_MANIFEST_TTL_MS) return;

  const manifestPath = path.resolve(process.cwd(), 'public', 'camera-data', 'tiles-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    cameraManifestCache = { ts: now, tileDeg: 5, tiles: [] };
    return;
  }

  const raw = fs.readFileSync(manifestPath, 'utf8');
  const data = JSON.parse(raw);
  const tileDeg = Number.isFinite(data?.tileDeg) ? data.tileDeg : 5;
  const tiles = Array.isArray(data?.tiles)
    ? data.tiles.filter(t => Number.isFinite(t?.lat) && Number.isFinite(t?.lng) && t.lat >= -90 && t.lat <= 90 && t.lng >= -180 && t.lng <= 180 && typeof t.key === 'string')
    : [];

  cameraManifestCache = {
    ts: now,
    tileDeg,
    tiles,
  };
}

async function readCameraTile(tileKey) {
  const now = Date.now();
  const cached = cameraTileCache.get(tileKey);
  if (cached && (now - cached.ts) < CAMERA_TILE_CACHE_TTL_MS) return cached.cameras;

  const tilePath = path.resolve(process.cwd(), 'public', 'camera-data', 'tiles', `${tileKey}.json`);
  if (!fs.existsSync(tilePath)) {
    cameraTileCache.set(tileKey, { ts: now, cameras: [] });
    return [];
  }

  try {
    const raw = fs.readFileSync(tilePath, 'utf8');
    const data = JSON.parse(raw);
    const cameras = Array.isArray(data) ? data : [];
    cameraTileCache.set(tileKey, { ts: now, cameras });
    return cameras;
  } catch {
    cameraTileCache.set(tileKey, { ts: now, cameras: [] });
    return [];
  }
}

async function getCameraSnapshot(bounds, maxPoints = CAMERA_MAX_POINTS) {
  await ensureCameraManifest();
  const b = normalizeBounds(bounds);
  if (!b) {
    return { cameras: [], total: 0, source: 'camera-tiles', mode: 'bounds-required', cacheHit: false, ts: Date.now() };
  }

  const cacheKey = `cam:${boundsCacheKey(b)}:${maxPoints}`;
  const now = Date.now();
  const cached = cameraSnapshotCache.get(cacheKey);
  if (cached && (now - cached.ts) < CAMERA_SNAPSHOT_TTL_MS) {
    return { ...cached.payload, cacheHit: true };
  }

  const [minLon, minLat, maxLon, maxLat] = b;
  const tileDeg = cameraManifestCache.tileDeg;
  const tiles = cameraManifestCache.tiles.filter(t => {
    const tileMaxLat = t.lat + tileDeg;
    const tileMaxLon = t.lng + tileDeg;
    if (tileMaxLat < minLat || t.lat > maxLat) return false;
    if (tileMaxLon < minLon || t.lng > maxLon) return false;
    return true;
  });

  const cameras = [];
  for (const tile of tiles) {
    const tileCameras = await readCameraTile(tile.key);
    for (const cam of tileCameras) {
      if (!Number.isFinite(cam?.a) || !Number.isFinite(cam?.o)) continue;
      if (cam.a < minLat || cam.a > maxLat || cam.o < minLon || cam.o > maxLon) continue;
      cameras.push(cam);
      if (cameras.length >= maxPoints) break;
    }
    if (cameras.length >= maxPoints) break;
  }

  const generatedAt = Date.now();
  const payload = {
    cameras,
    total: cameras.length,
    source: 'camera-tiles',
    tileCount: tiles.length,
    cacheHit: false,
    ts: generatedAt,
  };

  cameraSnapshotCache.set(cacheKey, { ts: generatedAt, payload });
  scheduleCacheWrite();
  return payload;
}

// ── Hub grid — mathematically tiled at 250nm radius with ~30% overlap ─────────
// Generated by: lat step = RADIUS_DEG * 1.4, lon step = lat_step / cos(lat)

function generateHubGrid() {
  const LAT_STEP = RADIUS_DEG * 1.4;
  const hubs = [];
  let lat = -70 + LAT_STEP / 2;
  while (lat <= 83) {
    const cosLat  = Math.max(Math.cos(lat * Math.PI / 180), 0.08);
    const lonStep = Math.min(LAT_STEP / cosLat, 360);
    let lon = -180;
    while (lon < 180) {
      let normLon = lon % 360;
      if (normLon > 180) normLon -= 360;
      hubs.push({ lat: Math.round(lat * 10) / 10, lon: Math.round(normLon * 10) / 10 });
      lon += lonStep;
    }
    lat += LAT_STEP;
  }
  return hubs;
}

const ALL_HUBS = generateHubGrid();
console.log(`[proxy] Hub grid: ${ALL_HUBS.length} hubs at ${RADIUS_NM}nm radius`);

// ── Per-hub fetch cache (avoid re-fetching hubs that were just queried) ────────
/** @type {Map<string, { time: number, promise?: Promise }>} */
const hubCache = new Map();

function hubKey(hub) { return `${hub.lat},${hub.lon}`; }

function boundsToQueryCenter(bounds) {
  if (!bounds) return null;
  const [minLon, minLat, maxLon, maxLat] = bounds;
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;

  let lonSpan = maxLon - minLon;
  if (lonSpan < 0) lonSpan += 360;
  const latSpan = Math.max(0, maxLat - minLat);

  let centerLon = minLon + lonSpan / 2;
  if (centerLon > 180) centerLon -= 360;
  const centerLat = minLat + latSpan / 2;

  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.max(Math.cos(centerLat * Math.PI / 180), 0.1);
  const diagKm = Math.hypot(latSpan * kmPerDegLat, lonSpan * kmPerDegLon);
  const radiusNm = Math.min(250, Math.max(75, Math.round((diagKm / 1.852) * 0.6)));

  return { lat: centerLat, lon: centerLon, distNm: radiusNm };
}

async function fetchReadsbProvider(baseUrl, bounds, globalMode = false) {
  const urls = [];
  if (globalMode) {
    urls.push(`${baseUrl}/v2/all`);
  } else {
    const center = boundsToQueryCenter(bounds);
    if (center) {
      urls.push(`${baseUrl}/v2/lat/${center.lat.toFixed(4)}/lon/${center.lon.toFixed(4)}/dist/${center.distNm}`);
      urls.push(`${baseUrl}/v2/point/${center.lat.toFixed(4)}/${center.lon.toFixed(4)}/${center.distNm}`);
    } else {
      urls.push(`${baseUrl}/v2/point/0/0/250`);
    }
  }

  let lastError = null;
  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      if (!resp.ok) {
        lastError = new Error(`${baseUrl} ${resp.status}`);
        continue;
      }
      const data = await resp.json();
      upsert(data.aircraft ?? data.ac ?? []);
      return true;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error(`${baseUrl} unavailable`);
}

function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

function gcDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function decodeGooglePolyline(encoded) {
  const coords = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);

    coords.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }
  return coords;
}

function trafficFlowFromSpeed(speed) {
  switch (speed) {
    case 'TRAFFIC_JAM': return { density: 9, speed: 3.5, priority: 3 };
    case 'SLOW': return { density: 6, speed: 8.5, priority: 3 };
    default: return { density: 3, speed: 15, priority: 2 };
  }
}

function osmRoadClass(tags = {}) {
  const highway = tags.highway || '';
  if (['motorway', 'trunk', 'primary'].includes(highway)) {
    return { density: 12, speed: 25, priority: 3 };
  }
  if (['secondary', 'tertiary'].includes(highway)) {
    return { density: 6, speed: 15, priority: 2 };
  }
  if (['residential', 'unclassified', 'living_street'].includes(highway)) {
    return { density: 2, speed: 10, priority: 1 };
  }
  return { density: 1, speed: 8, priority: 0 };
}

function resolveTrafficBackendMode() {
  const hasGoogleKey = GOOGLE_ROUTES_KEY.trim().length > 0;
  if (BACKEND_TRAFFIC_PROVIDER === 'google') return hasGoogleKey ? 'google-live' : 'osm-sim';
  if (BACKEND_TRAFFIC_PROVIDER === 'osm') return 'osm-sim';
  return hasGoogleKey ? 'google-live' : 'osm-sim';
}

async function buildOsmTrafficRoads(minLon, minLat, maxLon, maxLat) {
  const query = `
    [out:json];
    (
      way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street"](${minLat},${minLon},${maxLat},${maxLon});
    );
    out geom;
  `;

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...HEADERS },
    body: query,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Overpass ${resp.status}`);

  const data = await resp.json();
  const roads = [];
  for (const way of (data.elements ?? []).filter(el => el.type === 'way')) {
    if (!way.tags?.highway || !Array.isArray(way.geometry) || way.geometry.length < 2) continue;
    const profile = osmRoadClass(way.tags);
    const coords = way.geometry.map(node => ({ lat: node.lat, lon: node.lon }));
    roads.push({
      id: `osm-${way.id}`,
      name: way.tags.name || '[unnamed]',
      coords,
      density: profile.density,
      speed: profile.speed,
      priority: profile.priority,
      totalLength: coords.reduce((sum, _, idx) => {
        if (idx === 0) return sum;
        const prev = coords[idx - 1];
        const curr = coords[idx];
        return sum + gcDistanceMeters(prev.lat, prev.lon, curr.lat, curr.lon);
      }, 0),
    });
  }

  return roads;
}

async function getOpenSkyTokenServer() {
  if (!OPENSKY_CLIENT_ID || !OPENSKY_CLIENT_SECRET) return '';
  if (openSkyToken && Date.now() < openSkyTokenExp) return openSkyToken;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: OPENSKY_CLIENT_ID,
    client_secret: OPENSKY_CLIENT_SECRET,
  });

  const resp = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(12_000),
  });
  if (!resp.ok) throw new Error(`OpenSky token ${resp.status}`);

  const data = await resp.json();
  openSkyToken = data.access_token ?? '';
  openSkyTokenExp = Date.now() + Math.max(((data.expires_in ?? 3600) - 60) * 1000, 60_000);
  return openSkyToken;
}

async function fetchOpenSkyProvider() {
  const token = await getOpenSkyTokenServer();
  const headers = token ? { Authorization: `Bearer ${token}`, ...HEADERS } : HEADERS;
  const resp = await fetch('https://opensky-network.org/api/states/all', {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`OpenSky ${resp.status}`);

  const data = await resp.json();
  const aircraft = (data.states ?? [])
    .filter(s => Number.isFinite(s?.[5]) && Number.isFinite(s?.[6]) && s?.[8] !== true)
    .map(s => ({
      hex: (s[0] ?? '').trim().toLowerCase(),
      flight: (s[1] ?? '').trim(),
      lon: s[5],
      lat: s[6],
      alt_baro: Number.isFinite(s[7]) ? s[7] * 3.281 : 10000,
      gs: Number.isFinite(s[9]) ? s[9] * 1.944 : 0,
      track: Number.isFinite(s[10]) ? s[10] : 0,
      baro_rate: Number.isFinite(s[11]) ? s[11] * 196.85 : 0,
      squawk: s[14] ?? '',
      category: '',
      t: '',
      dbFlags: 0,
    }));

  upsert(aircraft);
}

async function fetchN2yoSnapshot(maxCount = Infinity) {
  if (!N2YO_KEY) {
    throw new Error('N2YO API key missing');
  }

  const points = [];
  const seen = new Set();
  const limit = Number.isFinite(maxCount) ? maxCount : Infinity;

  for (const sample of N2YO_SAMPLE_POINTS) {
    const url = `https://api.n2yo.com/rest/v1/satellite/above/${sample.lat}/${sample.lon}/0/90/0/&apiKey=${N2YO_KEY}`;
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`N2YO ${resp.status}`);
    const data = await resp.json();
    for (const sat of data.above ?? []) {
      const satId = String(sat.satid ?? sat.satid ?? sat.satname ?? `${sat.satlat}_${sat.satlng}`);
      if (seen.has(satId)) continue;
      const lat = Number(sat.satlat);
      const lon = Number(sat.satlng);
      const altKm = Number(sat.satalt);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altKm)) continue;
      seen.add(satId);
      points.push({
        id: satId,
        name: sat.satname ?? `N2YO ${satId}`,
        lat,
        lon,
        altM: altKm * 1000,
      });
      if (points.length >= limit) {
        return points;
      }
    }
  }

  return points;
}

function googleRoutePairsForBounds(minLon, minLat, maxLon, maxLat) {
  const cx = (minLon + maxLon) / 2;
  const cy = (minLat + maxLat) / 2;
  const dx = (maxLon - minLon) * 0.46;
  const dy = (maxLat - minLat) * 0.46;
  const p = {
    w: { lat: cy, lon: cx - dx },
    e: { lat: cy, lon: cx + dx },
    n: { lat: cy + dy, lon: cx },
    s: { lat: cy - dy, lon: cx },
    nw: { lat: cy + dy, lon: cx - dx },
    ne: { lat: cy + dy, lon: cx + dx },
    sw: { lat: cy - dy, lon: cx - dx },
    se: { lat: cy - dy, lon: cx + dx },
  };
  return [[p.w, p.e], [p.e, p.w], [p.n, p.s], [p.s, p.n], [p.nw, p.se], [p.ne, p.sw]];
}

async function buildGoogleTrafficRoads(minLon, minLat, maxLon, maxLat) {
  if (!GOOGLE_ROUTES_KEY) throw new Error('Google Routes key missing on server');
  const pairs = googleRoutePairsForBounds(minLon, minLat, maxLon, maxLat);
  const departureTime = new Date(Date.now() + 5 * 60_000).toISOString();
  const roads = [];

  for (let i = 0; i < pairs.length; i++) {
    const [origin, destination] = pairs[i];
    const body = {
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lon } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lon } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
      departureTime,
      extraComputations: ['TRAFFIC_ON_POLYLINE'],
      polylineQuality: 'HIGH_QUALITY',
      polylineEncoding: 'ENCODED_POLYLINE',
      computeAlternativeRoutes: false,
    };

    const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_ROUTES_KEY,
        'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) continue;
    const data = await resp.json();
    const route = data?.routes?.[0];
    const encoded = route?.polyline?.encodedPolyline;
    if (!encoded) continue;

    const points = decodeGooglePolyline(encoded);
    if (points.length < 2) continue;
    const intervals = route?.travelAdvisory?.speedReadingIntervals ?? [];

    if (!intervals.length) {
      const f = trafficFlowFromSpeed('NORMAL');
      roads.push({
        id: `g-${i}-all`,
        coords: points,
        density: f.density,
        speed: f.speed,
        priority: f.priority,
      });
      continue;
    }

    intervals.forEach((it, idx) => {
      const start = Math.max(0, it.startPolylinePointIndex ?? 0);
      const end = Math.min(points.length - 1, it.endPolylinePointIndex ?? points.length - 1);
      if (end - start < 1) return;
      const seg = points.slice(start, end + 1);
      if (seg.length < 2) return;
      const f = trafficFlowFromSpeed(it.speed ?? 'NORMAL');
      roads.push({ id: `g-${i}-${idx}`, coords: seg, density: f.density, speed: f.speed, priority: f.priority });
    });
  }

  return roads.map(r => ({
    ...r,
    totalLength: r.coords.reduce((sum, _, i) => i === 0 ? sum : sum + gcDistanceMeters(r.coords[i - 1].lat, r.coords[i - 1].lon, r.coords[i].lat, r.coords[i].lon), 0),
  }));
}

function parseTLEText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  let pendingName = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('0 ')) { pendingName = line.slice(2).trim(); continue; }
    if (!line.startsWith('1 ')) continue;
    const line1 = line;
    const line2 = lines[i + 1] ?? '';
    if (!line2.startsWith('2 ')) continue;
    out.push({ name: pendingName || `SAT-${out.length + 1}`, line1, line2 });
    pendingName = '';
    i += 1;
  }
  return out;
}

function classifySatelliteMilitaryStatus(upperName) {
  const military = [
    'NROL', 'NRO', 'USAF', 'USA-', 'USSF', 'AFSPC', 'COSMOS', 'YAOGAN', 'MILITARY', 'DEFENSE',
    'DSP', 'SBIRS', 'WARNING', 'EARLY WARN', 'KH-11', 'KH-9', 'KH-8', 'KEYHOLE', 'ORION',
    'IMPROVED CRYSTAL', 'LACROSSE', 'RAINBOW', 'VORTEX', 'JUMPSEAT', 'MILSTAR', 'SKYNET',
    'PYRAMIDS', 'FLTSAT', 'DSCS', 'AFSAT', 'AFTS-', 'NAVY', 'SSN-', 'FLTSATCOM', 'UFO-',
    'ZIYUAN', 'HUANJING', 'KOPEK', 'CYKLOP', 'KVANT', 'PROGNOZ', 'HEXAGON', 'GAMBIT',
    'TALENT', 'SIGINT', 'COMINT', 'ELINT', 'RECONNAISSANCE', 'RECONNAISSANCE IMAGERY',
    'NATIONAL SECURITY',
  ];
  return military.some(k => upperName.includes(k));
}

function classifySatelliteApplication(upperName) {
  const astronomical = ['HUBBLE', 'JWST', 'JAMES WEBB', 'CHANDRA', 'XMM', 'FERMI', 'TESS', 'KEPLER', 'GAIA', 'EUCLID', 'ASTRO'];
  if (astronomical.some(k => upperName.includes(k))) return 'Astronomical';

  const weather = ['NOAA', 'METEOR', 'METOP', 'GOES', 'HIMAWARI', 'WEATHER'];
  if (weather.some(k => upperName.includes(k))) return 'Weather';

  const navigation = ['GPS', 'NAVSTAR', 'GLONASS', 'GALILEO', 'BEIDOU', 'QZSS', 'IRNSS', 'NAVIC', 'EGNOS', 'WAAS'];
  if (navigation.some(k => upperName.includes(k))) return 'Navigation';

  const earthObservation = ['LANDSAT', 'SENTINEL', 'TERRA', 'AQUA', 'NOAA', 'METEOR', 'HIMAWARI', 'GOES', 'RADARSAT', 'PLEIADES', 'WORLDVIEW', 'SPOT', 'SUOMI', 'NPP'];
  if (earthObservation.some(k => upperName.includes(k))) return 'Earth Observation';

  const communication = ['STARLINK', 'ONEWEB', 'IRIDIUM', 'GLOBALSTAR', 'INTELSAT', 'EUTELSAT', 'INMARSAT', 'TELSTAR', 'ASTRA', 'O3B', 'TDRS', 'SKYNET', 'SATCOM'];
  if (communication.some(k => upperName.includes(k))) return 'Communication';

  return 'Unknown';
}

function classifySatelliteCrewedStatus(upperName) {
  const crewed = ['ISS', 'ZARYA', 'TIANGONG', 'CSS', 'CREW DRAGON', 'STARLINER', 'SOYUZ', 'SHENZHOU'];
  return crewed.some(k => upperName.includes(k)) ? 'Crewed' : 'Uncrewed';
}

function classifySatelliteOrbitType(line2 = '') {
  const l2 = String(line2).padEnd(69, ' ');
  const inclinationDeg = Number.parseFloat(l2.slice(8, 16).trim());
  const eccRaw = l2.slice(26, 33).trim();
  const eccentricity = Number.parseFloat(`0.${eccRaw}`);
  const meanMotionRevDay = Number.parseFloat(l2.slice(52, 63).trim());

  if (!Number.isFinite(meanMotionRevDay) || meanMotionRevDay <= 0) return 'Unknown';

  const periodMinutes = 1440 / meanMotionRevDay;
  const nearGeoPeriod = Math.abs(periodMinutes - 1436) < 40;
  const lowInclination = Number.isFinite(inclinationDeg) ? inclinationDeg < 20 : false;
  const lowEccentricity = Number.isFinite(eccentricity) ? eccentricity < 0.02 : true;

  if (nearGeoPeriod && lowInclination && lowEccentricity) return 'GEO';
  if (periodMinutes < 128) return 'LEO';
  if (periodMinutes < 600) return 'MEO';
  const highEccentricity = Number.isFinite(eccentricity) ? eccentricity > 0.25 : false;
  if (highEccentricity || periodMinutes >= 600) return 'HEO';
  return 'Unknown';
}

function deriveSatelliteMeta(name, line2) {
  const upperName = String(name ?? '').toUpperCase();
  return {
    rawName: name ?? '',
    isMilitary: classifySatelliteMilitaryStatus(upperName),
    application: classifySatelliteApplication(upperName),
    crewedStatus: classifySatelliteCrewedStatus(upperName),
    orbitType: classifySatelliteOrbitType(line2),
  };
}

function categoryForSatelliteMeta(meta) {
  const rawName = String(meta?.rawName ?? '').toUpperCase();
  if (/\bDEB\b|DEBRIS|FRAGMENT/.test(rawName)) return 'debris';
  if (/\bR\/B\b|ROCKET BODY|UPPER STAGE|FREGAT|BREEZE-M|CENTAUR|DELTA\s+STAGE/.test(rawName)) return 'rocket';
  if (meta?.isMilitary) return 'military';

  const app = (meta?.application ?? 'unknown').toLowerCase();
  if (app === 'weather' || /NOAA|METEOR|GOES|HIMAWARI|METOP|WEATHER/.test(rawName)) return 'weather';
  if (app === 'earth observation') return 'earth_observation';
  if (app === 'communication') {
    if (/STARLINK|ONEWEB|KUIPER|O3B|TDRS|SATCOM/.test(rawName)) return 'internet';
    return 'communications';
  }
  if (app === 'navigation') return 'navigation';
  if (app === 'astronomical' || (meta?.crewedStatus ?? '').toLowerCase() === 'crewed') return 'scientific';
  return 'other';
}

async function ensureSatelliteCatalog() {
  const now = Date.now();
  if (satCatalog.length && (now - satCatalogTs) < SAT_CATALOG_TTL_MS) return;

  async function loadFromCelesTrak() {
    const url = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=TLE';
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(SAT_SNAPSHOT_POLL_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`CelesTrak ${resp.status}`);
    const text = await resp.text();
    const parsed = parseTLEText(text);
    satCatalog = parsed.map((t, idx) => {
      const meta = deriveSatelliteMeta(t.name, t.line2);
      return {
      id: `${idx}:${t.name}`,
      name: t.name,
      line1: t.line1,
      line2: t.line2,
      satrec: satellite.twoline2satrec(t.line1, t.line2),
      meta,
      category: categoryForSatelliteMeta(meta),
    };
    });
    satCatalogSource = 'celestrak';
  }

  async function loadFromSpaceTrack() {
    if (!SPACETRACK_USER || !SPACETRACK_PASS) {
      throw new Error('Space-Track credentials missing');
    }

    const loginBody = new URLSearchParams({
      identity: SPACETRACK_USER,
      password: SPACETRACK_PASS,
    });

    const loginResp = await fetch('https://www.space-track.org/ajaxauth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...HEADERS,
      },
      body: loginBody.toString(),
      signal: AbortSignal.timeout(SAT_SNAPSHOT_POLL_TIMEOUT_MS),
    });
    if (!loginResp.ok) throw new Error(`Space-Track login ${loginResp.status}`);

    const cookie = loginResp.headers.get('set-cookie') ?? '';
    if (!cookie) throw new Error('Space-Track session cookie missing');

    // Omit limit clause → Space-Track returns their full GP catalog
    const queryUrl = `https://www.space-track.org/basicspacedata/query/class/gp/EPOCH/%3Enow-1/orderby/CREATION_DATE%20DESC/format/json`;
    const gpResp = await fetch(queryUrl, {
      headers: {
        ...HEADERS,
        Cookie: cookie,
      },
      signal: AbortSignal.timeout(SAT_SNAPSHOT_POLL_TIMEOUT_MS),
    });
    if (!gpResp.ok) throw new Error(`Space-Track GP ${gpResp.status}`);

    const rows = await gpResp.json();
    const allRows = (Array.isArray(rows) ? rows : []).filter(r => r?.TLE_LINE1 && r?.TLE_LINE2);
    satCatalog = allRows.map((r, idx) => {
      const name = (r.OBJECT_NAME ?? `NORAD ${r.NORAD_CAT_ID ?? idx}`).trim();
      const line1 = r.TLE_LINE1;
      const line2 = r.TLE_LINE2;
      const meta = deriveSatelliteMeta(name, line2);
      return {
      id: `${idx}:${r.OBJECT_NAME ?? r.NORAD_CAT_ID ?? 'SAT'}`,
      name,
      line1,
      line2,
      satrec: satellite.twoline2satrec(line1, line2),
      meta,
      category: categoryForSatelliteMeta(meta),
    };
    });
    satCatalogSource = 'spacetrack';
  }

  try {
    switch (BACKEND_SATELLITE_PROVIDER) {
      case 'spacetrack':
        await loadFromSpaceTrack();
        break;
      case 'n2yo':
        // Browser-direct N2YO is targeted queries only; server snapshot mode
        // uses direct position sampling instead of TLE propagation.
        await loadFromCelesTrak();
        break;
      case 'celestrak':
      default:
        await loadFromCelesTrak();
        break;
    }
  } catch (err) {
    console.warn(`[proxy] Satellite catalog load failed (${BACKEND_SATELLITE_PROVIDER}), fallback to CelesTrak: ${err?.message ?? 'unknown'}`);
    await loadFromCelesTrak();
  }

  satCatalogTs = now;
}

function satelliteSnapshot(maxCount = Infinity, options = {}) {
  const nowDate = new Date();
  const gmst = satellite.gstime(nowDate);
  const points = [];
  const limit = Number.isFinite(maxCount) ? maxCount : satCatalog.length;
  const selectedCategories = Array.isArray(options.categories)
    ? options.categories.filter(Boolean).map(v => String(v).toLowerCase())
    : [];
  const categoryFilterEnabled = selectedCategories.length > 0;
  const perCategory = Number.isFinite(options.perCategory) && options.perCategory > 0
    ? Math.floor(options.perCategory)
    : SATELLITE_MAX_PER_CATEGORY;
  const perCategoryCounts = new Map();

  for (let i = 0; i < satCatalog.length; i++) {
    if (points.length >= limit) break;
    const s = satCatalog[i];
    const category = s.category ?? 'unknown';

    if (categoryFilterEnabled && !selectedCategories.includes(category)) {
      continue;
    }
    if (categoryFilterEnabled) {
      const used = perCategoryCounts.get(category) ?? 0;
      if (used >= perCategory) continue;
      perCategoryCounts.set(category, used + 1);
    }

    const pv = satellite.propagate(s.satrec, nowDate);
    if (!pv?.position) continue;
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    if (!Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude) || !Number.isFinite(geo.height)) continue;
    points.push({
      id: s.id,
      name: s.name,
      lat: toDeg(geo.latitude),
      lon: toDeg(geo.longitude),
      altM: geo.height * 1000,
      line1: s.line1,
      line2: s.line2,
      category,
      meta: s.meta,
    });
  }
  return points;
}

async function getSatellitesSnapshotPayload(maxCount = Infinity, options = {}) {
  const now = Date.now();
  const requestMax = Number.isFinite(maxCount) ? maxCount : Infinity;
  const requestedPerCategory = Number.isFinite(options.perCategory) && options.perCategory > 0
    ? Math.floor(options.perCategory)
    : SATELLITE_MAX_PER_CATEGORY;
  const selectedCategories = Array.isArray(options.categories)
    ? options.categories.filter(Boolean).map(v => String(v).toLowerCase())
    : [];
  const categoryKey = selectedCategories.length ? selectedCategories.sort().join(',') : 'all';
  const snapshotTtl = BACKEND_SATELLITE_PROVIDER === 'n2yo' ? N2YO_SNAPSHOT_TTL_MS : SAT_SNAPSHOT_TTL_MS;
  if (satSnapshotCache.points.length && satSnapshotCache.source === BACKEND_SATELLITE_PROVIDER && satSnapshotCache.categoryKey === categoryKey && satSnapshotCache.perCategory === requestedPerCategory && (now - satSnapshotCache.ts) < snapshotTtl && satSnapshotCache.maxCount >= requestMax) {
    const points = Number.isFinite(requestMax)
      ? satSnapshotCache.points.slice(0, requestMax)
      : satSnapshotCache.points;
    return { points, total: points.length, ts: satSnapshotCache.ts, source: `server-propagated:${satSnapshotCache.source}`, cacheHit: true };
  }

  const computeMax = Number.isFinite(requestMax) ? requestMax : 99_999;
  let points;
  let source;
  if (BACKEND_SATELLITE_PROVIDER === 'n2yo') {
    points = await fetchN2yoSnapshot(computeMax);
    source = 'n2yo';
  } else {
    await ensureSatelliteCatalog();
    points = satelliteSnapshot(computeMax, {
      categories: selectedCategories,
      perCategory: requestedPerCategory,
    });
    source = satCatalogSource;
  }
  const generatedAt = Date.now();
  satSnapshotCache = {
    ts: generatedAt,
    points,
    source,
    maxCount: computeMax,
    perCategory: requestedPerCategory,
    categoryKey,
  };
  scheduleCacheWrite();
  return { points: Number.isFinite(requestMax) ? points.slice(0, requestMax) : points, total: Number.isFinite(requestMax) ? Math.min(points.length, requestMax) : points.length, ts: generatedAt, source: `server-propagated:${source}`, cacheHit: false };
}

async function getTrafficPayload(bounds) {
  const b = normalizeBounds(bounds);
  if (!b) {
    return { roads: [], total: 0, ts: Date.now(), source: 'traffic-server', mode: 'bounds-required' };
  }

  const backendMode = resolveTrafficBackendMode();
  const cacheKey = `${backendMode}:${boundsCacheKey(b, 'traffic-global')}`;
  const cached = trafficSnapshotCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.ts) < TRAFFIC_SNAPSHOT_TTL_MS) {
    return { ...cached.payload, cacheHit: true };
  }

  const [minLon, minLat, maxLon, maxLat] = b;
  const roads = backendMode === 'google-live'
    ? await buildGoogleTrafficRoads(minLon, minLat, maxLon, maxLat)
    : await buildOsmTrafficRoads(minLon, minLat, maxLon, maxLat);
  const generatedAt = Date.now();
  const payload = {
    roads,
    total: roads.length,
    ts: generatedAt,
    source: backendMode === 'google-live' ? 'google-routes-server' : 'osm-overpass-server',
    mode: backendMode,
    cacheKey,
    cacheHit: false,
  };
  trafficSnapshotCache.set(cacheKey, { ts: generatedAt, payload });
  scheduleCacheWrite();
  return payload;
}

function overpassMarineQuery(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  const [minLon, minLat, maxLon, maxLat] = bounds;
  return `
    [out:json][timeout:20];
    (
      node["seamark:type"~"^(light_vessel|tanker|cargo|passenger|fishing_vessel|fishing|pilot_station|tug)$"](${minLat},${minLon},${maxLat},${maxLon});
      way["seamark:type"~"^(light_vessel|tanker|cargo|passenger|fishing_vessel|fishing|pilot_station|tug)$"](${minLat},${minLon},${maxLat},${maxLon});
      relation["seamark:type"~"^(light_vessel|tanker|cargo|passenger|fishing_vessel|fishing|pilot_station|tug)$"](${minLat},${minLon},${maxLat},${maxLon});
      node["ship:type"](${minLat},${minLon},${maxLat},${maxLon});
      way["ship:type"](${minLat},${minLon},${maxLat},${maxLon});
      relation["ship:type"](${minLat},${minLon},${maxLat},${maxLon});
    );
    out center tags;
  `;
}

function normalizeLon180(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function vesselTypeFromTags(tags = {}) {
  const type = String(tags['ship:type'] ?? tags['seamark:type'] ?? tags.ship ?? '').toLowerCase();
  if (type.includes('tanker')) return 'tanker';
  if (type.includes('cargo')) return 'cargo';
  if (type.includes('passenger')) return 'passenger';
  if (type.includes('fishing')) return 'fishing';
  return type || 'other';
}

function buildTrackPoints(lat, lon, headingDeg = 0, speedKnots = 10, steps = 6) {
  const points = [];
  const headingRad = (Number(headingDeg) || 0) * (Math.PI / 180);
  const speedMps = (Number(speedKnots) || 0) * 0.514444;
  const stepSeconds = 60;
  for (let i = steps - 1; i >= 0; i -= 1) {
    const distanceMeters = speedMps * stepSeconds * i;
    const dLat = (Math.cos(headingRad) * distanceMeters) / 111320;
    const dLon = (Math.sin(headingRad) * distanceMeters) / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.2));
    points.push({ lat: lat - dLat, lon: normalizeLon180(lon - dLon) });
  }
  points.push({ lat, lon: normalizeLon180(lon) });
  return points;
}

function parseOverpassVessels(payload) {
  const out = [];
  for (const element of payload?.elements ?? []) {
    const lat = Number.isFinite(element?.lat) ? element.lat : element?.center?.lat;
    const lon = Number.isFinite(element?.lon) ? element.lon : element?.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const tags = element?.tags ?? {};
    const type = vesselTypeFromTags(tags);
    const heading = Number.parseFloat(tags.heading ?? tags.course ?? tags['seamark:radio_station:category']);
    const speed = Number.parseFloat(tags.speed ?? tags.knots ?? tags['seamark:notice:speed_limit']);

    out.push({
      id: `${element.type ?? 'obj'}-${element.id}`,
      lat,
      lon: normalizeLon180(lon),
      name: tags.name || tags.ref || tags['seamark:name'] || `Vessel ${element.id}`,
      type,
      speed: Number.isFinite(speed) ? speed : null,
      heading: Number.isFinite(heading) ? heading : null,
      simulated: false,
      tags,
      track: buildTrackPoints(lat, normalizeLon180(lon), Number.isFinite(heading) ? heading : 0, Number.isFinite(speed) ? speed : 8),
    });
  }
  return out;
}

function parseAisNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAisVessels(payload) {
  const candidates = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.vessels) ? payload.vessels
      : Array.isArray(payload?.positions) ? payload.positions
        : Array.isArray(payload?.data) ? payload.data
          : []);

  const out = [];
  for (const row of candidates) {
    const lat = parseAisNumber(row?.lat ?? row?.latitude ?? row?.LAT ?? row?.Latitude);
    const lon = parseAisNumber(row?.lon ?? row?.lng ?? row?.longitude ?? row?.LON ?? row?.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const heading = parseAisNumber(row?.heading ?? row?.cog ?? row?.course ?? row?.COG);
    const speed = parseAisNumber(row?.speed ?? row?.sog ?? row?.SOG ?? row?.speed_knots);
    const idRaw = row?.id ?? row?.mmsi ?? row?.MMSI ?? row?.imo ?? row?.IMO ?? row?.uuid;
    const id = idRaw ? `ais-${String(idRaw)}` : `ais-${lat.toFixed(6)}-${lon.toFixed(6)}`;
    const shipType = String(row?.type ?? row?.shipType ?? row?.ship_type ?? row?.vesselType ?? row?.vessel_type ?? '').toLowerCase();
    const name = row?.name ?? row?.vesselName ?? row?.ship_name ?? row?.SHIPNAME ?? row?.callsign ?? `AIS ${String(idRaw ?? out.length + 1)}`;

    out.push({
      id,
      lat,
      lon: normalizeLon180(lon),
      name: String(name),
      type: shipType || 'other',
      speed: Number.isFinite(speed) ? speed : null,
      heading: Number.isFinite(heading) ? heading : null,
      simulated: false,
      tags: {
        ship: shipType || 'other',
        mmsi: row?.mmsi ?? row?.MMSI ?? null,
        imo: row?.imo ?? row?.IMO ?? null,
      },
      track: buildTrackPoints(lat, normalizeLon180(lon), Number.isFinite(heading) ? heading : 0, Number.isFinite(speed) ? speed : 8),
    });
  }

  return out;
}

function buildAisProxyUrl(bounds) {
  if (!AIS_PROXY_URL) return '';
  const [minLon, minLat, maxLon, maxLat] = bounds;
  const url = new URL(AIS_PROXY_URL);
  if (!url.searchParams.has('minLon')) url.searchParams.set('minLon', `${minLon}`);
  if (!url.searchParams.has('minLat')) url.searchParams.set('minLat', `${minLat}`);
  if (!url.searchParams.has('maxLon')) url.searchParams.set('maxLon', `${maxLon}`);
  if (!url.searchParams.has('maxLat')) url.searchParams.set('maxLat', `${maxLat}`);
  return url.toString();
}

async function fetchAisVessels(bounds) {
  if (!AIS_PROXY_URL) return [];
  const url = buildAisProxyUrl(bounds);
  const headers = { ...HEADERS };
  if (AIS_PROXY_KEY) {
    headers['Authorization'] = `Bearer ${AIS_PROXY_KEY}`;
    headers['X-Api-Key'] = AIS_PROXY_KEY;
  }

  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    throw new Error(`AIS ${resp.status}`);
  }
  const payload = await resp.json();
  return parseAisVessels(payload);
}

async function getMarinePayload(bounds) {
  const b = normalizeBounds(bounds);
  if (!b) {
    return { vessels: [], total: 0, ts: Date.now(), source: 'marine-server', mode: 'bounds-required' };
  }

  const cacheKey = boundsCacheKey(b, 'marine-global');
  const cached = marineSnapshotCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.ts) < MARINE_SNAPSHOT_TTL_MS) {
    return { ...cached.payload, cacheHit: true };
  }

  let vessels = [];
  let source = 'marine-live-empty';
  const errors = [];

  const providerOrder = (() => {
    if (BACKEND_MARINE_PROVIDER === 'ais') return ['ais'];
    if (BACKEND_MARINE_PROVIDER === 'overpass') return ['overpass'];
    // auto: prefer AIS when configured, otherwise Overpass.
    return AIS_PROXY_URL ? ['ais', 'overpass'] : ['overpass'];
  })();

  for (const provider of providerOrder) {
    try {
      if (provider === 'ais') {
        vessels = await fetchAisVessels(b);
        source = 'ais-live-server';
      } else {
        const query = overpassMarineQuery(b);
        const response = await fetchOverpassJson(query, 22_000);
        vessels = parseOverpassVessels(response);
        source = 'osm-overpass-server';
      }

      if (vessels.length > 0) break;
    } catch (error) {
      errors.push(`${provider}:${error?.message ?? 'unknown'}`);
    }
  }

  if (!vessels.length && errors.length > 0) {
    console.warn(`[proxy] Marine live fetch failed (${providerOrder.join(' -> ')}): ${errors.join(' | ')}`);
  }

  const generatedAt = Date.now();
  const payload = {
    vessels,
    total: vessels.length,
    ts: generatedAt,
    source,
    cacheKey,
    cacheHit: false,
  };
  marineSnapshotCache.set(cacheKey, { ts: generatedAt, payload });
  scheduleCacheWrite();
  return payload;
}

async function fetchJson(url, timeoutMs = 20_000) {
  const resp = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`${url} ${resp.status}`);
  }
  return resp.json();
}

async function fetchText(url, timeoutMs = 20_000) {
  const resp = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`${url} ${resp.status}`);
  }
  return resp.text();
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(cell => cell.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    return Object.fromEntries(headers.map((header, index) => [header, (values[index] ?? '').trim()]));
  });
}

function toIsoString(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const COLLECTION_BACKEND_CAPABILITIES = {
  'COPERNICUS/S2_SR_HARMONIZED': ['copernicus-dataspace', 'sentinel-hub'],
  'COPERNICUS/S2_HARMONIZED': ['copernicus-dataspace', 'sentinel-hub'],
  'COPERNICUS/S1_GRD': ['copernicus-dataspace', 'sentinel-hub'],
  'COPERNICUS/S3/OLCI': ['copernicus-dataspace', 'sentinel-hub'],
  'COPERNICUS/S5P/OFFL/L3_NO2': ['copernicus-dataspace', 'sentinel-hub'],
  'COPERNICUS/S5P/OFFL/L3_CO': ['copernicus-dataspace', 'sentinel-hub'],
  'COPERNICUS/S5P/OFFL/L3_SO2': ['copernicus-dataspace', 'sentinel-hub'],
  'COPERNICUS/S5P/OFFL/L3_CH4': ['copernicus-dataspace', 'sentinel-hub'],
  'COPERNICUS/S5P/OFFL/L3_AER_AI': ['copernicus-dataspace', 'sentinel-hub'],
  'LANDSAT/LC09/C02/T1_L2': ['nasa-gibs', 'copernicus-dataspace'],
  'LANDSAT/LC08/C02/T1_L2': ['nasa-gibs', 'copernicus-dataspace'],
  'LANDSAT/LE07/C02/T1_L2': ['nasa-gibs', 'copernicus-dataspace'],
  'LANDSAT/LT05/C02/T1_L2': ['nasa-gibs', 'copernicus-dataspace'],
  'LANDSAT/LC09/C02/T1_TOA': ['nasa-gibs', 'copernicus-dataspace'],
  'LANDSAT/LC08/C02/T1_TOA': ['nasa-gibs', 'copernicus-dataspace'],
  'MODIS/061/MOD09GA': ['nasa-gibs'],
  'MODIS/061/MYD09GA': ['nasa-gibs'],
  'MODIS/061/MOD09GQ': ['nasa-gibs'],
  'MODIS/061/MOD13Q1': ['nasa-gibs'],
  'MODIS/061/MOD11A2': ['nasa-gibs'],
  'MODIS/061/MOD14A1': ['nasa-gibs'],
  'MODIS/061/MOD10A1': ['nasa-gibs'],
  'MODIS/061/MCD43A4': ['nasa-gibs'],
  'NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG': ['nasa-gibs'],
  'NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG': ['nasa-gibs'],
  'NASA/VIIRS/VNP46A1': ['nasa-gibs'],
  'NOAA/VIIRS/001/VNP09GA': ['nasa-gibs'],
  'NOAA/VIIRS/001/VNP13A1': ['nasa-gibs'],
  'NOAA/GOES/16/MCMIPF': ['nasa-gibs'],
  'NOAA/GOES/17/MCMIPF': ['nasa-gibs'],
  'NOAA/GOES/18/MCMIPF': ['nasa-gibs'],
  'ASTER/AST_L1T_003': ['nasa-gibs'],
  'NASA/ASTER_GED/AG100_003': ['nasa-gibs'],
};

function stripClosedRing(points) {
  if (points.length < 2) return points;
  const [firstLon, firstLat] = points[0];
  const [lastLon, lastLat] = points[points.length - 1];
  if (firstLon === lastLon && firstLat === lastLat) {
    return points.slice(0, -1);
  }
  return points;
}

function sanitizePoints(points) {
  return stripClosedRing(points.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat)));
}

function geometryToOuterRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.slice(0, 1);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map(poly => poly[0]).filter(Boolean);
  }
  return [];
}

function getSummaryOverall(summary) {
  return Number(summary?.scores?.overall ?? 0);
}

function formatCompactNumber(value) {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function inferFaaSeverity(text) {
  return /vip|president|presidential|special security|security|space|rocket|hazard/i.test(text)
    ? 'high'
    : 'medium';
}

function parseAltitudeTokenMeters(rawToken, { isUpper = false } = {}) {
  if (rawToken == null) return null;
  const token = String(rawToken).trim().toUpperCase();
  if (!token) return null;

  if (/^(SFC|SURFACE|GND|GROUND)$/.test(token)) return 0;
  if (/^(UNL|UNLIMITED|ABOVE)$/.test(token)) return isUpper ? OVERLAY_MAX_FLIGHT_HEIGHT_M : null;

  const flMatch = token.match(/^FL\s*(\d{2,3})$/i);
  if (flMatch) {
    const flightLevel = Number(flMatch[1]);
    return Number.isFinite(flightLevel) ? flightLevel * 100 * 0.3048 : null;
  }

  const numUnitMatch = token.match(/^(\d+(?:\.\d+)?)\s*(FT|FEET|F|M|METER|METERS|KM)?$/i);
  if (!numUnitMatch) return null;

  const value = Number(numUnitMatch[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (numUnitMatch[2] ?? 'FT').toUpperCase();
  if (unit === 'KM') return value * 1000;
  if (unit.startsWith('M')) return value;
  return value * 0.3048;
}

function pickFirstAltitudeMeters(candidates, options = {}) {
  for (const candidate of candidates) {
    const meters = parseAltitudeTokenMeters(candidate, options);
    if (Number.isFinite(meters)) return meters;
  }
  return null;
}

function parseAltitudeRangeMetersFromText(text) {
  const src = String(text ?? '');
  if (!src.trim()) return { floorMeters: null, ceilingMeters: null };

  const token = '(?:SFC|SURFACE|GND|GROUND|UNL|UNLIMITED|FL\\s*\\d{2,3}|\\d+(?:\\.\\d+)?\\s*(?:FT|FEET|F|M|METER|METERS|KM)?)';
  const rangeRe = new RegExp(`(${token})\\s*(?:-|TO|THRU|THROUGH)\\s*(${token})`, 'i');
  const match = src.toUpperCase().match(rangeRe);
  if (!match) return { floorMeters: null, ceilingMeters: null };

  const floorMeters = parseAltitudeTokenMeters(match[1], { isUpper: false });
  const ceilingMeters = parseAltitudeTokenMeters(match[2], { isUpper: true });
  return { floorMeters, ceilingMeters };
}

function normalizeVerticalBoundsMeters(floorMeters, ceilingMeters) {
  const floor = Number.isFinite(floorMeters) ? Math.max(0, floorMeters) : null;
  let ceiling = Number.isFinite(ceilingMeters) ? Math.max(0, ceilingMeters) : null;

  if (Number.isFinite(floor) && Number.isFinite(ceiling) && ceiling <= floor) {
    ceiling = null;
  }

  return {
    floorMeters: floor,
    ceilingMeters: ceiling,
  };
}

async function loadFaaFlightRestrictions() {
  try {
    const [geoJson, list] = await Promise.all([
      fetchJson(FAA_TFR_WFS_URL),
      fetchJson(FAA_TFR_LIST_URL),
    ]);
    const listByGid = new Map((Array.isArray(list) ? list : []).map(item => [String(item.gid), item]));
    const features = Array.isArray(geoJson?.features) ? geoJson.features : [];

    return features.flatMap((feature, featureIndex) => {
      const properties = feature?.properties ?? {};
      const listItem = listByGid.get(String(properties.GID));
      const title = properties.TITLE || listItem?.description || listItem?.notam_id || `FAA TFR ${featureIndex + 1}`;
      const description = listItem?.description || properties.LEGAL || 'FAA temporary flight restriction.';
      const updatedAt = toIsoString(listItem?.mod_abs_time || properties.LAST_MODIFICATION_DATETIME);
      const pointsSets = geometryToOuterRings(feature?.geometry);
      const altitudeText = `${title} ${description} ${properties.LEGAL ?? ''}`;
      const parsedRange = parseAltitudeRangeMetersFromText(altitudeText);

      const floorMeters = pickFirstAltitudeMeters([
        properties.LOWER_VAL,
        properties.LOWER,
        properties.FLOOR,
        listItem?.lower_alt,
        listItem?.lower,
      ]) ?? parsedRange.floorMeters;

      const ceilingMeters = pickFirstAltitudeMeters([
        properties.UPPER_VAL,
        properties.UPPER,
        properties.CEILING,
        listItem?.upper_alt,
        listItem?.upper,
      ], { isUpper: true }) ?? parsedRange.ceilingMeters;

      const vertical = normalizeVerticalBoundsMeters(floorMeters, ceilingMeters);

      return pointsSets.map((ring, ringIndex) => {
        const points = sanitizePoints((ring ?? []).map(([lon, lat]) => [Number(lon), Number(lat)]));
        if (points.length < 3) return null;

        const severity = inferFaaSeverity(`${title} ${description}`);
        return {
          id: `faa-${properties.NOTAM_KEY ?? properties.GID ?? featureIndex}-${ringIndex}`,
          name: title,
          zoneType: 'tfr',
          severity,
          source: 'FAA TFR WFS + TFR API',
          status: 'active',
          startsAt: null,
          endsAt: null,
          updatedAt,
          observedAt: updatedAt,
          floorMeters: vertical.floorMeters,
          ceilingMeters: vertical.ceilingMeters,
          points,
          summary: description,
        };
      }).filter(Boolean);
    });
  } catch (error) {
    console.warn(`[proxy] FAA TFR fetch failed: ${error?.message ?? 'unknown'}`);
    return [];
  }
}

function overpassTag(tagValue = '') {
  return String(tagValue).replace(/"/g, '\\"');
}

function overpassAirspaceQuery(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  const [minLon, minLat, maxLon, maxLat] = bounds;
  const airspaceFilter = 'restricted|prohibited|danger|no_drone|temporary';
  return `
    [out:json][timeout:25];
    (
      way["boundary"="airspace"]["airspace"~"^(${overpassTag(airspaceFilter)})$"](${minLat},${minLon},${maxLat},${maxLon});
      relation["boundary"="airspace"]["airspace"~"^(${overpassTag(airspaceFilter)})$"](${minLat},${minLon},${maxLat},${maxLon});
    );
    out geom;
  `;
}

function boundsSpan(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  const [minLon, minLat, maxLon, maxLat] = bounds;
  let lonSpan = maxLon - minLon;
  if (lonSpan < 0) lonSpan += 360;
  const latSpan = Math.max(0, maxLat - minLat);
  return { lonSpan, latSpan };
}

function shouldFetchGlobalAirspace(bounds) {
  const span = boundsSpan(bounds);
  if (!span) return false;
  const approxAreaDeg2 = span.lonSpan * span.latSpan;
  // Overpass becomes unreliable for very broad extents; defer until user zooms in.
  if (span.lonSpan > 120 || span.latSpan > 70) return false;
  if (approxAreaDeg2 > 1800) return false;
  return true;
}

async function fetchOverpassJson(query, timeoutMs = 25_000) {
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', ...HEADERS },
        body: query,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        lastError = new Error(`Overpass ${resp.status} @ ${endpoint}`);
        continue;
      }
      return await resp.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Overpass request failed');
}

function mapOsmAirspaceTypeToSeverity(airspaceType = '') {
  const type = String(airspaceType).toLowerCase();
  if (type === 'prohibited' || type === 'restricted') return 'high';
  return 'medium';
}

function parseOsmAltitude(tags = {}, keys = [], options = {}) {
  const values = keys
    .map((key) => tags?.[key])
    .filter((value) => value != null && String(value).trim() !== '');
  return pickFirstAltitudeMeters(values, options);
}

function buildOsmAirspaceZone(id, tags, points, nowIso) {
  const airspaceType = String(tags?.airspace ?? 'restricted').toLowerCase();
  const sourceName = tags?.source || 'OpenStreetMap airspace';
  const desc = tags?.description || tags?.note || tags?.name || '';

  const floorMeters = parseOsmAltitude(tags, ['lower', 'lower_limit', 'lower:altitude', 'floor', 'min_height']);
  const ceilingMeters = parseOsmAltitude(tags, ['upper', 'upper_limit', 'upper:altitude', 'ceiling', 'max_height'], { isUpper: true });
  const vertical = normalizeVerticalBoundsMeters(floorMeters, ceilingMeters);

  return {
    id,
    name: tags?.name || `OSM ${airspaceType} airspace`,
    zoneType: airspaceType,
    severity: mapOsmAirspaceTypeToSeverity(airspaceType),
    source: sourceName,
    status: 'active',
    startsAt: null,
    endsAt: null,
    updatedAt: nowIso,
    observedAt: nowIso,
    floorMeters: vertical.floorMeters,
    ceilingMeters: vertical.ceilingMeters,
    points,
    summary: desc,
  };
}

async function loadGlobalOsmFlightRestrictions(bounds) {
  const normalizedBounds = normalizeBounds(bounds);
  if (!normalizedBounds) return [];
  if (!shouldFetchGlobalAirspace(normalizedBounds)) return [];

  try {
    const query = overpassAirspaceQuery(normalizedBounds);
    if (!query) return [];

    const payload = await fetchOverpassJson(query, 25_000);
    const elements = Array.isArray(payload?.elements) ? payload.elements : [];
    const nowIso = new Date().toISOString();
    const zones = [];

    for (const el of elements) {
      const tags = el?.tags ?? {};
      const airspaceType = String(tags?.airspace ?? '').toLowerCase();
      if (!['restricted', 'prohibited', 'danger', 'no_drone', 'temporary'].includes(airspaceType)) continue;

      if (el?.type === 'way' && Array.isArray(el?.geometry)) {
        const points = sanitizePoints(el.geometry.map((node) => [Number(node.lon), Number(node.lat)]));
        if (points.length < 3) continue;
        zones.push(buildOsmAirspaceZone(`osm-way-${el.id}`, tags, points, nowIso));
        continue;
      }

      if (el?.type === 'relation' && Array.isArray(el?.members)) {
        let ringIndex = 0;
        for (const member of el.members) {
          if (member?.role !== 'outer' || !Array.isArray(member?.geometry)) continue;
          const points = sanitizePoints(member.geometry.map((node) => [Number(node.lon), Number(node.lat)]));
          if (points.length < 3) continue;
          zones.push(buildOsmAirspaceZone(`osm-rel-${el.id}-${ringIndex}`, tags, points, nowIso));
          ringIndex += 1;
        }
      }
    }

    return zones;
  } catch (error) {
    console.warn(`[proxy] Global OSM airspace fetch failed (non-fatal): ${error?.message ?? 'unknown'}`);
    return [];
  }
}

async function loadGpsJamInterference() {
  try {
    const manifestRows = parseCsv(await fetchText(GPSJAM_MANIFEST_URL));
    const latestDate = manifestRows.length ? manifestRows[manifestRows.length - 1].date : null;
    if (!latestDate) return [];

    const rows = parseCsv(await fetchText(`${GPSJAM_DATA_BASE_URL}/${latestDate}-h3_4.csv`));
    const observedAt = `${latestDate}T23:59:59.000Z`;

    return rows.flatMap((row) => {
      const hex = row.hex;
      const countGood = Number(row.count_good_aircraft ?? 0);
      const countBad = Number(row.count_bad_aircraft ?? 0);
      const total = countGood + countBad;
      if (!hex || !Number.isFinite(total) || total <= 0 || !Number.isFinite(countBad)) return [];

      const pctBad = (countBad / total) * 100;
      if (pctBad <= 2) return [];

      const severity = pctBad > 10 ? 'high' : 'medium';
      const points = sanitizePoints(cellToBoundary(hex).map(([lat, lon]) => [Number(lon), Number(lat)]));
      if (points.length < 3) return [];

      return [{
        id: `gpsjam-${hex}`,
        name: `GPS interference ${severity.toUpperCase()} (${pctBad.toFixed(1)}%)`,
        zoneType: 'gps',
        severity,
        source: 'GPSJam',
        status: 'active',
        startsAt: `${latestDate}T00:00:00.000Z`,
        endsAt: observedAt,
        updatedAt: observedAt,
        observedAt,
        floorMeters: 0,
        ceilingMeters: OVERLAY_MAX_FLIGHT_HEIGHT_M,
        points,
        summary: `${countBad} suspect aircraft out of ${total} observed aircraft in this H3 cell.`,
      }];
    });
  } catch (error) {
    console.warn(`[proxy] GPSJam fetch failed: ${error?.message ?? 'unknown'}`);
    return [];
  }
}

function buildCountryFeatureMap(topoPayload) {
  const topology = topoPayload?.data?.topology;
  const objectKey = topology ? Object.keys(topology.objects ?? {})[0] : null;
  const idField = topoPayload?.data?.idField ?? 'usercode';
  if (!topology || !objectKey) return new Map();

  const collection = topojsonFeature(topology, topology.objects[objectKey]);
  const features = Array.isArray(collection?.features) ? collection.features : [];
  return new Map(features.map(feature => [String(feature?.properties?.[idField] ?? '').toUpperCase(), feature]));
}

function normalizeCountryNameKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/&amp;/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function countryNameAliases() {
  return new Map([
    ['congodrc', 'demrepcongo'],
    ['drcongo', 'demrepcongo'],
    ['democraticrepublicofthecongo', 'demrepcongo'],
    ['curacao', 'curacao'],
    ['puertorico', 'puertorico'],
    ['northkorea', 'northkorea'],
    ['southkorea', 'southkorea'],
    ['southsudan', 'southsudan'],
    ['westernsahara', 'westernsahara'],
  ]);
}

function buildCountryFeatureMapByName(topoPayload) {
  const topology = topoPayload?.data?.topology;
  const objectKey = topology ? Object.keys(topology.objects ?? {})[0] : null;
  if (!topology || !objectKey) return new Map();

  const collection = topojsonFeature(topology, topology.objects[objectKey]);
  const features = Array.isArray(collection?.features) ? collection.features : [];
  const aliases = countryNameAliases();
  const out = new Map();

  for (const feature of features) {
    const rawName = String(feature?.properties?.name ?? '');
    const normalized = normalizeCountryNameKey(rawName);
    if (normalized) out.set(normalized, feature);

    const aliasEntry = [...aliases.entries()].find(([, target]) => target === normalized);
    if (aliasEntry) out.set(aliasEntry[0], feature);
  }

  return out;
}

function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&#8212;|&mdash;/g, '-')
    .replace(/&#8217;|&#039;|&apos;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(text) {
  return decodeHtmlEntities(String(text ?? ''))
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function warningLevelToSeverity(level) {
  const normalized = String(level ?? '').trim();
  if (normalized === '1') return 'high';
  if (normalized === '2') return 'medium';
  return 'low';
}

function parseSafeAirspaceFeedItems(html) {
  const items = [];
  const regex = /<div class="feed-item[^\"]*"[^>]*data-feed-item-country="([^"]+)"[^>]*data-feed-item-warn-level="([^"]+)"[^>]*>([\s\S]*?)<a href="([^"]+)" class="feed-item-link-overlay"><\/a>[\s\S]*?<\/div><!-- \.feed-item -->/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const [, countryRaw, levelRaw, innerHtml, href] = match;
    const levelLabelMatch = innerHtml.match(/<span class="feed-item-level">([\s\S]*?)<\/span>/i);
    const summaryMatch = innerHtml.match(/<div class="feed-item-summary">([\s\S]*?)<div class="feed-item-summary-fade"><\/div>/i);
    items.push({
      country: decodeHtmlEntities(countryRaw).trim(),
      level: String(levelRaw).trim(),
      levelLabel: stripHtml(levelLabelMatch?.[1] ?? ''),
      summary: stripHtml(summaryMatch?.[1] ?? ''),
      href: decodeHtmlEntities(href).trim(),
    });
  }
  return items;
}

function pointsBounds(points) {
  if (!Array.isArray(points) || !points.length) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

function boundsIntersect(a, b) {
  if (!a || !b) return true;
  const [aMinLon, aMinLat, aMaxLon, aMaxLat] = a;
  const [bMinLon, bMinLat, bMaxLon, bMaxLat] = b;
  return !(aMaxLon < bMinLon || aMinLon > bMaxLon || aMaxLat < bMinLat || aMinLat > bMaxLat);
}

async function loadSafeAirspaceWarnings(bounds) {
  try {
    const [html, topoPayload] = await Promise.all([
      fetchText(SAFE_AIRSPACE_MAP_URL),
      fetchJson(`${IODA_API_BASE_URL}/topo/country`),
    ]);
    const items = parseSafeAirspaceFeedItems(html);
    const featureMap = buildCountryFeatureMapByName(topoPayload);
    const normalizedBounds = normalizeBounds(bounds);
    const zones = [];

    for (const item of items) {
      const lookupKey = countryNameAliases().get(normalizeCountryNameKey(item.country)) ?? normalizeCountryNameKey(item.country);
      const feature = featureMap.get(lookupKey);
      if (!feature) continue;

      const rings = geometryToOuterRings(feature.geometry);
      let ringIndex = 0;
      for (const ring of rings) {
        const points = sanitizePoints((ring ?? []).map(([lon, lat]) => [Number(lon), Number(lat)]));
        if (points.length < 3) continue;
        if (normalizedBounds && !boundsIntersect(pointsBounds(points), normalizedBounds)) continue;

        zones.push({
          id: `safeairspace-${lookupKey}-${ringIndex}`,
          name: item.country,
          zoneType: 'safeairspace',
          severity: warningLevelToSeverity(item.level),
          source: 'Safe Airspace',
          status: item.levelLabel || 'active',
          startsAt: null,
          endsAt: null,
          updatedAt: null,
          observedAt: null,
          floorMeters: 0,
          ceilingMeters: OVERLAY_MAX_FLIGHT_HEIGHT_M,
          points,
          summary: `${item.levelLabel}${item.summary ? `: ${item.summary}` : ''}`.trim(),
          linkUrl: item.href,
        });
        ringIndex += 1;
      }
    }

    return zones;
  } catch (error) {
    console.warn(`[proxy] Safe Airspace fetch failed: ${error?.message ?? 'unknown'}`);
    return [];
  }
}

function inferIodaSeverity(overallScore) {
  return overallScore >= 10_000_000 ? 'high' : 'medium';
}

async function loadIodaBlackouts() {
  try {
    const until = Math.floor(Date.now() / 1000);
    const from = until - IODA_BLACKOUT_LOOKBACK_SEC;
    const [summaryPayload, topoPayload] = await Promise.all([
      fetchJson(`${IODA_API_BASE_URL}/outages/summary?entityType=country&from=${from}&until=${until}&limit=${IODA_COUNTRY_SUMMARY_LIMIT}`),
      fetchJson(`${IODA_API_BASE_URL}/topo/country`),
    ]);

    const countryFeatureMap = buildCountryFeatureMap(topoPayload);
    const summaries = Array.isArray(summaryPayload?.data) ? summaryPayload.data : [];
    const rankedSummaries = summaries
      .map((summary) => {
        const code = String(summary?.entity?.code ?? '').toUpperCase();
        return {
          code,
          overallScore: getSummaryOverall(summary),
          summary,
        };
      })
      .filter(({ code, overallScore }) => overallScore > 0 && countryFeatureMap.has(code))
      .sort((left, right) => right.overallScore - left.overallScore);

    const eventSets = await Promise.all(rankedSummaries.slice(0, IODA_EVENT_ENRICH_LIMIT).map(async ({ code, summary }) => {
      const encodedCode = encodeURIComponent(code);
      try {
        const payload = await fetchJson(`${IODA_API_BASE_URL}/outages/events?entityType=country&entityCode=${encodedCode}&from=${from}&until=${until}&limit=10&format=ioda`);
        return [code, { summary, events: Array.isArray(payload?.data) ? payload.data : [] }];
      } catch {
        return [code, { summary, events: [] }];
      }
    }));
    const eventsByCode = new Map(eventSets);

    const totalSeverityScore = rankedSummaries.reduce((sum, item) => sum + item.overallScore, 0);
    const globalSummary = {
      from: toIsoString(from),
      until: toIsoString(until),
      totalSeverityScore,
      countryCount: rankedSummaries.length,
      countries: rankedSummaries.slice(0, 100).map(({ summary, overallScore, code }) => ({
        code,
        name: summary?.entity?.name ?? code,
        score: overallScore,
        eventCount: Number(summary?.event_cnt ?? 0),
      })),
    };

    const blackouts = rankedSummaries.flatMap(({ code, overallScore, summary }) => {
      const feature = countryFeatureMap.get(code);
      if (!feature) return [];
      const events = eventsByCode.get(code)?.events ?? [];

      const primaryEvent = [...events].sort((left, right) => {
        const scoreDelta = Number(right?.score ?? 0) - Number(left?.score ?? 0);
        if (scoreDelta !== 0) return scoreDelta;
        return Number(right?.until ?? 0) - Number(left?.until ?? 0);
      })[0] ?? null;

      const activeWindow = primaryEvent
        ? `${new Date(primaryEvent.from * 1000).toISOString()} to ${new Date(primaryEvent.until * 1000).toISOString()}`
        : 'Recent 24h summary';
      const sourceLabels = Object.keys(summary?.scores ?? {}).filter(key => key !== 'overall');
      const pointsSets = geometryToOuterRings(feature.geometry);

      return pointsSets.map((ring, ringIndex) => {
        const points = sanitizePoints((ring ?? []).map(([lon, lat]) => [Number(lon), Number(lat)]));
        if (points.length < 3) return null;

        return {
          id: `ioda-${code}-${ringIndex}`,
          name: summary.entity.name,
          outageType: 'blackout',
          severity: inferIodaSeverity(overallScore),
          outageScore: overallScore,
          source: 'IODA (Georgia Tech)',
          status: primaryEvent && primaryEvent.until >= Math.floor(Date.now() / 1000) ? 'active' : 'recent',
          startsAt: primaryEvent ? toIsoString(primaryEvent.from) : null,
          endsAt: primaryEvent ? toIsoString(primaryEvent.until) : null,
          updatedAt: primaryEvent ? toIsoString(primaryEvent.until) : null,
          observedAt: primaryEvent ? toIsoString(primaryEvent.until) : null,
          floorMeters: 0,
          ceilingMeters: OVERLAY_MAX_FLIGHT_HEIGHT_M,
          points,
          asnScope: sourceLabels.join(', '),
          summary: `Country-scale connectivity outage score ${formatCompactNumber(overallScore)} over the last 24 hours. Signals: ${sourceLabels.join(', ') || 'none'}. Window: ${activeWindow}.`,
        };
      }).filter(Boolean);
    });

    return {
      blackouts,
      globalSummary,
    };
  } catch (error) {
    console.warn(`[proxy] IODA blackout fetch failed: ${error?.message ?? 'unknown'}`);
    return {
      blackouts: [],
      globalSummary: null,
    };
  }
}

async function getOverlayPayload(bounds = null) {
  const now = Date.now();
  const normalizedBounds = normalizeBounds(bounds);
  const cacheKey = normalizedBounds ? `overlay:${boundsCacheKey(normalizedBounds, 'overlay-global')}` : 'overlay-global';
  const cached = overlaySnapshotCache.get(cacheKey);
  if (cached && (now - cached.ts) < OVERLAY_SNAPSHOT_TTL_MS) {
    return { ...cached.payload, cacheHit: true };
  }

  const [faaFlightRestrictions, gpsInterference, internetOutageData, globalFlightRestrictions] = await Promise.all([
    loadFaaFlightRestrictions(),
    loadGpsJamInterference(),
    loadIodaBlackouts(),
    loadSafeAirspaceWarnings(normalizedBounds),
  ]);

  const flightRestrictions = [...faaFlightRestrictions, ...globalFlightRestrictions];

  const payload = {
    ts: now,
    maxFlightHeightMeters: OVERLAY_MAX_FLIGHT_HEIGHT_M,
    flightRestrictions,
    gpsInterference,
    internetBlackouts: internetOutageData.blackouts,
    internetGlobalSummary: internetOutageData.globalSummary,
    cacheHit: false,
  };

  overlaySnapshotCache.set(cacheKey, { ts: now, payload });
  return payload;
}

// ── Aircraft database ─────────────────────────────────────────────────────────
/** @type {Map<string, object>} */
const db = new Map();

function upsert(aircraft) {
  const now = Date.now();
  for (const a of aircraft) {
    const id = (a.hex ?? '').toLowerCase().trim();
    if (!id || !a.lat || !a.lon) continue;
    if (a.alt_baro === 'ground' || (a.alt_baro ?? 0) <= 100) continue;
    db.set(id, {
      hex:      id,
      flight:   (a.flight ?? a.r ?? '').trim(),
      lat:      a.lat,
      lon:      a.lon,
      alt_baro: a.alt_baro ?? a.alt_geom ?? 10000,
      track:    a.track ?? 0,
      gs:       a.gs ?? 0,
      // enrichment fields — used for icon shape, color classification, HUD panel
      t:        a.t        ?? '',       // ICAO type code e.g. "H60", "B738", "A320"
      category: a.category ?? '',       // ADS-B category byte e.g. "A7" = rotorcraft
      dbFlags:  a.dbFlags  ?? 0,        // bit 0 = military
      squawk:   a.squawk   ?? '',
      baro_rate: a.baro_rate ?? a.geom_rate ?? 0,
      _seen:    now,
    });
  }
}

function pruneStale() {
  const cutoff = Date.now() - STALE_MS;
  let n = 0;
  for (const [id, a] of db) { if (a._seen < cutoff) { db.delete(id); n++; } }
  if (n) console.log(`[proxy] Pruned ${n} — DB: ${db.size}`);
}

setInterval(pruneStale, 30_000);

// ── Hub selection — find hubs that overlap the viewport bbox ──────────────────

function hubsForBounds(minLon, minLat, maxLon, maxLat) {
  // Pad the bbox by one hub radius so we catch aircraft near the edges
  const pad = RADIUS_DEG * 1.1;
  const pMinLat = minLat - pad, pMaxLat = maxLat + pad;
  const pMinLon = minLon - pad, pMaxLon = maxLon + pad;
  const wraps = pMaxLon - pMinLon >= 360; // full globe visible

  return ALL_HUBS.filter(h => {
    if (h.lat < pMinLat || h.lat > pMaxLat) return false;
    if (wraps) return true;
    if (pMinLon < -180 || pMaxLon > 180) {
      // bbox wraps antimeridian
      return h.lon >= pMinLon + 360 || h.lon <= pMaxLon - 360 ||
             (h.lon >= pMinLon && h.lon <= pMaxLon);
    }
    return h.lon >= pMinLon && h.lon <= pMaxLon;
  });
}

// ── Hub fetcher with per-hub TTL cache ────────────────────────────────────────

async function fetchHub(hub) {
  const key = hubKey(hub);
  const cached = hubCache.get(key);

  // Return cached promise if hub was recently fetched
  if (cached) {
    if (cached.promise) return cached.promise; // in-flight
    if (Date.now() - cached.time < HUB_TTL) return; // fresh, skip
  }

  const promise = (async () => {
    try {
      const url = `https://opendata.adsb.fi/api/v3/lat/${hub.lat}/lon/${hub.lon}/dist/${RADIUS_NM}`;
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`${res.status}`);
      const d = await res.json();
      upsert(d.aircraft ?? d.ac ?? []);
    } catch (err) {
      // Silently ignore individual hub failures
    } finally {
      hubCache.set(key, { time: Date.now(), promise: null });
    }
  })();

  hubCache.set(key, { time: Date.now(), promise });
  return promise;
}

// ── Request handler ───────────────────────────────────────────────────────────

async function getFlightsPayload(query = {}) {
  let hubs = [];
  let flightSource = BACKEND_FLIGHT_PROVIDER;
  const requestHeavy = query.mode === 'heavy' || SERVER_HEAVY_MODE;
  const viewportBufferDeg = requestHeavy ? 3 : 1;
  const parts = (query.bounds ?? '').split(',').map(Number);
  const bounds = (parts.length === 4 && parts.every(n => Number.isFinite(n))) ? normalizeBounds(parts) : null;
  const cacheKey = `${requestHeavy ? 'heavy' : 'normal'}:${boundsCacheKey(bounds)}:${BACKEND_FLIGHT_PROVIDER}`;
  const cached = flightSnapshotCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < FLIGHT_SNAPSHOT_TTL_MS) {
    return { ...cached.payload, cacheHit: true };
  }

  // Use configured backend provider where available; keep proxy hub mode as fallback.
  let shouldUseHubGridFallback = BACKEND_FLIGHT_PROVIDER === 'proxy';

  if (BACKEND_FLIGHT_PROVIDER === 'airplaneslive' || BACKEND_FLIGHT_PROVIDER === 'adsbool') {
    try {
      const base = BACKEND_FLIGHT_PROVIDER === 'airplaneslive'
        ? 'https://api.airplanes.live'
        : 'https://api.adsb.lol';
      // In server-heavy mode use /v2/all for global coverage (no viewport limit)
      await fetchReadsbProvider(base, bounds, requestHeavy);
    } catch (err) {
      console.warn(`[proxy] ${BACKEND_FLIGHT_PROVIDER} backend fetch failed, falling back to hub grid: ${err?.message ?? 'unknown'}`);
      shouldUseHubGridFallback = true;
      flightSource = `${BACKEND_FLIGHT_PROVIDER}:fallback-hub-grid`;
    }
  }

  if (BACKEND_FLIGHT_PROVIDER === 'opensky') {
    try {
      await fetchOpenSkyProvider();
    } catch (err) {
      console.warn(`[proxy] OpenSky backend fetch failed, falling back to hub grid: ${err?.message ?? 'unknown'}`);
      shouldUseHubGridFallback = true;
      flightSource = 'opensky:fallback-hub-grid';
    }
  }

  if (shouldUseHubGridFallback) {
    // In heavy mode fetch ALL hubs globally; otherwise only viewport hubs
    if (requestHeavy) {
      hubs = ALL_HUBS;
    } else if (bounds) {
      const [minLon, minLat, maxLon, maxLat] = bounds;
      hubs = hubsForBounds(minLon, minLat, maxLon, maxLat);
    }

    const batches = [];
    for (let i = 0; i < hubs.length; i += MAX_CONC) {
      batches.push(hubs.slice(i, i + MAX_CONC));
    }
    for (const batch of batches) {
      await Promise.allSettled(batch.map(h => fetchHub(h)));
    }
  }

  // In server-heavy mode return the entire DB (global mode); otherwise filter to bbox
  let aircraft = [...db.values()].map(({ _seen, ...rest }) => rest);

  if (!requestHeavy && bounds) {
    const [minLon, minLat, maxLon, maxLat] = bounds;
    aircraft = aircraft.filter(a =>
      a.lat >= minLat - viewportBufferDeg && a.lat <= maxLat + viewportBufferDeg &&
      a.lon >= minLon - viewportBufferDeg && a.lon <= maxLon + viewportBufferDeg
    );
  }

  console.log(`[proxy] flights=${flightSource} ${hubs.length} hubs queried → ${aircraft.length} aircraft in viewport${requestHeavy ? ' (heavy)' : ''}`);

  const payload = { aircraft, total: aircraft.length, ts: Date.now(), source: flightSource, cacheKey, cacheHit: false };
  flightSnapshotCache.set(cacheKey, { ts: Date.now(), payload });
  scheduleCacheWrite();
  return payload;
}

async function handleFlights(query, res) {
  const payload = await getFlightsPayload(query);
  res.writeHead(200);
  res.end(JSON.stringify(payload));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const [path, qs] = req.url.split('?');
  const queryParams = new URLSearchParams(qs ?? '');
  const query = Object.fromEntries(queryParams);
  const url   = path.replace(/\/$/, '');

  try {
    if (url.startsWith('/tiles/google/') || url.startsWith('/tiles/maptiler/')) {
      await handleTileProxy(url, queryParams, res);
      return;
    }
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err?.message ?? 'tile proxy failed' }));
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  if (url === '/api/flights') {
    await handleFlights(query, res);
  } else if (url === '/api/cameras/stream/health') {
    try {
      await handleCameraStreamHealth(res);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message ?? 'camera stream health failed' }));
    }
  } else if (url === '/api/cameras/stream') {
    try {
      await handleCameraStreamProxy(queryParams, res);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message ?? 'camera stream proxy failed' }));
    }
  } else if (url.startsWith('/api/cameras/hls/')) {
    try {
      await handleCameraHlsSegment(url, res);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message ?? 'camera hls segment failed' }));
    }
  } else if (url === '/api/nofly_gps') {
    try {
      const parts = (query.bounds ?? '').split(',').map(Number);
      const bounds = (parts.length === 4 && parts.every(n => Number.isFinite(n))) ? parts : null;
      const payload = await getOverlayPayload(bounds);
      res.writeHead(200);
      res.end(JSON.stringify({
        ts: payload.ts,
        maxFlightHeightMeters: payload.maxFlightHeightMeters,
        flightRestrictions: payload.flightRestrictions,
        gpsInterference: payload.gpsInterference,
        cacheHit: payload.cacheHit,
      }));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'nofly_gps request failed' }));
    }
  } else if (url === '/api/internet') {
    try {
      const parts = (query.bounds ?? '').split(',').map(Number);
      const bounds = (parts.length === 4 && parts.every(n => Number.isFinite(n))) ? parts : null;
      const payload = await getOverlayPayload(bounds);
      res.writeHead(200);
      res.end(JSON.stringify({
        ts: payload.ts,
        maxFlightHeightMeters: payload.maxFlightHeightMeters,
        internetBlackouts: payload.internetBlackouts,
        cacheHit: payload.cacheHit,
      }));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'internet request failed' }));
    }
  } else if (url === '/api/traffic/google') {
    const parts = (query.bounds ?? '').split(',').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'bounds must be minLon,minLat,maxLon,maxLat' }));
      return;
    }
    try {
      const payload = await getTrafficPayload(parts);
      res.writeHead(200);
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'traffic request failed' }));
    }
  } else if (url === '/api/marine/snapshot') {
    const parts = (query.bounds ?? '').split(',').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'bounds must be minLon,minLat,maxLon,maxLat' }));
      return;
    }
    try {
      const payload = await getMarinePayload(parts);
      res.writeHead(200);
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'marine snapshot failed' }));
    }
  } else if (url === '/api/satellite-imagery/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      copernicusDataspaceConfigured: Boolean(COPERNICUS_DATASPACE_WMS_URL),
      sentinelHubConfigured: Boolean(SENTINEL_HUB_WMS_URL),
    }));
  } else if (url === '/api/satellite-imagery/preview') {
    const lat = Number(query.lat);
    const lon = Number(query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'lat and lon are required numeric query params' }));
      return;
    }

    const validation = validateSatelliteImageryRequest({
      lat,
      lon,
      date: String(query.date ?? ''),
      source: String(query.source ?? 'auto'),
      collectionId: String(query.collection ?? ''),
      bands: String(query.bands ?? ''),
    });
    if (!validation.ok) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    const request = validation.value;
    try {
      const payload = await resolveSatelliteImageryPreview({
        lat: request.lat,
        lon: request.lon,
        date: request.date,
        source: request.source,
        collectionId: request.collectionId,
        bands: request.bands,
      });
      res.writeHead(200);
      res.end(JSON.stringify({
        ...payload,
        location: { lat: request.lat, lon: request.lon },
        request,
        copernicusDataspaceConfigured: Boolean(COPERNICUS_DATASPACE_WMS_URL),
        sentinelHubConfigured: Boolean(SENTINEL_HUB_WMS_URL),
      }));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'satellite imagery preview failed' }));
    }
  } else if (url === '/api/satellites/snapshot') {
    const rawMax = parseInt(query.max ?? '0', 10);
    // 0 or missing → no limit (full catalog); otherwise honour the requested count
    const maxCount = rawMax > 0 ? rawMax : Infinity;
    const perCategory = Math.max(parseInt(query.perCategory ?? `${SATELLITE_MAX_PER_CATEGORY}`, 10) || SATELLITE_MAX_PER_CATEGORY, 1);
    const categories = String(query.categories ?? '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    try {
      const payload = await getSatellitesSnapshotPayload(maxCount, { perCategory, categories });
      res.writeHead(200);
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'satellite snapshot failed' }));
    }
  } else if (url === '/api/cameras/snapshot') {
    const parts = (query.bounds ?? '').split(',').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'bounds must be minLon,minLat,maxLon,maxLat' }));
      return;
    }
    const maxCount = Math.max(parseInt(query.max ?? `${CAMERA_MAX_POINTS}`, 10) || CAMERA_MAX_POINTS, 1);
    try {
      const payload = await getCameraSnapshot(parts, maxCount);
      res.writeHead(200);
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'camera snapshot failed' }));
    }
  } else if (url === '/api/world/snapshot') {
    const parts = (query.bounds ?? '').split(',').map(Number);
    const bounds = (parts.length === 4 && parts.every(n => Number.isFinite(n))) ? parts : null;
    const include = new Set((query.include ?? 'flights,satellites,traffic,marine,cameras').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    const maxSat = Math.max(parseInt(query.satMax ?? '0', 10) || 0, 0) || Infinity;
    const satPerCategory = Math.max(parseInt(query.satPerCategory ?? `${SATELLITE_MAX_PER_CATEGORY}`, 10) || SATELLITE_MAX_PER_CATEGORY, 1);
    const satCategories = String(query.satCategories ?? '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    const maxCam = Math.max(parseInt(query.camMax ?? `${CAMERA_MAX_POINTS}`, 10) || CAMERA_MAX_POINTS, 1);

    try {
      const payload = { ts: Date.now(), mode: SERVER_HEAVY_MODE ? 'heavy' : 'normal' };
      const flightsPromise = include.has('flights')
        ? getFlightsPayload({
          bounds: bounds ? bounds.join(',') : '',
          mode: 'heavy',
        })
        : null;
      const satellitesPromise = include.has('satellites')
        ? getSatellitesSnapshotPayload(maxSat, { perCategory: satPerCategory, categories: satCategories })
        : null;
      const trafficPromise = (include.has('traffic') && bounds)
        ? getTrafficPayload(bounds)
        : null;
      const marinePromise = (include.has('marine') && bounds)
        ? getMarinePayload(bounds)
        : null;
      const camerasPromise = (include.has('cameras') && bounds)
        ? getCameraSnapshot(bounds, maxCam)
        : null;

      const [flightsPayload, satellitesPayload, trafficPayload, marinePayload, camerasPayload] = await Promise.all([
        flightsPromise,
        satellitesPromise,
        trafficPromise,
        marinePromise,
        camerasPromise,
      ]);

      if (flightsPayload) payload.flights = flightsPayload;
      if (satellitesPayload) payload.satellites = satellitesPayload;
      if (trafficPayload) payload.traffic = trafficPayload;
      if (marinePayload) payload.marine = marinePayload;
      if (camerasPayload) payload.cameras = camerasPayload;

      payload.diagnostics = {
        providers: {
          flights: payload.flights?.source ?? null,
          satellites: payload.satellites?.source ?? null,
          traffic: payload.traffic?.source ?? null,
          marine: payload.marine?.source ?? null,
          cameras: payload.cameras?.source ?? null,
        },
        cache: {
          flights: payload.flights?.cacheHit ?? null,
          satellites: payload.satellites?.cacheHit ?? null,
          traffic: payload.traffic?.cacheHit ?? null,
          marine: payload.marine?.cacheHit ?? null,
          cameras: payload.cameras?.cacheHit ?? null,
        },
      };

      res.writeHead(200);
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err?.message ?? 'world snapshot failed' }));
    }
  } else if (url === '/health') {
    ensureTileCacheDir();
    const tileEntries = fs.readdirSync(TILE_CACHE_DIR).filter(name => name.endsWith('.json')).length;
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      db: db.size,
      hubs: ALL_HUBS.length,
      hub_cache: hubCache.size,
      cache: {
        flights: flightSnapshotCache.size,
        traffic: trafficSnapshotCache.size,
        marine: marineSnapshotCache.size,
        sat_points: satSnapshotCache.points?.length ?? 0,
        camera_tiles: cameraTileCache.size,
        camera_snapshots: cameraSnapshotCache.size,
      },
      tileCache: {
        dir: TILE_CACHE_DIR,
        entries: tileEntries,
        ttlMs: TILE_CACHE_TTL_MS,
      },
    }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => {
  ensureTileCacheDir();
  loadSnapshotCacheFromDisk();
  console.log(`[proxy] Mode: ${SERVER_HEAVY_MODE ? 'heavy' : 'normal'}`);
  console.log(`[proxy] Providers: flights=${BACKEND_FLIGHT_PROVIDER}, satellites=${BACKEND_SATELLITE_PROVIDER}, satelliteImagery=${BACKEND_SATELLITE_IMAGERY_PROVIDER || 'auto'}`);
  console.log(`[proxy] ShadowGrid → http://localhost:${PORT}/api/flights?bounds=minLon,minLat,maxLon,maxLat`);
  ensureSatelliteCatalog()
    .then(() => {
      console.log(`[proxy] Satellite catalog primed: ${satCatalog.length} objects (${satCatalogSource})`);
    })
    .catch((err) => {
      console.warn(`[proxy] Satellite catalog warm-up failed: ${err?.message ?? 'unknown'}`);
    });
});
