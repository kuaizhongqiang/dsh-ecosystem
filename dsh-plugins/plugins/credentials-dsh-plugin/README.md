# credential-management tools for native dsh

把 `credentials_list` / `credentials_set` / `credentials_unset` /
`credentials_verify` 四个凭证管理工具装进任何一台装有 dsh（npm 版）的电脑，
让模型可以在对话里查看、配置、删除关键 token/key（如 `MIMO_API_KEY`、
`DEEPSEEK_API_KEY`），全程走 dsh 官方凭证 seam，**永不暴露 key 值**。

## 包里有什么

```
credentials-dsh-plugin/
├── install.ps1                    一键安装脚本（幂等，可重复执行）
├── README.md                      本说明
└── plugins/
    └── credentials/
        ├── index.js               凭证管理工具插件（自包含，仅依赖 npm 版
        │                          已有的 dsh-tools / dsh-credentials /
        │                          schemastery）
        └── package.json           ESM 声明（消除 MODULE_TYPELESS 警告）
```

> 本插件自身**不需要任何 API key**（它管理凭证而非调用外部服务），
> 因此没有 `.env.example`。

## 前置要求（目标电脑）

- Node.js（dsh 要求 `^22.19 || >=24`）
- dsh npm 版已安装：`npm install -g @deepseek-ai/dsh`
  （或每次用 `npx @deepseek-ai/dsh`）
- 至少启动过一次 `dsh web`，让 `profiles/web` 目录初始化

## 安装（目标电脑上）

```powershell
cd credentials-dsh-plugin
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：
1. 把 `plugins/credentials` 复制到 `%DSH_HOME%\profiles\web\plugins\credentials`
2. 幂等地在 `cordis.patch.yml` 追加 `- insert:` 挂载条目（已存在则跳过）

## 工具说明

| 工具 | 作用 | 安全特性 |
|------|------|----------|
| `credentials_list` | 列出已配置的凭证引用（可传 `refs` 指定，或不传枚举存储中的所有 key） | 只报 configured/source/writable，**永不返回值** |
| `credentials_verify` | 验证某个引用（如 `MIMO_API_KEY`）是否已配置、来自哪层（env/file/.env） | 只报状态与来源，**不返回值** |
| `credentials_set` | 在托管凭证文件中存储一个 key 值 | 值由用户在本条消息提供；部署了 approval 服务时**写前需用户确认**；描述明令模型不得回显 key |
| `credentials_unset` | 删除一个 key | 不读取、不暴露值；同样可挂 approval |

> 关键安全边界：`credentials_set` 的 key 值会**经过一次对话上下文**（模型
> 可见、工具调用参数会进会话记录）。更保守的路径仍是 GUI 设置页或直接编辑
> `%DSH_HOME%\.credentials.yaml`（改完**无需重启**，热生效）。

## 工作原理

- 全部操作走 `@deepseek-ai/dsh-credentials` 官方 seam（`resolve` /
  `describe` / `set` / `unset`），自动获得：跨进程文件锁、原子写、
  0600 权限（POSIX）、chokidar 热更新、环境变量影子写保护
- 凭证文件：`%DSH_HOME%\.credentials.yaml`（本机 `C:\Users\kuai\.dsh\.credentials.yaml`）
- 解析优先级：进程环境变量 > `.credentials.yaml` > 项目 `.env` > 用户 `.env`

## 可选配置

`cordis.patch.yml` 条目里可覆盖：

```yaml
- insert:
    - id: tool-credentials
      name: './plugins/credentials/index.js'
      config:
        requireApproval: false   # 默认 true；关闭 set/unset 的 approval 闸门
```

## 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 对话里说“MIMO_API_KEY 配置好了吗？”→ 模型调用 `credentials_verify`
   （或 `credentials_list`），返回 configured/source 而不泄露值
3. 说“帮我配置新的 key：FOO_API_KEY = sk-xxx”→ `credentials_set`
   （有 approval 服务时需确认；之后改 `.credentials.yaml` 立即生效）

## 卸载

1. 编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，删除 `tool-credentials` 条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\credentials\`
3. 重启 `dsh web`

（卸载不会删除凭证文件本身。）
