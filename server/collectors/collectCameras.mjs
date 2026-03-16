/**
 * server/collectors/collectCameras.mjs
 *
 * Downloads camera data and writes:
 *
 *   public/camera-data/cameras.json        — full normalised array
 *   public/camera-data/cameras-lite.json  — compact array (id,a,o,u,x,t,s,y,z,d,k,m)
 *   public/camera-data/cameras-globe.json — minimal [lat,lng,typeIdx] tuples for globe coverage
 *   public/camera-data/meta.json          — source stats + timestamp
 *
 * Modes:
 *   osm (default) — OpenStreetMap surveillance objects via Overpass, manufacturer filtered
 *   trafficvision — Legacy feed mode from trafficvision.live sources
 *   both — Fetch both trafficvision feeds and OSM objects, deduplicated
 *
 * Usage:
 *   node server/collectors/collectCameras.mjs
 *   node server/collectors/collectCameras.mjs --mode=trafficvision --sources=wsdot,511ny
 *   node server/collectors/collectCameras.mjs --mode=both
 *   node server/collectors/collectCameras.mjs --osm-manufacturer="Flock Safety"
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = path.resolve(__dirname, '../../public/camera-data');
const BASE_URL  = 'https://trafficvision.live/camera-data';

// ─── Source manifest (extracted from trafficvision.live main bundle) ──────────
const SOURCES = [
  { name:'NYC DOT',            file:'nycdot-cameras.json',                     source:'nycdot' },
  { name:'511NY',              file:'511ny-cameras.json',                       source:'511ny' },
  { name:'NY Mesonet',         file:'nysmesonet-cameras.json',                  source:'nysmesonet' },
  { name:'WeatherSTEM',        file:'weatherstem-cameras.json',                 source:'weatherstem' },
  { name:'511GA',              file:'511ga-cameras.json',                       source:'511ga' },
  { name:'511ID',              file:'511id-cameras.json',                       source:'511id' },
  { name:'511AZ',              file:'511az-cameras.json',                       source:'511az' },
  { name:'511NE',              file:'511newengland-cameras.json',               source:'511ne' },
  { name:'511PA',              file:'511pa-cameras.json',                       source:'511pa' },
  { name:'511NJ',              file:'511nj-cameras.json',                       source:'511nj' },
  { name:'511FL',              file:'511fl-cameras.json',                       source:'511fl' },
  { name:'TPK Traffic',        file:'tpktraffic-cameras.json',                  source:'tpktraffic' },
  { name:'511IA',              file:'511ia-cameras.json',                       source:'511ia' },
  { name:'511IN',              file:'511in-cameras.json',                       source:'511in' },
  { name:'511SC',              file:'511sc-cameras.json',                       source:'511sc' },
  { name:'511LA',              file:'511la-cameras.json',                       source:'511la' },
  { name:'511MN',              file:'511mn-cameras.json',                       source:'511mn' },
  { name:'511MT',              file:'511mt-cameras.json',                       source:'511mt' },
  { name:'511WI',              file:'511wi-cameras.json',                       source:'511wi' },
  { name:'Alabama DOT',        file:'alabama-cameras.json',                     source:'alabama' },
  { name:'Alaska 511',         file:'alaska-cameras.json',                      source:'alaska' },
  { name:'ARDOT',              file:'ardot-cameras.json',                       source:'ardot' },
  { name:'ALERTCalifornia',    file:'alertcalifornia-cameras.json',             source:'alertcalifornia' },
  { name:'CALTRANS',           file:'caltrans-cameras.json',                    source:'caltrans' },
  { name:'COTRIP',             file:'cotrip-cameras.json',                      source:'cotrip' },
  { name:'CTROADS',            file:'ctroads-cameras.json',                     source:'ctroads' },
  { name:'DELDOT',             file:'deldot-cameras.json',                      source:'deldot' },
  { name:'DRIVENC',            file:'drivenc-cameras.json',                     source:'drivenc' },
  { name:'GOAKAMAI',           file:'goakamai-cameras.json',                    source:'goakamai' },
  { name:'GOKY',               file:'goky-cameras.json',                        source:'goky' },
  { name:'Illinois DOT',       file:'illinois-cameras.json',                    source:'illinois' },
  { name:'KANDRIVE',           file:'kandrive-cameras.json',                    source:'kandrive' },
  { name:'KCSCOUT',            file:'kcscout-cameras.json',                     source:'kcscout' },
  { name:'Maine Turnpike',     file:'maineturnpike-cameras.json',               source:'maineturnpike' },
  { name:'Mass511',            file:'mass511-cameras.json',                     source:'mass511' },
  { name:'MDOT CHART',         file:'mdchart-cameras.json',                     source:'mdchart' },
  { name:'MDOT',               file:'mdot-cameras.json',                        source:'mdot' },
  { name:'MIDRIVE',            file:'midrive-cameras.json',                     source:'midrive' },
  { name:'MODOT',              file:'modot-cameras.json',                       source:'modot' },
  { name:'Nebraska 511',       file:'nebraska511-cameras.json',                 source:'nebraska511' },
  { name:'NDROADS',            file:'ndroads-cameras.json',                     source:'ndroads' },
  { name:'NJTA',               file:'njta-cameras.json',                        source:'njta' },
  { name:'NMROADS',            file:'nmroads-cameras.json',                     source:'nmroads' },
  { name:'NVROADS',            file:'nvroads-cameras.json',                     source:'nvroads' },
  { name:'OHGO',               file:'ohgo-cameras.json',                        source:'ohgo' },
  { name:'OKTRAFFIC',          file:'oktraffic-cameras.json',                   source:'oktraffic',
    url:'https://firebasestorage.googleapis.com/v0/b/trafficvision-60eb1.firebasestorage.app/o/camera-data%2Foktraffic-cameras.json?alt=media' },
  { name:'Oregon DOT',         file:'ordot-cameras.json',                       source:'ordot' },
  { name:'PGCTRIP',            file:'pgctrip-cameras.json',                     source:'pgctrip' },
  { name:'RIDOT StateCams',    file:'ridot-statecams-cameras.json',             source:'ridot' },
  { name:'SD511',              file:'sd511-cameras.json',                       source:'sd511' },
  { name:'SDOT',               file:'sdot-cameras.json',                        source:'sdot' },
  { name:'TDOT',               file:'tdot-cameras.json',                        source:'tdot' },
  { name:'Texas TxDOT',        file:'texas-txdot-drivetexas-cameras.json',      source:'texas' },
  { name:'Austin Mobility',    file:'austin-austinmobility-cameras.json',       source:'austin' },
  { name:'Houston TranStar',   file:'texas-houston-houstontranstar-cameras.json', source:'houstontranstar' },
  { name:'TravelMidwest',      file:'travelmidwest-cameras.json',               source:'travelmidwest' },
  { name:'UDOT',               file:'udot-cameras.json',                        source:'udot' },
  { name:'VDOT',               file:'vdot-cameras.json',                        source:'vdot' },
  { name:'Arlington VA',       file:'arlingtonva-cameras.json',                 source:'arlingtonva' },
  { name:'WSDOT',              file:'wsdot-cameras.json',                       source:'wsdot' },
  { name:'WV511',              file:'wv511-cameras.json',                       source:'wv511' },
  { name:'WYOROAD',            file:'wyoroad-cameras.json',                     source:'wyoroad' },
  { name:'NPS',                file:'nps-cameras.json',                         source:'nps' },
  { name:'Eye-N-Sky',          file:'eyensky-cameras.json',                     source:'eyensky' },
  { name:'ACT-PR',             file:'actpr-cameras.json',                       source:'actpr' },
  { name:'AVO-ASHCAM',         file:'avo-ashcam-cameras.json',                  source:'avo-ashcam' },
  { name:'Borealis Broadband', file:'borealisbroadband-cameras.json',           source:'borealisbroadband' },
  { name:'Instacam',           file:'instacam-cameras.json',                    source:'instacam' },
  { name:'USGS HIVIS',         file:'hivis-cameras.json',                       source:'hivis' },
  { name:'NDAWN',              file:'ndawn-cameras.json',                       source:'ndawn' },
  { name:'NOAA Buoys',         file:'noaabuoys-cameras.json',                   source:'noaabuoys' },
  { name:'511NL',              file:'511nl-cameras.json',                       source:'511nl' },
  { name:'511 Nova Scotia',    file:'511novascotia-cameras.json',               source:'511novascotia' },
  { name:'511ON',              file:'511on-cameras.json',                       source:'511on' },
  { name:'Alberta 511',        file:'alberta-cameras.json',                     source:'alberta' },
  { name:'DriveBC',            file:'DriveBC-cameras.json',                     source:'drivebc' },
  { name:'GTA Update',         file:'gtaupdate-cameras.json',                   source:'gtaupdate' },
  { name:'Highway Hotline',    file:'highwayhotline-cameras.json',              source:'highwayhotline' },
  { name:'Manitoba 511',       file:'manitoba511-cameras.json',                 source:'manitoba511' },
  { name:'NavCanada',          file:'navcanada-cameras.json',                   source:'navcanada' },
  { name:'Nova Scotia Webcams',file:'novascotiawebcams-cameras.json',           source:'novascotiawebcams' },
  { name:'Quebec 511',         file:'quebec511-cameras.json',                   source:'quebec511' },
  { name:'Traffic Ottawa',     file:'trafficottawa-cameras.json',               source:'trafficottawa' },
  { name:'Surrey BC',          file:'surrey-cameras.json',                      source:'surrey' },
  { name:'Richmond BC',        file:'richmondbc-cameras.json',                  source:'richmondbc' },
  { name:'Vancouver',          file:'vancouver-cameras.json',                   source:'vancouver' },
  { name:'511 GNB',            file:'gnb-cameras.json',                         source:'gnb' },
  { name:'York Region',        file:'yorkmaps-cameras.json',                    source:'yorkmaps' },
  { name:'UK Traffic',         file:'trafficcameras-uk-cameras.json',           source:'uk' },
  { name:'TrafficEngland',     file:'trafficengland-cameras.json',              source:'trafficengland' },
  { name:'TrafficWales',       file:'TrafficWales-cameras.json',                source:'trafficwales' },
  { name:'Durham',             file:'DURHAM-cameras.json',                      source:'durham' },
  { name:'CausewayCouncils',   file:'CausewayCouncils-cameras.json',            source:'causewaycouncils' },
  { name:'NETRAVELDATA',       file:'netraveldata-cameras.json',                source:'netraveldata' },
  { name:'TII',                file:'tii-cameras.json',                         source:'tii' },
  { name:'Nottingham Travelwise', file:'travelwise-cameras.json',               source:'travelwise' },
  { name:'TfL JamCams',        file:'tfljamcam-cameras.json',                   source:'tfljamcam' },
  { name:'Argyll and Bute',    file:'argyllbute-cameras.json',                  source:'argyllbute' },
  { name:'ASFINAG',            file:'asfinag-cameras.json',                     source:'asfinag' },
  { name:'Tirol',              file:'tirol-cameras.json',                       source:'tirol' },
  { name:'Autostrade',         file:'autostrade-cameras.json',                  source:'autostrade' },
  { name:'BayernInfo',         file:'bayerninfo-cameras.json',                  source:'bayerninfo' },
  { name:'France ASFA',        file:'france-cameras.json',                      source:'france' },
  { name:'France DIRCE',       file:'france-dirce-cameras.json',                source:'france-dirce' },
  { name:'France Bison Fute',  file:'bisonfute-cameras.json',                   source:'bisonfute' },
  { name:'KOELN.DE',           file:'koeln-cameras.json',                       source:'koeln' },
  { name:'FOTO-WEBCAM',        file:'foto-webcam-cameras.json',                 source:'foto-webcam' },
  { name:'ASTRA Switzerland',  file:'astra-cameras.json',                       source:'astra' },
  { name:'Feldberg-Erlebnis',  file:'feldberg-erlebnis-cameras.json',           source:'feldberg-erlebnis' },
  { name:'Trafikverket',       file:'trafikverket-cameras.json',                source:'trafikverket' },
  { name:'Vegvesen',           file:'vegvesen-cameras.json',                    source:'vegvesen' },
  { name:'Fintraffic',         file:'fintraffic-cameras.json',                  source:'fintraffic' },
  { name:'Liikennetilanne',    file:'liikennetilanne-cameras.json',             source:'liikennetilanne' },
  { name:'DARS.SI',            file:'dars-cameras.json',                        source:'dars' },
  { name:'HAK.HR',             file:'hak-cameras.json',                         source:'hak' },
  { name:'LiveCamCroatia',     file:'livecamcroatia-cameras.json',              source:'livecamcroatia' },
  { name:'Pljusak',            file:'pljusak-cameras.json',                     source:'pljusak' },
  { name:'Utinform',           file:'utinform-cameras.json',                    source:'utinform' },
  { name:'Kozutfigyelo',       file:'kozutfigyelo-cameras.json',                source:'kozutfigyelo' },
  { name:'DGT.ES',             file:'dgtes-cameras.json',                       source:'dgtes' },
  { name:'AVAMET',             file:'avamet-cameras.json',                      source:'avamet' },
  { name:'CITA',               file:'cita-cameras.json',                        source:'cita' },
  { name:'Wallonie',           file:'wallonie-cameras.json',                    source:'wallonie' },
  { name:'Geobilbao',          file:'geobilbao-cameras.json',                   source:'geobilbao' },
  { name:'Trafikoa',           file:'trafikoa-cameras.json',                    source:'trafikoa' },
  { name:'SCT Catalonia',      file:'sct-catalonia-cameras.json',               source:'sct-catalonia' },
  { name:'Vegagerdin',         file:'vegagerdin-cameras.json',                  source:'vegagerdin' },
  { name:'SNERPA',             file:'snerpa-cameras.json',                      source:'snerpa' },
  { name:'NetMadeira',         file:'netmadeira-cameras.json',                  source:'netmadeira' },
  { name:'SPOTAZORES',         file:'spotazores-cameras.json',                  source:'spotazores' },
  { name:'WebcamRomania',      file:'webcamromania-cameras.json',               source:'webcamromania' },
  { name:'DIGI.RO',            file:'digiro-cameras.json',                      source:'digiro' },
  { name:'Eismoinfo',          file:'eismoinfo-cameras.json',                   source:'eismoinfo' },
  { name:'TarkTee',            file:'tarktee-cameras.json',                     source:'tarktee' },
  { name:'KRK.RU',             file:'krk-cameras.json',                         source:'krk' },
  { name:'Astrakhan',          file:'astrakhan-cameras.json',                   source:'astrakhan' },
  { name:'RTA-TELECOM',        file:'rta-telecom-cameras.json',                 source:'rta-telecom' },
  { name:'CITY-N',             file:'cityn-cameras.json',                       source:'cityn' },
  { name:'VEDETTA',            file:'vedetta-cameras.json',                     source:'vedetta' },
  { name:'WEACOM',             file:'weacom-cameras.json',                      source:'weacom' },
  { name:'Tulun-TeleCom',      file:'ttk-tulun-cameras.json',                   source:'ttk-tulun' },
  { name:'Biysk',              file:'biysk-cameras.json',                       source:'biysk' },
  { name:'QLDTRAFFIC',         file:'qldtraffic-cameras.json',                  source:'qldtraffic' },
  { name:'NSWGOV',             file:'nswgov-cameras.json',                      source:'nswgov' },
  { name:'NZTA',               file:'nzta-cameras.json',                        source:'nzta' },
  { name:'JARTIC',             file:'jartic-cameras.json',                      source:'jartic' },
  { name:'Niigata',            file:'niigata-cameras.json',                     source:'niigata' },
  { name:'Fukui-KKR',          file:'fukui-kkr-cameras.json',                   source:'fukui-kkr' },
  { name:'IHIGHWAY',           file:'ihighway-cameras.json',                    source:'ihighway' },
  { name:'YUKINAVI',           file:'yukinavi-cameras.json',                    source:'yukinavi' },
  { name:'ROADNAVI',           file:'roadnavi-cameras.json',                    source:'roadnavi' },
  { name:'Numazu',             file:'numazu-cameras.json',                      source:'numazu' },
  { name:'Shizukawa',          file:'shizukawa-cameras.json',                   source:'shizukawa' },
  { name:'F-ROAD',             file:'froad-cameras.json',                       source:'froad' },
  { name:'ROADINFO',           file:'roadinfo-cameras.json',                    source:'roadinfo' },
  { name:'ROADI',              file:'roadi-cameras.json',                       source:'roadi' },
  { name:'ROAD-INFO-PRVS',     file:'road-info-prvs-cameras.json',              source:'road-info-prvs' },
  { name:'RIVER.GO.JP',        file:'rivergojp-cameras.json',                   source:'rivergojp' },
  { name:'HBC',                file:'hbc-cameras.json',                         source:'hbc' },
  { name:'TOPIS Seoul',        file:'topis-seoul-cameras.json',                 source:'topis-seoul' },
  { name:'GJTIC',              file:'gjtic-cameras.json',                       source:'gjtic' },
  { name:'Geoje',              file:'geoje-cameras.json',                       source:'geoje' },
  { name:'Gimpo',              file:'gimpo-cameras.json',                       source:'gimpo' },
  { name:'Goyang',             file:'goyang-cameras.json',                      source:'goyang' },
  { name:'ROADPLUS',           file:'roadplus-cameras.json',                    source:'roadplus' },
  { name:'SPATIC',             file:'spatic-cameras.json',                      source:'spatic' },
  { name:'KBS',                file:'kbs-cameras.json',                         source:'kbs' },
  { name:'Icheon',             file:'icheon-cameras.json',                      source:'icheon' },
  { name:'Daegu',              file:'daegu-cameras.json',                       source:'daegu' },
  { name:'Suwon',              file:'suwon-cameras.json',                       source:'suwon' },
  { name:'Sejong',             file:'sejong-cameras.json',                      source:'sejong' },
  { name:'Chungju',            file:'chungju-cameras.json',                     source:'chungju' },
  { name:'TWIPCAM',            file:'twipcam-cameras.json',                     source:'twipcam' },
  { name:'FITIC',              file:'fitic-cameras.json',                       source:'fitic' },
  { name:'ITIC',               file:'itic-cameras.json',                        source:'itic' },
  { name:'Nakhon City',        file:'nakhoncity-cameras.json',                  source:'nakhoncity' },
  { name:'Thailand DOH',       file:'thailand-doh-cameras.json',                source:'thailand-doh' },
  { name:'Pattaya',            file:'pattaya-cameras.json',                     source:'pattaya' },
  { name:'Singapore LTA',      file:'singapore-cameras.json',                   source:'singapore' },
  { name:'Selangor JPS',       file:'selangor-cameras.json',                    source:'selangor' },
  { name:'HCMC',               file:'hcmc-cameras.json',                        source:'hcmc' },
  { name:'TTGT',               file:'binhdinh-vietnam-ttgt-cameras.json',       source:'ttgt' },
  { name:'Yogyakarta CCTV',    file:'jogjacctv-cameras.json',                   source:'jogjacctv' },
  { name:'Malang Kota',        file:'malangkota-cameras.json',                  source:'malangkota' },
  { name:'Bandung ATCS',       file:'bandung-cameras.json',                     source:'bandung' },
  { name:'BALIPROV',           file:'baliprov-cameras.json',                    source:'baliprov' },
  { name:'Banjarkota',         file:'banjarkota-cameras.json',                  source:'banjarkota' },
  { name:'MUDIK',              file:'mudik-cameras.json',                       source:'mudik' },
  { name:'Saranganvision',     file:'saranganvision-cameras.json',              source:'saranganvision' },
  { name:'Hong Kong',          file:'hongkong-cameras.json',                    source:'hongkong' },
  { name:'DAER',               file:'daer-cameras.json',                        source:'daer' },
  { name:'Cordoba',            file:'cordoba-cameras.json',                     source:'cordoba' },
  { name:'Santos Mapeada',     file:'santosmapeada-cameras.json',               source:'santosmapeada' },
  { name:'Kenya Aero Club',    file:'kenya-aeroclubea-cameras.json',            source:'kenya-aeroclubea' },
  { name:'YouWebcams',         file:'youwebcams-cameras.json',                  source:'youwebcams' },
  { name:'Webcamera24',        file:'webcamera24-cameras.json',                 source:'webcamera24' },
  { name:'WEBCAMTAXI',         file:'webcamtaxi-cameras.json',                  source:'webcamtaxi' },
  { name:'SKAPING',            file:'skaping-cameras.json',                     source:'skaping' },
  { name:'MYAIRPORTCAMS',      file:'myairportcams-cameras.json',               source:'myairportcams' },
  { name:'COASTALAIRRADAR',    file:'coastalairradar-cameras.json',             source:'coastalairradar' },
  { name:'ServiceSecurity',    file:'servicesecurity-cameras.json',             source:'servicesecurity' },
  { name:'I-TRAFFIC',          file:'itraffic-cameras.json',                    source:'itraffic' },
  { name:'IZUM',               file:'izum-cameras.json',                        source:'izum' },
  { name:'APACE-AI',           file:'apace-ai-cameras.json',                    source:'apace-ai' },
  { name:'Czech Republic SD',  file:'dopravniinfo-cameras.json',                source:'dopravniinfo' },
  { name:'PhenoCam',           file:'phenocam-cameras.json',                    source:'phenocam' },
  { name:'Tabalong',           file:'tabalong-cameras.json',                    source:'tabalong' },
  { name:'Astrainfra',         file:'astrainfra-cameras.json',                  source:'astrainfra' },
  { name:'Misc',               file:'misc-cameras.json',                        source:'misc' },
  { name:'Misc2',              file:'misc2-cameras.json',                       source:'misc2' },
];

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);
const CONCURRENCY   = parseInt(args.concurrency ?? '12');
const SUBSET        = args.sources ? String(args.sources).split(',') : null;
const SKIP_EXISTING = args['skip-existing'] === true;
const MODE          = String(args.mode ?? 'osm').toLowerCase();
const OSM_MANUFACTURER = args['osm-manufacturer'] === true ? 'Flock Safety' : (args['osm-manufacturer'] ? String(args['osm-manufacturer']) : 'Flock Safety');
const OSM_INCLUDE_ALL_SURVEILLANCE = String(args['osm-all'] ?? 'false').toLowerCase() === 'true';

const sources = SUBSET
  ? SOURCES.filter(s => SUBSET.includes(s.source))
  : SOURCES;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pickUrl(cameras) {
  if (!Array.isArray(cameras)) return [];
  return cameras;
}

function parseDirection(value) {
  if (value == null) return null;
  const raw = String(value).trim().toUpperCase();
  if (!raw) return null;
  const compass = {
    N: 0,
    NE: 45,
    E: 90,
    SE: 135,
    S: 180,
    SW: 225,
    W: 270,
    NW: 315,
  };
  if (raw in compass) return compass[raw];
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Normalise a raw camera record to our schema */
function normalise(raw, sourceName) {
  const lat = raw.lat ?? raw.latitude ?? null;
  const lng = raw.lng ?? raw.longitude ?? null;
  if (lat == null || lng == null) return null;

  // Try multiple field names for URLs (trafficvision and others use different schemas)
  const imageUrl = raw.imageUrl ?? raw.image ?? raw.image_url ?? raw.snapshot_url ?? raw.still ?? null;
  const videoUrl = raw.videoUrl ?? raw.video ?? raw.video_url ?? raw.stream_url ?? raw.m3u8 ?? raw.hls ?? null;
  
  if (!imageUrl && !videoUrl) return null;

  return {
    id:       raw.id,
    source:   raw.source || sourceName,
    feedType: raw.feedType || (imageUrl && videoUrl ? 'hybrid' : videoUrl ? 'video' : 'image'),
    lat:      parseFloat(lat),
    lng:      parseFloat(lng),
    imageUrl,
    videoUrl,
    location: raw.location || raw.name || '',
    country:  raw.country  || '',
    state:    raw.state    || '',
    city:     raw.city     || '',
    // Sunders enrichment fields (populated by enrichment process)
    sundersType: raw.sundersType || null,
    sundersOperator: raw.sundersOperator || null,
    sundersDirection: raw.sundersDirection || null,
    sundersHeight: raw.sundersHeight || null,
  };
}

