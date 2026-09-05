# Install the A-share stock analysis tools into a native dsh installation.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Steps:
#   1. Locate $DSH_HOME (defaults to ~/.dsh) and the web profile.
#   2. Copy plugins/stock (index.js + package.json) into the profile.
#   3. Add the profile patch entry (idempotent: skipped when already present).
#   4. Remind the user to restart the web instance.
#
# No API key needed: data comes from Tencent public quote endpoints.
$ErrorActionPreference = 'Stop'

# --- 0. Prerequisites ------------------------------------------------------
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$pluginDir = Join-Path $profileDir 'plugins\stock'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$version = (Get-Content (Join-Path $PSScriptRoot 'plugins\stock\package.json') -Raw | ConvertFrom-Json).version

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

# --- 1. Copy the plugin ----------------------------------------------------
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\stock\index.js') -Destination $pluginDir -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\stock\package.json') -Destination $pluginDir -Force
Write-Host "OK  plugin copied -> $pluginDir  (v$version)" -ForegroundColor Green

# --- 2. Add the profile patch entry (idempotent) ---------------------------
$entryText = @'

# --- stock analysis tools (native dsh) ---
# stock_quote / stock_kline / stock_indicators / stock_market_overview /
# watchlist_add|remove|list / stock_daily_collect / stock_report.
# Data from Tencent public endpoints (no key); user data under %DSH_HOME%\stock.
- insert:
    - id: tool-stock
      name: './plugins/stock/index.js'
'@
$current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
if ($current -match 'tool-stock') {
  Write-Host "SKIP profile patch entry already present in $patchFile" -ForegroundColor Yellow
} else {
  # dsh initializes cordis.patch.yml with a bare "[]" (empty-array placeholder).
  # Appending entries after it would produce invalid YAML, so strip that line
  # and merge the entry into the existing list. Written UTF-8 without BOM.
  $lines = ($current -split "`r?`n") | Where-Object { $_ -notmatch '^\s*\[\]\s*$' }
  $base = ($lines -join "`n").TrimEnd()
  $combined = if ($base) { $base + "`n" + $entryText.TrimStart() } else { $entryText.TrimStart() }
  [System.IO.File]::WriteAllText($patchFile, $combined, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "OK  profile patch entry added -> $patchFile" -ForegroundColor Green
}

# --- 3. Optional config reminder -------------------------------------------
Write-Host ''
Write-Host 'Optional config (edit the tool-stock entry in cordis.patch.yml):' -ForegroundColor Cyan
Write-Host '  config:'
Write-Host '    klineDays: 150              # daily K-line cache depth (max 150)'
Write-Host '    dataRoot: C:/path/to/stock  # user data dir (default %DSH_HOME%\stock)'
Write-Host '    timeoutMs: 15000            # per-request timeout'

# --- 4. Restart reminder ----------------------------------------------------
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Restart the web instance:  stop it, then run  dsh web  (or  npx @deepseek-ai/dsh web)'
Write-Host "  2. Verify in chat: '茅台现在什么价？' (stock_quote) or '今天大盘怎么样？' (stock_market_overview)."
