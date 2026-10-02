param([switch]$Bundle)

# Local packaging helper. Tauri does the desktop builds; this only wraps the steps so a release can
# be produced on a workstation without recalling the exact commands.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root

try {
    $pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
    $version = $pkg.version

    Write-Host "=== WhisperNet v$version ===" -ForegroundColor Cyan

    Write-Host "`n[1/3] Type checking..." -ForegroundColor Yellow
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw "Type check failed" }

    Write-Host "`n[2/3] Building the client..." -ForegroundColor Yellow
    npm run build:client
    if ($LASTEXITCODE -ne 0) { throw "Client build failed" }

    if (-not $Bundle) {
        Write-Host "`nDone. Re-run with -Bundle to package the desktop app." -ForegroundColor Green
        return
    }

    Write-Host "`n[3/3] Packaging the desktop app (Tauri nsis)..." -ForegroundColor Yellow
    $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
    npm run tauri build -- --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "Packaging failed" }

    $installer = Get-ChildItem "src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue
    if (-not $installer) { throw "No installer was produced" }

    # the desktop updater replaces the running binary in place, so the release also needs a plain
    # zip holding the executable next to the installer
    $zip = Join-Path $root "dist\WhisperNet_${version}_x64-portable.zip"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $zip) | Out-Null
    Compress-Archive -Path "src-tauri\target\release\whispernet.exe" -DestinationPath $zip -Force

    Write-Host "`n=== DONE ===" -ForegroundColor Green
    $installer | ForEach-Object { Write-Host "Installer: $($_.FullName)" -ForegroundColor Cyan }
    Write-Host "Portable:  $zip" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "To publish:" -ForegroundColor White
    Write-Host "  1. create the GitHub release with tag v$version" -ForegroundColor White
    Write-Host "  2. upload the installer and the portable zip as release assets" -ForegroundColor White
}
finally {
    Pop-Location
}
