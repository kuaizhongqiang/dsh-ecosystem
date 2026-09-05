# 安装 github 插件

把 GitHub 仓库管理插件装进目标电脑的 dsh web：8 个工具覆盖仓库/文件/issue/PR
的查询与写操作，以及本地工作区同步（clone/pull/commit/push）。

- **无 token**：匿名模式，公开仓库只读（60 次/时），装完即用。
- **有 token**（`GITHUB_TOKEN`）：私有仓库 + 写操作（5000 次/时）。

推荐 fine-grained PAT：Contents / Issues / Pull requests 读写 + Metadata
只读，按仓库勾选，不含删除与管理权限。

## 0. 定位插件包

插件包在本仓库 `plugins/github-dsh-plugin/`，二选一获取：

- 本地已有仓库克隆：直接用 `<仓库根>/plugins/github-dsh-plugin`
- 没有克隆：`git clone https://github.com/kuaizhongqiang/dsh-plugins`，
  或让用户下载 Release 压缩包并解压

以下步骤均在插件包目录内执行。

## 1. 检查前置（目标电脑）

1. Node.js 满足 dsh 要求：`node -v` 应输出 `^22.19 || >=24`
2. dsh 已安装：`npm install -g @deepseek-ai/dsh`（或确认 `npx @deepseek-ai/dsh` 可用）
3. `%DSH_HOME%\profiles\web` 已初始化（`$env:DSH_HOME` 缺省 `~/.dsh`）。
   至少启动过一次 `dsh web`；没有就先用 `dsh web` 启动一次再继续
4. （可选，github_sync 需要）git 在 PATH 中：`git --version`

## 2. 执行安装脚本

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会（幂等，可重复执行）：

1. 复制 `plugins/github`（index.js + package.json + lib/）到
   `%DSH_HOME%\profiles\web\plugins\github`，并打印版本号
2. 幂等地在 `cordis.patch.yml` 追加 `- insert:` 的 `tool-github` 挂载条目
   （已存在则跳过；一个条目注册八个工具）

确认输出出现 `OK  plugin copied ... (v0.1.0)`、`OK  profile patch entry
added`（或 `SKIP ... already present`）。若报 `no dsh profiles found` 或
`web profile not found`，回到步骤 1 检查。

## 3. 可选配置

### Token（解锁私有仓库与写操作）

让用户在对话里执行 `credentials_set` 配置 `GITHUB_TOKEN`（fine-grained PAT，
权限见上），或设置同名环境变量。插件运行时经凭证 seam 读取，永不回显。

### cordis.patch.yml 条目里可覆盖

```yaml
- insert:
    - id: tool-github
      name: './plugins/github/index.js'
      config:
        defaultRepo: owner/repo        # repo 参数缺省值
        projectRoot: F:/some/project   # project-scope 工作区根
        allowWrite: false              # 整体锁定只读
        tokenRef: GITHUB_TOKEN         # 凭证引用名
```

## 4. 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）；
   启动日志应出现 `[tool-github] v0.1.0 — 9 tools registered`
2. 对话里试（按依赖 token 与否排列）：
   - "看下 kuaizhongqiang/dsh-plugins 这个仓库" → `github_repo` get（匿名可测）
   - "读一下它的 README.md" → `github_files`（匿名可测）
   - "最近有什么提交" → `github_commit`（匿名可测）
   - "github 现在什么身份" → `github_repo` action me（验证 token 与限流）
   - "把 3 号 issue 关掉，评论已修复" → `github_issue` close（需 token）
   - "把本仓库 clone 到项目工作区改 README 再推送" → `github_sync` clone →
     文件工具 → `github_sync` commit / push（需 token）

## 5. 排查

- 报 `no-token`：该操作需要 `GITHUB_TOKEN`；用 `credentials_set` 配置后重试
- 报 401 / 403 权限：fine-grained PAT 需勾选目标仓库与 Contents/Issues/Pull
  requests 写权限；classic token 需 `repo` scope
- 报限流（403 rate limit）：匿名 60 次/时太紧，配 token 或等重置
- `github_sync` 报 `git-missing`：安装 Git for Windows
- `github_sync` 报 `dirty-worktree`：先 commit 再 pull；pull 仅 fast-forward
- push 报认证失败：确认 token 有目标仓库的 Contents 写权限；token 不会写入
  `.git/config`，每次推送临时注入
- 升级：重跑 `install.ps1`（覆盖复制，patch 条目幂等跳过），重启 `dsh web`

## 6. 卸载

1. 编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，删除 `tool-github` 条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\github\`
3. 重启 `dsh web`

（卸载不会删除工作区里的本地 clone。）