async function fetchSource(s, idx, total) {
  const url = s.url ?? `${BASE_URL}/${s.file}`;
  const label = `[${String(idx+1).padStart(3)}/${total}] ${s.name}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'ShadowGrid-Collector/1.0',
        'Accept': 'application/json,text/plain,*/*',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const bodyText = await res.text();
    if (bodyText.trim().startsWith('<!DOCTYPE') || bodyText.trim().startsWith('<html')) {
      throw new Error('Upstream returned HTML instead of JSON (feed missing, moved, or blocked)');
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      const snippet = bodyText.slice(0, 120).replace(/\s+/g, ' ').trim();
      throw new Error(`Invalid JSON response${contentType ? ` (${contentType})` : ''}${snippet ? `: ${snippet}` : ''}`);
    }

    const raw  = Array.isArray(data) ? data : (data.cameras ?? []);
    const cams = raw.map(c => normalise(c, s.source)).filter(Boolean);
    console.log(`  ✓ ${label}  →  ${cams.length} cameras`);
    return { source: s.source, name: s.name, count: cams.length, cameras: cams };
  } catch (err) {
    console.warn(`  ✗ ${label}  →  ${err.message}`);
    return { source: s.source, name: s.name, count: 0, cameras: [], error: err.message };
  }
}

/** Fetch OSM surveillance objects directly from Overpass (no sunders dependency). */
async function fetchOsmSurveillanceCameras() {
  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];

  const manufacturerNeedle = OSM_MANUFACTURER.trim().toLowerCase();
  const regions = [
    { name: 'USA Northeast', minLat: 40, maxLat: 45, minLng: -74, maxLng: -71 },
    { name: 'USA California', minLat: 37, maxLat: 38, minLng: -122, maxLng: -120 },
    { name: 'USA Texas', minLat: 29, maxLat: 34, minLng: -103, maxLng: -94 },
    { name: 'UK London', minLat: 51.3, maxLat: 51.7, minLng: -0.5, maxLng: 0.2 },
    { name: 'Germany Berlin', minLat: 52.3, maxLat: 52.7, minLng: 13.1, maxLng: 13.8 },
  ];

  const cameras = [];
  const byId = new Set();
  let totalFetched = 0;

  console.log(`\n  Fetching OSM surveillance objects from Overpass...`);
  console.log(`    Manufacturer filter: ${OSM_INCLUDE_ALL_SURVEILLANCE ? 'disabled (--osm-all=true)' : OSM_MANUFACTURER}`);

  for (const region of regions) {
    const q = `[out:json][timeout:60];(node["man_made"="surveillance"](${region.minLat},${region.minLng},${region.maxLat},${region.maxLng});way["man_made"="surveillance"](${region.minLat},${region.minLng},${region.maxLat},${region.maxLng});relation["man_made"="surveillance"](${region.minLat},${region.minLng},${region.maxLat},${region.maxLng}););out center tags;`;

    let data = null;
    let lastError = null;

    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const body = new URLSearchParams({ data: q });
        const res = await fetch(endpoint, {
          method: 'POST',
          body,
          headers: {
            'User-Agent': 'ShadowGrid-Collector/1.0',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json,text/plain,*/*',
          },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!data || !Array.isArray(data.elements)) {
      console.log(`      ${region.name}: ${lastError?.message || 'No Overpass response'}`);
      continue;
    }

    const elements = data.elements;
    totalFetched += elements.length;
    let accepted = 0;

    for (const el of elements) {
      const lat = Number(el.lat ?? el.center?.lat);
      const lng = Number(el.lon ?? el.center?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const tags = el.tags || {};
      const manufacturer = String(tags.manufacturer || '').trim();
      const hasMfgMatch = manufacturerNeedle.length === 0 || manufacturer.toLowerCase().includes(manufacturerNeedle);
      if (!OSM_INCLUDE_ALL_SURVEILLANCE && !hasMfgMatch) continue;

      const osmType = el.type || 'node';
      const osmId = `${osmType}-${el.id}`;
      if (byId.has(osmId)) continue;
      byId.add(osmId);

      const direction = parseDirection(tags['camera:direction'] ?? tags.direction);
      const height = parseNumber(tags.height);
      const angle = parseNumber(tags['camera:angle']);
      const version = parseInt(String(el.version ?? ''), 10);

      cameras.push({
        id: `osm-${osmId}`,
        source: 'osm',
        feedType: 'image',
        lat,
        lng,
        imageUrl: null,
        videoUrl: null,
        location: tags.name || tags.operator || manufacturer || 'OSM Surveillance Camera',
        country: '',
        state: '',
        city: '',
        sundersType: tags['camera:type'] || tags['surveillance:type'] || null,
        sundersOperator: tags.operator || null,
        sundersDirection: Number.isFinite(direction) ? direction : null,
        sundersHeight: Number.isFinite(height) ? height : null,
        sundersManufacturer: manufacturer || null,
        osmType: osmType,
        osmObjectId: String(el.id),
        osmMount: tags['camera:mount'] || null,
        osmSurveillance: tags.surveillance || null,
        osmSurveillanceType: tags['surveillance:type'] || null,
        osmSurveillanceZone: tags['surveillance:zone'] || null,
        osmCameraAngle: Number.isFinite(angle) ? angle : null,
        osmTimestamp: tags.timestamp || null,
        osmVersion: Number.isFinite(version) ? version : null,
        osmManufacturerWikidata: tags['manufacturer:wikidata'] || null,
      });
      accepted++;
    }

    console.log(`      ${region.name}: ${elements.length} fetched, ${accepted} accepted`);
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`    Total fetched: ${totalFetched}, Qualified: ${cameras.length} surveillance cameras`);
  return cameras;
}

/** Run an array of async tasks with max concurrency */
async function pool(tasks, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n ShadowGrid Camera Collector`);
  console.log(`  Mode        : ${MODE}`);
  console.log(`  Sources     : ${sources.length}`);
  console.log(`  Concurrency : ${CONCURRENCY}`);
  console.log(`  Output      : ${OUT_DIR}\n`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let results = [];
  let allCameras = [];

  if (MODE === 'trafficvision') {
    const tasks = sources.map((s, idx) => () => fetchSource(s, idx, sources.length));
    results = await pool(tasks, CONCURRENCY);
    allCameras = results.flatMap(r => r.cameras);
    console.log(`\n  Total cameras: ${allCameras.length}`);
  } else if (MODE === 'both') {
    console.log(`\n  Fetching trafficvision feeds...`);
    const tvTasks = sources.map((s, idx) => () => fetchSource(s, idx, sources.length));
    results = await pool(tvTasks, CONCURRENCY);
    const tvCameras = results.flatMap(r => r.cameras);
    console.log(`  Trafficvision cameras: ${tvCameras.length}`);
    
    const osmCameras = await fetchOsmSurveillanceCameras();
    allCameras = [...tvCameras, ...osmCameras];
    console.log(`\n  Combined (before dedup): ${allCameras.length}`);
  } else {
    allCameras = await fetchOsmSurveillanceCameras();
    console.log(`\n  Total OSM surveillance cameras: ${allCameras.length}`);
  }

  // ── Deduplicate by id ─────────────────────────────────────────────────────
  const seen = new Set();
  const unique = allCameras.filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  console.log(`  Unique cameras: ${unique.length}`);

  // ── Full output ────────────────────────────────────────────────────────────
  const fullPath = path.join(OUT_DIR, 'cameras.json');
  fs.writeFileSync(fullPath, JSON.stringify(unique));
  console.log(`  → ${fullPath}  (${(fs.statSync(fullPath).size / 1024 / 1024).toFixed(1)} MB)`);

  // ── Compact/lite output — only fields needed for tile rendering ────────────
  // Schema: id(i), lat(a), lon(o), imageUrl(u), videoUrl(x), feedType(t), source(s)
  // For hybrid (h): both u and x are populated. For image (i): only u. For video (v): only x.
  // OSM metadata fields: type(y), operator(z), direction(d), height(k), manufacturer(m),
  // mount(r), surveillance(e), surveillance:type(w), zone(j), angle(g), timestamp(n),
  // version(b), manufacturer:wikidata(f), OSM object type(p), OSM id(q).
  const lite = unique.map(c => {
    const feedTypeChar = c.feedType[0];  // 'i'=image, 'v'=video, 'h'=hybrid
    const obj = {
      i: c.id,
      a: +c.lat.toFixed(5),
      o: +c.lng.toFixed(5),
      t: feedTypeChar,
      s: c.source,
    };

    // Populate URLs based on feed type
    if (feedTypeChar === 'h') {
      // Hybrid: store both URLs
      obj.u = c.imageUrl || null;
      obj.x = c.videoUrl || null;
    } else if (feedTypeChar === 'v') {
      // Video only
      obj.x = c.videoUrl || null;
    } else {
      // Image only
      obj.u = c.imageUrl || null;
    }

    // OSM metadata enrichment fields
    if (c.sundersType) obj.y = c.sundersType;                // camera:type from OSM
    if (c.sundersOperator) obj.z = c.sundersOperator;        // operator name
    if (c.sundersDirection != null) obj.d = c.sundersDirection; // direction in degrees
    if (c.sundersHeight != null) obj.k = c.sundersHeight;    // height in meters
    if (c.sundersManufacturer) obj.m = c.sundersManufacturer; // manufacturer (Flock Safety, etc.)
    if (c.osmMount) obj.r = c.osmMount;
    if (c.osmSurveillance) obj.e = c.osmSurveillance;
    if (c.osmSurveillanceType) obj.w = c.osmSurveillanceType;
    if (c.osmSurveillanceZone) obj.j = c.osmSurveillanceZone;
    if (c.osmCameraAngle != null) obj.g = c.osmCameraAngle;
    if (c.osmTimestamp) obj.n = c.osmTimestamp;
    if (c.osmVersion != null) obj.b = c.osmVersion;
    if (c.osmManufacturerWikidata) obj.f = c.osmManufacturerWikidata;
    if (c.osmType) obj.p = c.osmType;
    if (c.osmObjectId) obj.q = c.osmObjectId;

    return obj;
  });
  const litePath = path.join(OUT_DIR, 'cameras-lite.json');
  fs.writeFileSync(litePath, JSON.stringify(lite));
  console.log(`  → ${litePath}  (${(fs.statSync(litePath).size / 1024 / 1024).toFixed(1)} MB)`);

  // ── Globe positions cache — [lat4, lng4, typeIdx] tuples ──────────────────
  // Compact file used for full-globe CCTV coverage visualisation at high altitude.
  // typeIdx: 0=image  1=video  2=hybrid
  // Only changes when the camera list is rebuilt — browser caches it permanently.
  const T_IDX = { i: 0, v: 1, h: 2 };
  const globe = {
    v:  1,
    ts: new Date().toISOString(),
    n:  lite.length,
    d:  lite.map(c => [+c.a.toFixed(4), +c.o.toFixed(4), T_IDX[c.t] ?? 0]),
    // Count cameras with attached OSM metadata tags.
    osmTagged: lite.filter(c => c.y || c.z || c.d || c.k || c.m || c.w || c.e).length,
  };
  const globePath = path.join(OUT_DIR, 'cameras-globe.json');
  fs.writeFileSync(globePath, JSON.stringify(globe));
  console.log(`  → ${globePath}  (${(fs.statSync(globePath).size / 1024 / 1024).toFixed(1)} MB)`);

  // ── Spatial tile index — 5°×5° tiles ──────────────────────────────────────
  const TILE_DEG = 5;
  const tileMap  = new Map();
  for (const c of lite) {
    const tLat = Math.floor(c.a / TILE_DEG) * TILE_DEG;
    const tLng = Math.floor(c.o / TILE_DEG) * TILE_DEG;
    const key  = `${tLat}_${tLng}`;
    if (!tileMap.has(key)) tileMap.set(key, []);
    tileMap.get(key).push(c);
  }
  const tilesDir = path.join(OUT_DIR, 'tiles');
  fs.mkdirSync(tilesDir, { recursive: true });
  for (const [key, cams] of tileMap) {
    fs.writeFileSync(path.join(tilesDir, `${key}.json`), JSON.stringify(cams));
  }
  console.log(`  → ${tilesDir}/  (${tileMap.size} tile files)`);

  // ── Tile manifest ──────────────────────────────────────────────────────────
  const manifest = {
    tileDeg:     TILE_DEG,
    totalCameras: unique.length,
    tiles: [...tileMap.entries()].map(([key, v]) => {
      const [tLat, tLng] = key.split('_').map(Number);
      return { key, lat: tLat, lng: tLng, count: v.length };
    }),
  };
  const manifestPath = path.join(OUT_DIR, 'tiles-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(`  → ${manifestPath}`);

  // ── Source meta ────────────────────────────────────────────────────────────
  const meta = {
    generated:    new Date().toISOString(),
    mode: MODE,
    totalCameras: unique.length,
    sources: (MODE === 'trafficvision' || MODE === 'both')
      ? results.map(({ source, name, count, error }) => ({
          source, name, count, ...(error ? { error } : {}),
        }))
          .concat(MODE === 'both' ? [{ source: 'osm', name: 'OpenStreetMap Overpass' }] : [])
      : [{ source: 'osm', name: 'OpenStreetMap Overpass', count: unique.length }],
  };
  const metaPath = path.join(OUT_DIR, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`  → ${metaPath}`);

  if (MODE === 'trafficvision' || MODE === 'both') {
    const failed = results.filter(r => r.error);
    if (failed.length) {
      console.log(`\n  ⚠  ${failed.length} sources failed:`);
      failed.forEach(r => console.log(`    - ${r.name}: ${r.error}`));
    }
  }

  console.log('\n  Done.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
