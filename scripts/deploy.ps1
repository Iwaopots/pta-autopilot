# Link this repository into a DSH profile's node_modules as a junction.
# Check-and-create only: never deletes an existing directory. If a link exists
# but points elsewhere, fail and let a human resolve it.
param(
  [string]$ProfileName = 'desktop'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$package = Join-Path $repo 'package.json'
if (-not (Test-Path -LiteralPath $package)) {
  throw "package.json not found at $package; run this from pta-autopilot/scripts."
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$modules = Join-Path $dshHome "profiles\$ProfileName\node_modules"
$link = Join-Path $modules 'pta-autopilot'
New-Item -ItemType Directory -Force -Path $modules | Out-Null

if (Test-Path -LiteralPath $link) {
  $item = Get-Item -LiteralPath $link -Force
  $target = @($item.Target)[0]
  $same = $false
  if ($target) {
    try { $same = (Resolve-Path -LiteralPath $target).Path -eq (Resolve-Path -LiteralPath $repo).Path } catch { $same = $false }
  }
  if (-not $same) {
    throw "Existing $link points to $target; remove that link manually and retry."
  }
  Write-Host "pta-autopilot already deployed: $link -> $repo"
} else {
  New-Item -ItemType Junction -Path $link -Target $repo | Out-Null
  Write-Host "Created junction: $link -> $repo"
}

Write-Host 'Restart the DSH desktop app, then check /_pta/ping for version and tools.'
