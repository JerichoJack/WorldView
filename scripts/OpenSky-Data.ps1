# ===== CONFIG =====
$statesUrl = "https://opensky-network.org/api/states/all"
$aircraftDbFile = "scripts\aircraft-database-complete-2025-08.csv"

# Output file
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$outputFile = "opensky_states_enriched_$timestamp.json"

# ===== LOAD AIRCRAFT DATABASE =====
Write-Host "Loading aircraft database..."

$aircraftDb = @{}

# Import CSV and remove quotes from headers
$csvText = Get-Content $aircraftDbFile -Raw
$csvText = $csvText -replace "'([^']*)'", '$1'   # Remove single quotes from headers
$csvRows = $csvText | ConvertFrom-Csv

foreach ($row in $csvRows) {
    if ($row.icao24 -and $row.icao24.Trim() -ne "") {
        $icao = $row.icao24.Trim().ToLower()
        $type = $row.typecode
        $categoryDesc = $row.categoryDescription

        $aircraftDb[$icao] = [PSCustomObject]@{
            typecode      = $type
            category_desc = $categoryDesc
        }
    }
}

Write-Host "Loaded $($aircraftDb.Count) aircraft records."

# ===== FETCH OPENSKY DATA =====
try {
    Write-Host "Requesting OpenSky state data..."

    $response = Invoke-RestMethod -Uri $statesUrl -Method Get

    $mappedStates = @()

    foreach ($state in $response.states) {
        $icao24 = ($state[0] -as [string]).ToLower()

        # Lookup type from local DB
        $aircraftInfo = $aircraftDb[$icao24]

        $mappedStates += [PSCustomObject]@{
            icao24           = $icao24
            callsign         = ($state[1] -as [string]).Trim()
            origin_country   = $state[2]
            time_position    = $state[3]
            last_contact     = $state[4]
            longitude        = $state[5]
            latitude         = $state[6]
            baro_altitude    = $state[7]
            on_ground        = $state[8]
            velocity         = $state[9]
            true_track       = $state[10]
            vertical_rate    = $state[11]
            sensors          = $state[12]
            geo_altitude     = $state[13]
            squawk           = $state[14]
            spi              = $state[15]
            position_source  = $state[16]
            category         = $state[17]

            # ✅ Enriched fields from CSV
            icao_type_code   = if ($aircraftInfo) { $aircraftInfo.typecode } else { $null }
            category_desc    = if ($aircraftInfo) { $aircraftInfo.category_desc } else { $null }
        }
    }

    # Wrap output
    $output = [PSCustomObject]@{
        time   = $response.time
        states = $mappedStates
    }

    # Save JSON
    $output | ConvertTo-Json -Depth 10 | Out-File -FilePath $outputFile -Encoding utf8

    Write-Host "Enriched data saved to $outputFile"
}
catch {
    Write-Host "Error occurred:"
    Write-Host $_
}