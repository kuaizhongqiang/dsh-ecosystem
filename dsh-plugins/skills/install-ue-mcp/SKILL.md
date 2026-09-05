---
name: install-ue-mcp
description: 把 UE 5.8+ 编辑器内置的 Unreal MCP 接入 dsh web，让模型获得 mcp__unreal__* 工具（list_toolsets / describe_toolset / call_tool 驱动编辑器场景、Actor、蓝图、PIE 等），自带监督器按配置拉起 UnrealEditor -ModelContextProtocolStartServer。当用户要求接入 UE/Unreal、安装/卸载 ue-mcp 插件，或 mcp__unreal__* 工具不可用需要排查时使用。
whenToUse: 用户想用 dsh 操作 UE 编辑器/工程（摆 Actor、查场景、跑 PIE 等）、要求安装或卸载 ue-mcp 插件、或 mcp__unreal__* 工具报错需要排查时。
---

# 安装 ue-mcp 插件（UE 内置 Unreal MCP 桥）

把 UE 5.8+ 编辑器内置的 **Unreal MCP** 接入 dsh web，主对话模型直接获得
`mcp__unreal__*` 工具。包内自带**监督器插件**：探测
`http://127.0.0.1:8000/mcp`，无响应时按机器配置自动拉起
`UnrealEditor -ModelContextProtocolStartServer` 并写日志。

**默认安装为关闭（opt-in）**：不常驻、不自动拉起编辑器；需要时再手动启用。

> UE 侧前置见 [Epic 官方文档](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor?lang=zh-CN)。

## 0. 定位插件包

插件包在本仓库 `plugins/ue-mcp-dsh-plugin/`，二选一获取：

- 本地已有仓库克隆：直接用 `<仓库根>/plugins/ue-mcp-dsh-plugin`
- 没有克隆：`git clone https://github.com/kuaizhongqiang/dsh-plugins`，
  或让用户下载 Release 压缩包并解压

以下步骤均在插件包目录内执行。

## 1. 检查前置

1. Node.js 满足 dsh 要求（`^22.19 || >=24`），dsh 已安装
   （`npm install -g @deepseek-ai/dsh` 或 `npx @deepseek-ai/dsh`）
2. `%DSH_HOME%\profiles\web` 已初始化（至少启动过一次 `dsh web`）
3. UE 工程已启用 Unreal MCP 插件（Edit → Plugins 勾选 Unreal MCP /
   All Toolsets；重启编辑器生效）
4. 已知本机引擎编辑器路径与目标 `.uproject` 路径

## 2. 执行安装脚本

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会（幂等）：
1. 复制 `plugins/ue-mcp` 到 `%DSH_HOME%\profiles\web\plugins\ue-mcp`
2. 幂等地在 `cordis.patch.yml` 追加两个 `- insert:` 条目（已存在则跳过）：
   - `mcp-ue`：`@deepseek-ai/dsh-mcp-client`，streamable-http 连接
     `http://127.0.0.1:8000/mcp`，`serverName: unreal`（默认 `disabled: true`）
   - `ue-mcp-supervisor`：本包插件，保证端点可达（拉起编辑器）
     （默认 `enabled: false`，不自动拉起编辑器）

两个条目默认都为关闭。**启用步骤**：编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，
把 `mcp-ue` 的 `disabled: true` 改为 `false`；若希望 dsh 自动拉起编辑器，再把
`ue-mcp-supervisor` 的 `enabled: false` 改为 `true`，然后重启 `dsh web`。
（自己手动带 MCP 参数打开编辑器时，只需启用 `mcp-ue`。）

本插件**不需要任何 API key**。

## 3. 按机器调整配置（重要）

install.ps1 写入的默认值含**本机专属路径**，目标机器必须核对
`cordis.patch.yml` 的 `ue-mcp-supervisor` 条目：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `endpointUrl` | `http://127.0.0.1:8000/mcp` | UE MCP 探活端点 |
| `command` | `E:\Unreal\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe` | 引擎编辑器可执行文件（按机器/引擎版本改） |
| `args` | `[<uproject>, -ModelContextProtocolStartServer]` | 目标工程与自启参数（`uproject` 必须按工程改） |
| `cwd` | 工程目录 | 编辑器工作目录 |
| `logFile` | `%DSH_HOME%\logs\ue-mcp-editor.log` | 编辑器输出日志 |
| `checkIntervalMs` | `10000` | 探活间隔 |
| `startupTimeoutMs` | `180000` | 编辑器冷启动等待就绪上限 |
| `maxStartupFailures` | `3` | 连续失败上限，超过后暂停自动重启 |

监督器**不会杀**手动打开的编辑器；只有它自己拉起的子进程才会在插件销毁时
被清理。手动打开的编辑器若没带 MCP 参数，请在编辑器控制台执行
`ModelContextProtocol.StartServer`（避免双开同工程）。`mcp-ue` 条目如需
调整，改 `url` / `toolCallTimeoutMs` 即可。

## 4. 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 确认 UE 编辑器可达：监督器自动拉起，或手动打开编辑器并启动服务器
3. 在对话里让模型执行任意 UE 操作（如"列出当前关卡 Actor / 读相机位置"），
   模型应调用 `mcp__unreal__list_toolsets`、`mcp__unreal__call_tool` 等工具
4. 工具名格式：`mcp__unreal__<原名>`；服务器默认工具搜索模式，先
   `list_toolsets` 发现 → `describe_toolset` 查参数 → `call_tool` 调用

## 5. 排查

- 端口 8000 被占用：改 UE 编辑器偏好（Model Context Protocol 端口）并同步
  `endpointUrl` / `url`，重启
- 编辑器能起来但工具报连接错误：看编辑器日志有没有
  `Starting MCP server on port 8000`；没有则控制台 `ModelContextProtocol.StartServer`
- 多工程共用同一 profile：切换工程需改 `args`（uproject）与 `cwd` 并重启
- `mcp-ue` 使用 streamable-http 传输，需要 dsh-mcp-client（npm 版内置）

## 6. 卸载

1. 编辑 `cordis.patch.yml`，删除 `mcp-ue` 与 `ue-mcp-supervisor` 两个条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\ue-mcp\`
3. 重启 `dsh web`
