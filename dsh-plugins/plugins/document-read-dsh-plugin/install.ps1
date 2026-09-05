# Install the read_document tool into a native dsh installation.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Steps:
#   1. Locate $DSH_HOME (defaults to ~/.dsh) and the web profile.
#   2. Copy plugins/document-read into the profile.
#   3. Add the profile patch entry (idempotent: skipped when already present).
#   4. Check/install the Python parsing libraries (python-docx, openpyxl,
#      PyMuPDF) — optional; the plugin reports a clear error at call time if
#      they are missing.
#   5. Remind the user to restart the web instance.
$ErrorActionPreference = 'Stop'

# --- 0. Prerequisites ------------------------------------------------------
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$pluginDir = Join-Path $profileDir 'plugins\document-read'
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
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\document-read\index.js') -Destination $pluginDir -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\document-read\package.json') -Destination $pluginDir -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\document-read\parse_document.py') -Destination $pluginDir -Force
Write-Host "OK  plugin copied -> $pluginDir" -ForegroundColor Green

# --- 2. Add the profile patch entry (idempotent) ---------------------------
$entryText = @'

# --- read_document tool (native dsh) ---
# Reads Word / Excel / PDF documents (local path or URL): extracts text and
# describes embedded images via an OpenAI-compatible vision endpoint
# (Xiaomi MiMo by default). Parsing uses bundled parse_document.py
# (python-docx / openpyxl / PyMuPDF).
- insert:
    - id: tool-document-read
      name: './plugins/document-read/index.js'
'@
$current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
if ($current -match 'tool-document-read') {
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

# --- 3. Python parser dependencies (optional but recommended) ---------------
Write-Host ''
Write-Host 'Python parser libraries (python-docx / openpyxl / PyMuPDF):' -ForegroundColor Cyan
$py = if ($env:PYTHON) { $env:PYTHON } else { 'python' }
try {
  $out = & $py -c "import docx, openpyxl, fitz; print('ok')" 2>&1
  if ($LASTEXITCODE -eq 0 -and ($out -join '') -match 'ok') {
    Write-Host 'OK  python-docx, openpyxl and PyMuPDF already available' -ForegroundColor Green
  } else {
    Write-Host 'WARN missing one or more python libraries. Install them with:' -ForegroundColor Yellow
    Write-Host '  python -m pip install python-docx openpyxl PyMuPDF'
    Write-Host '  (the plugin reports a clear error at call time until they are installed)'
  }
} catch {
  Write-Host "WARN could not probe python: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host '  Install python 3.9+ and:  python -m pip install python-docx openpyxl PyMuPDF'
}

# --- 4. Credential reminder ------------------------------------------------
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Make sure MIMO_API_KEY is configured (credentials service or environment variable).'
Write-Host '     It is used to describe embedded images; without it, text extraction still works.'
Write-Host '  2. Restart the web instance:  stop it, then run  dsh web  (or  npx @deepseek-ai/dsh web)'
Write-Host '  3. Ask: "读一下这个文档: C:\path\to\file.docx" or give a URL; the model will call read_document.'
