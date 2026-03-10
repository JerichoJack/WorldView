import { CITIES, flyTo } from '../core/camera.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export function initCitySearch(viewer) {
  const input = document.getElementById('city-search');
  const btn = document.getElementById('city-search-btn');
  const status = document.getElementById('city-search-status');

  if (!input || !btn || !status) return;

  async function runSearch() {
    const q = input.value.trim();
    if (!q) {
      setStatus(status, 'Type a place', true);
      return;
    }

    const preset = findPresetCity(q);
    if (preset) {
      flyTo(viewer, { ...preset, pitch: -45 });
      setStatus(status, 'Preset city');
      return;
    }

    setStatus(status, 'Searching...');

    try {
      const params = new URLSearchParams({
        q,
        format: 'jsonv2',
        limit: '8',
        addressdetails: '1',
        dedupe: '1',
      });

      const resp = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (!resp.ok) {
        throw new Error(`Nominatim ${resp.status}`);
      }

      const results = await resp.json();
      const best = pickBestResult(Array.isArray(results) ? results : [], q);
      if (!best) {
        setStatus(status, 'Not found', true);
        return;
      }

      const lat = Number(best.lat);
      const lon = Number(best.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        setStatus(status, 'Bad result', true);
        return;
      }

      flyTo(viewer, {
        lon,
        lat,
        alt: 70000,
        pitch: -55,
      });

      setStatus(status, 'Found');
    } catch (err) {
      console.warn('[CitySearch] search failed:', err.message);
      setStatus(status, 'Search failed', true);
    }
  }

  btn.addEventListener('click', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });
}

function pickBestResult(results, query) {
  if (!results.length) return null;

  const { place, region } = splitQuery(query);
  const placeNeedle = normalize(place);
  const regionNeedle = normalize(region);

  let best = null;
  let bestScore = -Infinity;

  for (const r of results) {
    const score = scoreResult(r, placeNeedle, regionNeedle);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  return best;
}

function scoreResult(r, placeNeedle, regionNeedle) {
  const type = String(r?.type ?? '').toLowerCase();
  const cls = String(r?.class ?? '').toLowerCase();
  const display = normalize(String(r?.display_name ?? ''));
  const addr = r?.address ?? {};

  const cityLike = normalize(
    String(addr.city ?? addr.town ?? addr.village ?? addr.hamlet ?? addr.municipality ?? '')
  );
  const regionLike = normalize(String(addr.state ?? addr.region ?? ''));

  let score = 0;

  const typeWeight = {
    city: 120,
    town: 110,
    village: 95,
    hamlet: 80,
    suburb: 55,
    county: 15,
    administrative: 10,
  };

  score += typeWeight[type] ?? 40;
  if (cls === 'place') score += 25;
  if (cls === 'boundary') score -= 10;

  if (placeNeedle) {
    if (cityLike === placeNeedle) score += 120;
    else if (cityLike.includes(placeNeedle)) score += 60;

    if (display.includes(placeNeedle)) score += 30;
  }

  if (regionNeedle) {
    if (regionLike.includes(regionNeedle)) score += 35;
    else if (display.includes(regionNeedle)) score += 20;
  }

  return score;
}

function splitQuery(q) {
  const parts = String(q).split(',').map(s => s.trim()).filter(Boolean);
  return {
    place: parts[0] ?? q,
    region: parts[1] ?? '',
  };
}

function normalize(v) {
  return String(v).toLowerCase().replace(/\s+/g, ' ').trim();
}

function findPresetCity(raw) {
  const q = raw.toLowerCase().trim();
  if (!q) return null;

  const aliases = {
    'new york': 'nyc',
    'new york city': 'nyc',
    ny: 'nyc',
    'nyc': 'nyc',
    'global': 'globe',
    'world': 'globe',
  };

  const key = aliases[q] ?? q;
  return CITIES[key] ?? null;
}

function setStatus(node, text, isError = false) {
  node.textContent = text;
  node.style.color = isError ? '#ff6666' : '';

  window.clearTimeout(node._wvTimer);
  node._wvTimer = window.setTimeout(() => {
    node.textContent = '';
    node.style.color = '';
  }, 2500);
}
