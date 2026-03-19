// This script appends or updates aircraft info in aircraftDatabase.csv
// Usage: Call from server or via an API endpoint when new HUD info is available

import fs from 'fs';
import path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { stringify as csvStringify } from 'csv-stringify/sync';

const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../public/aircraft-database-files/aircraftDatabase.csv');

/**
 * Upsert an aircraft record in the CSV database.
 * @param {Object} info - { icao24, registration, typecode, manufacturer, model, operator, country }
 */
export function upsertAircraftRecord(info) {
  if (!info.icao24) throw new Error('icao24 is required');
  let rows = [];
  let headers = ['icao24','registration','typecode','manufacturer','model','operator','country'];
  if (fs.existsSync(DB_PATH)) {
    const csv = fs.readFileSync(DB_PATH, 'utf8');
    rows = csvParse(csv, { columns: true, skip_empty_lines: true });
    if (rows.length && Object.keys(rows[0]).length > headers.length) {
      headers = Object.keys(rows[0]);
    }
  }
  // Remove any existing row for this icao24
  rows = rows.filter(r => (r.icao24 || r.ICAO24 || '').toLowerCase() !== info.icao24.toLowerCase());
  // Add new/updated row
  const newRow = {};
  for (const h of headers) newRow[h] = info[h] || '';
  rows.push(newRow);
  // Write back to CSV
  const csvOut = csvStringify(rows, { header: true, columns: headers });
  fs.writeFileSync(DB_PATH, csvOut, 'utf8');
}
