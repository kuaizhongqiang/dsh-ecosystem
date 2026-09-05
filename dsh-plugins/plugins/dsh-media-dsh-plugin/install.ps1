# dsh-media —— 感知类合并包（PM2,路线图 §8 11→7）。
# 合并自:audio-read / audio-speak / describe-image / video-read / document-read
# 共享凭证/模式:MIMO_API_KEY(+ vision 端点);「主模型保持 text-only + 外挂感知」。
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1                          # 全部 5 个服务
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only audio-read,video-read
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall -Only audio-read
#
# 幂等:载荷覆盖复制;patch 条目按 tool-<svc> 判重跳过;卸载按节头精确剥离。
param(
  [string]$Only = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$AllServices = @(
  @{ id = 'audio-read';     files = @('index.js', 'package.json') },
  @{ id = 'audio-speak';    files = @('index.js', 'package.json') },
  @{ id = 'describe-image'; files = @('index.js', 'package.json'); apiproxy = $true },
  @{ id = 'video-read';     files = @('index.js', 'package.json') },
  @{ id = 'document-read';  files = @('index.js', 'package.json', 'parse_document.py'); python = $true }
)

# --- 解析 --only -------------------------------------------------------------
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

# --- 0. Prerequisites --------------------------------------------------------
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

if (-not (Test-Path (Join-Path $dshHome 'profiles'))) {
  Write-Host "ERROR: no dsh profiles found under $dshHome. Is dsh installed?" -ForegroundColor Red
  Write-Host 'Install dsh first:  npm install -g @deepseek-ai/dsh   (or run via npx @deepseek-ai/dsh)'
  exit 1
}
if (-not (Test-Path $profileDir)) {
  Write-Host "ERROR: web profile not found at $profileDir" -ForegroundColor Red
  Write-Host 'Boot it once with:  dsh web   (or  npx @deepseek-ai/dsh web)'
  exit 1
}

# --- section 工具函数 ---------------------------------------------------------
# 从 cordis.patch.yml 文本中剥离一个节(从节头注释起,至块内注释/insert/id/name/空行结束)。
function Remove-PatchSection([string]$text, [string]$header) {
  $lines = $text -split "`r?`n"
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($l in $lines) {
    if (-not $skip -and $l -match '^\s*#\s*---\s*' -and $l -like "*$header*") { $skip = $true; continue }
    if ($skip) {
      if ($l -match '^\s*#' -or $l -match '^\s*- insert:' -or $l -match '^\s+- ' -or $l.Trim() -eq '') { continue }
      $skip = $false   # 未知内容:停止剥离(安全)
    }
    [void]$out.Add($l)
  }
  return (($out -join "`n").TrimEnd())
}

function Add-PatchEntry([string]$header, [string]$toolId, [string]$svcId) {
  $current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
  if ($current -match [regex]::Escape($toolId)) {
    Write-Host "SKIP $toolId already present in $patchFile" -ForegroundColor Yellow
    return
  }
  # dsh 初始化的 cordis.patch.yml 是裸 "[]";直接追加会产生非法 YAML,先剥离空数组行再合并。
  $entryText = @"

# --- dsh-media: $header (native dsh) ---
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

# --- Uninstall 分支 -----------------------------------------------------------
if ($Uninstall) {
  foreach ($id in $selected) {
    $dir = Join-Path $profileDir ("plugins\" + $id)
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Write-Host "OK  removed $dir" -ForegroundColor Green }
    if (Test-Path $patchFile) {
      $raw = Get-Content $patchFile -Raw
      $cleaned = Remove-PatchSection $raw "dsh-media: $id"
      if ($cleaned -ne $raw) {
        [System.IO.File]::WriteAllText($patchFile, $cleaned, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "OK  patch section removed (dsh-media: $id)" -ForegroundColor Green
      }
    }
  }
  Write-Host ''
  Write-Host 'dsh-media uninstall done. Restart the web instance to take effect.' -ForegroundColor Cyan
  exit 0
}

# --- 1. Copy payloads + patch entries ----------------------------------------
foreach ($svc in $AllServices) {
  $id = $svc.id
  if ($selected -notcontains $id) { continue }
  $pluginDir = Join-Path $profileDir ("plugins\" + $id)
  New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
  foreach ($f in $svc.files) {
    Copy-Item -Path (Join-Path $PSScriptRoot ("plugins\" + $id + "\" + $f)) -Destination $pluginDir -Force
  }
  Write-Host "OK  plugin copied -> $pluginDir" -ForegroundColor Green
  Add-PatchEntry $id "tool-$id" $id

  if ($svc.apiproxy) {
    # describe-image:apiproxy 提示补丁(可重跑;失败仅告警)
    $patchScript = Join-Path $PSScriptRoot 'patch-apiproxy.mjs'
    Copy-Item -Path $patchScript -Destination $profileDir -Force
    Write-Host 'OK  patch-apiproxy.mjs copied to profile' -ForegroundColor Green
    Push-Location $profileDir
    try {
      node .\patch-apiproxy.mjs
      if ($LASTEXITCODE -ne 0) { Write-Host 'WARN apiproxy patch failed (npm version may differ); see output above' -ForegroundColor Yellow }
    } finally {
      Pop-Location
    }
  }
  if ($svc.python) {
    # document-read:python 解析依赖探测(可选)
    Write-Host ''
    Write-Host 'Python parser libraries (python-docx / openpyxl / PyMuPDF):' -ForegroundColor Cyan
    $py = if ($env:PYTHON) { $env:PYTHON } else { 'python' }
    try {
      $out = & $py -c "import docx, openpyxl, fitz; print('ok')" 2>&1
      if ($LASTEXITCODE -eq 0 -and ($out -join '') -match 'ok') {
        Write-Host 'OK  python-docx, openpyxl and PyMuPDF already available' -ForegroundColor Green
      } else {
        Write-Host 'WARN missing python libs. Install:  python -m pip install python-docx openpyxl PyMuPDF' -ForegroundColor Yellow
      }
    } catch {
      Write-Host "WARN could not probe python: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

# --- 2. Reminders -------------------------------------------------------------
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Make sure MIMO_API_KEY is configured (credentials service or environment variable);'
Write-Host '     describe-image / document-read also accept a vision endpoint config.'
Write-Host '  2. Restart the web instance:  stop it, then run  dsh web  (or  npx @deepseek-ai/dsh web)'
Write-Host ('  3. Installed services: ' + ($selected -join ', '))
