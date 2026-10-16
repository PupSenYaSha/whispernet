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

    Write-Host "`n[3/4] Packaging the desktop app (Tauri nsis)..." -ForegroundColor Yellow
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

    # The digest the updater refuses to install without.
    #
    # `src-tauri/src/lib.rs` looks for `<zip name>.sha256` among the release assets and returns an error
    # naming it if there is none, so a release published without this file advertises updates that the app
    # then declines to apply - which reads to the user as "up to date" with no explanation. Written in the
    # same `<hash>  <name>` form the release workflow uses, because the parser reads the first run of hex
    # digits and insists on sixty-four of them.
    $digest = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    $digestPath = "$zip.sha256"
    Set-Content -Path $digestPath -Value "$digest  $(Split-Path -Leaf $zip)" -NoNewline -Encoding ascii

    # Sign the portable archive. This step used to not exist here at all, and the instructions below still
    # told the operator to publish three files - so a release made the documented way was one that no
    # desktop client could ever install from: `src-tauri/src/lib.rs`'s `verify_update_signature` looks for
    # `<zip name>.sig` among the assets and hard-refuses without it, and the refusal message reads to the
    # user exactly like an attack succeeding. The CI job has always done this via the same script; this is
    # the manual path catching up.
    #
    # The key is read from the environment and never echoed, never passed as an argument and never written
    # into the output directory - an argument would land in a process listing and a transcript, and this
    # script's own output goes to whatever the operator redirects it to. `scripts/sign-update.mjs` refuses
    # a missing key itself; the check here is so the failure is a sentence about the release rather than a
    # stack trace from inside the signer.
    Write-Host "`n[4/4] Signing the portable archive..." -ForegroundColor Yellow
    if (-not $env:UPDATE_SIGNING_KEY_HEX -and -not $env:UPDATE_SIGNING_KEY_BASE64) {
        throw ("Neither UPDATE_SIGNING_KEY_HEX nor UPDATE_SIGNING_KEY_BASE64 is set. The release cannot " +
               "be published without a signature: the updater refuses to install an archive with no " +
               "published .sig, so an unsigned release is one that no desktop client can update from. " +
               "Set the variable for this session and run again. See scripts/generate-update-key.mjs.")
    }
    node scripts/sign-update.mjs $zip
    if ($LASTEXITCODE -ne 0) { throw "Signing failed" }
    $sigPath = "$zip.sig"
    if (-not (Test-Path -LiteralPath $sigPath)) { throw "The signer reported success but wrote no $sigPath" }

    Write-Host "`n=== DONE ===" -ForegroundColor Green
    $installer | ForEach-Object { Write-Host "Installer: $($_.FullName)" -ForegroundColor Cyan }
    Write-Host "Portable:  $zip" -ForegroundColor Cyan
    Write-Host "Digest:    $digestPath" -ForegroundColor Cyan
    Write-Host "Signature: $sigPath" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "To publish:" -ForegroundColor White
    Write-Host "  1. create the GitHub release with tag v$version" -ForegroundColor White
    Write-Host "  2. upload the installer, the portable zip, its .sha256 AND its .sig as release assets" -ForegroundColor White
    Write-Host "     (the in-app updater refuses to install anything without the digest beside it, and" -ForegroundColor Gray
    Write-Host "      refuses again without the signature, which is what says who built the release)" -ForegroundColor Gray
}
finally {
    Pop-Location
}
