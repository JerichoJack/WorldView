/**
 * archive/collector.js
 * Phase 7 — Node.js cron job that polls all live APIs and stores
 * timestamped snapshots for the 4D timeline replay feature.
 *
 * Run with:  node src/archive/collector.js
 * Or via:    npm run archive
 */

import fs   from 'fs';
import path from 'path';

const ARCHIVE_DIR  = './data/archive';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

async function snapshot() {
  const ts    = new Date().toISOString().replace(/[:.]/g, '-');
  const frame = { timestamp: new Date().toISOString() };

  // ── Flights ─────────────────────────────────────────────────────────────
  try {
    const resp    = await fetch('https://opensky-network.org/api/states/all');
    const data    = await resp.json();
    frame.flights = (data.states ?? []).map(s => ({
      icao:     s[0], callsign: s[1],
      lon: s[5], lat: s[6], alt: s[7],
      heading: s[10], velocity: s[9],
    }));
  } catch (e) {
    console.warn('[Collector] Flights failed:', e.message);
    frame.flights = [];
  }

  // ── Write to disk ────────────────────────────────────────────────────────
  const file = path.join(ARCHIVE_DIR, `${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(frame, null, 2));
  console.log(`[Collector] Snapshot saved: ${file} (${frame.flights.length} aircraft)`);
}

// Run once immediately, then on interval
snapshot();
setInterval(snapshot, POLL_INTERVAL_MS);
