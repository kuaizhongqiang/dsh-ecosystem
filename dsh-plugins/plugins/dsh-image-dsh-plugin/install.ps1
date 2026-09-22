# dsh-image —— 图片生成包(Doubao Seedream 5.0,火山方舟)。
# 工具:generate_image —— 文生图 / 图生图 / 多图融合 / 组图,结果一律落盘。
# 凭证:ARK_API_KEY(credentials seam 优先,回落同名环境变量)。
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only image-gen
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#
# 幂等:载荷覆盖复制;patch 条目按 tool-<svc> 判重跳过;卸载按节头精确剥离。
param(
  [string]$Only = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$AllServices = @(
  @{ id = 'image-gen'; files = @('index.js', 'package.json') }
)

# validate-patch.mjs ships next to this script (../scripts) and is also copied
# into the profile so the check can run from either location.
$validatorSource = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'scripts\validate-patch.mjs'

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

# 写后校验:patch 条目的 YAML 若被写坏(例如 config 键被注释吞掉),插件会
# 静默跑默认值,必须在重启前发现。
function Test-ProfilePatch {
  $validator = Join-Path $profileDir 'validate-patch.mjs'
  if (-not (Test-Path $validator)) { $validator = $validatorSource }
  if (-not (Test-Path $validator)) {
    Write-Host "SKIP patch validator not found (looked in profile and $validatorSource)" -ForegroundColor Yellow
    return
  }
  try {
    node $validator $patchFile
    if ($LASTEXITCODE -ne 0) { Write-Host 'WARN patch validation found a problem; fix the file before restarting' -ForegroundColor Yellow }
  } catch {
    Write-Host "WARN could not validate the patch (node unavailable): $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Add-PatchEntry([string]$toolId, [string]$svcId) {
  $current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
  if ($current -match [regex]::Escape($toolId)) {
    Write-Host "SKIP $toolId already present in $patchFile" -ForegroundColor Yellow
    return
  }
  # dsh 初始化的 cordis.patch.yml 是裸 "[]";直接追加会产生非法 YAML,先剥离空数组行再合并。
  $entryText = @"

# --- dsh-image: $svcId (native dsh) ---
# Doubao Seedream 5.0 image generation; payload: ./plugins/$svcId/index.js
- insert:
    - id: $toolId
      name: './plugins/$svcId/index.js'
"@
  $lines = ($current -split "`r?`n") | Where-Object { $_ -notmatch '^\s*\[\]\s*$' }
  $base = ($lines -join "`n").TrimEnd()
  $combined = if ($base) { $base + "`n" + $entryText.TrimStart() } else { $entryText.TrimStart() }
  [System.IO.File]::WriteAllText($patchFile, $combined, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "OK  profile patch entry added ($toolId) -> $patchFile" -ForegroundColor Green
  Test-ProfilePatch
}

# --- Uninstall 分支 -----------------------------------------------------------
if ($Uninstall) {
  foreach ($id in $selected) {
    $dir = Join-Path $profileDir ("plugins\" + $id)
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Write-Host "OK  removed $dir" -ForegroundColor Green }
    if (Test-Path $patchFile) {
      $raw = Get-Content $patchFile -Raw
      $cleaned = Remove-PatchSection $raw "dsh-image: $id"
      if ($cleaned -ne $raw) {
        [System.IO.File]::WriteAllText($patchFile, $cleaned, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "OK  patch section removed (dsh-image: $id)" -ForegroundColor Green
      }
    }
  }
  Write-Host ''
  Test-ProfilePatch
  Write-Host 'dsh-image uninstall done. Restart the web instance to take effect.' -ForegroundColor Cyan
  exit 0
}

# --- 1. Copy payloads + patch entries ----------------------------------------
# The validator rides along in the profile so uninstall (and later re-runs) can
# check the file without the repository checkout present.
if (Test-Path $validatorSource) {
  Copy-Item -Path $validatorSource -Destination $profileDir -Force
  Write-Host 'OK  validate-patch.mjs copied to profile' -ForegroundColor Green
} else {
  Write-Host "SKIP patch validator not found at $validatorSource" -ForegroundColor Yellow
}
foreach ($svc in $AllServices) {
  $id = $svc.id
  if ($selected -notcontains $id) { continue }
  $pluginDir = Join-Path $profileDir ("plugins\" + $id)
  New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
  foreach ($f in $svc.files) {
    Copy-Item -Path (Join-Path $PSScriptRoot ("plugins\" + $id + "\" + $f)) -Destination $pluginDir -Force
  }
  $version = (Get-Content (Join-Path $PSScriptRoot ("plugins\" + $id + "\package.json")) -Raw | ConvertFrom-Json).version
  Write-Host "OK  plugin copied -> $pluginDir  (v$version)" -ForegroundColor Green
  Add-PatchEntry "tool-$id" $id
}

# --- 2. Reminders -------------------------------------------------------------
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Set ARK_API_KEY (Volcengine Ark console -> API Key) through the credentials'
Write-Host '     service or as an environment variable. Without it the tool answers with a'
Write-Host '     clear error; nothing else breaks.'
Write-Host '  2. Restart the web instance:  stop it, then run  dsh web  (or  npx @deepseek-ai/dsh web)'
Write-Host ('  3. Installed services: ' + ($selected -join ', '))
Write-Host '  4. Verify in chat: "draw a picture of ..." -> generate_image, or ask for'
Write-Host '     "把这张图改成铅笔画" with a local file path to exercise image2image.'
