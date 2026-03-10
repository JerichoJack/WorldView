# 🌍 WorldView

A browser-based geospatial intelligence platform that lets you observe any place on Earth through the lens of a surveillance analyst — night vision, FLIR thermal, CRT scan lines, live air traffic with detailed aircraft silhouettes, and real satellite orbits draped directly onto a photorealistic 3D globe.

All of it running in a browser tab. No classified clearances required.

---

## ✨ Features

- **Photorealistic 3D Globe** — powered by your choice of Google 3D Tiles, Cesium ion (terrain + OSM buildings + Bing satellite), or MapTiler (switchable via a single env variable)
- **Live Air Traffic** — viewport-aware aircraft from your chosen flight data provider, polled every 10s; aircraft rendered as distinct top-down silhouettes (heavy, widebody, jet, turboprop, helicopter, light) color-coded by classification (commercial/military/other)
- **Military Flight Detection** — classifies aircraft using ADS-B `dbFlags`, known military ICAO hex ranges, and callsign pattern matching
- **Satellite Orbital Tracking** — 200 satellites rendered on actual orbital paths using real TLE data via SGP4 propagation; click any to inspect
- **Visual Shader Modes** — NVG (night vision), FLIR thermal, CRT scan lines, and anime cel-shading via WebGL post-process stages
- **IP Geolocation Startup** — camera opens at your approximate location on launch (falls back to configurable env defaults)
- **Tactical HUD** — corner brackets, UTC clock, live entity counter, coordinate readout, and layer/shader controls
- **Street-Level Traffic** — vehicle flow particle system *(Phase 5 — stub, not yet implemented)*
- **CCTV Integration** — public camera feeds projected onto 3D buildings *(Phase 6 — stub, not yet implemented)*
- **4D Timeline / Replay** — scrub through archived snapshots of all data layers *(Phase 7 — stub, not yet implemented)*

