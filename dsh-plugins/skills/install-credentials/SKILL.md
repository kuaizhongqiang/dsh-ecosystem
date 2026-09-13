---
name: install-credentials
description: 把 credentials_list / credentials_set / credentials_unset / credentials_verify 四个凭证管理工具安装到 dsh web（全程走官方凭证 seam，管理 %DSH_HOME%\.credentials.yaml，永不暴露 key 值，set 可挂 approval 闸门）。当用户要求安装、卸载或排查 credentials 插件，或想在对话里查看/配置/删除关键 token 或 API key 时使用。
whenToUse: 用户想给 dsh 加凭证管理能力（对话里查看/配置/删除 key）、要求安装或卸载 credentials 插件、或装完新插件后需要配置并验证其 API key 时。
---

# 安装 credentials 插件

把 `credentials_list` / `credentials_set` / `credentials_unset` /
`credentials_verify` 四个凭证管理工具装进目标电脑的 dsh web，让模型可以在
对话里查看、配置、删除关键 token/key，全程走官方凭证 seam
（`@deepseek-ai/dsh-credentials`），**永不暴露 key 值**。

## 0. 定位插件包

插件包在本仓库 `plugins/credentials-dsh-plugin/`，二选一获取：

- 本地已有仓库克隆：直接用 `<仓库根>/plugins/credentials-dsh-plugin`
- 没有克隆：`git clone https://github.com/kuaizhongqiang/dsh-plugins`，
  或让用户下载 Release 压缩包并解压

以下步骤均在插件包目录内执行。

## 1. 检查前置（目标电脑）

1. Node.js 满足 dsh 要求：`node -v` 应输出 `^22.19 || >=24`
2. dsh 已安装：`npm install -g @deepseek-ai/dsh`（或确认 `npx @deepseek-ai/dsh` 可用）
3. `%DSH_HOME%\profiles\web` 已初始化（`$env:DSH_HOME` 缺省 `~/.dsh`）。
   至少启动过一次 `dsh web`；没有就先用 `dsh web` 启动一次再继续

## 2. 执行安装脚本

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会（幂等，可重复执行）：
1. 复制 `plugins/credentials` 到 `%DSH_HOME%\profiles\web\plugins\credentials`
2. 幂等地在 `cordis.patch.yml` 追加 `- insert:` 的 `tool-credentials` 挂载条目
   （已存在则跳过；一个条目注册四个工具）。本部署的条目带
   `config: requireApproval: false`（approval 策略为 `never` 时闸门必然拒绝，
   详见 §3）；旧条目缺这段 config 时脚本会原地补上
3. 写完后调用 `scripts/validate-patch.mjs` 校验整份 `cordis.patch.yml`，
   发现 YAML 被写坏（例如 `config:` 解析成 null）会打印 `FAIL`

确认输出出现 `OK  plugin copied`、`OK  profile patch entry added`（或
`SKIP ... already present`）以及 `OK patch parses and every insert item is
well formed`。若报 `no dsh profiles found` 或 `web profile not found`，回到
步骤 1 检查 dsh 是否装好、`dsh web` 是否初始化过。

> 本插件自身不需要任何 API key（它管理凭证而非调用外部服务），无需配置
> MIMO_API_KEY 等。

## 3. 配置与 approval 闸门

`requireApproval` 默认 `true`（写前走 approval 闸门）。**只有部署里存在能给出
`allowed-once` 的应答方时才应打开**：本部署的 approval 策略是 `never`，
`approval.request()` 会直接返回 `rejected`，闸门打开就等于每次写入都失败
（历史故障：条目里 `config:` 后面紧跟注释行，YAML 把 `requireApproval: false`
折进注释，`config` 解析成 `null`，插件回落到默认 `true`，于是
`credentials_set` 稳定报 “the write was not approved (rejected)”）。

```yaml
- insert:
    - id: tool-credentials
      name: './plugins/credentials/index.js'
      config:
        requireApproval: false   # 本部署默认；策略 never 下必须为 false
```

要点：YAML 里 `config:` 之后**不要**紧跟缩进注释再写键值——注释会把下一行
折进注释运行；注释要写在 `config:` 上方或键值之后。

## 4. 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 在对话里说“MIMO_API_KEY 配置好了吗？”→ 模型调用 `credentials_verify`
   （或 `credentials_list`），返回 configured/source 而不泄露值
3. 说“帮我配置新的 key：FOO_API_KEY = sk-xxx”→ `credentials_set`
   （`requireApproval: false` 时直接写入；写入后热生效，无需重启）

## 5. 排查

- 报 `no credentials service is mounted`：凭证服务未随 profile 加载，
  检查 dsh 版本/安装是否完整
- `credentials_set` 报 `not approved`：approval 闸门拒绝了写入。先确认条目里
  `requireApproval: false` **真的被解析到**（`config` 不应是 `null`）——
  可用 `node scripts/validate-patch.mjs %DSH_HOME%\profiles\web\cordis.patch.yml`
  校验；若闸门确实打开而策略是 `never`，插件现在会直接报
  “this session's approval policy is "never"” 而不是含糊的 not approved
- `credentials_set` 报 `supplied read-only by the launching environment`：
  该 key 由进程环境变量提供，seam 拒绝写入（写了也会被环境遮蔽）；
  需在启动 dsh 的 shell 里取消环境变量
- `credentials_list` 不传参时列出的 key 来自托管凭证文件
  （`%DSH_HOME%\.credentials.yaml`）；环境变量提供的 key 需显式传 `refs`

## 6. 卸载

1. 编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，删除 `tool-credentials` 条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\credentials\`
3. 重启 `dsh web`

（卸载不会删除凭证文件本身。）
