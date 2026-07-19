param([switch]$IncludeServer)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
$tsc = Join-Path $root "node_modules/tsx/dist/cli.mjs"
$tscBin = Join-Path $root "node_modules/typescript/bin/tsc"
$vite = Join-Path $root "node_modules/vite/bin/vite.js"
$eb = Join-Path $root "node_modules/electron-builder/cli.js"

$pkg = Get-Content (Join-Path $root "package.json") | ConvertFrom-Json
$version = $pkg.version

Write-Host "=== WhisperNet v$version Build ===" -ForegroundColor Cyan

Write-Host "`n[1/3] Building client..." -ForegroundColor Yellow
& $node $vite build
if ($LASTEXITCODE -ne 0) { throw "Client build failed" }

$step = 2
$totalSteps = if ($IncludeServer) { 4 } else { 3 }

if ($IncludeServer) {
  Write-Host "`n[$step/$totalSteps] Building server..." -ForegroundColor Yellow
  & $node $tsc $tscBin -p server/tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw "Server build failed" }
  $step++
}

Write-Host "`n[$step/$totalSteps] Building Electron..." -ForegroundColor Yellow
& $node $tsc $tscBin -p electron/tsconfig.json
if ($LASTEXITCODE -ne 0) { throw "Electron build failed" }
$step++

Write-Host "`n[$step/$totalSteps] Packaging..." -ForegroundColor Yellow
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
& $node $eb --win
if ($LASTEXITCODE -ne 0) { throw "Packaging failed" }

$unpacked = Join-Path $root "dist/build/win-unpacked"
$zipPath = Join-Path $root "dist/build/WhisperNet-v$version.zip"

Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Get-ChildItem "$unpacked/locales" | Where-Object { $_.Name -notmatch "en|ru" } | Remove-Item -Force -ErrorAction SilentlyContinue

Compress-Archive -Path "$unpacked/*" -DestinationPath $zipPath -Force
$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)

Write-Host "`n=== DONE ===" -ForegroundColor Green
Write-Host "Zip: dist/build/WhisperNet-v$version.zip ($sizeMB MB)" -ForegroundColor Cyan
Write-Host ""
Write-Host "To distribute:" -ForegroundColor White
Write-Host "  1. Send WhisperNet-v$version.zip to friends" -ForegroundColor White
Write-Host "  2. They extract and run WhisperNet.exe" -ForegroundColor White
Write-Host ""
Write-Host "To publish update:" -ForegroundColor White
Write-Host "  1. Bump version in package.json" -ForegroundColor White
Write-Host "  2. Run this script" -ForegroundColor White
Write-Host "  3. Create GitHub release with tag v$version" -ForegroundColor White
Write-Host "  4. Upload the zip as release asset" -ForegroundColor White
