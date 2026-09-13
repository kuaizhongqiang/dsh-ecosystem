# agent-memory-dsh-plugin -- Windows installer (dsh-ecosystem)
# 把「TencentDB Agent Memory」在 DSH 侧的接入装到 web profile：
#   memory     主记忆 MCP 通道（mcp-agent-memory -> mcp-bridge，npx 固定版本）
#   codegraph  代码图谱只读通道（mcp-agent-memory-codegraph，本地 MCP server）
#   autostore  自动入库（计划任务 + 隐藏窗口 VBS，每 10 分钟 --once）
#   engine     第三方引擎（Linux/systemd 或 docker 部署，本脚本只给指引）
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only memory,codegraph
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoStart
#
# 幂等: 载荷覆盖复制; cordis.patch.yml 按标记块增删, 重复执行不产生重复条目。
# 凭证: 本脚本不写任何密钥; 占位符 <...> 需你按 README/.env.example 自行填写。
param(
  [string]$Only = '',
  [switch]$Uninstall,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$AllServices = @('memory', 'codegraph', 'autostore', 'engine')
$selected = if ($Only) { $Only.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } } else { @('memory', 'codegraph', 'autostore') }
$unknown = $selected | Where-Object { $AllServices -notcontains $_ }
if ($unknown) { Write-Host ('ERROR: unknown service: ' + ($unknown -join ', ') + '. available: ' + ($AllServices -join ', ')) -ForegroundColor Red; exit 1 }
function Has-Svc([string]$id) { return ($selected -contains $id) }

$PKG = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $PKG '..\..\..')).Path
$AmDir = Join-Path $RepoRoot 'agent-memory'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$pluginsDir = Join-Path $profileDir 'plugins'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$MARK = 'agent-memory-dsh-plugin'
$TASK = 'dsh-memory-autostore'

Write-Host '== agent-memory-dsh-plugin =='
Write-Host "  package : $PKG"
Write-Host "  repo    : $RepoRoot"
Write-Host "  profile : $profileDir"
Write-Host "  services: $($selected -join ', ')$(if ($Uninstall) { '  (uninstall)' })"

function Test-PatchId([string]$id) {
  if (-not (Test-Path $patchFile)) { return $false }
  return [bool](Select-String -Path $patchFile -Pattern ('id: ' + $id + '$') -Quiet)
}
function Add-PatchBlock([string]$id, [string]$body) {
  if (Test-PatchId $id) { Write-Host "  SKIP patch $id (already present)"; return }
  $lines = @('', "# >>> $MARK`: $id >>>") + ($body -split "`n") + @("# <<< $MARK`: $id <<<")
  New-Item -ItemType Directory -Force -Path (Split-Path $patchFile) | Out-Null
  Add-Content -Path $patchFile -Value $lines -Encoding UTF8
  Write-Host "  OK  patch entry added: $id"
}
function Remove-PatchBlock([string]$id) {
  if (-not (Test-PatchId $id)) { Write-Host "  SKIP patch $id (absent)"; return }
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($line in (Get-Content -Path $patchFile -Encoding UTF8)) {
    if ($line -eq "# >>> $MARK`: $id >>>") { $skip = $true; continue }
    if ($line -eq "# <<< $MARK`: $id <<<") { $skip = $false; continue }
    if (-not $skip) { $out.Add($line) }
  }
  Set-Content -Path $patchFile -Value $out -Encoding UTF8
  Write-Host "  OK  patch entry removed: $id"
}

# --- 1. codegraph ------------------------------------------------------------
if (Has-Svc 'codegraph') {
  Write-Host '-- codegraph'
  if ($Uninstall) {
    Remove-PatchBlock 'mcp-agent-memory-codegraph'
    $dst = Join-Path $pluginsDir 'agent-memory-codegraph'
    if (Test-Path $dst) { Move-Item $dst "$dst.removed-$(Get-Date -Format yyyyMMdd-HHmmss)"; Write-Host "  moved $dst -> *.removed-*" }
  } else {
    $src = Join-Path $PKG 'plugins\agent-memory-codegraph'
    $dst = Join-Path $pluginsDir 'agent-memory-codegraph'
    New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    Copy-Item -Recurse $src $dst
    Write-Host "  copied -> $dst"
    $body = @"
- insert:
    - id: mcp-agent-memory-codegraph
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-memory-codegraph
        transport: stdio
        command: node
        args: ['$($dst.Replace('\','/'))/index.mjs']
        env:
          KNOWLEDGE_ENDPOINT: 'http://127.0.0.1:8421'
          SERVICE_ID: default
          TEAM_ID: '<TEAM_ID>'
          USER_ID: '<USER_ID>'
          AGENT_ID: '<AGENT_ID>'
        toolCallTimeoutMs: 30000
"@
    Add-PatchBlock 'mcp-agent-memory-codegraph' $body
  }
}

