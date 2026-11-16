# 发版闸门：一条命令跑完全部检查，任何一项红即非 0 退出。
# 用法：pwsh -File scripts\checks-all.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$node = 'D:\node\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
$failed = @()

Write-Host '== 1. JS 语法 =='
foreach ($file in @('index.js', 'client.js', 'lib\pta.js', 'lib\accounts.js', 'lib\service.js', 'lib\scheduler.js', 'lib\launcher.js')) {
    & $node --check (Join-Path $root $file)
    if ($LASTEXITCODE -ne 0) { $failed += "syntax:$file"; Write-Host "  FAIL $file" } else { Write-Host "  ok   $file" }
}

Write-Host '== 2. 单元/契约测试 =='
Push-Location $root
foreach ($test in @('test\smoke.mjs', 'test\client-contract.mjs', 'test\scheduler.mjs')) {
    if (-not (Test-Path $test)) { Write-Host "  skip $test（不存在）"; continue }
    $out = & $node $test 2>&1 | Select-Object -Last 1
    if ($LASTEXITCODE -ne 0) { $failed += "test:$test"; Write-Host "  FAIL $test -> $out" } else { Write-Host "  ok   $test -> $out" }
}
Pop-Location

Write-Host '== 3. 插件在线 =='
try {
    $ping = (Invoke-WebRequest -Uri 'http://127.0.0.1:49531/_pta/ping' -TimeoutSec 8 -UseBasicParsing).Content | ConvertFrom-Json
    $toolCount = @($ping.tools).Count
    Write-Host "  version=$($ping.version) tools=$toolCount toolErrors=$(@($ping.toolErrors).Count) launch=$($ping.launch.available)/$($ping.launch.mode)"
    if (@($ping.toolErrors).Count -gt 0) { $failed += 'plugin:toolErrors' }
    if ($toolCount -lt 10) { $failed += 'plugin:tools' }
} catch {
    Write-Host "  FAIL 插件未响应（HTTP $([int]$_.Exception.Response.StatusCode)）"
    $failed += 'plugin:ping'
}

Write-Host ''
if ($failed.Count -eq 0) { Write-Host 'ALL GREEN'; exit 0 }
Write-Host "FAILED: $($failed -join ', ')"; exit 1
