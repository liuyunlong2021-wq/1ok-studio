#Requires -Version 5.1
<#
build_sidecar_windows.ps1 — Package the Python backend for the Windows bundle.

Mirrors build_sidecar.sh with the macOS-only steps removed (codesign,
materialized Python.framework symlinks, check_macos_compat.py). Output lands in
src-tauri/, which is where src-tauri/src/sidecar.rs::prod_sidecar_path() and the
Demucs helper lookup in src/apps/comic_gen/pipeline.py both look for it.

Two artifacts, on purpose:

  * 1okstudio-backend/ — onedir, always loaded. Excludes demucs/torch so the
    runtime the app pays for on every launch stays small.
  * 1okstudio-demucs.exe — onefile, on demand. Only the dub workflow runs it,
    so paying torch's unpack cost only there is the right trade.
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

$BinaryName = '1okstudio-backend'
$DemucsName = '1okstudio-demucs'
$OutputDir = 'src-tauri'

$Python = if ($env:SIDECAR_PYTHON) {
    $env:SIDECAR_PYTHON
} else {
    Join-Path $RepoRoot '.venv\Scripts\python.exe'
}

Write-Host ''
Write-Host '===================================================='
Write-Host '  One OK Studio - Windows Sidecar Builder'
Write-Host '===================================================='
Write-Host ''

if (-not (Test-Path $Python)) {
    Write-Host "ERROR: no interpreter at $Python" -ForegroundColor Red
    Write-Host '       Create one with:  uv venv .venv --python 3.11'
    Write-Host '       Then:              uv pip install --python .venv torch torchaudio --index-url https://download.pytorch.org/whl/cpu'
    Write-Host '                          uv pip install --python .venv -r requirements.txt'
    exit 1
}

Write-Host "-> Interpreter: $Python"

# Refuse a CUDA build of torch. The default PyPI wheel for Windows bundles the
# CUDA runtime, which turns the on-demand Demucs helper into a multi-gigabyte
# download for no benefit — the helper runs on the user's machine, and most of
# them have no NVIDIA GPU. Fail here rather than discover it in the installer
# size.
$torchReport = & $Python -c "import torch; print(torch.__version__); print('cuda' if torch.version.cuda else 'cpu')"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'ERROR: torch is not importable in this environment.' -ForegroundColor Red
    Write-Host '       uv pip install --python .venv torch torchaudio --index-url https://download.pytorch.org/whl/cpu'
    exit 1
}
Write-Host "   torch $($torchReport[0]) ($($torchReport[1]))"
if ($torchReport[1] -ne 'cpu') {
    Write-Host '' -ForegroundColor Red
    Write-Host 'ERROR: this environment has a CUDA build of torch.' -ForegroundColor Red
    Write-Host '       The bundled Demucs helper would carry the whole CUDA runtime.' -ForegroundColor Red
    Write-Host '       Build against a CPU-only torch:' -ForegroundColor Red
    Write-Host '         uv venv .venv-release-windows --python 3.11' -ForegroundColor Red
    Write-Host '         uv pip install --python .venv-release-windows torch torchaudio --index-url https://download.pytorch.org/whl/cpu' -ForegroundColor Red
    Write-Host '         uv pip install --python .venv-release-windows -r requirements.txt' -ForegroundColor Red
    Write-Host '         $env:SIDECAR_PYTHON = ".venv-release-windows\Scripts\python.exe"' -ForegroundColor Red
    exit 1
}

