# dsh-launcher —— launcher 桥接插件(PM3,6 工具)

> 把 launcher 的宿主能力(重启/连接/状态/打开/升级)升级为 dsh 一等工具面(PLAN §8 / D6)。
> 依赖 launcher **M5**(connections.json)与 **M6**(restart API + 注册文件 + 环境变量注入)。

## 工具(6,无新凭证)

| 工具 | 说明 |
|---|---|
| `launcher_restart(reason?)` | 按 D6 发现链委托 launcher 重启:① `DSH_LAUNCHER_EXE` 环境变量 → ② `launcher-registration.json`(心跳+pid 复核)REST bridge 优先、其次 `<launcherExe> restart` → ③ 提示手动。触发前把 `reason` 写入重启意图文件(编排 seam) |
| `launcher_status(clearRestartIntent?)` | launcher 注册(版本/pid/心跳/running)+ 激活连接 + launch-token 状态 + **重启意图**(重启后待恢复提示;`clearRestartIntent=true` 确认清除),token 脱敏 |
| `launcher_connections` | 列出/切换 `connections.json` 连接组(`action=use`,可 `restart=true` 立即生效);写 D8 变更标记 |
| `launcher_open` | 按激活/指定连接打开浏览器(带 token 自动登录;url 脱敏回显) |
| `launcher_check_update` | launcher GitHub Release 升级检测(升级需用户主动确认,M8 lock 语义) |
| `launcher_cli(action, version?, from?, force?)` | **dsh-cli(L1.5 入口层)的安装 / 更新入口**:`status` 看是否已安装/版本(纯本地读,不触网);`install` 从伞仓 Release 按**本机平台**取资产(Windows `dshcli.exe` / Linux `dshcli-linux-<arch>`,非 Windows 自动补可执行位),可给 `version`,或给 `from` 用本地文件 / 私有 URL;`update` 检查并升级(版本相同不重装,`force=true` 可强装);`start` 拉起 `dshcli serve` |

### dsh-cli 的安装 / 更新入口(`launcher_cli`)

launcher 侧对 dsh-cli 提供**两条入口**(主人 2026-09-24 追加要求):

- **安装入口** —— `launcher_cli {action:'install'}`:默认从伞仓 Release 取**稳定资产名**
  `https://github.com/kuaizhongqiang/dsh-ecosystem/releases/latest/download/dshcli.exe`,
  落到 `%DSH_HOME%\bin\dshcli.exe`,并在旁边写 `dshcli.install.json`(版本 / 大小 / sha256 / 来源,**不含任何 token**);
  给了 `version` 就取带版本资产 `dshcli-<ver>.exe`;
- **更新入口** —— `launcher_cli {action:'update'}`:比对已装版本与目标版本,**不同才下载替换**,旧 exe 备份为
  `dshcli.exe.bak-<时间戳>`;`action:'start'` 拉起 `dshcli serve`(常驻服务,token 见
  `%DSH_HOME%\dsh-cli\endpoint.json`)。
- **内网 / 离线**:给 `from`(本地 exe 路径或私有 URL)即可,走完全同一套流程 —— 质量门就是这么离线验的。

## 重启编排 seam(2026-09-05)

`launcher_restart` 跑在 dsh 进程内,重启会杀掉本进程与进行中的回合/后台任务。工具在委托重启前
原子写 `%DSH_HOME%\.dsh-restart-intent.json`(`{version, requestedAt, reason, byPid}`,无 token);
重启后恢复会话时,`launcher_status` 若显示「⚠️ 上次重启意图」即提示先 `update_goal resume`
再继续被中断工作,完成后用 `clearRestartIntent=true` 清除。详见 `skills/install-launcher/SKILL.md` §3a。

## 输出契约(issue #30)

工具返回值一律**无损 JSON**:`launcher_status` 的 `detail` 在出口经 `jsonSafe()` 递归清洗
(对象 `undefined` 属性剔除、数组项与 `NaN`/`Infinity` 归 `null`),连接对象经 `stripToken()` 剔除 `token`。
dsh 侧把「含 `undefined` 值的结果」判为非 lossless JSON 并让**整条工具失效**(这正是 issue #30 的现象);
新增字段照此接入,勿再写 `x ?? undefined` 之类的占位。

## 安装

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

Linux / macOS（POSIX，与 install.ps1 等价）：

```sh
./install.sh              # 安装（幂等）
./install.sh --uninstall  # 卸载（删载荷 + 精确剥掉本节 patch，不碰别的节）
DSH_HOME=/path ./install.sh          # 指定 DSH_HOME（缺省 ~/.dsh）
./install.sh --profile /x/profiles/web   # 直接指定 web profile 目录
```

两者都会在写 patch 后用 `dsh-plugins/scripts/validate-patch.mjs` 校验；校验不过会**非零退出**，
不会让你带着坏 patch 去重启。

重启 web 实例后工具生效（服务端 profile 补丁**不是**热重载的，`patchReload: live` 只覆盖客户端插件；
0.1.7 起 launcher 会把 `patchReload` 钉成 `startup`）。工具只读/写 `%DSH_HOME%` seam 文件
(launcher-registration.json / connections.json / launch-token.json)，**token 不出本机、输出一律脱敏**(D2)。

> 非 Windows 上没有 launcher 本体时：`launcher_cli`（装/升级 dsh-cli）与 `launcher_status` /
> `launcher_check_update` 可用；`launcher_restart` / `launcher_open` / `launcher_connections` 会给出
> 明确的手动指引或「仅支持 Windows」错误，不会静默失败。

## 发现链(D6/M6)

1. `DSH_LAUNCHER_EXE` 环境变量(launcher 亲手拉起 dsh 时注入);
2. `%DSH_HOME%\launcher-registration.json`(优先 REST bridge `POST /api/dsh/restart?key=`,
   其次 `<launcherExe> restart`;心跳 >60s 视为陈旧,必须以 pid 存活复核);
3. 都无 → 工具返回手动重启指引。
