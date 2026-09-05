# GitHub 插件（tool-github）

把 GitHub 仓库管理接入 dsh web：查仓库、读代码、管 issue/PR、本地工作区
同步（clone/pull/commit/push）。架构与 [stock 插件](../stock-dsh-plugin/)一致，
单入口 `plugins/github/index.js` + `lib/` 分层，零第三方依赖（仅 dsh 自带包）。
详细设计见 [DESIGN.md](DESIGN.md)。

## 工具（8 个）

| 工具 | 作用 | 写操作 |
|---|---|---|
| `github_repo` | 仓库详情 / 列仓库 / 分支 / `me` 自检（身份+限流） | — |
| `github_files` | 读文件（自动截断、二进制识别）/ 目录树 | — |
| `github_file_write` | 单文件 create/update/delete（一个 commit） | ✅ |
| `github_issue` | list / get / create / comment / close / reopen / label | ✅ |
| `github_pr` | list / get（含 diff）/ create / comment / merge / close | ✅ |
| `github_commit` | 提交历史 / 单 commit 改动（patch 截断） | — |
| `github_search` | 搜仓库 / 代码（需 token）/ issue | — |
| `github_sync` | list / clone / status / pull / branch / commit / push | ✅ |

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本幂等：复制插件到 `%DSH_HOME%\profiles\web\plugins\github`（打印版本）、
幂等追加 `cordis.patch.yml` 条目。之后重启 `dsh web`。

## Token（可选）

- **无 token**：匿名模式，公开仓库只读（60 次/时）。
- **有 token**：私有仓库 + 写操作（5000 次/时）。推荐 fine-grained PAT：
  Contents / Issues / Pull requests 读写 + Metadata 只读，按仓库勾选，
  **不含删除与管理权限**。存进凭证 seam 即可：`credentials_set` 配置
  `GITHUB_TOKEN`。

## 工作区（github_sync）

| scope | 根目录 | 用途 |
|---|---|---|
| `global`（默认） | `%DSH_HOME%\github\<owner>\<repo>` | 全局工作副本 |
| `project` | `<projectRoot>\.dsh-github\<owner>\<repo>` | 随项目走 |

clone 后工具会输出本地路径，直接用 dsh 的文件工具改代码，再
`github_sync commit` / `push` 推回。push 自动返回创建 PR 的链接。

## 安全设计

- token 只经凭证 seam 读取，永不回显、不进日志、不进 `.git/config`（git 走
  一次性 `http.extraheader` 注入，输出全量脱敏）。
- 破坏性操作（merge / 删文件 / push）必须显式 `confirm: true`。
- `config.allowWrite: false` 可整体锁定只读。
- 不做：删仓库、改仓库设置、force push、删远程分支。
- 提交身份：`user.name` = GitHub login，提交信息自动附
  `Co-authored-by: coworker (DeepSeek Harness GLM)`（可经
  `gitCoworkerName/gitCoworkerEmail` 覆盖）。

## 配置项（cordis.patch.yml）

```yaml
- insert:
    - id: tool-github
      name: './plugins/github/index.js'
      config:
        tokenRef: GITHUB_TOKEN      # 凭证引用名
        apiBase: https://api.github.com
        defaultRepo: ''             # 省略 repo 参数时的默认仓库
        perPage: 25
        timeoutMs: 20000
        workspaceRoot: ''           # 默认 %DSH_HOME%\github
        projectRoot: ''             # project scope 根
        gitUserName: ''             # commit 身份，空则取 GitHub login
        gitUserEmail: ''
        gitCoworkerName: ''         # 默认 coworker (DeepSeek Harness GLM)
        gitCoworkerEmail: ''
        allowWrite: true
        maxFileBytes: 65536
        maxDiffLines: 400
```

## 卸载

1. 编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，删除 `tool-github` 条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\github\`
3. 重启 `dsh web`

（卸载不删除工作区里的本地 clone。）

## 版本

见 [plugins/github/package.json](plugins/github/package.json)；`index.js`
运行时读取并导出 `version`，web 实例日志行 `[tool-github] v…` 可确认实际
加载版本。升级 = 重跑 `install.ps1`。
