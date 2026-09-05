# GitHub 插件（tool-github）详细设计

> 状态：已实现（v0.1.1，8 工具，冒烟测试通过） · 2026-02
>
> 定位：把 GitHub 仓库管理接入 dsh web——查仓库、读代码、管 issue/PR、
> 本地工作区同步（clone/commit/push）。对齐 stock 插件的架构与工程约定。

## 0. 目标与原则

1. **LLM-first 输出**：GitHub REST API 返回的 JSON 极啰嗦，插件层裁剪成紧凑
   结构（结构化 schema + render 文本），一个工具调用不吃掉半个上下文。
2. **无 token 也可用**：不带 token 走公开接口（60 次/时），公开仓库立即可用；
   配置 `GITHUB_TOKEN` 后解锁私有仓库 + 写操作（5000 次/时）。
3. **零外部依赖**：只用 `node:fs` / `node:child_process` / 全局 `fetch`，
   依赖面与 stock 相同（dsh 自带 `@deepseek-ai/dsh-tools`）。
4. **写操作分层闸门**：常规写直接可用，破坏性操作（merge / 删文件 / push）
   必须显式传 `confirm: true`；插件配置可整体关闭写。

## 1. 插件版本字段规范（含存量补齐）

现状：所有插件（describe-image / unity-mcp / stock）均无 version 字段。

### 规范

1. **`package.json` 是版本的单一事实来源**：

   ```json
   {
     "name": "dsh-profile-web-plugin-github",
     "version": "0.1.0",
     "private": true,
     "type": "module"
   }
   ```

2. **`index.js` 运行时读取版本**（不硬编码，避免两处漂移）：

   ```js
   import { readFileSync } from 'node:fs'
   import { fileURLToPath } from 'node:url'
   import { join, dirname } from 'node:path'

   const PKG = JSON.parse(readFileSync(
     join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
   export const version = PKG.version
   ```

   `apply()` 首次注册时 `console.info('[tool-github] v' + version)` 一行，
   便于从 web 实例日志确认实际加载的版本。

3. **`install.ps1` 打印版本**：复制完成后输出
   `OK  plugin copied -> <dir>  (v0.1.0)`，从 package.json 读取。

4. **`cordis.patch.yml` 条目注释带版本**：
   `# --- tool-github v0.1.1 ---`（升级后重跑 install.ps1 时该注释保持幂等
   匹配 id，不重复插入；版本体现在注释需人工看，仅作参考不作匹配依据）。

5. **升级流程 = 重跑 install.ps1**：覆盖复制（幂等）+ patch 条目按 id 幂等
   跳过；重启 `dsh web` 后日志行确认新版本。

### 存量插件补齐清单

| 插件 | 动作 | 目标版本 |
|---|---|---|
| describe-image | package.json 加 version + index.js 加运行时读取 + install.ps1 打印 | 0.1.0 |
| unity-mcp | 同上 | 0.1.0 |
| stock（远端仓库） | 同上；install.ps1 需补复制 package.json 的一步 | 0.1.0 |

## 2. 总体架构

```
plugins/github-dsh-plugin/
├── DESIGN.md                  ← 本文件
├── install.ps1                ← 幂等安装（复制 + patch 条目 + 版本打印）
├── README.md
├── .env.example               ← 仅注释说明 token 走 credentials seam
└── plugins/github/
    ├── package.json           ← name/version/private/type
    └── index.js               ← 全部逻辑，目标 ≤ 1100 行
```

- 导出：`name = 'tool-github'`、`inject = ['tools']`、`Config`（schemastery）、
  `version`、`apply(ctx, config)`。
- 工具注册形态与 stock 一致：

  ```js
  ctx.tools.register(defineTool({
    name, description,
    parameters: { /* 扁平参数声明 */ },
    output: { schema: { /* 结构化结果 */ }, render: (_args, value) => [{ type: 'text', text }] },
    async execute(args) { /* ... */ },
    presentCall: args => ({ card: 'generic', title: 'GitHub ...', kind: 'read' | 'write', rawInput: args }),
  }))
  ```

  **所有变更类工具 `presentCall.kind = 'write'`**，UI 侧可据此区分展示。

### 内部分层（index.js 内）

| 层 | 职责 |
|---|---|
| `gh(path, opts)` | fetch 封装：`apiBase` 拼接、`Authorization`（有 token 时）、`Accept: application/vnd.github+json`、超时（AbortController）、错误归一化 `{ status, message, hint }`、解析 `x-ratelimit-remaining/reset` |
| `paginate(path, params, { perPage, max })` | page 循环聚合，默认单页，`max` 截断 |
| `resolveRepo(input)` | `owner/repo`、完整 URL、配置的 `defaultRepo` 三种来源归一；解析失败报使用说明 |
| `getToken()` | 读凭证文件 `%DSH_HOME%\.credentials.yaml` 中 `config.tokenRef`（默认 `GITHUB_TOKEN`）；缺失 → 匿名模式（read-only 公开） |
| 速率追踪 | 模块级记录 remaining/reset；`< 20` 时每次输出附加 `⚠ rate remaining N, resets HH:MM`；403/429 归一为明确的限流错误 |

