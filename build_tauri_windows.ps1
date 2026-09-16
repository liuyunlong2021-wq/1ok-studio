#Requires -Version 5.1
<#
build_tauri_windows.ps1 — One-click build for the One OK Studio Windows installer.

Produces: src-tauri/target/<target>/release/bundle/nsis/One OK Studio_<version>_x64-setup.exe

Mirrors build_tauri_mac.sh. Everything macOS-specific is gone, because none of
it has a Windows counterpart: the codesign/notarytool/staple/spctl chain, the
`check_macos_compat.py` Mach-O sweep, and the Python.framework symlink
materialization that exists only because Tauri cannot copy PyInstaller's
framework layout as a resource.
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

Write-Host ''
Write-Host '===================================================='
Write-Host '  One OK Studio - Tauri Windows Build'
Write-Host '===================================================='
Write-Host ''

# --- Step 1: prerequisites -------------------------------------------------
Write-Host '-> Checking prerequisites...'

# rustup's installer edits PATH for future shells, so a session opened before
# the install will not have it. Add the default location instead of failing.
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not (Get-Command cargo -ErrorAction SilentlyContinue) -and (Test-Path $cargoBin)) {
    $env:PATH = "$cargoBin;$env:PATH"
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host 'ERROR: Rust/Cargo not found.' -ForegroundColor Red
    Write-Host '       winget install --id Rustlang.Rustup --source winget'
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'ERROR: Node.js not found.' -ForegroundColor Red
    exit 1
}

Write-Host "   Rust $(cargo --version)"
Write-Host "   Node $(node --version)"

# Building over a running instance replaces files it has open. The macOS script
# guards with pgrep; this is the same guard in PowerShell.
$running = Get-Process -Name 'one-ok-studio' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host 'ERROR: One OK Studio is running. Quit the app before rebuilding.' -ForegroundColor Red
    exit 1
}

# --- Step 2: Python sidecar ------------------------------------------------
Write-Host ''
Write-Host '-> Step 2: Building the Python sidecar...'
& (Join-Path $RepoRoot 'build_sidecar_windows.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# --- Step 3: frontend ------------------------------------------------------
Write-Host ''
Write-Host '-> Step 3: Building the frontend (static export for Tauri)...'
# build:tauri wraps `next build` to export TAURI_BUILD, which next.config.mjs
# needs to emit distDir "out" without the /static basePath. tauri build would
# run the same script via beforeBuildCommand; doing it here first means the
# frontend failure surfaces before the sidecar's five-minute Tauri build.
& npm --prefix frontend run build:tauri
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host '   frontend built to frontend/out/'

# --- Step 4: Tauri bundle --------------------------------------------------
Write-Host ''
Write-Host '-> Step 4: Building the Tauri application...'

$arch = $env:PROCESSOR_ARCHITECTURE
$target = switch ($arch) {
    'AMD64' { 'x86_64-pc-windows-msvc' }
    'ARM64' { 'aarch64-pc-windows-msvc' }
    default {
        Write-Host "ERROR: unsupported architecture: $arch" -ForegroundColor Red
        exit 1
    }
}
Write-Host "   Target: $target"

# The backend is not an `externalBin`: it is a PyInstaller onedir tree copied in
# as a bundle resource. Keeping that in a separate config file rather than an
# inline --config string avoids handing JSON through PowerShell's argument
# quoting, and passing it on the command line (instead of a tauri.windows.conf
# overlay) keeps `cargo check` working before the sidecar has been built.
$bundleConfig = Join-Path $RepoRoot 'src-tauri\tauri.bundle.windows.conf.json'

# NSIS is fetched by the Tauri CLI on first use; that download is the usual
# reason a first build looks like it has hung right here.
Write-Host '   Bundling NSIS (the toolchain is downloaded on first use)...'
& npx tauri build --target $target --bundles nsis --config $bundleConfig
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# --- Report ----------------------------------------------------------------
$version = (Get-Content (Join-Path $RepoRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
$nsisDir = Join-Path $RepoRoot "src-tauri\target\$target\release\bundle\nsis"
$installer = Get-ChildItem $nsisDir -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

Write-Host ''
Write-Host '===================================================='
Write-Host '  Build Complete'
Write-Host '===================================================='
Write-Host ''
Write-Host "  version: $version"
if ($installer) {
    Write-Host "  installer: $($installer.FullName)"
    Write-Host "  size: $([math]::Round($installer.Length / 1MB, 1)) MB"
} else {
    Write-Host "  installer not found under $nsisDir" -ForegroundColor Yellow
    Get-ChildItem (Join-Path $RepoRoot "src-tauri\target\$target\release\bundle") -ErrorAction SilentlyContinue
}
Write-Host ''
