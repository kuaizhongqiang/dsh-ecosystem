# agent-memory-dsh-plugin -- Windows installer (dsh-ecosystem)
#
# 两种接入模式:
#   native (默认) 一个原生 cordis 插件 tool-agent-memory:11 个工具(主记忆 3 + 代码图谱 8)
#                 + 进程内自动入库(turn/end -> L0)。不需要 npx/MCP 子进程与外部守护。
#   mcp           原两条 MCP 通道(mcp-agent-memory / mcp-agent-memory-codegraph)
#                 + 可选外部 autostore 守护(计划任务 + 隐藏 VBS)。
#
# 服务(-Only,缺省随模式):
#   native 缺省 memory,codegraph;autostore 仅显式指定时才装外部守护。
#   mcp    缺省 memory,codegraph,autostore。
#   engine 第三方引擎在 Windows 上走 WSL2/docker,本脚本只给指引。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Mode mcp
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only memory,codegraph
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoStart
#
# 幂等: 载荷覆盖复制; cordis.patch.yml 按标记块增删; 模式切换会移除另一模式条目(避免重复工具)。
# 凭证: 本脚本不写任何密钥; 占位符 <...> 需你按 README/.env.example 自行填写。
# 注意: 改完插件 JS 必须重启 dsh web -- 本部署未启用 cordis-plugin-hmr;
#       不要用 './plugins/xxx/index.js?v=N' 这种写法(loader 会把它当字面路径,报 ERR_MODULE_NOT_FOUND 并拖垮整棵插件树)。
param(
  [ValidateSet('native', 'mcp')][string]$Mode = 'native',
  [string]$Only = '',
  [switch]$Uninstall,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$AllServices = @('memory', 'codegraph', 'autostore', 'engine')
if (-not $Only) {
  $Only = if ($Mode -eq 'native') { 'memory,codegraph' } else { 'memory,codegraph,autostore' }
}
$selected = $Only.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$unknown = $selected | Where-Object { $AllServices -notcontains $_ }
if ($unknown) { Write-Host ('ERROR: unknown service: ' + ($unknown -join ', ') + '. available: ' + ($AllServices -join ', ')) -ForegroundColor Red; exit 1 }
function Has-Svc([string]$id) { return ($selected -contains $id) }

$PKG = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $PKG '..\..\..')).Path
$AmDir = Join-Path $RepoRoot 'agent-memory'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$pluginsDir = Join-Path $profileDir 'plugins'
$nativeDir = Join-Path $pluginsDir 'agent-memory-native'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$MARK = 'agent-memory-dsh-plugin'
$TASK = 'dsh-memory-autostore'

Write-Host '== agent-memory-dsh-plugin =='
Write-Host "  package : $PKG"
Write-Host "  repo    : $RepoRoot"
Write-Host "  profile : $profileDir"
Write-Host "  mode    : $Mode$(if ($Uninstall) { '  (uninstall)' })"
Write-Host "  services: $($selected -join ', ')"

