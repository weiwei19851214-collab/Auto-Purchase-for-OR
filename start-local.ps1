param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

function Get-FirstConfiguredPort {
  foreach ($name in @('PORT', 'OR_RUNNER_PORT', 'OPENROUTER_RECHARGE_PORT', 'RECHARGE_RUNNER_PORT', 'LEGACY_SKILL_PORT')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { return $value }
  }
  return '4100'
}

if (-not $env:PORT) {
  # Keep the same port precedence as the macOS/Linux launcher.
  $env:PORT = Get-FirstConfiguredPort
}
if (-not $env:OR_RUNNER_DB) {
  $env:OR_RUNNER_DB = Join-Path $projectRoot 'data\runner.sqlite'
}

foreach ($relativePath in @('data\uploads', 'data\results', 'data\logs')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot $relativePath) | Out-Null
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found. Install Node.js 22 or later, then run this script again.'
}

$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
  throw "Node.js $(& node -v) is too old. This project requires Node.js 22 or later."
}

if (-not (Test-Path (Join-Path $projectRoot 'node_modules'))) {
  Write-Host 'node_modules was not found. Run npm install before starting the project.' -ForegroundColor Yellow
}

# The local console owns this loopback port; an existing listener is usually a previous local run.
$listeners = @(Get-NetTCPConnection -LocalPort ([int]$env:PORT) -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  Write-Host "Port $env:PORT is in use. Stopping previous process PID $($listener.OwningProcess)." -ForegroundColor Yellow
  Stop-Process -Id $listener.OwningProcess -Force
}

Write-Host 'Starting OpenRouter Recharge Runner'
Write-Host "Project directory: $projectRoot"
Write-Host "URL: http://127.0.0.1:$env:PORT"
Write-Host "Database: $env:OR_RUNNER_DB"
Write-Host ''

# Use the Windows npm shim explicitly.
& npm.cmd start
exit $LASTEXITCODE
