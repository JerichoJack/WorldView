# Requires: PowerShell 7+

$baseUrl = "https://s3.opensky-network.org/data-samples/metadata"
$cacheDir = "$PSScriptRoot\cache"
$stateFile = "$cacheDir\state.json"

New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

# -----------------------------
# Load state (incremental mode)
# -----------------------------
if (Test-Path $stateFile) {
    $state = Get-Content $stateFile | ConvertFrom-Json
    $startDate = Get-Date $state.lastProcessed
    $startDate = $startDate.AddMonths(1)
} else {
    $startDate = Get-Date "2019-01-01"
}

$endDate = Get-Date

Write-Host "Processing from $startDate to $endDate"

# -----------------------------
# Generate file list
# -----------------------------
$files = @()

$current = $startDate
while ($current -le $endDate) {
    $ym = $current.ToString("yyyy-MM")

    $files += [PSCustomObject]@{
        Name = "aircraftDatabase-$ym.csv"
        Date = $current
    }

    $files += [PSCustomObject]@{
        Name = "aircraft-database-complete-$ym.csv"
        Date = $current
    }

    $current = $current.AddMonths(1)
}

# -----------------------------
# Shared dedup map (thread-safe)
# -----------------------------
$aircraftMap = [System.Collections.Concurrent.ConcurrentDictionary[string, object]]::new()

# -----------------------------
# Parallel processing
# -----------------------------
$files | ForEach-Object -Parallel {

    param($baseUrl, $cacheDir, $aircraftMap)

    $file = $_.Name
    $fileDate = $_.Date
    $url = "$baseUrl/$file"
    $localPath = Join-Path $cacheDir $file

    # Skip if already downloaded
    if (!(Test-Path $localPath)) {
        try {
            Write-Host "Downloading $file"
            Invoke-WebRequest -Uri $url -OutFile $localPath -ErrorAction Stop
        } catch {
            return
        }
    } else {
        Write-Host "Cached: $file"
    }

    try {
        # Stream read file
        $reader = [System.IO.StreamReader]::new($localPath)

        # Read header
        $headerLine = $reader.ReadLine()
        if (-not $headerLine) { return }

        $headers = $headerLine -replace "'" -split ","

        while (!$reader.EndOfStream) {
            $line = $reader.ReadLine()
            if (-not $line) { continue }

            $values = ($line -replace "'") -split ","

            if ($values.Count -ne $headers.Count) { continue }

            $row = @{}
            for ($i = 0; $i -lt $headers.Count; $i++) {
                $row[$headers[$i]] = $values[$i]
            }

            $icao = $row["icao24"]
            if ([string]::IsNullOrWhiteSpace($icao)) { continue }

            $newEntry = [PSCustomObject]($row + @{ __date = $fileDate })

            $aircraftMap.AddOrUpdate(
                $icao,
                $newEntry,
                { param($key, $existing)
                    if ($fileDate -gt $existing.__date) {
                        return $newEntry
                    } else {
                        return $existing
                    }
                }
            ) | Out-Null
        }

        $reader.Close()

    } catch {
        Write-Host "Error processing $file"
    }

} -ArgumentList $baseUrl, $cacheDir, $aircraftMap -ThrottleLimit 6

# -----------------------------
# Export result
# -----------------------------
Write-Host "Final aircraft count: $($aircraftMap.Count)"

$result = $aircraftMap.Values | ForEach-Object {
    $_.PSObject.Properties.Remove("__date")
    $_
}

$outputFile = "$PSScriptRoot\aircraftDatabase-New.csv"
$result | Export-Csv -Path $outputFile -NoTypeInformation

# -----------------------------
# Save state
# -----------------------------
$newState = @{
    lastProcessed = $endDate.ToString("yyyy-MM-dd")
}
$newState | ConvertTo-Json | Set-Content $stateFile

Write-Host "Done! Output saved to $outputFile"