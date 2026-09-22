# uninstall-old.ps1 —— PM2 迁移脚本:清理 7 个 deprecated 旧包(audio-read/audio-speak/
# describe-image/video-read/document-read/deepseek-balance/deepseek-recharge)。
#
# 动作:
#   1. 删除 %DSH_HOME%\profiles\web\plugins\<svc> 旧载荷目录;
#   2. 从 cordis.patch.yml 剥离旧 patch 节(按旧节头精确匹配);
#   3. 清理旧技能目录 —— **默认执行**,`-KeepSkills` 可保留。
#
# 为什么技能清理默认化(issue #31):技能是「给 Agent 看的安装说明书」。仓库侧删除旧包只是
# 删掉了货源,本机若还留着 `install-<old>`,会话里说一句「装 describe-image」就可能把已下线
# 的服务装回去(而旧包已不在仓库,会装到一份来路不明的载荷)。因此迁移必须连技能一起清。
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\uninstall-old.ps1
#   powershell -ExecutionPolicy Bypass -File .\uninstall-old.ps1 -KeepSkills
#
# 注意:先安装新合并包(dsh-media / dsh-deepseek / dsh-launcher)再运行本脚本,避免服务真空期。

param([switch]$KeepSkills)

$ErrorActionPreference = 'Stop'

$old = @(
  @{ svc = 'audio-read';      header = 'audio reading tools (native dsh)' },
  @{ svc = 'audio-speak';     header = 'speak_text tool (native dsh)' },
  @{ svc = 'describe-image';  header = 'describe_image tool (native dsh)' },
  @{ svc = 'video-read';      header = 'read_video tool (native dsh)' },
  @{ svc = 'document-read';   header = 'read_document tool (native dsh)' },
  @{ svc = 'deepseek-balance';  header = 'deepseek_balance tool (native dsh)' },
  @{ svc = 'deepseek-recharge'; header = 'deepseek_recharge tool (native dsh)' }
)

$oldSkills = @(
  'install-audio-read', 'install-audio-speak', 'install-describe-image',
  'install-video-read', 'install-document-read',
  'install-deepseek-balance', 'install-deepseek-recharge'
)

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$skillsDir = Join-Path $dshHome 'skills'

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

Write-Host "清理 deprecated 旧包(DSH_HOME=$dshHome)……" -ForegroundColor Cyan
foreach ($t in $old) {
  $svc = $t.svc
  $dir = Join-Path $profileDir ("plugins\" + $svc)
  if (Test-Path $dir) {
    Remove-Item $dir -Recurse -Force
    Write-Host "OK  removed payload $svc" -ForegroundColor Green
  } else {
    Write-Host "SKIP payload not present: $svc" -ForegroundColor Yellow
  }
  if (Test-Path $patchFile) {
    $raw = Get-Content $patchFile -Raw
    $cleaned = Remove-PatchSection $raw $t.header
    if ($cleaned -ne $raw) {
      [System.IO.File]::WriteAllText($patchFile, $cleaned, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "OK  patch section removed: $($t.header)" -ForegroundColor Green
    } else {
      Write-Host "SKIP patch section not present: $($t.header)" -ForegroundColor Yellow
    }
  }
}

$leftoverSkills = @($oldSkills | Where-Object { Test-Path (Join-Path $skillsDir $_) })
if ($KeepSkills) {
  if ($leftoverSkills.Count -gt 0) {
    Write-Host ''
    Write-Host "-KeepSkills:保留 $($leftoverSkills.Count) 个旧技能:" -ForegroundColor Yellow
    foreach ($s in $leftoverSkills) { Write-Host "    $s" -ForegroundColor Yellow }
    Write-Host '  注意:只要它们还在,会话里仍可能据此装回已下线的旧包。' -ForegroundColor Yellow
  }
} else {
  Write-Host ''
  foreach ($s in $oldSkills) {
    $d = Join-Path $skillsDir $s
    if (Test-Path $d) {
      Remove-Item $d -Recurse -Force
      Write-Host "OK  removed skill $s" -ForegroundColor Green
    } else {
      Write-Host "SKIP skill not present: $s" -ForegroundColor Yellow
    }
  }
}

Write-Host ''
Write-Host '完成。请重启 web 实例生效;新合并包见 plugins/dsh-media-dsh-plugin 与 plugins/dsh-deepseek-dsh-plugin。' -ForegroundColor Cyan