# `uv venv` deliberately creates environments without pip — uv manages packages
# itself — and the release instructions build the venv with uv, so `python -m
# pip` is not something this script can assume exists.
$pyinstallerVersion = & $Python -m PyInstaller --version 2>$null
if (-not $pyinstallerVersion) {
    Write-Host '-> Installing PyInstaller into the environment...'
    $installed = $false

    if (& $Python -m pip --version 2>$null) {
        & $Python -m pip install pyinstaller
        $installed = $LASTEXITCODE -eq 0
    }
    if (-not $installed -and (Get-Command uv -ErrorAction SilentlyContinue)) {
        & uv pip install --python $Python pyinstaller
        $installed = $LASTEXITCODE -eq 0
    }
    if (-not $installed) {
        & $Python -m ensurepip --upgrade
        & $Python -m pip install pyinstaller
        $installed = $LASTEXITCODE -eq 0
    }
    if (-not $installed) {
        Write-Host 'ERROR: could not install PyInstaller.' -ForegroundColor Red
        Write-Host "       uv pip install --python `"$Python`" -r requirements-windows-x64.txt" -ForegroundColor Red
        exit 1
    }

    $pyinstallerVersion = & $Python -m PyInstaller --version 2>$null
}
Write-Host "   PyInstaller $pyinstallerVersion"

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# --- Backend runtime -------------------------------------------------------
Write-Host ''
Write-Host '-> Building the backend runtime (onedir)...'
# A stale artifact from an older layout would collide with the new one.
Remove-Item -Recurse -Force (Join-Path $OutputDir $BinaryName) -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $OutputDir "$BinaryName.spec") -ErrorAction SilentlyContinue

& $Python -m PyInstaller `
    --name $BinaryName `
    --onedir `
    --console `
    --noconfirm `
    --clean `
    --hidden-import=uvicorn `
    --hidden-import=uvicorn.logging `
    --hidden-import=uvicorn.loops `
    --hidden-import=uvicorn.loops.auto `
    --hidden-import=uvicorn.protocols `
    --hidden-import=uvicorn.protocols.http `
    --hidden-import=uvicorn.protocols.http.auto `
    --hidden-import=uvicorn.protocols.websockets `
    --hidden-import=uvicorn.protocols.websockets.auto `
    --hidden-import=uvicorn.lifespan `
    --hidden-import=uvicorn.lifespan.on `
    --hidden-import=fastapi `
    --hidden-import=pydantic `
    --hidden-import=starlette `
    --hidden-import=httptools `
    --hidden-import=dotenv `
    --hidden-import=yaml `
    --hidden-import=dashscope `
    --hidden-import=dashscope.audio.tts_v2 `
    --exclude-module=demucs `
    --exclude-module=torch `
    --exclude-module=torchaudio `
    --exclude-module=sympy `
    --add-data "src;src" `
    --add-data "config;config" `
    --add-data "skills;skills" `
    --distpath $OutputDir `
    sidecar_entry.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# --- Demucs helper ---------------------------------------------------------
Write-Host ''
Write-Host '-> Building the on-demand Demucs helper (onefile)...'
Remove-Item -Force (Join-Path $OutputDir "$DemucsName.exe") -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $OutputDir "$DemucsName.spec") -ErrorAction SilentlyContinue

& $Python -m PyInstaller `
    --name $DemucsName `
    --onefile `
    --console `
    --noconfirm `
    --clean `
    --collect-all=demucs `
    --hidden-import=demucs.separate `
    --distpath $OutputDir `
    demucs_sidecar_entry.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# --- Verify ----------------------------------------------------------------
# macOS checks Mach-O deployment targets here. The equivalent Windows risk is a
# runtime that is missing collected modules or DLLs, and that only shows up when
# something tries to start it — so start it. `--help` parses arguments and exits
# without binding a port.
Write-Host ''
Write-Host '-> Verifying the packaged runtime starts...'

$backendExe = Join-Path $OutputDir "$BinaryName\$BinaryName.exe"
$demucsExe = Join-Path $OutputDir "$DemucsName.exe"
foreach ($artifact in @($backendExe, $demucsExe)) {
    if (-not (Test-Path $artifact)) {
        Write-Host "ERROR: expected artifact missing: $artifact" -ForegroundColor Red
        exit 1
    }
}

& $backendExe --help *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: $backendExe could not start (exit $LASTEXITCODE)." -ForegroundColor Red
    Write-Host '       Run it by hand to see the traceback.' -ForegroundColor Red
    exit 1
}
Write-Host '   backend runtime starts'

# The Demucs helper is a onefile bundle, so this also proves the archive
# unpacks. It carries torch, which is the dependency most likely to be
# collected incompletely, and a helper that only fails at dub time would be
# invisible until a user hit it.
& $demucsExe --help *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: $demucsExe could not start (exit $LASTEXITCODE)." -ForegroundColor Red
    Write-Host '       Run it by hand to see the traceback.' -ForegroundColor Red
    exit 1
}
Write-Host '   demucs helper starts'

Remove-Item -Recurse -Force (Join-Path $RepoRoot 'build') -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $RepoRoot "$BinaryName.spec") -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $RepoRoot "$DemucsName.spec") -ErrorAction SilentlyContinue

$backendSize = [math]::Round((Get-ChildItem (Join-Path $OutputDir $BinaryName) -Recurse -File |
    Measure-Object Length -Sum).Sum / 1MB, 1)
$demucsSize = [math]::Round((Get-Item $demucsExe).Length / 1MB, 1)

Write-Host ''
Write-Host 'Sidecar runtime built:'
Write-Host "  $backendExe  ($backendSize MB)"
Write-Host "  $demucsExe  ($demucsSize MB)"