# --- 2. memory ---------------------------------------------------------------
if (Has-Svc 'memory') {
  Write-Host '-- memory'
  if ($Uninstall) {
    Remove-PatchBlock 'mcp-agent-memory'
  } else {
    $body = @"
- insert:
    - id: mcp-agent-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-memory
        transport: stdio
        command: npx
        args: ['-y', 'tencent-agent-memory-mcp-bridge@0.4.0']
        env:
          MEMORY_ENDPOINT: http://127.0.0.1:8422
          API_KEY: '<bridge api key>'
          SERVICE_ID: default
          TEAM_ID: '<TEAM_ID>'
          AGENT_ID: '<AGENT_ID>'
          USER_ID: '<USER_ID>'
          USER_KEY: '<sk-mem-...>'
          TASK_ID: '<project label task_id>'
        toolCallTimeoutMs: 30000
"@
    Add-PatchBlock 'mcp-agent-memory' $body
    Write-Host '  NOTE: replace the <...> placeholders in cordis.patch.yml (see README / .env.example)'
    if (Test-Path (Join-Path $AmDir 'packages\mcp-bridge\dist\index.js')) {
      Write-Host "  NOTE: local build found -> you may point args at $AmDir\packages\mcp-bridge\dist\index.js to avoid npm"
    }
  }
}

# --- 3. autostore (scheduled task + hidden VBS) ------------------------------
if (Has-Svc 'autostore') {
  Write-Host '-- autostore'
  $taskDir = Join-Path $dshHome 'agent-memory\scripts'
  $vbs = Join-Path $taskDir 'dsh-memory-autostore-hidden.vbs'
  if ($Uninstall) {
    $q = schtasks /query /tn $TASK 2>$null
    if ($LASTEXITCODE -eq 0) { schtasks /delete /tn $TASK /f | Out-Null; Write-Host "  removed scheduled task: $TASK" }
    else { Write-Host "  SKIP scheduled task $TASK (absent)" }
    if (Test-Path $vbs) { Remove-Item $vbs -Force; Write-Host "  removed $vbs" }
  } else {
    $mjsSrc = Join-Path $AmDir 'scripts\dsh-memory-autostore.mjs'
    if (-not (Test-Path $mjsSrc)) { Write-Host "ERROR: not found: $mjsSrc (is -RepoRoot correct?)" -ForegroundColor Red; exit 1 }
    New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
    Copy-Item $mjsSrc (Join-Path $taskDir 'dsh-memory-autostore.mjs') -Force
    $node = (Get-Command node).Source
    $vbsBody = @"
' generated by agent-memory-dsh-plugin install.ps1 -- runs autostore --once with a hidden window
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
nodePath = "$node"
scriptPath = base & "\dsh-memory-autostore.mjs"
logPath = base & "\dsh-memory-autostore-run.log"
cmdLine = "cmd /c """"" & nodePath & """ """ & scriptPath & """ --once >> """ & logPath & """ 2>&1"""
shell.Run cmdLine, 0, False
"@
    Set-Content -Path $vbs -Value $vbsBody -Encoding ASCII
    Write-Host "  wrote $vbs (node: $node)"
    if ($NoStart) {
      Write-Host "  SKIP scheduled task (-NoStart); manual: schtasks /create /tn $TASK /sc minute /mo 10 /tr `"wscript.exe `"$vbs`"`" /f"
    } else {
      schtasks /create /tn $TASK /sc minute /mo 10 /tr "wscript.exe `"$vbs`"" /f | Out-Null
      Write-Host "  OK  scheduled task registered: $TASK (every 10 minutes)"
    }
  }
}

# --- 4. engine (third-party, guidance only) ----------------------------------
if (Has-Svc 'engine') {
  Write-Host '-- engine (third-party TencentDB Agent Memory)'
  if ($Uninstall) { Write-Host '  engine services are not managed by this script on Windows' }
  else {
    Write-Host '  The memory engine (MemoryCore/MemoryKnowledge/MemoryPanel/MemoryProxy + TDAI gateway)'
    Write-Host '  is a separate upstream project and is deployed on Linux (systemd) or via docker.'
    Write-Host '  On Windows: use WSL2 (see templates/systemd/*.service) or docker (upstream deploy/global-images).'
    Write-Host '  See templates/engine/ and docs/modules/agent-memory.md for prerequisites.'
  }
}

Write-Host '== done =='
if (-not $Uninstall) { Write-Host '  Restart dsh web to load new cordis entries (MCP wiring is read at process start).' }
