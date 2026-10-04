# dsh-continuity —— 任务连续性域（第 8 包，2026-10-04 立项）。
#
# 域定义：任务不因「载体」更替而中断。载体 = 会话 / 上下文窗口 / 进程。
# v1 只交付一个服务：
#   handoff —— /handoff 命令 + handoff_start 工具：确定性交接文档 → 同 workspace
#              新开会话 → 克隆 goal（轮次归零）→ 播种首条消息并自动开跑。
# 预期后续（仍属本域，届时按 PLUGIN-SPEC §2 复用本包，不另开）：restart 恢复、
# 跨会话 resume 索引、brief 自动维护、历史任务召回。
#
# 无凭证、无外部系统：只用 dsh 自身的 session/goal/plan/sessionProjections seam。
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfileName desktop
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only handoff
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#
# 幂等：载荷覆盖复制；patch 条目按 tool-<svc> 判重跳过；卸载按节头精确剥离。
param(
  [string]$Only = '',
  [string]$ProfileName = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$pkg = 'dsh-continuity'
$AllServices = @(
  @{ id = 'handoff'; files = @('index.js', 'core.js', 'package.json') }
)

# validate-patch.mjs（repo scripts/ 下）也复制进 profile，便于脱离 checkout 复检。
$validatorSource = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'scripts\validate-patch.mjs'

# --- 解析 -Only ---------------------------------------------------------------
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

# --- 0. 前置 ------------------------------------------------------------------
# 目标 profile 解析（2026-10-04 补，血泪教训）：
# 本机同时存在 profiles\web 与 profiles\desktop，桌面宿主跑的是 **desktop**，而
# install.ps1 长期硬编码 profiles\web —— 插件装进了没人加载的 profile，表现是
# "装完了但工具不存在"。解析顺序（先命中先用）：
#   1) -ProfileName <name>
#   2) $env:DSH_PROFILE / $env:DSH_PROFILE_DIR（会话内由 dsh-shell-env 注入，最可靠）
#   3) 进程祖先链命令行里的 profiles\<name>（在会话里跑安装器时命中）
#   4) $dshHome\profiles 下唯一一个带 cordis.patch.yml 的 profile
#   5) 兜底 web + 大声警告（多 profile 时必须显式 -ProfileName）
function Resolve-ProfileName([string]$explicit, [string]$dshHomePath) {
  $profilesRoot = Join-Path $dshHomePath 'profiles'
  # 每个候选都要验证「该 profile 真的存在」——陈旧的 DSH_PROFILE（例如在临时
  # DSH_HOME 下复用当前 shell 的环境变量）不能把一个不存在的 profile 顶上来。
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($explicit) { [void]$candidates.Add($explicit) }
  if ($env:DSH_PROFILE) { [void]$candidates.Add($env:DSH_PROFILE) }
  if ($env:DSH_PROFILE_DIR -and $env:DSH_PROFILE_DIR -match 'profiles[\\/]([^\\/]+?)[\\/]?$') { [void]$candidates.Add($Matches[1]) }
  try {
    $cur = $PID
    for ($i = 0; $i -lt 8; $i++) {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
      if (-not $proc) { break }
      if ($proc.CommandLine -and $proc.CommandLine -match 'profiles[\\/]([A-Za-z0-9._-]+)') { [void]$candidates.Add($Matches[1]); break }
      $cur = $proc.ParentProcessId
      if (-not $cur) { break }
    }
  } catch { }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path (Join-Path $profilesRoot ($candidate + '\cordis.patch.yml')))) { return $candidate }
  }
  # 唯一候选（只有一个 profile 出现过）→ 直接用，不必让用户显式指定。
  $dirs = @(Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'cordis.patch.yml') })
  if ($dirs.Count -eq 1) { return $dirs[0].Name }
  # 显式指定但目录不存在：返回它，让后面的报错直说「profile X not found」。
  if ($explicit) { return $explicit }
  return ''
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileName = Resolve-ProfileName $ProfileName $dshHome

