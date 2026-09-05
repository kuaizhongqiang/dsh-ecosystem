# dsh-launcher —— launcher 桥接合并包(PM3,路线图 §8;依赖 launcher M5/M6 seam)。
# 服务:launcher(5 工具:launcher_restart/status/connections/open/check_update)。
# 无新凭证:seam 全在 %DSH_HOME% 文件与 DSH_LAUNCHER_EXE 环境变量。
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
param(
  [string]$Only = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$pkg = 'dsh-launcher'
$svc = 'launcher'
$toolId = 'tool-launcher'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$pluginDir = Join-Path $profileDir ("plugins\" + $svc)

if (-not (Test-Path (Join-Path $dshHome 'profiles'))) {
  Write-Host "ERROR: no dsh profiles found under $dshHome. Is dsh installed?" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $profileDir)) {
  Write-Host "ERROR: web profile not found at $profileDir. Boot it once with: dsh web" -ForegroundColor Red
  exit 1
}

function Remove-PatchSection([string]$text, [string]$header) {
  $lines = $text -split "`r?`n"
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($l in $lines) {
    if (-not $skip -and $l -match '^\s*#\s*---\s*' -and $l -like "*$header*") { $skip = $true; continue }
    if ($skip) {
      if ($l -match '^\s*#' -or $l -match '^\s*- insert:' -or $l -match '^\s+- ' -or $l.Trim() -eq '') { continue }
      $skip = $false
    }
    [void]$out.Add($l)
  }
  return (($out -join "`n").TrimEnd())
}

if ($Uninstall) {
  if (Test-Path $pluginDir) { Remove-Item $pluginDir -Recurse -Force; Write-Host "OK  removed $pluginDir" -ForegroundColor Green }
  if (Test-Path $patchFile) {
    $raw = Get-Content $patchFile -Raw
    $cleaned = Remove-PatchSection $raw "$pkg`: $svc"
    if ($cleaned -ne $raw) {
      [System.IO.File]::WriteAllText($patchFile, $cleaned, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host 'OK  patch section removed' -ForegroundColor Green
    }
  }
  Write-Host 'dsh-launcher plugin uninstalled. Restart the web instance.' -ForegroundColor Cyan
  exit 0
}

# 1. copy payload
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
foreach ($f in @('index.js', 'package.json')) {
  Copy-Item -Path (Join-Path $PSScriptRoot ("plugins\" + $svc + "\" + $f)) -Destination $pluginDir -Force
}
Write-Host "OK  plugin copied -> $pluginDir" -ForegroundColor Green

# 2. patch entry (idempotent by tool-launcher)
$current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
if ($current -match [regex]::Escape($toolId)) {
  Write-Host "SKIP $toolId already present in $patchFile" -ForegroundColor Yellow
} else {
  $entryText = @"

# --- $pkg`: $svc (native dsh) ---
# Launcher seam tools: restart/status/connections/open/check_update (M5/M6 discovery chain).
- insert:
    - id: $toolId
      name: './plugins/$svc/index.js'
"@
  $lines = ($current -split "`r?`n") | Where-Object { $_ -notmatch '^\s*\[\]\s*$' }
  $base = ($lines -join "`n").TrimEnd()
  $combined = if ($base) { $base + "`n" + $entryText.TrimStart() } else { $entryText.TrimStart() }
  [System.IO.File]::WriteAllText($patchFile, $combined, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "OK  profile patch entry added ($toolId) -> $patchFile" -ForegroundColor Green
}

# 3. reminder
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Restart the web instance (tools appear after restart): stop it, then dsh web;'
Write-Host '     or call launcher_restart from a previous session when a launcher is registered.'
Write-Host '  2. No credentials needed: the tools read %DSH_HOME% seam files only (tokens stay local).'
