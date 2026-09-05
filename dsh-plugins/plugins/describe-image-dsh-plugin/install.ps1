# Install the describe_image tool into a native dsh installation.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Steps:
#   1. Locate $DSH_HOME (defaults to ~/.dsh) and the web profile.
#   2. Copy plugins/describe-image into the profile.
#   3. Add the profile patch entry (idempotent: skipped when already present).
#   4. Apply the apiproxy hint patch (idempotent: re-runnable).
#   5. Remind the user to restart the web instance.
$ErrorActionPreference = 'Stop'

# --- 0. Prerequisites ------------------------------------------------------
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$pluginDir = Join-Path $profileDir 'plugins\describe-image'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$version = (Get-Content (Join-Path $PSScriptRoot 'plugins\describe-image\package.json') -Raw | ConvertFrom-Json).version

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
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\describe-image\index.js') -Destination $pluginDir -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\describe-image\package.json') -Destination $pluginDir -Force
Write-Host "OK  plugin copied -> $pluginDir  (v$version)" -ForegroundColor Green

# --- 2. Add the profile patch entry (idempotent) ---------------------------
$entryText = @'

# --- describe_image tool (native dsh) ---
# The main model stays text-only; it calls describe_image to read an image
# (attachmentId or path) through a configurable OpenAI-compatible vision
# endpoint (Xiaomi MiMo by default).
- insert:
    - id: tool-describe-image
      name: './plugins/describe-image/index.js'
'@
$current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
if ($current -match 'tool-describe-image') {
  Write-Host "SKIP profile patch entry already present in $patchFile" -ForegroundColor Yellow
} else {
  # dsh initializes cordis.patch.yml with a bare "[]" (empty-array placeholder).
  # Appending entries after it would produce invalid YAML (js-yaml / cordis both
  # reject a sequence that continues after a flow value), so strip that line and
  # merge the entry into the existing list. Written UTF-8 without BOM.
  $lines = ($current -split "`r?`n") | Where-Object { $_ -notmatch '^\s*\[\]\s*$' }
  $base = ($lines -join "`n").TrimEnd()
  $combined = if ($base) { $base + "`n" + $entryText.TrimStart() } else { $entryText.TrimStart() }
  [System.IO.File]::WriteAllText($patchFile, $combined, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "OK  profile patch entry added -> $patchFile" -ForegroundColor Green
}

# --- 3. Apply the apiproxy hint patch --------------------------------------
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

# --- 4. Credential reminder ------------------------------------------------
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Make sure MIMO_API_KEY is configured (credentials service or environment variable).'
Write-Host '  2. Restart the web instance:  stop it, then run  dsh web  (or  npx @deepseek-ai/dsh web)'
Write-Host '  3. Attach an image in the chat or pass a path; the model will call describe_image.'
