#!/usr/bin/env python3
import csv
import requests
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from tqdm import tqdm
import argparse
import csv
import sys

# Increase CSV field size limit to handle huge notes fields
max_size = sys.maxsize
csv.field_size_limit(max_size)

# ----------------------------
# CLI arguments
# ----------------------------
parser = argparse.ArgumentParser(description="Build Aircraft Database")
parser.add_argument("--output", "-o", default="aircraftDatabase-New.csv", help="Output CSV file")
parser.add_argument("--incremental", "-i", action="store_true", help="Only process new months")
parser.add_argument("--workers", "-w", type=int, default=8, help="Number of parallel downloads")
parser.add_argument("--start", type=str, help="Start date (YYYY-MM-DD)")
parser.add_argument("--end", type=str, help="End date (YYYY-MM-DD)")
args = parser.parse_args()

# ----------------------------
# Config
# ----------------------------
BUCKET_URL = "https://s3.opensky-network.org/data-samples/metadata/"
FIELDNAMES = [
    'icao24','registration','manufacturericao','manufacturername','model','typecode',
    'serialnumber','linenumber','icaoaircrafttype','operator','operatorcallsign',
    'operatoricao','operatoriata','owner','testreg','registered','reguntil',
    'status','built','firstflightdate','seatconfiguration','engines','modes',
    'adsb','acars','notes','categoryDescription', 'firstseen', 'lastseen'
]

# ----------------------------
# Directories
# ----------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
DOWNLOAD_DIR = REPO_ROOT / "public" / "aircraft-database-files"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ----------------------------
# Helpers
# ----------------------------
def month_range(start, end):
    current = start.replace(day=1)
    while current <= end:
        yield current
        current = (current.replace(day=28) + timedelta(days=4)).replace(day=1)

def generate_file_list(start, end):
    """Generate expected CSV filenames per month"""
    files = ["aircraftDatabase.csv"]
    for current in month_range(start, end):
        ym = current.strftime("%Y-%m")
        files.append(f"aircraftDatabase-{ym}.csv")
        files.append(f"aircraft-database-complete-{ym}.csv")
    return files

def download_csv(filename):
    """Download CSV file if missing"""
    url = f"{BUCKET_URL}{filename}"
    local_file = DOWNLOAD_DIR / filename
    if local_file.exists():
        return local_file  # skip already-downloaded
    try:
        r = requests.get(url, stream=True)
        r.raise_for_status()
        with open(local_file, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        return local_file
    except requests.HTTPError:
        print(f"Warning: Could not fetch {url}")
        return None

def process_csv(file_path):
    """Read a CSV file robustly, handle large fields and encoding"""
    if not file_path or not file_path.exists():
        return []
    csv.field_size_limit(sys.maxsize)
    rows = []
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            reader = csv.DictReader(f)
            for row in reader:
                # ensure all fields exist
                cleaned = {k: row.get(k, "") for k in FIELDNAMES}
                rows.append(cleaned)
    except Exception as e:
        print(f"Warning: Could not process {file_path}: {e}")
    return rows

# ----------------------------
# Main
# ----------------------------
start_date = datetime.strptime(args.start, "%Y-%m-%d") if args.start else datetime(2019, 1, 1)
end_date = datetime.strptime(args.end, "%Y-%m-%d") if args.end else datetime.now()

all_aircraft = {}
stats = {"processed_files": 0, "new_aircraft": 0, "duplicates": 0}

files = generate_file_list(start_date, end_date)
print(f"Processing {len(files)} files ({start_date.date()} -> {end_date.date()})...")

with ThreadPoolExecutor(max_workers=args.workers) as executor:
    future_to_file = {executor.submit(download_csv, f): f for f in files}
    downloaded_files = []
    for future in tqdm(as_completed(future_to_file), total=len(future_to_file), desc="Downloading"):
        f = future_to_file[future]
        result = future.result()
        if result:
            downloaded_files.append(result)
        stats["processed_files"] += 1

# ----------------------------
# Read & merge CSVs
# ----------------------------
for f in tqdm(downloaded_files, desc="Merging"):
    rows = process_csv(f)
    for ac in rows:
        key = ac["icao24"]
        if key in all_aircraft:
            stats["duplicates"] += 1
            # merge lastseen if newer
            try:
                all_aircraft[key]['lastseen'] = max(all_aircraft[key]['lastseen'], ac['lastseen'])
            except Exception:
                pass
        else:
            stats["new_aircraft"] += 1
            all_aircraft[key] = ac

# ----------------------------
# Write final CSV
# ----------------------------

print("Writing output...")
# Write to the main output location
with open(args.output, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
    writer.writeheader()
    for v in all_aircraft.values():
        writer.writerow(v)

# Also write to public/aircraft-database-files
public_output = DOWNLOAD_DIR / args.output
with open(public_output, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
    writer.writeheader()
    for v in all_aircraft.values():
        writer.writerow(v)

# ----------------------------
# Summary
# ----------------------------
print("Done!")
print(f"Total files processed: {stats['processed_files']}")
print(f"New aircraft added: {stats['new_aircraft']}")
print(f"Duplicates skipped/merged: {stats['duplicates']}")
print(f"Output saved to {args.output}")
print(f"Raw files downloaded to {DOWNLOAD_DIR}")