# Install the credential-management tools into a native dsh installation.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Steps:
#   1. Locate $DSH_HOME (defaults to ~/.dsh) and the web profile.
#   2. Copy plugins/credentials into the profile.
#   3. Add the profile patch entry (idempotent: skipped when already present).
#   4. Remind the user to restart the web instance.
$ErrorActionPreference = 'Stop'

# --- 0. Prerequisites ------------------------------------------------------
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$pluginDir = Join-Path $profileDir 'plugins\credentials'
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

# --- 1. Copy the plugin ----------------------------------------------------
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\credentials\index.js') -Destination $pluginDir -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\credentials\package.json') -Destination $pluginDir -Force
Write-Host "OK  plugin copied -> $pluginDir" -ForegroundColor Green

# --- 2. Add the profile patch entry (idempotent) ---------------------------
$entryText = @'

# --- credential-management tools (native dsh) ---
# credentials_list / credentials_set / credentials_unset / credentials_verify
# manage %DSH_HOME%\.credentials.yaml through the official credentials seam
# (values never revealed; set gated behind approval when composed).
- insert:
    - id: tool-credentials
      name: './plugins/credentials/index.js'
'@
$current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
if ($current -match 'tool-credentials') {
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

# --- 3. Credential note ----------------------------------------------------
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. No API key is needed by this plugin itself (it manages the credential store).'
Write-Host '  2. Restart the web instance:  stop it, then run  dsh web  (or  npx @deepseek-ai/dsh web)'
Write-Host '  3. Ask the model to list/verify/set/remove a credential, e.g. "MIMO_API_KEY 配置好了吗?"'
