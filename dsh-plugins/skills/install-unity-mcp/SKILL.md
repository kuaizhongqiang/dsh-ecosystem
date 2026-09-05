---
name: install-unity-mcp
description: 把 MCP for Unity 桥接入 dsh web，让模型获得 mcp__unity__* 工具（manage_scene / execute_code / run_tests / manage_gameobject 等 48 个 Unity Editor 工具），自带监督器自动拉起服务器。当用户要求接入 Unity、安装/卸载 unity-mcp 插件，或 mcp__unity__* 工具不可用需要排查时使用。
whenToUse: 用户想用 dsh 操作 Unity 项目、要求安装或卸载 unity-mcp 插件、或 mcp__unity__* 工具报错需要排查时。
---

# 安装 unity-mcp 插件（MCP for Unity 桥）

把 MCP for Unity 接入 dsh web，主对话模型直接获得 `mcp__unity__*` 工具。
包内自带**监督器插件**：探测 MCP 服务器端点（默认 `http://127.0.0.1:8080`），
无响应时用 `uvx` 自动拉起服务器并写日志——无需手动维护服务器进程。

## 0. 定位插件包

插件包在本仓库 `plugins/unity-mcp-dsh-plugin/`，二选一获取：

- 本地已有仓库克隆：直接用 `<仓库根>/plugins/unity-mcp-dsh-plugin`
- 没有克隆：`git clone https://github.com/kuaizhongqiang/dsh-plugins`，
  或让用户下载 Release 压缩包并解压

以下步骤均在插件包目录内执行。

## 1. 检查前置

1. Node.js 满足 dsh 要求（`^22.19 || >=24`），dsh 已安装
   （`npm install -g @deepseek-ai/dsh` 或 `npx @deepseek-ai/dsh`）
2. `%DSH_HOME%\profiles\web` 已初始化（至少启动过一次 `dsh web`）
3. Unity 项目已安装 MCP for Unity 客户端包 `com.coplaydev.unity-mcp`，
   并在 Unity 里启动桥（Window → MCP for Unity → Start Bridge）
4. uv/uvx 可用（服务器运行方式，安装见 https://docs.astral.sh/uv/）

## 2. 执行安装脚本

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会（幂等）：
1. 复制 `plugins/unity-mcp` 到 `%DSH_HOME%\profiles\web\plugins\unity-mcp`
2. 幂等地在 `cordis.patch.yml` 追加两个 `- insert:` 条目（已存在则跳过）：
   - `mcp-unity`：`@deepseek-ai/dsh-mcp-client`，streamable-http 连接
     `http://127.0.0.1:8080/mcp`
   - `unity-mcp-supervisor`：本包插件，保证服务器进程存活

本插件**不需要任何 API key**。

## 3. 按机器调整配置（重要）

install.ps1 写入的默认值含**本机专属路径**，目标机器必须核对
`cordis.patch.yml` 的 `unity-mcp-supervisor` 条目：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `endpointUrl` | `http://127.0.0.1:8080/mcp` | 服务器探活端点 |
| `command` | `C:\Users\kuai\.local\bin\uvx.exe` | 启动服务器的可执行文件（按机器改） |
| `args` | uvx 全参数 | `--from mcpforunityserver==10.1.2 mcp-for-unity --transport http --http-url http://127.0.0.1:8080 --project-scoped-tools` |
| `cwd` | 原作者的 Unity 项目路径 | 决定 `--project-scoped-tools` 作用的目标项目（必须按机器/项目改） |
| `logFile` | `%DSH_HOME%\logs\unity-mcp-server.log` | 服务器输出日志 |
| `checkIntervalMs` | `10000` | 探活间隔 |
| `startupTimeoutMs` | `90000` | 拉起后等待就绪的最长时间 |
| `maxStartupFailures` | `3` | 连续失败上限，超过后暂停自动重启 |

监督器**不会杀**手动启动的服务器；只有它自己拉起的子进程才会在插件销毁时
被清理。`mcp-unity` 桥接条目如需调整，改 `url` / `toolCallTimeoutMs` 即可。

## 4. 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 确认 Unity 里桥已启动（Window → MCP for Unity → Start Bridge）
3. 在对话里让模型执行任意 Unity 操作（如“读取 Unity 控制台”），模型应调用
   `mcp__unity__read_console` 等工具
4. 工具名格式：`mcp__unity__<原名>`（如 `mcp__unity__manage_scene`）

## 5. 排查

- 服务器端口 8080 被占用：改 `args` 里的 `--http-url`，并让 `endpointUrl` /
  `url` 保持一致，重启
- 服务器能启动但工具报连接错误：Unity 未开或桥未启动——先检查 Unity 侧
- 多项目共用同一 profile：每次切换项目需改 `cwd` 并重启
- `mcp-unity` 使用 streamable-http 传输，需要 dsh-mcp-client（npm 版内置）

## 6. 卸载

1. 编辑 `cordis.patch.yml`，删除 `mcp-unity` 与 `unity-mcp-supervisor` 两个条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\unity-mcp\`
3. 重启 `dsh web`
