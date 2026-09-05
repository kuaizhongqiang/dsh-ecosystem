# Install the UE (Unreal) MCP bridge (mcp-ue) into a native dsh installation.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Steps:
#   1. Locate $DSH_HOME (defaults to ~/.dsh) and the web profile.
#   2. Copy plugins/ue-mcp into the profile.
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
$pluginDir = Join-Path $profileDir 'plugins\ue-mcp'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$version = (Get-Content (Join-Path $PSScriptRoot 'plugins\ue-mcp\package.json') -Raw | ConvertFrom-Json).version

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
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\ue-mcp\index.js') -Destination $pluginDir -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\ue-mcp\package.json') -Destination $pluginDir -Force
Write-Host "OK  plugin copied -> $pluginDir  (v$version)" -ForegroundColor Green

# --- 2. Add the profile patch entries (idempotent) -------------------------
# Two insert blocks: mcp-ue (streamable-http bridge to the UE editor's built-in
# Unreal MCP) and ue-mcp-supervisor (starts UnrealEditor with
# -ModelContextProtocolStartServer when the endpoint is down).
# Values mirror the plugin defaults; edit cordis.patch.yml after install to
# override (engine/editor path, uproject path, port, timeouts).
$entryText = @'

# --- UE built-in Unreal MCP (unreal-mcp in editor, streamable-http) ---
# serverName: unreal -> tools appear as mcp__unreal__list_toolsets etc.
# The endpoint lives inside the Unreal Editor; ue-mcp-supervisor below keeps it
# reachable by starting the editor with -ModelContextProtocolStartServer.
# BOTH rows are installed DISABLED BY DEFAULT (no resident polling, no
# auto-starting the editor). To use UE MCP: launch the editor yourself with
# -ModelContextProtocolStartServer, then set disabled: false on mcp-ue and
# restart dsh web; set ue-mcp-supervisor enabled: true only if you want dsh to
# auto-start the editor for you.
- insert:
    - id: mcp-ue
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
      config:
        serverName: unreal
        transport: streamable-http
        url: http://127.0.0.1:8000/mcp
        toolCallTimeoutMs: 120000
        reconnect:
          enabled: true

# --- ue-mcp supervisor ---
# Starts the Unreal Editor (UE 5.8+) with -ModelContextProtocolStartServer when
# http://127.0.0.1:8000/mcp does not answer. command/args must point at the
# local engine editor binary and the target .uproject.
# DISABLED BY DEFAULT: set enabled to true (then restart web) to let it
# auto-start the editor; or launch the editor manually and only enable mcp-ue.
- insert:
    - id: ue-mcp-supervisor
      name: './plugins/ue-mcp/index.js'
      config:
        enabled: false
        endpointUrl: http://127.0.0.1:8000/mcp
        command: 'E:\Unreal\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe'
        args:
          - 'D:\UEProject\UE_MCP_Test\UE_MCP.uproject'
          - '-ModelContextProtocolStartServer'
        cwd: 'D:\UEProject\UE_MCP_Test'
        logFile: 'C:\Users\kuai\.dsh\logs\ue-mcp-editor.log'
        checkIntervalMs: 10000
        startupTimeoutMs: 180000
        maxStartupFailures: 3
'@
$current = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
if ($current -match '- id: mcp-ue') {
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
Write-Host '  1. Adjust ue-mcp-supervisor config in cordis.patch.yml for this machine (command = UnrealEditor.exe path, args = target .uproject, cwd, logFile).'
Write-Host '  2. Make sure the Unreal MCP port (default 8000) matches the UE editor ModelContextProtocol settings.'
Write-Host '  3. Restart the web instance:  stop it, then run  dsh web  (or  npx @deepseek-ai/dsh web)'
Write-Host '  4. In the chat, the model can now call mcp__unreal__* tools (list_toolsets, call_tool, ...).'
