# dsh-launcher —— launcher 桥接插件(PM3,5 工具)

> 把 launcher 的宿主能力(重启/连接/状态/打开/升级)升级为 dsh 一等工具面(PLAN §8 / D6)。
> 依赖 launcher **M5**(connections.json)与 **M6**(restart API + 注册文件 + 环境变量注入)。

## 工具(5,无新凭证)

| 工具 | 说明 |
|---|---|
| `launcher_restart` | 按 D6 发现链委托 launcher 重启:① `DSH_LAUNCHER_EXE` 环境变量 → ② `launcher-registration.json`(心跳+pid 复核)REST bridge 优先、其次 `<launcherExe> restart` → ③ 提示手动 |
| `launcher_status` | launcher 注册(版本/pid/心跳/running)+ 激活连接 + launch-token 状态(token 脱敏) |
| `launcher_connections` | 列出/切换 `connections.json` 连接组(`action=use`,可 `restart=true` 立即生效);写 D8 变更标记 |
| `launcher_open` | 按激活/指定连接打开浏览器(带 token 自动登录;url 脱敏回显) |
| `launcher_check_update` | launcher GitHub Release 升级检测(升级需用户主动确认,M8 lock 语义) |

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

重启 web 实例后工具生效。工具只读/写 `%DSH_HOME%` seam 文件(launcher-registration.json /
connections.json / launch-token.json),**token 不出本机、输出一律脱敏**(D2)。

## 发现链(D6/M6)

1. `DSH_LAUNCHER_EXE` 环境变量(launcher 亲手拉起 dsh 时注入);
2. `%DSH_HOME%\launcher-registration.json`(优先 REST bridge `POST /api/dsh/restart?key=`,
   其次 `<launcherExe> restart`;心跳 >60s 视为陈旧,必须以 pid 存活复核);
3. 都无 → 工具返回手动重启指引。
