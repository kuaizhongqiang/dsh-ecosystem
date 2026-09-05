# ue-mcp 插件（Unreal MCP 桥）

把 **UE 5.8+ 编辑器内置的 Unreal MCP** 接入 dsh web，主对话模型直接获得
`mcp__unreal__*` 工具（`list_toolsets` / `describe_toolset` / `call_tool` 及
55+ 个工具集：场景、Actor、资产、蓝图、材质、Sequencer、PIE 控制……）。
自带**监督器插件**：探测 `http://127.0.0.1:8000/mcp`，无响应时按机器配置
自动拉起 `UnrealEditor -ModelContextProtocolStartServer` 并写日志。

> UE 侧前置：工程需启用 `ModelContextProtocol`（及 `ToolsetRegistry` /
> `AllToolsets`）插件——见 [Epic 官方文档](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor?lang=zh-CN)。
> 本插件**不需要任何 API key**。

## 架构

install.ps1 向 `cordis.patch.yml` 追加两个条目（幂等）：

1. **`mcp-ue`**：`@deepseek-ai/dsh-mcp-client`，streamable-http 连接
   `http://127.0.0.1:8000/mcp`，`serverName: unreal` → 工具名前缀
   `mcp__unreal__`。
2. **`ue-mcp-supervisor`**：本包监督器，保证端点可达（进程生命周期见下）。

Unreal MCP 服务器运行在 **UE 编辑器进程内**，因此监督器拉起的"服务器"就是
带 `-ModelContextProtocolStartServer` 启动参数的 `UnrealEditor.exe`。

## 安装

前置：

1. Node.js 满足 dsh 要求（`^22.19 || >=24`），dsh 已安装
2. `%DSH_HOME%\profiles\web` 已初始化（至少启动过一次 `dsh web`）
3. 目标 UE 工程已启用 Unreal MCP 插件（`Edit → Plugins` 勾选 Unreal MCP /
   All Toolsets），本机引擎/工程路径已知

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

## 按机器调整配置（重要）

install.ps1 写入的默认值含**本机专属路径**，目标机器必须核对
`cordis.patch.yml` 的 `ue-mcp-supervisor` 条目：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `endpointUrl` | `http://127.0.0.1:8000/mcp` | UE 编辑器 MCP 探活端点 |
| `command` | `E:\Unreal\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe` | 启动编辑器的可执行文件（按机器/引擎版本改） |
| `args` | `[<uproject路径>, -ModelContextProtocolStartServer]` | 目标工程 + 自启 MCP 参数（`uproject` 必须按工程改） |
| `cwd` | 工程目录 | 编辑器工作目录 |
| `logFile` | `%DSH_HOME%\logs\ue-mcp-editor.log` | 编辑器输出日志 |
| `checkIntervalMs` | `10000` | 探活间隔 |
| `startupTimeoutMs` | `180000` | 编辑器冷启动等待就绪上限（首启含着色器等，给足时间） |
| `maxStartupFailures` | `3` | 连续失败上限，超过后暂停自动重启 |

监督器**不会杀**用户手动打开的编辑器；只有它自己拉起的子进程才会在插件
销毁时被清理。若你的编辑器已手动打开但**没带 MCP 参数**，监督器不会去抢
（避免双开同工程）——请在编辑器控制台执行 `ModelContextProtocol.StartServer`，
或关闭后让监督器统一拉起。`mcp-ue` 桥接条目如需调整，改 `url` /
`toolCallTimeoutMs` 即可。

## 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 确认 UE 编辑器可达：监督器会自动拉起，或手动打开编辑器并
   `ModelContextProtocol.StartServer`
3. 在对话里让模型执行任意 UE 操作（如"列出当前关卡 Actor"），模型应调用
   `mcp__unreal__list_toolsets` / `mcp__unreal__call_tool` 等工具
4. 工具名格式：`mcp__unreal__<原名>`（服务器处于工具搜索模式时先
   `list_toolsets` → `describe_toolset` → `call_tool`）

## 排查

- 端口 8000 被占用：改 UE 编辑器偏好（Model Context Protocol 端口）并同步
  `endpointUrl` / `url`，重启
- 编辑器能起来但工具报连接错误：确认编辑器日志出现
  `Starting MCP server on port 8000`（无则控制台 `ModelContextProtocol.StartServer`）
- 多工程共用同一 profile：切换工程需改 `args` 里的 uproject 与 `cwd` 后重启
- `mcp-ue` 使用 streamable-http 传输，需要 dsh-mcp-client（npm 版内置）

## 卸载

1. 编辑 `cordis.patch.yml`，删除 `mcp-ue` 与 `ue-mcp-supervisor` 两个条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\ue-mcp\`
3. 重启 `dsh web`

## 版本

`plugins/ue-mcp/package.json` 的 `version` 为单一事实来源（当前 v0.1.0）；
升级 = 重跑 `install.ps1`（幂等覆盖）。
