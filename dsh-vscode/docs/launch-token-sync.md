# launch-token 同步补齐 —— dsh-vscode 开发任务书

> 状态：待开发。背景与协议依据：伞仓 `kuaizhongqiang/dsh-ecosystem` 的
> `docs/ECOSYSTEM-PLAN.md`（决策 D5/D6/D8、Phase 5「多连接启动项」的兼容层、Phase 6 重启 seam）
> 与 `docs/modules/dsh-vscode.md`（"token 认证跟随"生态位表述）。实现参照：
> `dsh-launcher` 的 `src/tokenFile.ts` / `src/launch.ts`（协议先落地方）。

## 1. 目标

让 dsh-vscode 完整参与 `%DSH_HOME%\launch-token.json`（下称 **launch-token**）协议，实现
伞仓 D5/Phase 5 承诺的 **token 认证跟随**，修复两类真实问题：

1. **vscode 先拉起 dsh** 时：dsh-launcher 随后点「启动」走"复用已运行实例"分支，
   读共享文件拿 token —— 但 vscode 当前不写该文件，launcher 读不到 → 只能打开无 token
   地址 → 浏览器 401"authentication required"。
2. **launcher 重启 dsh 后**：dsh 每次启动 token 轮换，vscode 仍持有旧的静态
   `dsh.token` → 会话/请求 401，用户需手动重新粘贴 token。

## 2. 协议语义（对齐 launcher 实现）

launch-token 是**当前激活 dsh 实例的唯一记录**，v1 schema：

```jsonc
{
  "version": 1,
  "token": "<dsh web 打印的 ?token= 裸值>",
  "port": 3080,
  "url": "http://127.0.0.1:3080/?token=<token>",
  "pid": 1234,            // 写方 spawn 的 dsh 子进程 PID（清理归属用）
  "writtenAt": "<ISO8601>",
  "source": "dsh-launcher",   // 或 "dsh-vscode"
  "managedBy": "dsh-launcher" // 可选；读取方忽略未知字段
}
```

规则：

- **谁拉起 dsh 谁写**：source 区分发起方；写时带 pid（dsh 子进程 PID）。
- 读取方：按 `url`（desktop 完全跟随）；vscode 的 **serverUrl 仍为静态配置**，
  本轮只做 **token 跟随**，不做 serverUrl 自动切换。
- **清理归属（D8）**：`source` + `pid` 双匹配才删，删除前复读确认（防 TOCTOU）。
  若 vscode 本轮实现清理，必须与 launcher `clearLaunchToken` 同语义；vscode 不清理
  launcher 的记录，反之亦然。**建议本轮 vscode 只写不删**（dsh 进程由谁停，
  谁清理自己那份；vscode 停自己的 dsh 时按 pid 删自己写的记录即可）。
- 红线（D2）：token 明文仅存本机（Windows 依赖 NTFS 默认 ACL，当前用户可读写）；
  **永不**写入扩展包/日志/同步；日志与 UI 中一律脱敏（`token=***`）。
- 文件路径解析：`process.env.DSH_HOME ?? <home>/.dsh`（与 launcher `dshHome()` 同一规则）。

## 3. 现状与差距

| 模块 | 现在做什么 | 缺口 |
|---|---|---|
| `src/config.ts` | `dsh.token` / `dsh.serverUrl` / `dsh.remote` / `dsh.localServerPath` / `dsh.extraHeaders` | token 只来自静态设置 |
| `src/extension.ts` `connect()` | 本地模式：`LocalServerManager.start(cwd)` → `new DshConnection(url, { token: config.token })`；token 为空时跳过认证 | 不读 launch-token；重启后 token 轮换不感知 |
| `src/localServer.ts` | spawn `dsh.cmd web`，日志只抓 `http://127.0.0.1:\d+`（无 token），RPC 探测就绪；**不写** launch-token | ① 不写共享文件 ② 日志正则不含 `?token=` |
| `src/client/auth.ts` | `authenticateWithToken(base, token)` 换 `dsh-auth-*` cookie（303） | 只消费，不管理来源 |

## 4. 实现方案（建议按序完成）

### 4.1 新增共享文件读写模块 `src/launchTokenFile.ts`

对齐 launcher `tokenFile.ts` 的最小实现：

