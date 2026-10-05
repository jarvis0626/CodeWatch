$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskManifest = Get-Content -LiteralPath (Join-Path $taskRoot 'desktop/cloudflared.json') -Raw | ConvertFrom-Json
$taskDirectory = Join-Path $taskRoot 'build/vendor'
$taskBinary = Join-Path $taskDirectory 'cloudflared.exe'
New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
if ((Test-Path -LiteralPath $taskBinary) -and
    (Get-FileHash -LiteralPath $taskBinary -Algorithm SHA256).Hash.ToLowerInvariant() -eq $taskManifest.sha256) {
    Write-Output "Verified bundled phone connector $($taskManifest.version)."
    exit 0
}
$taskDownload = Join-Path $taskDirectory ('cloudflared-' + [guid]::NewGuid().ToString('N') + '.download')
try {
    Invoke-WebRequest -Uri $taskManifest.url -OutFile $taskDownload -UseBasicParsing
    if ((Get-FileHash -LiteralPath $taskDownload -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskManifest.sha256) {
        throw 'Phone connector checksum verification failed.'
    }
    Move-Item -LiteralPath $taskDownload -Destination $taskBinary -Force
    Write-Output "Prepared verified phone connector $($taskManifest.version)."
}
finally {
    if (Test-Path -LiteralPath $taskDownload) { Remove-Item -LiteralPath $taskDownload }
}
