param(
  [string]$RepositoryUrl = 'https://github.com/weiwei19851214-collab/Auto-Purchase-for-OR',
  [string]$Branch = 'new-portal',
  [string]$InstallRoot = (Join-Path $env:USERPROFILE 'OpenRouter-Recharge-Runner')
)

$ErrorActionPreference = 'Stop'

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machinePath;$userPath"
}

function Ensure-Git {
  if (Get-Command git -ErrorAction SilentlyContinue) { return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Git is required, but Windows Package Manager (winget) was not found. Install Git for Windows, then run this script again.'
  }

  Write-Host 'Installing Git for Windows with winget...' -ForegroundColor Yellow
  & winget install --id Git.Git --exact --source winget --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -ne 0) {
    throw "winget install Git.Git failed with exit code $LASTEXITCODE."
  }

  Refresh-ProcessPath
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git installation completed, but this terminal cannot find git yet. Close this window and run the bootstrap script again.'
  }
}

function Get-NodeMajorVersion {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
  try {
    return [int](& node -p "process.versions.node.split('.')[0]")
  } catch {
    return 0
  }
}

function Ensure-Node {
  $nodeMajor = Get-NodeMajorVersion
  if ($nodeMajor -ge 22) { return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Node.js 22 or later is required, but Windows Package Manager (winget) was not found. Install Node.js LTS from https://nodejs.org/ and run this script again.'
  }

  $wingetAction = if ($nodeMajor -eq 0) { 'install' } else { 'upgrade' }
  Write-Host "Installing Node.js LTS with winget ($wingetAction)..." -ForegroundColor Yellow
  & winget $wingetAction --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -ne 0) {
    throw "winget $wingetAction failed with exit code $LASTEXITCODE."
  }

  Refresh-ProcessPath
  if ((Get-NodeMajorVersion) -lt 22) {
    throw 'Node.js installation completed, but this terminal cannot find Node.js 22 yet. Close this window and run this script again.'
  }
}

function Invoke-Git {
  param([string[]]$GitArguments)
  & git @GitArguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($GitArguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

Ensure-Git

$projectPath = Join-Path $InstallRoot 'Auto-Purchase-for-OR'
if (Test-Path $projectPath) {
  if (-not (Test-Path (Join-Path $projectPath '.git'))) {
    throw "Install path already exists but is not a Git repository: $projectPath"
  }
  Write-Host "Using existing project: $projectPath"
} else {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  Write-Host "Cloning branch $Branch..."
  Invoke-Git @('clone', '--branch', $Branch, '--single-branch', $RepositoryUrl, $projectPath)
}

Ensure-Node

$port = if ($env:PORT) { $env:PORT } else { '4100' }
$env:PORT = $port
$env:OR_RUNNER_DB = Join-Path $projectPath 'data\runner.sqlite'
foreach ($relativePath in @('data\uploads', 'data\results', 'data\logs')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $projectPath $relativePath) | Out-Null
}

# The console is local-only. Stop only the old listener on this project's configured port.
$listeners = @(Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  Write-Host "Port $port is in use. Stopping previous process PID $($listener.OwningProcess)." -ForegroundColor Yellow
  Stop-Process -Id $listener.OwningProcess -Force
}

$consoleUrl = "http://127.0.0.1:$port"
$healthUrl = "$consoleUrl/api/health"
Write-Host "Starting project at $projectPath"
$launcher = Start-Process cmd.exe -ArgumentList @('/k', 'npm.cmd start') -WorkingDirectory $projectPath -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Seconds 1
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    if ($launcher.HasExited) { break }
  }
}

if (-not $ready) {
  throw "The local console did not become ready at $consoleUrl. Check the separate cmd window for the startup error."
}

Write-Host "Opening $consoleUrl"
Start-Process $consoleUrl
