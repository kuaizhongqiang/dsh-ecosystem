# install.ps1 — agent-modes-dsh-plugin
#
# 把 7 个阶段模式的 preset 声明合并进目标 profile 的 cordis.patch.yml。
# 本包是**声明型**插件:载荷不是 index.js,而是 presets/cordis.patch.yml 这份
# YAML 片段(preset 声明)。因此安装动作 = 片段追加,而不是复制插件目录。
#
# profile:省略 -ProfileName 时自动解析(见下方「目标 profile 解析」),与
# dsh-continuity/install.ps1 同一套规范,不再写死 profiles\web。web 与桌面版是各自
# 独立的 profile 目录(%DSH_HOME%\profiles\<profile>),preset 声明必须分别安装。
#
# 规范:docs/PLUGIN-SPEC.md §4(幂等 / -Only 子集 / -Uninstall / 节头)。
#
# ⚠️ 本文件必须保留 UTF-8 BOM。Windows PowerShell 5.1 读无 BOM 文件时按 ANSI(GBK)
# 解码,中文注释会吞掉紧随其后的 ` / { / } 等字节,导致脚本整体解析失败
# (实测报 3 处 Missing closing)。加 BOM 后 ps5.1 解析干净。
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfileName desktop
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall [-ProfileName desktop]
#
# -ProfileName 省略(默认)时自动解析正在运行的 profile:显式值 ->
# $env:DSH_PROFILE / $env:DSH_PROFILE_DIR -> 进程祖先链 -> 唯一候选 -> 兜底 web。
param(
  [string]$Only = '',
  [string]$ProfileName = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# ⚠️ 一律显式按 UTF-8 读写文本文件。Windows PowerShell 5.1 的 Get-Content 对无 BOM
# 文件按 ANSI(GBK) 解码,中文行尾字节会与换行符配对,把整行连同换行一起吞掉 ——
# YAML 片段被拼成一行、profile patch 里既有的中文注释被破坏。实测踩到过。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Read-TextUtf8([string]$path) { return [System.IO.File]::ReadAllText($path, $utf8NoBom) }

$Pkg = 'dsh-agent-modes'

# 单服务包:一个安装单元 = 全部 7 个模式。保留 -Only 以符合规范,但不提供逐模式子集
# ——任一模式单独安装都会让 install.ps1 的判重锚点(preset-clarify)与卸载边界失准。
$AllServices = @('agent-modes')

# 判重锚点:patch 里出现这个 preset 行即视为已安装。
$MarkerId = 'preset-clarify'
$SectionHeader = "# --- ${Pkg}: agent-modes (native dsh) ---"
$FragmentPath = Join-Path $PSScriptRoot 'presets\cordis.patch.yml'

if (-not (Test-Path $FragmentPath)) { Write-Host "ERROR: 缺少载荷 $FragmentPath" -ForegroundColor Red; exit 1 }

$selected = if ($Only) { $Only.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } } else { $AllServices }
if (-not $selected -or $selected.Count -eq 0) { Write-Host 'ERROR: -Only 为空' -ForegroundColor Red; exit 1 }
$unknown = $selected | Where-Object { $AllServices -notcontains $_ }
if ($unknown) { Write-Host ('ERROR: 未知服务: ' + ($unknown -join ', ') + ' (可用: ' + ($AllServices -join ', ') + ')') -ForegroundColor Red; exit 1 }

# --- 目标 profile 解析(照搬 dsh-continuity/install.ps1 的现行规范)----------------
# 血泪教训:本机同时存在 profiles\web 与 profiles\desktop,桌面宿主跑的是 desktop,
# 而长期硬编码 profiles\web 的安装器会把插件装进没人加载的 profile,表现是
# "装完了但模式不存在"。解析顺序(先命中先用):
#   1) -ProfileName <name>
#   2) $env:DSH_PROFILE / $env:DSH_PROFILE_DIR(会话内由 dsh-shell-env 注入,最可靠)
#   3) 进程祖先链命令行里的 profiles\<name>(在会话里跑安装器时命中)
#   4) $dshHome\profiles 下唯一一个带 cordis.patch.yml 的 profile
#   5) 兜底 web + 大声警告(多 profile 时必须显式 -ProfileName)
function Resolve-ProfileName([string]$explicit, [string]$dshHomePath) {
  $profilesRoot = Join-Path $dshHomePath 'profiles'
  # 每个候选都要验证「该 profile 真的存在」——陈旧的 DSH_PROFILE(例如在临时
  # DSH_HOME 下复用当前 shell 的环境变量)不能把一个不存在的 profile 顶上来。
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
  # 唯一候选(只有一个 profile 出现过)→ 直接用,不必让用户显式指定。
  $dirs = @(Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'cordis.patch.yml') })
  if ($dirs.Count -eq 1) { return $dirs[0].Name }
  # 显式指定但目录不存在:返回它,让后面的报错直说「profile X not found」。
  if ($explicit) { return $explicit }
  return ''
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileName = Resolve-ProfileName $ProfileName $dshHome

