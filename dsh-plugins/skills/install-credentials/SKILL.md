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
   （已存在则跳过；一个条目注册四个工具）

确认输出出现 `OK  plugin copied`、`OK  profile patch entry added`（或
`SKIP ... already present`）。若报 `no dsh profiles found` 或 `web profile
not found`，回到步骤 1 检查 dsh 是否装好、`dsh web` 是否初始化过。

> 本插件自身不需要任何 API key（它管理凭证而非调用外部服务），无需配置
> MIMO_API_KEY 等。

## 3. 可选配置

`cordis.patch.yml` 条目里可覆盖：

```yaml
- insert:
    - id: tool-credentials
      name: './plugins/credentials/index.js'
      config:
        requireApproval: false   # 默认 true；关闭 set/unset 的 approval 闸门
```

## 4. 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 在对话里说“MIMO_API_KEY 配置好了吗？”→ 模型调用 `credentials_verify`
   （或 `credentials_list`），返回 configured/source 而不泄露值
3. 说“帮我配置新的 key：FOO_API_KEY = sk-xxx”→ `credentials_set`
   （有 approval 服务时需确认；写入后热生效，无需重启）

## 5. 排查

- 报 `no credentials service is mounted`：凭证服务未随 profile 加载，
  检查 dsh 版本/安装是否完整
- `credentials_set` 报 `not approved`：approval 闸门拒绝了写入（策略
  `never` 或无应答者时失败关闭属预期）；可确认后再试，或按需配置
  `requireApproval: false`
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
