# Install the MCP for Unity bridge (mcp-unity) into a native dsh installation.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Steps:
#   1. Locate $DSH_HOME (defaults to ~/.dsh) and the web profile.
#   2. Copy plugins/unity-mcp into the profile.
#   3. Add the profile patch entries (idempotent: skipped when already present).
#   4. Remind the user to restart the web instance.
#
# NOTE: keep the here-string below pure ASCII (English comments). This file is
# UTF-8 without BOM; on ANSI/GBK consoles PowerShell decodes it with the ANSI
# codepage, and multi-byte UTF-8 tails can swallow the following line breaks,
# corrupting the generated YAML. English comments avoid that entirely.
$ErrorActionPreference = 'Stop'

# --- 0. Prerequisites ------------------------------------------------------
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$pluginDir = Join-Path $profileDir 'plugins\unity-mcp'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$version = (Get-Content (Join-Path $PSScriptRoot 'plugins\unity-mcp\package.json') -Raw | ConvertFrom-Json).version

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
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\unity-mcp\index.js') -Destination $pluginDir -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\unity-mcp\package.json') -Destination $pluginDir -Force
Write-Host "OK  plugin copied -> $pluginDir  (v$version)" -ForegroundColor Green

# --- 2. Add the profile patch entries (idempotent) -------------------------
# Two insert blocks: mcp-unity (streamable-http bridge) and
# unity-mcp-supervisor (keeps the server process alive). Values mirror the
# plugin defaults; edit cordis.patch.yml after install to override.
$entryText = @'

# --- MCP for Unity (mcp-for-unity, streamable-http) ---
# serverName: unity -> tools appear as mcp__unity__manage_scene etc.
# The server process itself is kept alive by unity-mcp-supervisor below.
- insert:
    - id: mcp-unity
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: unity
        transport: streamable-http
        url: http://127.0.0.1:8080/mcp
        toolCallTimeoutMs: 120000
        reconnect:
          enabled: true

# --- unity-mcp supervisor ---
# Spawns the mcp-for-unity server when http://127.0.0.1:8080 does not answer
# (uvx --from mcpforunityserver==10.1.2 mcp-for-unity --transport http
#   --http-url http://127.0.0.1:8080 --project-scoped-tools).
# cwd selects the Unity project targeted by --project-scoped-tools.
- insert:
    - id: unity-mcp-supervisor
      name: './plugins/unity-mcp/index.js'
      config:
        enabled: true
        endpointUrl: http://127.0.0.1:8080/mcp
        command: 'C:\Users\kuai\.local\bin\uvx.exe'
        args:
          - '--from'
          - 'mcpforunityserver==10.1.2'
          - 'mcp-for-unity'
          - '--transport'
          - 'http'
          - '--http-url'
          - 'http://127.0.0.1:8080'
          - '--project-scoped-tools'
        cwd: 'G:\project\MCV_Module_0802'
        logFile: 'C:\Users\kuai\.dsh\logs\unity-mcp-server.log'
        checkIntervalMs: 10000
        startupTimeoutMs: 90000
        maxStartupFailures: 3
'@
$current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
if ($current -match '- id: mcp-unity') {
  Write-Host "SKIP profile patch entry already present in $patchFile" -ForegroundColor Yellow
} else {
  # dsh initializes cordis.patch.yml with a bare "[]" (empty-array placeholder).
  # Appending entries after it would produce invalid YAML (js-yaml / cordis both
  # reject a sequence that continues after a flow value), so strip that line and
  # merge the entries into the existing list. Written UTF-8 without BOM.
  $lines = ($current -split "`r?`n") | Where-Object { $_ -notmatch '^\s*\[\]\s*$' }
  $base = ($lines -join "`n").TrimEnd()
  $combined = if ($base) { $base + "`n" + $entryText.TrimStart() } else { $entryText.TrimStart() }
  [System.IO.File]::WriteAllText($patchFile, $combined, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "OK  profile patch entries added -> $patchFile" -ForegroundColor Green
}

# --- 3. Next steps ---------------------------------------------------------
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Make sure the MCP for Unity server port (default 8080) is free or already running.'
Write-Host '  2. Adjust unity-mcp-supervisor config in cordis.patch.yml if needed (cwd, uvx path, port).'
Write-Host '  3. Restart the web instance:  stop it, then run  dsh web  (or  npx @deepseek-ai/dsh web)'
Write-Host '  4. In the chat, the model can now call mcp__unity__* tools (manage_scene, execute_code, ...).'