if (-not (Test-Path (Join-Path $dshHome 'profiles'))) { Write-Host 'ERROR: no dsh profiles. Install dsh first.' -ForegroundColor Red; exit 1 }
if (-not $profileName) {
  $available = (@(Get-ChildItem (Join-Path $dshHome 'profiles') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'cordis.patch.yml') }).Name) -join ', '
  Write-Host "WARN 无法确定正在运行的 profile(候选: $available),回退到 web。" -ForegroundColor Yellow
  Write-Host '     多 profile 机器请显式指定:-ProfileName <name>(会话内安装时通常能自动识别)' -ForegroundColor Yellow
  $profileName = 'web'
}
$profileDir = Join-Path $dshHome ("profiles\" + $profileName)
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
Write-Host "profile: $profileName -> $profileDir" -ForegroundColor Cyan
if (-not (Test-Path $profileDir)) { Write-Host "ERROR: profile '$profileName' 不存在;先启动一次对应的 dsh(dsh web / 桌面版)完成初始化。" -ForegroundColor Red; exit 1 }

# 互斥检查:同一批 preset 若已作为 bundle 安装,再写进 patch 会撞重复 id。
# 针对**解析出来的** profile($profileDir)检查。
$profilePkg = Join-Path $profileDir 'package.json'
if (Test-Path $profilePkg) {
  $pkgJson = Read-TextUtf8 $profilePkg
  if ($pkgJson -match '@local/dsh-agent-modes') {
    Write-Host "ERROR: 检测到 @local/dsh-agent-modes 已作为 bundle 安装在 profile '$profileName'。" -ForegroundColor Red
    Write-Host '       两条安装路径不能同时存在(preset id 会重复)。' -ForegroundColor Red
    Write-Host '       先移除 bundle:在 dsh 会话里调用 plugin_manager remove_bundle @local/dsh-agent-modes,' -ForegroundColor Red
    Write-Host '       然后重跑本脚本。' -ForegroundColor Red
    exit 1
  }
}

# 剥离本包节。不要只认「注释 / `- insert:` / " - " 列表项」—— preset 载荷里有
# name: / config: / plugins: 这类更深缩进的映射键,那样会在第一个键上就停止剥离,
# 把 YAML 主体留在文件里(实测报 bad indentation of a mapping entry)。
# 规则:跳过空行、缩进行、注释行、顶层 `- insert:`;遇到非注释的非缩进行,或另一个
# 节头 banner,则本节结束。
function Remove-PatchSection([string]$text, [string]$header) {
  $lines = $text -split "`r?`n"
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($l in $lines) {
    if (-not $skip -and $l -match '^\s*#\s*---\s*' -and $l -like "*$header*") { $skip = $true; continue }
    if ($skip) {
      $isForeignBanner = ($l -match '^\s*#\s*---\s*') -and ($l -notlike "*$header*")
      if (-not $isForeignBanner) {
        $isBlank = $l.Trim() -eq ''
        $isIndented = $l -match '^\s+\S'
        $isComment = $l -match '^\s*#'
        $isTopLevelInsert = $l -match '^- insert:'
        if ($isBlank -or $isIndented -or $isComment -or $isTopLevelInsert) { continue }
      }
      $skip = $false
    }
    [void]$out.Add($l)
  }
  return (($out -join "`n").TrimEnd())
}

# 结构门:与 profile 用的是同一份校验器(dsh-plugins/scripts/validate-patch.mjs)。
$validator = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'scripts\validate-patch.mjs'

function Assert-PatchValid([string]$content, [string]$label) {
  if (-not (Test-Path $validator)) { Write-Host "WARN 未找到校验器,跳过结构门: $validator" -ForegroundColor Yellow; return }
  $tmp = Join-Path $env:TEMP ('agent-modes-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.yml')
  try {
    [System.IO.File]::WriteAllText($tmp, $content, (New-Object System.Text.UTF8Encoding($false)))
    $out = & node $validator $tmp 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      Write-Host "ERROR: 结构门未通过($label),未写入任何改动。" -ForegroundColor Red
      Write-Host $out
      exit 1
    }
    Write-Host "OK  结构门通过($label)" -ForegroundColor Green
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

$current = if (Test-Path $patchFile) { Read-TextUtf8 $patchFile } else { '' }

if ($Uninstall) {
  if (-not $current) { Write-Host 'SKIP patch 为空' -ForegroundColor Yellow; exit 0 }
  $cleaned = Remove-PatchSection $current "$Pkg`: agent-modes"
  if ($cleaned -eq $current) { Write-Host 'SKIP 未发现本包节' -ForegroundColor Yellow; exit 0 }
  Assert-PatchValid $cleaned 'uninstall'
  [System.IO.File]::WriteAllText($patchFile, $cleaned, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host 'OK  已剥离 agent-modes 节' -ForegroundColor Green
  Write-Host "Next: 重启 dsh(${profileName}) 使改动生效。" -ForegroundColor Cyan
  exit 0
}

if ($current -match [regex]::Escape($MarkerId)) {
  Write-Host "SKIP $MarkerId 已存在,本包已安装" -ForegroundColor Yellow
  exit 0
}

# 归一化换行:载荷在 git 上以 LF 存储,Windows 检出可能是 CRLF;profile patch 一律用 LF。
$fragment = ((Read-TextUtf8 $FragmentPath) -replace "`r`n", "`n").TrimEnd()
$entryText = "`n$SectionHeader`n# payload: ./presets/cordis.patch.yml (7 个 preset 声明)" + "`n" + $fragment + "`n"
# 剥掉裸 [] 占位行后按序列追加
$lines = ($current -split "`r?`n") | Where-Object { $_ -notmatch '^\s*\[\]\s*$' }
$base = ($lines -join "`n").TrimEnd()
$combined = if ($base) { $base + "`n" + $entryText } else { $entryText.TrimStart() }

Assert-PatchValid $combined 'install'
[System.IO.File]::WriteAllText($patchFile, $combined, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "OK  已写入 7 个 preset 声明 -> $patchFile" -ForegroundColor Green
Write-Host "    模式: 需求 / 文档·写 / 文档·审 / 设计·美化 / 实现 / 测试反馈 / 交付·仓库" -ForegroundColor Gray
Write-Host "Next: 重启 dsh(${profileName}),然后新建会话在模式选择器里确认 7 个模式。" -ForegroundColor Cyan