**错误输出统一形态**：`{ error: { status, message, hint? } }`。典型 hint：
- 404 + 匿名 → "仓库可能是私有的；用 credentials_set 配置 GITHUB_TOKEN"
- 401 → "token 失效或权限不足（fine-grained PAT 需勾选对应仓库与权限）"
- 403 + rate → "限流；reset 时间 / 建议配置 token"

## 3. 工具明细（8 个）

通用约定：`repo` 参数接受 `owner/repo` 或 URL；列表默认 `perPage: 25`（上限
100）；时间一律 ISO8601；`kind` 列标注 presentCall 类型。

### 3.1 github_repo — 仓库/分支/自检（kind: read）

| 参数 | 说明 |
|---|---|
| `action` | `get`（默认）/ `list` / `branches` / `me` |
| `repo` | get/branches 必填 |
| `owner` | list + 匿名时必填（`/users/{owner}/repos`）；有 token 时走 `/user/repos` |
| `type` | list: `owner`/`all`/`member`，默认 `owner` |
| `sort` | list: `pushed`（默认）/`updated`/`full_name` |
| `perPage` | 默认 25 |

- `get` → fullName、description、private、defaultBranch、stars/forks/openIssues、language、license、pushedAt、htmlUrl
- `branches` → name、protected、commit sha 前 7 位
- `me` → 登录名、token 类型（匿名/fine-grained/classic）、rate remaining/reset、token 可见仓库数。**诊断入口，也是安装后的第一步验证。**

### 3.2 github_files — 目录树/读文件（kind: read）

| 参数 | 说明 |
|---|---|
| `action` | `read`（默认）/ `tree` |
| `repo` | 必填 |
| `path` | 文件或目录路径，`/` 为根 |
| `ref` | 分支/tag/sha，默认仓库默认分支 |
| `recursive` | tree: 走 git trees API 递归，条目上限 1000，超限标 `truncated: true` |
| `maxBytes` | read: 截断阈值，默认 65536 |

- `read` → 解码文本（base64→utf8）；含 NUL 判定为二进制，只回元数据（size、可下载 url）；截断时附 `truncated: true` 与已读字节数。API 上限 1MB，超限 hint 指引用 `github_sync` 或 raw url。
- `tree` → 每项 name、type（file/dir/symlink）、size；浅层走 Contents API。

### 3.3 github_file_write — 单文件提交（kind: write）

| 参数 | 说明 |
|---|---|
| `action` | `create` / `update` / `delete` |
| `repo` `path` `message` | message 为提交信息，必填 |
| `content` | create/update 必填（utf8 文本） |
| `branch` | 默认默认分支 |
| `confirm` | **delete 必须为 true** |

- update/delete 先 GET 现文件拿 sha，404 时明确提示（update 遇 404 → 建议改 create）。
- 返回：commit sha、文件 html_url。
- 建议文件 ≤ 512KB；更大走 `github_sync`。
- 每次调用一个 commit——多文件改动应使用 `github_sync commit`。

### 3.4 github_issue — issue 管理（read / write）

| 参数 | 说明 |
|---|---|
| `action` | `list` / `get` / `create` / `comment` / `close` / `reopen` / `label` |
| `repo` `number` | get 起必填 |
| `state` | list: `open`（默认）/`closed`/`all` |
| `labels` | list: 逗号分隔过滤；create/label: 数组 |
| `title` `body` | create 必填 title；comment 必填 body |
| `comment` | close/reopen 可选附带评论 |
| `add` `remove` | label: 增/删标签数组 |
| `includeComments` | get: true 时附最近 10 条（每条截 1000 字符） |

- list 项：number、title、author、labels、updatedAt、comments 数。
- comment/close/reopen/label → kind: write。

### 3.5 github_pr — PR 管理（read / write）

| 参数 | 说明 |
|---|---|
| `action` | `list` / `get` / `create` / `comment` / `merge` / `close` |
| `repo` `number` | get 起必填 |
| `state` `base` `perPage` | list 过滤 |
| `title` `head` `base` `body` `draft` | create；head/base 必填 |
| `diff` | get: 默认 true，附 patch（全量上限 400 行 / 50KB）+ files 摘要（filename、status、±行数） |
| `method` | merge: `merge`（默认）/`squash`/`rebase` |
| `confirm` | **merge 必须为 true** |

