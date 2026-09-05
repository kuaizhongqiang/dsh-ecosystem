# MCP for Unity bridge for native dsh

把 MCP for Unity（`mcp-for-unity`）接入任何一台装有 dsh（npm 版）的电脑，
让主对话模型直接获得 `mcp__unity__*` 工具（manage_scene / execute_code /
run_tests / manage_gameobject 等 48 个 Unity Editor 工具）。

包内自带**监督器插件**：它会探测 MCP 服务器端点（默认 `http://127.0.0.1:8080`），
无响应时用 `uvx` 自动拉起服务器并写日志——无需手动维护服务器进程。

## 包里有什么

```
unity-mcp-dsh-plugin/
├── install.ps1                    一键安装脚本（幂等，可重复执行）
├── .env.example                   配置说明模板（本插件无 API 凭证，仅列出可覆盖项）
├── README.md                      本说明
└── plugins/
    └── unity-mcp/
        ├── index.js               unity-mcp-supervisor 插件：探测并自动拉起
        │                          mcp-for-unity 服务器（自包含，仅依赖 cordis）
        └── package.json           ESM 声明（消除 MODULE_TYPELESS 警告）
```

## 前置要求（目标电脑）

- Node.js（dsh 要求 `^22.19 || >=24`）
- dsh npm 版已安装：`npm install -g @deepseek-ai/dsh`
  （或每次用 `npx @deepseek-ai/dsh`，与当前本机用法一致）
- 至少启动过一次 `dsh web`，让 `profiles/web` 目录初始化
- Unity 项目已安装 MCP for Unity 客户端包
  （`com.coplaydev.unity-mcp`），并在 Unity 里启动桥（Window → MCP for Unity）
- uv/uvx 可用（服务器运行方式，安装见 https://docs.astral.sh/uv/）

## 安装（目标电脑上）

```powershell
# 进入解压后的目录
cd unity-mcp-dsh-plugin
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：
1. 把 `plugins/unity-mcp` 复制到 `%DSH_HOME%\profiles\web\plugins\unity-mcp`
2. 幂等地在 `cordis.patch.yml` 追加两个 `- insert:` 挂载条目（已存在则跳过）：
   - `mcp-unity`：`@deepseek-ai/dsh-mcp-client`，streamable-http 连接
     `http://127.0.0.1:8080/mcp`
   - `unity-mcp-supervisor`：本包插件，保证服务器进程存活

> 与 describe-image 包不同，本插件**不需要任何 API key**，没有 `.credentials.yaml`
> 配置步骤。

## 配置（可选，改 `cordis.patch.yml` 里的 `unity-mcp-supervisor` 条目）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `endpointUrl` | `http://127.0.0.1:8080/mcp` | 服务器探活端点 |
| `command` | `C:\Users\kuai\.local\bin\uvx.exe` | 启动服务器的可执行文件 |
| `args` | uvx 全参数 | `--transport http --http-url http://127.0.0.1:8080 --project-scoped-tools` |
| `cwd` | Unity 项目路径 | 决定 `--project-scoped-tools` 作用的目标项目 |
| `logFile` | `%DSH_HOME%\logs\unity-mcp-server.log` | 服务器输出日志 |
| `checkIntervalMs` | `10000` | 探活间隔 |
| `startupTimeoutMs` | `90000` | 拉起后等待就绪的最长时间 |
| `maxStartupFailures` | `3` | 连续失败上限，超过后暂停自动重启 |

监督器**不会杀**你手动启动的服务器：只有它自己拉起的子进程才会在插件销毁时被清理。
`mcp-unity` 桥接条目如需调整，改 `url` / `toolCallTimeoutMs` 即可。

## 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 确认 Unity 里桥已启动（Window → MCP for Unity → Start Bridge）
3. 在对话里让模型执行任意 Unity 操作（如"读取 Unity 控制台"），
   模型会调用 `mcp__unity__read_console` 等工具
4. 工具名格式：`mcp__unity__<原名>`（如 `mcp__unity__manage_scene`）

## 已知边界

- 服务器端口默认 8080，被占用时改 `args` 里的 `--http-url` 与 `endpointUrl`/`url` 保持一致。
- `cwd` 决定 `--project-scoped-tools` 的目标项目；多项目共用同一 profile 时，
  每次切换项目需改该字段并重启。
- 监督器只在端点无响应时拉起服务器；若服务器能启动但连不上 Unity 桥
  （Unity 未开 / 桥未启动），工具会报连接错误——先检查 Unity 侧。
- `mcp-unity` 使用 streamable-http 传输，需要 dsh-mcp-client（npm 版内置）。