---

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| 3D Globe & Rendering | [CesiumJS](https://cesium.com/platform/cesiumjs/) |
| Photorealistic City Models | Google Photorealistic 3D Tiles / Cesium ion / MapTiler *(switchable)* |
| Visual Shaders | WebGL `PostProcessStage` (inline GLSL) + CSS overlays |
| Live Flight Data | airplanes.live / adsb.lol / OpenSky Network *(switchable)* |
| Flight Data Proxy | Node.js HTTP server (`server/proxy.mjs`) — viewport-aware hub fetching from `opendata.adsb.fi` |
| Aircraft Classification | ADS-B `dbFlags` + ICAO hex ranges + callsign pattern matching |
| Satellite Orbital Math | [satellite.js](https://github.com/shashwatak/satellite-js) (SGP4 propagation) |
| Satellite TLE Data | CelesTrak / Space-Track / N2YO *(switchable)* |
| IP Geolocation | ipapi.co (free, no key) |
| Build Tool | [Vite](https://vitejs.dev/) with `vite-plugin-static-copy` |

---

## 🗺️ Map Provider Options

Set `VITE_MAP_PROVIDER` in your `.env` to switch instantly — no code changes required.

| Provider | Visual Quality | Cost | Credit Card? | Notes |
|---|---|---|---|---|
| `cesium` | ⭐⭐ Terrain + Bing satellite + OSM buildings | 100% free | ❌ No | **Recommended default** |
| `google` | ⭐⭐⭐ Photogrammetric city models | Free tier ($200/mo credit) | ✅ Required | Best possible visuals; falls back to `cesium` if key is missing |
| `maptiler` | ⭐⭐ Quantized-mesh terrain + satellite | 100% free tier | ❌ No | Falls back to `cesium` if key is missing |

> **Note:** Setting a Cesium ion token is recommended for all setups — it unlocks Bing satellite imagery and suppresses CesiumJS console warnings, even when using Google or MapTiler as the primary provider.

---

## ✈️ Flight Data Provider Options

Set `VITE_FLIGHT_PROVIDER` in your `.env` to switch.

| Provider | Coverage | Cost | Account / Key? | Notes |
|---|---|---|---|---|
| `airplaneslive` | Global, unfiltered ADS-B + MLAT | Free | ❌ None required | **Recommended default**; no rate limit for reasonable use |
| `adsbool` | Global, unfiltered | Free | ❌ None required | ADS-B Exchange drop-in replacement; includes military and untracked flights; ODbL licensed |
| `opensky` | Global, ~10k aircraft | Free (non-commercial) | ✅ OAuth2 client credentials | 4,000 credits/day authenticated; see setup below |
| *(default)* `proxy` | Viewport-aware global | Free | ❌ None required | Uses `server/proxy.mjs` — fetches from `opendata.adsb.fi` hub grid; best for local dev |

> **Proxy server:** The `proxy` provider (default when `VITE_FLIGHT_PROVIDER` is not set) requires the Node.js proxy to be running separately. See [Running the Proxy](#running-the-proxy) below.

---

## 🛰️ Satellite TLE Provider Options

Set `VITE_SATELLITE_PROVIDER` in your `.env` to switch.

| Provider | Objects | Cost | Account / Key? | Notes |
|---|---|---|---|---|
| `celestrak` | 20,000+ | Free | ❌ None required | **Recommended default**; uses GP TLE endpoint; transitioning to OMM format for catalog numbers > 69,999 (~July 2026) |
| `spacetrack` | Full catalog | Free | ✅ Free account (login) | Authoritative US Space Force data (18th Space Defense Squadron) |
| `n2yo` | Targeted queries | Free tier (1k req/hr) | ✅ Free API key | Better for per-satellite lookups |

---

## 🔑 API Keys Setup

### 🌍 Map Providers

**Cesium ion** *(recommended for all setups)*

1. Create a free account at [ion.cesium.com](https://ion.cesium.com)
2. Go to **Access Tokens → Create token** (default scopes are fine)
3. Paste into `VITE_CESIUM_ION_TOKEN`

**Google Maps** *(only for `VITE_MAP_PROVIDER=google`)*

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create or select a project
2. Enable the [Map Tiles API](https://console.cloud.google.com/apis/library/tile.googleapis.com)
3. Go to **Credentials → Create API Key**, then restrict it to "Map Tiles API"
4. Enable billing — the $200/mo free credit covers typical development usage
5. Paste into `VITE_GOOGLE_MAPS_API_KEY`

**MapTiler** *(only for `VITE_MAP_PROVIDER=maptiler`)*

1. Create a free account at [cloud.maptiler.com](https://cloud.maptiler.com)
2. Go to **Account → API Keys** and copy your default key
3. Paste into `VITE_MAPTILER_API_KEY`

---

### ✈️ Flight Data Providers

**airplanes.live** and **adsb.lol** — no setup required. Just set `VITE_FLIGHT_PROVIDER=airplaneslive` or `adsbool` and go.

**OpenSky Network** *(for `VITE_FLIGHT_PROVIDER=opensky`)*

> ⚠️ OpenSky migrated to **OAuth2 in March 2025**. The old username/password method no longer works. You now need API client credentials.

1. Create a free account at [opensky-network.org](https://opensky-network.org)
2. Go to your **Account page → "API Client" section**
3. Click **Create API Client** — a `credentials.json` file will download
4. Open it and copy `client_id` → `VITE_OPENSKY_CLIENT_ID`
5. Copy `client_secret` → `VITE_OPENSKY_CLIENT_SECRET`

Rate limits: 4,000 credits/day authenticated; anonymous access is heavily throttled.

---

### 🛰️ Satellite TLE Providers

**CelesTrak** — no setup required. Set `VITE_SATELLITE_PROVIDER=celestrak` and go.

**Space-Track** *(for `VITE_SATELLITE_PROVIDER=spacetrack`)*

1. Register for a free account at [space-track.org](https://www.space-track.org)
2. Add your credentials to `VITE_SPACETRACK_USERNAME` and `VITE_SPACETRACK_PASSWORD`

**N2YO** *(for `VITE_SATELLITE_PROVIDER=n2yo`)*

1. Request a free API key at [n2yo.com/api](https://www.n2yo.com/api/)
2. Paste into `VITE_N2YO_API_KEY`
3. Free tier: 1,000 requests/hour

---

## 🚀 Getting Started

### Prerequisites

- Node.js v18+
- At minimum, a **free Cesium ion token** is recommended (no credit card required)

### Installation

```bash
git clone https://github.com/JerichoJack/WorldView.git
cd WorldView
npm install
```

### Minimum viable setup (fully free, zero cost, no credit card)

```bash
cp .env.example .env
```

Then edit `.env` and set:

```env
VITE_MAP_PROVIDER=cesium
VITE_CESIUM_ION_TOKEN=your_cesium_ion_token_here

VITE_FLIGHT_PROVIDER=airplaneslive

VITE_SATELLITE_PROVIDER=celestrak
```

### Run locally

```bash
npm start
```

Open [http://localhost:5173](http://localhost:5173)

---

### Running the Proxy

If `VITE_FLIGHT_PROVIDER` is unset (or set to `proxy`), the app fetches flight data through a local Node.js proxy server. 

The proxy runs on port `3001` and handles viewport-aware hub fetching from `opendata.adsb.fi`, with per-hub caching (12s TTL) and a stale aircraft cleanup (2 min). It is not required if you use the `airplaneslive`, `adsbool`, or `opensky` providers directly.

---

## 📁 Project Structure

```
WorldView/
├── server/
│   └── proxy.mjs             # Node.js flight data proxy (viewport-aware hub fetching)
├── src/
│   ├── main.js               # Boot sequence — wires globe, layers, and UI
│   ├── core/
│   │   ├── globe.js          # CesiumJS viewer + map provider switcher
│   │   └── camera.js         # IP geolocation startup + fly-to navigation
│   ├── layers/
│   │   ├── flights.js        # Flight provider switcher + aircraft silhouette rendering
│   │   ├── satellites.js     # Satellite provider switcher + SGP4 orbital propagation
│   │   ├── traffic.js        # OSM road network + particle system (Phase 5 — stub)
│   │   └── cctv.js           # CCTV feeds projected onto buildings (Phase 6 — stub)
│   ├── ui/
│   │   ├── HUD.js            # Coordinate readout + click-to-inspect panel
│   │   ├── Controls.js       # Layer toggles + shader mode buttons + GLSL shaders
│   │   └── clock.js          # UTC clock
│   └── archive/
│       └── collector.js      # Node.js cron: polls APIs, writes snapshots (Phase 7 — stub)
├── public/
│   └── favicon.svg
├── index.html                # App shell + HUD markup + CSS (self-contained)
├── .env.example
├── vite.config.js
└── README.md
```

---

## 🗺️ Build Roadmap

- ✅ Phase 1 — CesiumJS globe with switchable map provider (Google / Cesium ion / MapTiler)
- ✅ Phase 1 — Switchable flight data providers (airplanes.live / adsb.lol / OpenSky / local proxy)
- ✅ Phase 1 — Switchable satellite TLE providers (CelesTrak / Space-Track / N2YO)
- ✅ Phase 2 — Aircraft silhouette rendering (7 distinct shapes by type code + ADS-B category)
- ✅ Phase 2 — Military/commercial/other classification with color coding
- ✅ Phase 3 — Satellite orbital tracking with SGP4 propagation + click-to-inspect
- ⬜ Phase 4 — Visual shaders (NVG, FLIR, CRT, Anime) via WebGL PostProcessStage + CSS overlays
- ⬜ Phase 5 — Street traffic particle system (OSM)
- ⬜ Phase 6 — CCTV feed projection onto 3D buildings
- ⬜ Phase 7 — 4D timeline + data archival / replay

---

## 🎨 Shader Modes

| Mode | Description |
|---|---|
| **Normal** | Default photorealistic view |
| **NVG** | Green-channel night vision with noise grain and vignette (WebGL + CSS radial overlay) |
| **FLIR** | Thermal false-color (iron palette) simulating infrared sensors |
| **CRT** | Retro scanline overlay with barrel distortion and phosphor bloom |
| **Anime** | Cel-shading via Sobel edge detection + quantized color bands |

---

## ✈️ Aircraft Rendering Detail

Aircraft are rendered as distinct top-down silhouettes using inline SVG icons, chosen by type in this priority order:

1. **ICAO type code** (`t` field from ADS-B data) — e.g. `B738`, `A320`, `H60`
2. **ADS-B category byte** — fallback when type code is absent
3. **Altitude proxy** — last resort for completely unidentified aircraft

Classification (commercial / military / other) uses:

1. `dbFlags` bit 0 from ADS-B database (most reliable)
2. Known military ICAO hex ranges (US, UK, France, Russia, China, and others)
3. Callsign pattern matching against known airline and military prefixes

---

## 💡 Inspiration

This project is a direct replication and exploration of [Bilawal Sidhu's WorldView](https://www.spatialintelligence.ai/p/i-built-a-spy-satellite-simulator) — a "spy satellite simulator in a browser" that fuses open-source intelligence feeds onto a photorealistic 3D globe. Bilawal's original repo has not been made public; this is my attempt to reverse-engineer and build the same system from the ground up using the same publicly documented tools and data sources.

The core thesis: the data was never the moat. Surveillance-grade views of the world are built entirely from open, public feeds. WorldView makes that visible.

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 🙏 Credits

- [Bilawal Sidhu](https://www.spatialintelligence.ai) — original WorldView concept and thesis
- [CesiumJS](https://cesium.com) — open-source 3D geospatial engine
- [Google Maps Platform](https://developers.google.com/maps) — Photorealistic 3D Tiles
- [Cesium ion](https://ion.cesium.com) — hosted terrain, imagery, and OSM buildings
- [MapTiler](https://www.maptiler.com) — terrain and satellite tile services
- [airplanes.live](https://airplanes.live) — free community ADS-B + MLAT flight data
- [adsb.lol](https://adsb.lol) — free open ADS-B flight data (ODbL)
- [OpenSky Network](https://opensky-network.org) — open flight data research network
- [CelesTrak](https://celestrak.org) — free satellite TLE data
- [Space-Track.org](https://space-track.org) — US Space Force satellite catalog
- [N2YO](https://n2yo.com) — satellite tracking API
- [satellite.js](https://github.com/shashwatak/satellite-js) — SGP4 orbital propagation
- [ipapi.co](https://ipapi.co) — IP geolocation for startup camera placement
