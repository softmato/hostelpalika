# One command for local work: Docker Desktop -> Go API stack -> web on :3000.
#   pwsh scripts/dev.ps1            rebuild the API image if server/ changed, then start
#   pwsh scripts/dev.ps1 -NoBuild   reuse the last API image (faster when only the web changed)
# Ctrl+C stops the web; the containers keep running. Stop them with:
#   docker compose -f server/deploy/compose.yaml -f server/deploy/compose.local.yaml stop
param([switch]$NoBuild)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Test-Docker { docker info *> $null; return $LASTEXITCODE -eq 0 }

function Wait-Until([scriptblock]$Ready, [int]$Seconds, [string]$What) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while (-not (& $Ready)) {
    if ((Get-Date) -gt $deadline) { throw "$What was not ready after $Seconds s." }
    Start-Sleep -Seconds 2
  }
}

# 1. Docker Desktop
if (Test-Docker) {
  Write-Host "Docker is running."
} else {
  Write-Host "Starting Docker Desktop..."
  Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  Wait-Until { Test-Docker } 240 "Docker"
  Write-Host "Docker is up."
}

# 2. Go API + Mongo + Redis (compose.local.yaml publishes the API on 127.0.0.1:8080)
$compose = @("compose", "-f", "$root/server/deploy/compose.yaml", "-f", "$root/server/deploy/compose.local.yaml")
$up = @("up", "-d") + $(if ($NoBuild) { @() } else { @("--build") }) + @("api")
Write-Host "Starting the Go API stack..."
docker @compose @up
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed." }

$health = "http://127.0.0.1:8080/api/v1/health?deep=1"
Wait-Until {
  try { (Invoke-WebRequest $health -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false }
} 180 "The Go API ($health)"
Write-Host "Go API healthy on http://127.0.0.1:8080"

# 3. Web: server reads and the browser's /api/v1 (same-origin rewrite, so cookies just work) go to local Go.
$env:API_URL = "http://127.0.0.1:8080"
$env:API_REWRITE_ENABLED = "true"
Remove-Item Env:NEXT_PUBLIC_API_URL -ErrorAction SilentlyContinue
Write-Host "Starting the web on http://localhost:3000 (Ctrl+C to stop)..."
npm --prefix "$root/apps/web" run dev