- get 的 diff 用 `Accept: application/vnd.github.diff`；冲突/未合并状态一并返回（mergeable 字段）。

### 3.6 github_commit — 提交历史与改动（kind: read）

| 参数 | 说明 |
|---|---|
| `action` | `list`（默认）/ `get` |
| `repo` | 必填 |
| `sha` | list 起点 ref/分支，默认默认分支 |
| `path` | list: 只看该路径的历史 |
| `ref` | get: 指定 commit |
| `perPage` | 默认 25 |

- list 项：sha7、author、date、message 首行。
- get → stats（±行数）、files 摘要 + 每文件 patch（单文件 60 行、总量 400 行上限）。

### 3.7 github_search — 搜索（kind: read）

| 参数 | 说明 |
|---|---|
| `scope` | `repos` / `code` / `issues` |
| `q` | GitHub 查询语法原文（如 `defineTool repo:kuaizhongqiang/dsh-plugins`） |
| `perPage` | 默认 25，上限 50 |

- 注意事项写进 description：code 搜索需 token、只索引默认分支 <384KB 文件；
  search 限流独立（匿名 10 次/分，token 30 次/分）。
- 输出按 scope 裁剪：repos → fullName/desc/stars；code → repo/path/sha7/片段 URL；issues → repo/number/title/state。

### 3.8 github_sync — 本地工作区同步（kind: write）

详见 §4。子命令：`list` / `clone` / `status` / `pull` / `branch` / `commit` / `push`。

## 4. github_sync 详细设计

### 4.1 工作区布局（拍板：全局级与项目级分离）

| scope | 根目录 | 用途 |
|---|---|---|
| `global`（默认） | `%DSH_HOME%\github\<owner>\<repo>`（config.workspaceRoot） | 与具体项目无关的仓库 |
| `project` | `<projectRoot>\.dsh-github\<owner>\<repo>` | 随项目走的工作副本 |

- `projectRoot` 来源：`config.projectRoot` → 调用参数 `projectRoot`（模型传
  当前工作目录）；两者皆缺时报错说明如何指定。
- 参数 `repo`（经 resolveRepo）或 `path`（直接给本地路径）二选一；`scope`
  仅在未给 `path` 时生效。
- **与 dsh 的核心协同**：clone 完成后输出本地路径，模型即可直接用
  read/edit/write/glob/grep 大改代码，改完回来 commit+push。Contents API
  只适合单文件小改，批量改动一律走这里。

### 4.2 子命令

通用参数：`repo` / `path` / `scope`（`global` 默认）/ `projectRoot`。

| 子命令 | 行为 | 关键点 |
|---|---|---|
| `list` | 枚举 global 与 project 两个工作区的仓库 + 当前分支 | 零风险 |
| `clone` | `repo`(+`ref`?+`depth`?) → 若已存在则报错并提示用 `pull` | 有 token 时注入凭据克隆私有仓库 |
| `status` | `git status --porcelain=v1 -b` 解析 → branch、ahead/behind、staged/modified/untracked（各上限 50） | 零风险 |
| `pull` | 脏工作区直接拒绝并附 status；`git pull --ff-only` | 冲突时输出冲突文件清单，不建议插件自动 rebase |
| `branch` | `name`(+`create`?+`from`?) → checkout(-b) | 新改动一律开分支，防止直推主干 |
| `commit` | `message` 必填；`add`: `all`（默认）/`staged`/路径数组 → add + commit | 输出本次提交文件清单；空提交报错 |
| `push` | `branch`? 默认当前；首次推送自动 `-u`；**`confirm: true` 必传** | 见 4.3 |

### 4.3 鉴权与安全

1. **token 不落盘**：推送/克隆私有仓库用一次性参数注入
   `git -c http.https://github.com/.extraheader="AUTHORIZATION: basic <base64('x-access-token:' + token)>"`
   不写 `.git/config`、不配 credential.helper；`push` 是唯一涉及网络写的地方。
2. **脱敏**：所有 git stderr 输出经正则清洗（`ghp_…` / `github_pat_…` /
   base64 串）后再返回；`GIT_TERMINAL_PROMPT=0` 防交互挂死。
3. **明确不做**：force push、删远程分支、改远端配置、`git reset --hard`。
4. **git 身份（拍板）**：提交人 = `user`，并带 AI 协作者署名。`config.gitUserName/gitUserEmail`
   优先；否则 user.name 取 `/user` 的 login，user.email 用
   `<login>@users.noreply.github.com`（per-invocation `-c` 注入，不落盘）。
   插件在提交信息末尾自动追加
   `Co-authored-by: coworker (DeepSeek Harness GLM) <coworker@deepseek-harness.invalid>`
   （名称/邮箱可经 `gitCoworkerName/gitCoworkerEmail` 覆盖；message 已含
   Co-authored-by 时不重复追加）。