function Test-PatchId([string]$id) {
  if (-not (Test-Path $patchFile)) { return $false }
  return [bool](Select-String -Path $patchFile -Pattern ('id: ' + $id + '$') -Quiet)
}
function Test-Managed([string]$id) {
  if (-not (Test-Path $patchFile)) { return $false }
  return [bool](Select-String -Path $patchFile -Pattern ('^# >>> ' + $MARK + ': ' + $id + ' >>>$') -Quiet)
}
function Add-PatchBlock([string]$id, [string]$body) {
  if (Test-PatchId $id) { Write-Host "  SKIP patch $id (already present)"; return }
  $lines = @('', "# >>> $MARK`: $id >>>") + ($body -split "`n") + @("# <<< $MARK`: $id <<<")
  New-Item -ItemType Directory -Force -Path (Split-Path $patchFile) | Out-Null
  Add-Content -Path $patchFile -Value $lines -Encoding UTF8
  Write-Host "  OK  patch entry added: $id"
}
function Remove-PatchBlock([string]$id) {
  if (-not (Test-PatchId $id)) { return }
  if (-not (Test-Managed $id)) { Write-Host "  SKIP patch $id (present but not managed by this package; left untouched)"; return }
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

# --- uninstall ---------------------------------------------------------------
if ($Uninstall) {
  Write-Host '-- uninstall'
  Remove-PatchBlock 'tool-agent-memory'
  Remove-PatchBlock 'mcp-agent-memory'
  Remove-PatchBlock 'mcp-agent-memory-codegraph'
  if (Test-Path $nativeDir) { Remove-Item -Recurse -Force $nativeDir; Write-Host "  removed $nativeDir" }
  $cgDir = Join-Path $pluginsDir 'agent-memory-codegraph'
  if (Test-Path $cgDir) { Remove-Item -Recurse -Force $cgDir; Write-Host "  removed $cgDir" }
  $q = schtasks /query /tn $TASK 2>$null
  if ($LASTEXITCODE -eq 0) { schtasks /delete /tn $TASK /f | Out-Null; Write-Host "  removed scheduled task: $TASK" }
  Write-Host '== done (memory data ~/.openclaw/memory-tdai untouched) =='
  exit 0
}

# --- native mode -------------------------------------------------------------
if ($Mode -eq 'native' -and (Has-Svc 'memory' -or Has-Svc 'codegraph')) {
  Write-Host '-- native plugin (memory + codegraph + in-process capture)'
  $src = Join-Path $PKG 'plugins\agent-memory-native'
  if (-not (Test-Path $src)) { Write-Host "ERROR: missing $src" -ForegroundColor Red; exit 1 }
  New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
  if (Test-Path $nativeDir) { Remove-Item -Recurse -Force $nativeDir }
  Copy-Item -Recurse $src $nativeDir
  Write-Host "  copied -> $nativeDir"
  Remove-PatchBlock 'mcp-agent-memory'
  Remove-PatchBlock 'mcp-agent-memory-codegraph'
  $body = @"
- insert:
    - id: tool-agent-memory
      name: './plugins/agent-memory-native/index.js'
      config:
        # 主记忆通道: MemoryCore gateway (:8422)
        memoryEndpoint: http://127.0.0.1:8422
        # code-graph 通道: MemoryKnowledge (:8421) -- 与 MemoryCore 是两个服务,
        # /v3/code-graph/* 只由 MemoryKnowledge 提供. 引擎在远端时改成 Knowledge 的
        # 对外地址(如 https://knowledge.<域名>), 不要用 memory.<域名>(那是 MemoryCore 网关, 会 404).
        knowledgeEndpoint: http://127.0.0.1:8421
        apiKeyRef: AGENT_MEMORY_API_KEY
        # 仅当 Knowledge 网关接受的 key 与 MemoryCore 不同才需要:
        # knowledgeApiKeyRef: AGENT_MEMORY_KNOWLEDGE_KEY
        serviceId: default
        teamId: '<TEAM_ID>'
        agentId: '<AGENT_ID>'
        userId: '<USER_ID>'
        userKeyRef: AGENT_MEMORY_USER_KEY
        taskId: '<project label task_id>'
        capture: true
        timeoutMs: 15000
"@
  Add-PatchBlock 'tool-agent-memory' $body
  Write-Host '  NOTE: replace the <...> placeholders (teamId/agentId/userId/taskId) in cordis.patch.yml'
  Write-Host '  NOTE: code-graph needs MemoryKnowledge (default :8421) reachable from THIS machine.'
  Write-Host '        If the engine runs elsewhere, point knowledgeEndpoint at a reachable Knowledge'
  Write-Host '        address (e.g. https://knowledge.<domain>) -- memory.<domain> only fronts MemoryCore.'
  Write-Host '  NOTE: secrets are referenced, not inlined — store them via credentials_set AGENT_MEMORY_API_KEY /'
  Write-Host '        AGENT_MEMORY_USER_KEY, or edit %DSH_HOME%\.credentials.yaml (refs:, 0600, hot-applied).'
  Write-Host '  NOTE: capture runs in-process; the external autostore task is not needed'
}

# --- mcp mode ----------------------------------------------------------------
if ($Mode -eq 'mcp') {
  if (Has-Svc 'codegraph') {
    Write-Host '-- mcp: codegraph'
    $src = Join-Path $PKG 'plugins\agent-memory-codegraph'
    $dst = Join-Path $pluginsDir 'agent-memory-codegraph'
    New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    Copy-Item -Recurse $src $dst
    Write-Host "  copied -> $dst"
    Remove-PatchBlock 'tool-agent-memory'
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
          # 仅当 Knowledge 在带鉴权的网关后面才需要（远端部署常见）:
          # KNOWLEDGE_API_KEY: '<knowledge api key>'
          SERVICE_ID: default
          TEAM_ID: '<TEAM_ID>'
          USER_ID: '<USER_ID>'
          AGENT_ID: '<AGENT_ID>'
        toolCallTimeoutMs: 30000
"@
    Add-PatchBlock 'mcp-agent-memory-codegraph' $body
  }
  if (Has-Svc 'memory') {
    Write-Host '-- mcp: memory'
    Remove-PatchBlock 'tool-agent-memory'
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
    Write-Host '  NOTE: replace the <...> placeholders (teamId/agentId/userId/taskId) in cordis.patch.yml'
  Write-Host '  NOTE: secrets are referenced, not inlined — store them via credentials_set AGENT_MEMORY_API_KEY /'
  Write-Host '        AGENT_MEMORY_USER_KEY, or edit %DSH_HOME%\.credentials.yaml (refs:, 0600, hot-applied).'
  }
}

# --- autostore (external daemon; scheduled task + hidden VBS) ----------------
if (Has-Svc 'autostore') {
  Write-Host '-- autostore daemon'
  $taskDir = Join-Path $dshHome 'agent-memory\scripts'
  $vbs = Join-Path $taskDir 'dsh-memory-autostore-hidden.vbs'
  $mjsSrc = Join-Path $AmDir 'scripts\dsh-memory-autostore.mjs'
  if (-not (Test-Path $mjsSrc)) { Write-Host "ERROR: not found: $mjsSrc" -ForegroundColor Red; exit 1 }
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
    Write-Host "  SKIP scheduled task (-NoStart)"
  } else {
    schtasks /create /tn $TASK /sc minute /mo 10 /tr "wscript.exe `"$vbs`"" /f | Out-Null
    Write-Host "  OK  scheduled task registered: $TASK (every 10 minutes)"
  }
}

# --- engine (third-party; guidance only) -------------------------------------
if (Has-Svc 'engine') {
  Write-Host '-- engine (third-party TencentDB Agent Memory)'
  Write-Host '  The engine is deployed on Linux (systemd, see templates/systemd/*.service) or docker.'
  Write-Host '  On Windows use WSL2 or docker (upstream deploy/global-images); see docs/modules/agent-memory.md.'
}

Write-Host '== done =='
Write-Host '  Restart dsh web to load new cordis entries (HMR is not enabled in this deployment).'
