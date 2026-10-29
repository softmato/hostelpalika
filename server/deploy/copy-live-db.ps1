# Copies the live Atlas database into the local Mongo container
# (compose.local.yaml) as `hostelpalika_dev`. Go has no seeds: local data is
# real data, and everything the Go server writes stays local.
#
#   pwsh server/deploy/copy-live-db.ps1
#
# Atlas is only read (mongodump). The URI comes from the repo-root .env and is
# never printed. The dump holds personal data, so the archive is deleted as
# soon as it is restored. Re-run any time for a fresh copy; it replaces the
# local database wholesale (--drop).
$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$target = "mongodb://127.0.0.1:27018/?directConnection=true"
$targetDb = "hostelpalika_dev"

$line = Get-Content (Join-Path $root ".env") | Where-Object { $_ -match '^\s*(MONGODB_URI|DATABASE_URL)\s*=' } | Select-Object -First 1
if (-not $line) { throw "MONGODB_URI not found in the repo-root .env" }
$source = ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")

# mongoose uses the database named in the URI path; "test" when there is none.
$sourceDb = if ($source -match '^mongodb(\+srv)?://[^/]+/([^?]+)') { $Matches[2] } else { "test" }

$tools = @(Get-Command mongodump -ErrorAction SilentlyContinue | ForEach-Object { Split-Path $_.Source }) +
         @(Get-ChildItem "C:\Program Files\MongoDB\Tools\*\bin" -ErrorAction SilentlyContinue | ForEach-Object FullName) |
         Select-Object -First 1
if (-not $tools) { throw "MongoDB Database Tools not found: winget install MongoDB.DatabaseTools" }

$archive = Join-Path ([IO.Path]::GetTempPath()) "hostelpalika-live-$([guid]::NewGuid()).archive.gz"
try {
    Write-Host "Dumping live database '$sourceDb' (read-only)..."
    & "$tools\mongodump.exe" --uri=$source --db=$sourceDb --readPreference=secondaryPreferred --archive=$archive --gzip --quiet
    if ($LASTEXITCODE -ne 0) { throw "mongodump failed" }

    Write-Host "Restoring into local '$targetDb'..."
    & "$tools\mongorestore.exe" --uri=$target --archive=$archive --gzip --drop `
        --nsFrom="$sourceDb.*" --nsTo="$targetDb.*" --quiet
    if ($LASTEXITCODE -ne 0) { throw "mongorestore failed" }
    Write-Host "Done: local $targetDb now mirrors live '$sourceDb'."
}
finally {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
}