- `dshHome()`：`process.env.DSH_HOME ?? join(homedir(), '.dsh')`。
- `launchTokenFilePath()`：`join(dshHome(), 'launch-token.json')`。
- `readLaunchToken()`：解析 + `version === 1` + token/url 非空校验；缺失/损坏返回 `undefined`。
- `writeLaunchToken(record)`：整文件覆盖；目录不存在先建；写失败不抛（降级为不自动跟随）。
- `tokenFromUrl(url)`：取 `?token=` 参数（无则 undefined）。
- `redactTokenUrl(text)`：`/([?&]token=)[A-Za-z0-9_-]+/g → '$1***'`（日志/UI 必用）。
- （可选，仅当需要）`clearLaunchToken(source, pid)`：source+pid 双匹配 + 删除前复读，语义照抄 launcher。

### 4.2 localServer 拉起 dsh 后写共享文件

`src/localServer.ts` `start()`：spawn 成功后，从 child stdout/stderr 增量累积输出，
正则抓取 `dsh web: (http://127\.0\.0\.1:\d+/.*\?token=[A-Za-z0-9_-]+)`；
抓到即 `writeLaunchToken({ token, url, port, pid: child.pid, source: 'dsh-vscode' })`。
就绪后若仍未抓到（旧版/未打印），不阻塞启动（当前 RPC 探测逻辑不变）。
相关 UI/日志展示该 url 时经 `redactTokenUrl`。

> 可选优化：vscode 拉起时加 `--no-open`（浏览器由谁打开需与 launcher 统一口径，
> 避免 dsh 自开 + launcher 再开；本轮可暂不动）。

### 4.3 连接时 token 来源改为「静态优先 + 共享文件兜底」

`src/extension.ts` `connect()`（本地模式，即非 `dsh.remote`）：
1. 取 `config.token`（静态，用户显式配置时**优先**，向后兼容）；
2. 为空 → `readLaunchToken()`：若其 `url`/port 与本机 serverUrl 对应（默认 3080）
   则用文件内 token，否则无 token（跳过认证，兼容未开启认证的本地服务）；
3. 连接后把使用的来源与过期语义写清（401/重连失败时**重读** launch-token 再试一次）。

remote 模式**不改**：仍走 `dsh.serverUrl` + `dsh.token`/`dsh.extraHeaders`
（remote token 生命周期不同，见 PLAN Phase 5）。

### 4.4 可选：token 失效自动刷新

`DshConnection` 收到 401 / 事件流断线时（`src/client/rpc.ts`、`connection.ts`）：
本地模式下重新 `readLaunchToken()`，若 token 已变则重建连接（避免 launcher restart
后需手动重连）。若接入成本高，可先只做 4.3，此条作为二期。

## 5. 验收清单

- [ ] 本地模式：vscode 在 3080 空闲时「拉起服务」，`%DSH_HOME%\launch-token.json`
      被写入（`source='dsh-vscode'`、pid 正确、url 带 token），日志/UI 无明文 token。
- [ ] 接上条：随后用 dsh-launcher（或任意读方）点启动 → 能拿到 token，不再"找不到 token"。
- [ ] launcher 先拉起 dsh（launch-token 由 launcher 写）→ vscode 本地连接 **不用填**
      `dsh.token` 也能认证成功（读文件兜底生效）。
- [ ] launcher restart 使 dsh 重启（token 轮换）→ vscode 仍显式配置了旧 `dsh.token`
      时按静态优先（保持旧行为）；未配置时自动读到新 token。
- [ ] remote 模式行为不变；serverUrl 不发生自动切换。
- [ ] 红线：仓库内无 token 泄漏；`vsix` 打包不包含本机 launch-token 路径内容。
- [ ] `dsh-vscode` 回归：本地/remote 两种连接、会话列表、聊天收发、工具卡片正常。

## 6. 代码触点汇总

- `src/launchTokenFile.ts`（新）
- `src/localServer.ts`：`start()` 内 child 输出处理段（现仅 `appendLog`），
  就绪探测函数区（`waitUntilReady`/`tryUrls`）
- `src/extension.ts`：`connect()`（约 L139–L183）token 装配逻辑
- `src/config.ts`：如需暴露"本地模式优先读共享文件"开关可加配置项（默认开）
- `src/client/connection.ts` / `rpc.ts`：401 重读（4.4，可选）

## 7. 参考

- 伞仓路线图与决策：`dsh-ecosystem/docs/ECOSYSTEM-PLAN.md`（D5/D6/D8、Phase 5）
- vscode 生态位表述：`dsh-ecosystem/docs/modules/dsh-vscode.md`
- launcher 参照实现：`dsh-launcher/src/tokenFile.ts`（schema/脱敏/原子删）
- 本机现象日志参考（"启动找不到 token"）：`%TEMP%\dsh-launcher.log`、
  `%DSH_HOME%\logs\dsh-launcher-child.log`
