# install.ps1 — 把 agent-memory-codegraph MCP 通道复制进 web profile（Windows）
# 用法: powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$src = Join-Path $here 'plugins\agent-memory-codegraph'
$prof = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$dst = Join-Path $prof 'plugins\agent-memory-codegraph'

if (-not (Test-Path $src)) { throw "source not found: $src" }
New-Item -ItemType Directory -Force -Path (Join-Path $prof 'plugins') | Out-Null
if (Test-Path $dst) {
  Write-Host "目标已存在，先备份到 $dst.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Move-Item $dst "$dst.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
}
Copy-Item -Recurse $src $dst
Write-Host "已复制到 $dst"
Write-Host '下一步：在 cordis.patch.yml 增加 mcp-agent-memory-codegraph 实例（见 cordis-patch.example.yml），'
Write-Host "并把 args 的绝对路径指向: $dst\index.mjs"