if (-not (Test-Path (Join-Path $dshHome 'profiles'))) {
  Write-Host "ERROR: no dsh profiles found under $dshHome. Is dsh installed?" -ForegroundColor Red
  Write-Host 'Install dsh first:  npm install -g @deepseek-ai/dsh   (or run via npx @deepseek-ai/dsh)'
  exit 1
}
if (-not $profileName) {
  $available = (@(Get-ChildItem (Join-Path $dshHome 'profiles') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'cordis.patch.yml') }).Name) -join ', '
  Write-Host "WARN 无法确定正在运行的 profile（候选: $available），回退到 web。" -ForegroundColor Yellow
  Write-Host '     多 profile 机器请显式指定：-ProfileName <name>（会话内安装时通常能自动识别）' -ForegroundColor Yellow
  $profileName = 'web'
}
$profileDir = Join-Path $dshHome ("profiles\" + $profileName)
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
Write-Host "profile: $profileName -> $profileDir" -ForegroundColor Cyan

if (-not (Test-Path $profileDir)) {
  Write-Host "ERROR: profile '$profileName' not found at $profileDir" -ForegroundColor Red
  Write-Host 'Boot it once with:  dsh web   (or  npx @deepseek-ai/dsh web)'
  exit 1
}

# --- 节工具函数 ---------------------------------------------------------------
# 注意：所有 Get-Content 必须带 -Encoding UTF8。Windows PowerShell 5.1 默认按
# ANSI 代码页解码，再以 UTF-8 回写会把 patch 文件里的中文注释逐次写坏
# （2026-10-04 实测：每跑一次 +301 字节）。14 个旧安装器已同批修复。
function Remove-PatchSection([string]$text, [string]$header) {
  $lines = $text -split "`r?`n"
  $out = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  $blockIndent = -1
  foreach ($l in $lines) {
    if (-not $skipping) {
      if ($l -match '^\s*#\s*---\s*' -and $l -like "*$header*") { $skipping = $true; continue }
      [void]$out.Add($l)
      continue
    }
    # Inside the section being removed: a new section header ends it, and its own
    # comments belong to it.
    if ($l -match '^\s*#\s*---\s*') { $skipping = $false; $blockIndent = -1; [void]$out.Add($l); continue }
    if ($l -match '^\s*#') { continue }
    if ($l.Trim() -eq '') { continue }
    if ($l -match '^\s*- insert:\s*$') { $blockIndent = ($l.Length - $l.TrimStart().Length); continue }
    if ($blockIndent -ge 0 -and ($l.Length - $l.TrimStart().Length) -gt $blockIndent) { continue }
    # Anything else is outside the section: keep it and stop skipping.
    $skipping = $false
    $blockIndent = -1
    [void]$out.Add($l)
  }
  return (($out -join "`n").TrimEnd())
}

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

function Add-PatchEntry([string]$svcId, [string]$toolId) {
  $current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw -Encoding UTF8 } else { '' }
  if ($current -match [regex]::Escape($toolId)) {
    Write-Host "SKIP $toolId already present in $patchFile" -ForegroundColor Yellow
    return
  }
  # dsh 初始化的 cordis.patch.yml 是裸 "[]"；直接追加会产生非法 YAML，先剥离空数组行。
  $entryText = @"

# --- ${pkg}: $svcId (native dsh) ---
# Task continuity: write a deterministic handoff brief, open a new session in the
# same workspace, clone the goal (rounds reset), then seed and start it.
# Payload: ./plugins/$svcId/index.js
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

# --- Uninstall ---------------------------------------------------------------
if ($Uninstall) {
  foreach ($id in $selected) {
    $dir = Join-Path $profileDir ("plugins\" + $id)
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Write-Host "OK  removed $dir" -ForegroundColor Green }
    if (Test-Path $patchFile) {
      $raw = Get-Content $patchFile -Raw -Encoding UTF8
      $cleaned = Remove-PatchSection $raw "${pkg}: $id"
      if ($cleaned -ne $raw) {
        [System.IO.File]::WriteAllText($patchFile, $cleaned, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "OK  patch section removed (${pkg}: $id)" -ForegroundColor Green
      }
    }
  }
  Write-Host ''
  Test-ProfilePatch
  Write-Host 'dsh-continuity uninstall done. Restart the web instance to take effect.' -ForegroundColor Cyan
  exit 0
}

# --- 1. 复制载荷 + 写 patch 条目 ----------------------------------------------
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
  Write-Host "OK  plugin copied -> $pluginDir" -ForegroundColor Green
  Add-PatchEntry $id "tool-$id"
}

# --- 2. 收尾提示 --------------------------------------------------------------
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Restart the web instance (launcher_restart, or stop it and run  dsh web).'
Write-Host '  2. After restart, in any session:  /handoff  (dry run:  /handoff --dry-run)'
Write-Host ('  3. Installed services: ' + ($selected -join ', '))
Write-Host "  Handoff briefs land in: $dshHome\handoff\<workspace>\"
Write-Host '  No credentials required.'
