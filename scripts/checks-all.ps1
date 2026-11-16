# Release gate wrapper (ASCII only, so Windows PowerShell 5.1 and pwsh both read it correctly).
# Usage: pwsh -File scripts\checks-all.ps1 [--offline]
$root = Split-Path -Parent $PSScriptRoot
$node = 'D:\node\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
& $node (Join-Path $root 'scripts\gate.mjs') @args
exit $LASTEXITCODE
