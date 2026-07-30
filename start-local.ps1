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
  # 与 macOS 启动脚本保持相同的端口优先级，最终仍只通过 PORT 交给 Node 服务。
  $env:PORT = Get-FirstConfiguredPort
}
if (-not $env:OR_RUNNER_DB) {
  $env:OR_RUNNER_DB = Join-Path $projectRoot 'data\runner.sqlite'
}

foreach ($relativePath in @('data\uploads', 'data\results', 'data\logs')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot $relativePath) | Out-Null
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '未找到 Node.js。请安装 Node.js 22 或更高版本后重新运行。'
}

$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
  throw "当前 Node.js 版本是 $(& node -v)，本项目需要 Node.js 22 或更高版本。"
}

if (-not (Test-Path (Join-Path $projectRoot 'node_modules'))) {
  Write-Host '提示: 未发现 node_modules。首次运行请先执行: npm install' -ForegroundColor Yellow
}

# 本地控制台固定监听回环地址；同端口的旧进程通常是本项目上一次启动残留。
$listeners = @(Get-NetTCPConnection -LocalPort ([int]$env:PORT) -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  Write-Host "检测到端口 $env:PORT 已被占用，正在停止旧进程 PID $($listener.OwningProcess)" -ForegroundColor Yellow
  Stop-Process -Id $listener.OwningProcess -Force
}

Write-Host 'OpenRouter 充值执行器本地启动'
Write-Host "项目目录: $projectRoot"
Write-Host "访问地址: http://127.0.0.1:$env:PORT"
Write-Host "数据库: $env:OR_RUNNER_DB"
Write-Host ''

# npm.cmd 避免 PowerShell 将 Windows 的 npm shim 误识别为 Unix 可执行文件。
& npm.cmd start
exit $LASTEXITCODE
