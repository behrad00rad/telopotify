$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appRoot = Join-Path $projectRoot 'TelopotifyApp'

if (-not (Test-Path (Join-Path $projectRoot 'node_modules')) -or
    -not (Test-Path (Join-Path $appRoot 'node_modules'))) {
  throw 'Dependencies are missing. Run npm ci in the project root and in TelopotifyApp first.'
}

$toolPaths = @('C:\Program Files\dotnet', 'D:\VisualStudio2026\MSBuild\Current\Bin') |
  Where-Object { Test-Path $_ }
if ($toolPaths.Count -gt 0) {
  $env:PATH = ($toolPaths -join ';') + ';' + $env:PATH
}

# React Native Windows 0.84 looks for pwsh.exe even when launched from Windows
# PowerShell. Codex includes a local copy on this PC, but a normal terminal does
# not have its directory on PATH.
if (-not (Get-Command pwsh.exe -ErrorAction SilentlyContinue)) {
  $pwshCandidates = @(
    (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe')
  )
  $pwshPath = $pwshCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $pwshPath) {
    throw 'PowerShell 7 (pwsh.exe) was not found. Install PowerShell 7, then run npm run app:windows again.'
  }
  $env:PATH = (Split-Path -Parent $pwshPath) + ';' + $env:PATH
}

function Get-BridgeAddress {
  try {
    $address = (Invoke-RestMethod -Uri 'http://127.0.0.1:43127/bootstrap' -TimeoutSec 2).address
    $uri = [Uri]$address
    if ($uri.Host -ne '127.0.0.1' -or $uri.Port -ne 43127 -or
        -not $uri.Query.Contains('token=')) { return $null }
    $statusAddress = $address.Replace('?', '/status?')
    $null = Invoke-RestMethod -Uri $statusAddress -TimeoutSec 2
    return $address
  } catch { return $null }
}

function Test-Metro {
  try {
    $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8081/status' -TimeoutSec 2 -UseBasicParsing
    return $true
  } catch { return $false }
}

$address = Get-BridgeAddress
if (-not $address) {
  Write-Host 'Starting the local Telegram bridge...'
  Start-Process -FilePath (Get-Command node.exe).Source `
    -ArgumentList 'spikes/telegram-client/library-server.mjs' `
    -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
  for ($attempt = 0; $attempt -lt 30 -and -not $address; $attempt++) {
    Start-Sleep -Seconds 1
    $address = Get-BridgeAddress
  }
  if (-not $address) { throw 'The Telegram bridge did not start. Run npm run dev:library to see its error.' }
}

if (-not (Test-Metro)) {
  Write-Host 'Starting the React Native development server...'
  Start-Process -FilePath (Get-Command npm.cmd).Source `
    -ArgumentList @('start', '--', '--port', '8081') `
    -WorkingDirectory $appRoot -WindowStyle Hidden | Out-Null
  for ($attempt = 0; $attempt -lt 30 -and -not (Test-Metro); $attempt++) {
    Start-Sleep -Seconds 1
  }
  if (-not (Test-Metro)) { throw 'The React Native server did not start. Run npm start in TelopotifyApp to see its error.' }
}

$runningApp = Get-Process -Name TelopotifyApp -ErrorAction SilentlyContinue
if ($runningApp) {
  $runningApp | Stop-Process -Force
}

Write-Host 'Building and opening the Windows app...'
Push-Location $appRoot
try {
  & npx.cmd react-native run-windows --no-packager --no-telemetry `
    --msbuildprops 'WindowsTargetPlatformVersion=10.0.26100.0,TargetPlatformVersion=10.0.26100.0'
  if ($LASTEXITCODE -ne 0) { throw 'The Windows app did not launch. See the build output above.' }
} finally { Pop-Location }

Write-Host ''
Write-Host 'The app is open and will connect to the local library automatically.'
