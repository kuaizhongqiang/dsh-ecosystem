# Install selected skill bundles from this repo into the dsh user skill root.
#
# Usage (from the repo root or the skills/ directory):
#   powershell -ExecutionPolicy Bypass -File .\skills\install-skills.ps1
#   powershell -ExecutionPolicy Bypass -File .\skills\install-skills.ps1 -Skills install-describe-image
#   powershell -ExecutionPolicy Bypass -File .\skills\install-skills.ps1 -Skills install-unity-mcp,install-describe-image
#   powershell -ExecutionPolicy Bypass -File .\skills\install-skills.ps1 -DryRun
#
# Idempotent: re-running refreshes the destination copies.
# NOTE: keep all messages ASCII (English) - on ANSI/GBK consoles multi-byte
# UTF-8 tails can swallow line breaks. This file is UTF-8 without BOM.
param(
  [string[]]$Skills = @(),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$destRoot = Join-Path $dshHome 'skills'

# --- discover skill bundles (dirs containing SKILL.md) ----------------------
$bundles = Get-ChildItem -Path $PSScriptRoot -Directory | Where-Object {
  $_.Name -notlike '.*' -and (Test-Path (Join-Path $_.FullName 'SKILL.md'))
} | Sort-Object Name

if ($bundles.Count -eq 0) {
  Write-Host "ERROR: no skill bundles (dirs with SKILL.md) found under $PSScriptRoot" -ForegroundColor Red
  exit 1
}

$selected = if ($Skills.Count -gt 0) {
  $bundles | Where-Object { $Skills -contains $_.Name }
} else {
  $bundles
}

if ($selected.Count -eq 0) {
  Write-Host "ERROR: no matching skills for: $($Skills -join ', ')" -ForegroundColor Red
  Write-Host "Available: $($bundles.Name -join ', ')"
  exit 1
}

# --- copy selected bundles --------------------------------------------------
Write-Host "Installing skills to: $destRoot" -ForegroundColor Cyan
foreach ($bundle in $selected) {
  $dest = Join-Path $destRoot $bundle.Name
  if ($DryRun) {
    Write-Host "WOULD copy $($bundle.Name) -> $dest" -ForegroundColor Yellow
    continue
  }
  New-Item -ItemType Directory -Path $destRoot -Force | Out-Null
  if (Test-Path $dest) { Remove-Item -Path $dest -Recurse -Force }
  Copy-Item -Path $bundle.FullName -Destination $destRoot -Recurse -Force
  Write-Host "OK  $($bundle.Name) -> $dest" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host "  1. Skills land in the dsh user root ($destRoot), rank 400; the current or next dsh session"
Write-Host '     discovers them automatically (hot refresh).'
Write-Host '  2. Invoke: type /<skill-name> in the chat, or just ask the model,'
Write-Host '     e.g. "install the describe-image plugin".'
Write-Host '  3. To pick a subset later, pass -Skills <name>[,<name>...].'
