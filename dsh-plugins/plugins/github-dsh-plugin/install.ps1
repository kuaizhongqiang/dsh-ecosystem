# Install the GitHub repository management tools into a native dsh installation.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Steps:
#   1. Locate $DSH_HOME (defaults to ~/.dsh) and the web profile.
#   2. Copy plugins/github (index.js + package.json + lib/) into the profile.
#   3. Add the profile patch entry (idempotent: skipped when already present).
#   4. Remind the user about GITHUB_TOKEN and restarting the web instance.
#
# The plugin works anonymously on public repos; set GITHUB_TOKEN through the
# credentials service to unlock private repos and write operations.
$ErrorActionPreference = 'Stop'

# --- 0. Prerequisites ------------------------------------------------------
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$pluginDir = Join-Path $profileDir 'plugins\github'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$srcManifest = Get-Content (Join-Path $PSScriptRoot 'plugins\github\package.json') -Raw | ConvertFrom-Json
$version = $srcManifest.version

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
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\github\*') -Destination $pluginDir -Recurse -Force
Write-Host "OK  plugin copied -> $pluginDir  (v$version)" -ForegroundColor Green

# --- 2. Add the profile patch entry (idempotent) ---------------------------
$entryText = @'

# --- tool-github v0.1.1 (native dsh) ---
# GitHub repository management: repo/file/issue/PR browsing plus local
# workspace sync (clone/pull/commit/push). Anonymous read-only on public
# repos; set GITHUB_TOKEN through the credentials service for private repos
# and write operations.
- insert:
    - id: tool-github
      name: './plugins/github/index.js'
'@
$current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
if ($current -match 'tool-github') {
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

# --- 3. Optional configuration reminder ------------------------------------
Write-Host ''
Write-Host 'Optional config (edit the tool-github entry in cordis.patch.yml):' -ForegroundColor Cyan
Write-Host '  config:'
Write-Host '    defaultRepo: owner/repo        # repo param default'
Write-Host '    projectRoot: F:/some/project   # project-scope sync root'
Write-Host '    allowWrite: false              # lock the whole plugin read-only'

# --- 4. Credential + restart reminder --------------------------------------
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. (Optional) Set GITHUB_TOKEN through the credentials service (fine-grained PAT:'
Write-Host '     Contents/Issues/Pull requests read+write + Metadata read on your repos).'
Write-Host '     Without a token the plugin still works anonymously on public repos.'
Write-Host '  2. Restart the web instance:  stop it, then run  dsh web  (or  npx @deepseek-ai/dsh web)'
Write-Host "  3. Verify in chat: ask me to run github_repo with action me, or just say"
Write-Host "     '看下 kuaizhongqiang/dsh-plugins 最近有什么提交'."