5. push 成功输出：目标分支、`https://github.com/<owner>/<repo>/compare/<default>...<branch>`
   一键开 PR 链接，并提示可用 `github_pr create` 直接建 PR。

## 5. 输出与截断规范

- 列表 `perPage` 默认 25（上限 100）；文件读默认 64KB；diff 总量 400 行；
  正文摘要 2000 字符；每类截断都带显式 `truncated` 标记。
- render 文本面向聊天 UI（紧凑表格/列表），结构化 schema 面向模型。

## 6. 安全设计汇总

| 层 | 机制 |
|---|---|
| 凭证 | token 只经 credentials seam 读取，永不回显、不进日志、不进 git 配置 |
| 闸门 | merge / delete 文件 / push 必须 `confirm: true`；`config.allowWrite=false` 整体禁写 |
| 权限 | 推荐 fine-grained PAT：Contents RW + Issues RW + Pull requests RW + Metadata R，仅勾选目标仓库 |
| 限流 | remaining < 20 预警；429/403 归一化提示 |
| 范围外 | 不做：删仓库、改仓库设置、force push、管理协作者/secret |

## 7. 配置项（cordis.patch.yml `config:` 节）

```yaml
- insert:
    - id: tool-github
      name: './plugins/github/index.js'
      config:
        tokenRef: GITHUB_TOKEN        # credentials seam 引用名
        apiBase: https://api.github.com  # 预留 GHES
        defaultRepo: ''               # 省略 repo 参数时的默认仓库
        perPage: 25
        timeoutMs: 20000
        workspaceRoot: ''             # 默认 %DSH_HOME%\github（global scope）
        projectRoot: ''               # project scope 根，空则由调用参数传入
        gitUserName: ''               # commit 身份，空则取 GitHub login
        gitUserEmail: ''              # 空则 <login>@users.noreply.github.com
        gitCoworkerName: ''           # 默认 coworker (DeepSeek Harness GLM)
        gitCoworkerEmail: ''          # 默认 coworker@deepseek-harness.invalid
        allowWrite: true              # false = 全插件只读
        maxFileBytes: 65536
        maxDiffLines: 400
```

## 8. 安装与 skill

- `install.ps1`：照 describe-image 模式（前置检查 → 复制 index.js+package.json
  并打印版本 → patch 条目幂等追加 → token 配置提醒 → 重启提示）。无 apiproxy 步骤。
- `skills/install-github/SKILL.md`：对齐 install-stock 的六段结构（定位插件包
  → 前置 → 安装 → 可选配置（credentials_set GITHUB_TOKEN）→ 验证对话 → 排查/卸载）。
- 验证对话样例：`"看下 kuaizhongqiang/dsh-plugins 最近有什么提交"` →
  github_commit list；`"把 3 号 issue 关掉，评论已修复"` → github_issue close；
  `"把本仓库 clone 下来改完 README 再推送"` → github_sync clone → 文件工具 →
  github_sync commit/push。

## 9. 实现顺序与验收

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P1 | HTTP 层 + github_repo(get/list/branches/me) + github_files + github_commit + github_search | 无 token 可测（公开仓库） |
| P2 | github_issue / github_pr / github_file_write / github_notifications | 需 GITHUB_TOKEN |
| P3 | github_sync 全子命令 | 本地 git 冒烟（建 scratch 仓库实推） |
| P4 | install.ps1 + SKILL.md + README + 存量插件版本补齐 + 端到端验收 | — |

验收清单：每个工具至少 1 条真实对话样例跑通；版本日志行可见；无 token 时
错误提示可指导配置；git stderr 无 token 泄漏（专项检查）。

## 10. 拍板结果（已确认）

1. **PAT**：fine-grained，Contents/Issues/PR RW + Metadata R，不含删除与管理
   权限（"不删库就问题不大"）。
2. **默认值**：perPage 25 / 文件读 64KB / diff 400 行，按 §5 维持。
3. **工作区**：全局与项目分离（§4.1）——global=`%DSH_HOME%\github`，
   project=`<projectRoot>\.dsh-github`。
4. **提交身份**：user.name=GitHub login，user.email=`<login>@users.noreply.github.com`，
   提交信息自动附 `Co-authored-by: coworker (DeepSeek Harness GLM)`（可配置）。
5. **版本**：github 0.1.0；存量补齐 describe-image / unity-mcp / stock 均 0.1.0。
6. **notifications 移除（v0.1.1）**：PAT 未授予 Notifications read 权限且不需要该
   功能，`github_notifications` 从插件移除（工具数 9 → 8）。
