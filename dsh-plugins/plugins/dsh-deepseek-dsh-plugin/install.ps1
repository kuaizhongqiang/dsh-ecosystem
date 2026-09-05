# dsh-deepseek —— DeepSeek 账户运维合并包（PM2,路线图 §8 11→7）。
# 合并自:deepseek-balance / deepseek-recharge。共享凭证:DEEPSEEK_API_KEY。
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only deepseek-balance
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
param(
  [string]$Only = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$AllServices = @(
  @{ id = 'deepseek-balance' },
  @{ id = 'deepseek-recharge' }
)

$selected = if ($Only) {
  $Only.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
} else {
  $AllServices | ForEach-Object { $_.id }
}
if (-not $selected -or $selected.Count -eq 0) {
  Write-Host 'ERROR: -Only 为空。可用服务:' ($AllServices.id -join ', ') -ForegroundColor Red
  exit 1
}
$unknown = $selected | Where-Object { $AllServices.id -notcontains $_ }
if ($unknown) {
  Write-Host ('ERROR: 未知服务: ' + ($unknown -join ', ') + '。可用: ' + ($AllServices.id -join ', ')) -ForegroundColor Red
  exit 1
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

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

function Add-PatchEntry([string]$toolId, [string]$svcId) {
  $current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
  if ($current -match [regex]::Escape($toolId)) {
    Write-Host "SKIP $toolId already present in $patchFile" -ForegroundColor Yellow
    return
  }
  $entryText = @"

# --- dsh-deepseek: $svcId (native dsh) ---
# Main model stays text-only; payload: ./plugins/$svcId/index.js
- insert:
    - id: $toolId
      name: './plugins/$svcId/index.js'
"@
  $lines = ($current -split "`r?`n") | Where-Object { $_ -notmatch '^\s*\[\]\s*$' }
  $base = ($lines -join "`n").TrimEnd()
  $combined = if ($base) { $base + "`n" + $entryText.TrimStart() } else { $entryText.TrimStart() }
  [System.IO.File]::WriteAllText($patchFile, $combined, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "OK  profile patch entry added ($toolId) -> $patchFile" -ForegroundColor Green
}

if ($Uninstall) {
  foreach ($id in $selected) {
    $dir = Join-Path $profileDir ("plugins\" + $id)
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Write-Host "OK  removed $dir" -ForegroundColor Green }
    if (Test-Path $patchFile) {
      $raw = Get-Content $patchFile -Raw
      $cleaned = Remove-PatchSection $raw "dsh-deepseek: $id"
      if ($cleaned -ne $raw) {
        [System.IO.File]::WriteAllText($patchFile, $cleaned, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "OK  patch section removed (dsh-deepseek: $id)" -ForegroundColor Green
      }
    }
  }
  Write-Host 'dsh-deepseek uninstall done. Restart the web instance to take effect.' -ForegroundColor Cyan
  exit 0
}

foreach ($svc in $AllServices) {
  $id = $svc.id
  if ($selected -notcontains $id) { continue }
  $pluginDir = Join-Path $profileDir ("plugins\" + $id)
  New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
  foreach ($f in @('index.js', 'package.json')) {
    Copy-Item -Path (Join-Path $PSScriptRoot ("plugins\" + $id + "\" + $f)) -Destination $pluginDir -Force
  }
  Write-Host "OK  plugin copied -> $pluginDir" -ForegroundColor Green
  Add-PatchEntry "tool-$id" $id
}

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Make sure DEEPSEEK_API_KEY is configured (credentials service or environment variable).'
Write-Host '  2. Restart the web instance:  stop it, then run  dsh web  (or  npx @deepseek-ai/dsh web)'
Write-Host ('  3. Installed services: ' + ($selected -join ', '))
