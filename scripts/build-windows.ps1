param([switch]$Installer, [switch]$SkipDependencyInstall)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskSigningBefore = $env:CSC_IDENTITY_AUTO_DISCOVERY
$taskCompressionBefore = $env:ELECTRON_BUILDER_COMPRESSION_LEVEL
Push-Location $taskRoot
try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'This build targets Windows x64.' }
    $taskPython = Join-Path $taskRoot 'backend/.venv/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $taskPython)) {
        & python -m venv backend/.venv
        if ($LASTEXITCODE -ne 0) { throw 'Creating the Python environment failed.' }
    }
    if (-not $SkipDependencyInstall) {
        & $taskPython -m pip install -r desktop/requirements-build.lock
        if ($LASTEXITCODE -ne 0) { throw 'Installing Python build dependencies failed.' }
        & npm.cmd --prefix frontend ci
        if ($LASTEXITCODE -ne 0) { throw 'Installing frontend dependencies failed.' }
        & npm.cmd --prefix desktop ci
        if ($LASTEXITCODE -ne 0) { throw 'Installing desktop dependencies failed.' }
    }
    & npm.cmd --prefix frontend run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    & $taskPython -m PyInstaller --noconfirm --clean --distpath build/sidecar --workpath build/pyinstaller desktop/sidecar.spec
    if ($LASTEXITCODE -ne 0) { throw 'Python helper build failed.' }
    # Local artifacts only; packaging must never publish a release.
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '5'
    $taskTarget = if ($Installer) { 'installer' } else { 'portable' }
    & npm.cmd --prefix desktop run $taskTarget
    if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed.' }
    Get-ChildItem -LiteralPath (Join-Path $taskRoot 'dist/windows') -Filter '*.exe' |
        Select-Object FullName, Length
}
finally {
    $env:CSC_IDENTITY_AUTO_DISCOVERY = $taskSigningBefore
    $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = $taskCompressionBefore
    Pop-Location
}
