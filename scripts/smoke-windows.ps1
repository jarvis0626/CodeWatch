param([string]$Executable = 'dist/windows/CodeWatch-0.2.0-x64-portable.exe')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskExe = if ([IO.Path]::IsPathRooted($Executable)) { $Executable } else { Join-Path $taskRoot $Executable }
$taskExe = (Resolve-Path -LiteralPath $taskExe).Path
$taskDir = Join-Path $taskRoot ('.local/packaged-smoke-' + [guid]::NewGuid().ToString('N'))
$taskProject = Join-Path $taskDir 'project'
New-Item -ItemType Directory -Path $taskProject -Force | Out-Null
Set-Content -LiteralPath (Join-Path $taskProject 'fixture.py') -Value 'value = 1'
$taskResult = Join-Path $taskDir 'result.json'
$taskPathBefore = $env:PATH
$taskNodeBefore = $env:ELECTRON_RUN_AS_NODE
try {
    # The tested app can only find Windows system programs, not Python/Node/Docker.
    $env:PATH = Join-Path $env:SystemRoot 'System32'
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $env:CODEWATCH_TEST_USER_DATA = Join-Path $taskDir 'user-data'
    $env:CODEWATCH_SMOKE_PROJECT = $taskProject
    $env:CODEWATCH_SMOKE_RESULT = $taskResult
    $taskProcess = Start-Process -FilePath $taskExe -ArgumentList '--smoke-test' -WindowStyle Hidden -PassThru
    if (-not $taskProcess.WaitForExit(120000)) { throw "Packaged smoke timed out. Logs: $taskDir" }
    if (-not (Test-Path -LiteralPath $taskResult)) { throw "No smoke result. Logs: $taskDir" }
    $taskReport = Get-Content -LiteralPath $taskResult -Raw | ConvertFrom-Json
    if (-not $taskReport.ok) { throw ($taskReport | ConvertTo-Json -Depth 5) }
    $taskDiscovery = Join-Path $env:CODEWATCH_TEST_USER_DATA 'desktop-connection.json'
    if (Test-Path -LiteralPath $taskDiscovery) { throw 'Owned backend discovery was not cleaned up.' }
    $taskRemaining = Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:CODEWATCH_TEST_USER_DATA, [StringComparison]::OrdinalIgnoreCase)
    }
    if ($taskRemaining) { throw 'A CodeWatch-owned helper remained after quit.' }
    $taskReport
    Write-Output "Packaged smoke passed; clean quit verified. Report: $taskResult"
}
finally {
    $env:PATH = $taskPathBefore
    $env:ELECTRON_RUN_AS_NODE = $taskNodeBefore
    Remove-Item Env:CODEWATCH_TEST_USER_DATA,Env:CODEWATCH_SMOKE_PROJECT,Env:CODEWATCH_SMOKE_RESULT -ErrorAction SilentlyContinue
}
