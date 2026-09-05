# dsh-remote — DeepSeek Harness 远程部署

将 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）部署到远程服务器，通过公网域名访问，登录鉴权由 Cloudflare Access 承担。

> 🔒 本仓库为通用部署记录：不包含任何真实域名、服务器 IP、用户名或密钥。
> 部署参数以占位符描述：`<DOMAIN>`（公网域名）、`<SERVER_IP>`（服务器 TailScale 内网 IP）、`<USER>`（SSH 用户名）。

## 架构链路

```
浏览器 → https://<DOMAIN>/ → Cloudflare Access 登录
  → cloudflared (Tunnel, token 模式) → nginx 127.0.0.1:3082
  → (Host/Origin 重写为 localhost) → dsh 127.0.0.1:3080
```

## 环境

| 项 | 值 |
|---|---|
| 服务器 | Ubuntu 22.04.5 LTS，Intel i5-12600 / 16G / 1T |
| 服务器 SSH | `<USER>@<SERVER_IP>`（TailScale 内网，无固定公网 IP） |
| 域名 | `https://<DOMAIN>/`（Cloudflare Tunnel + Access） |
| dsh 版本 | v0.1.0-rc.5（`~/deepseek-harness`，官方仓库 clone） |
| 运行时 | Node 24（/usr/bin/node）+ pnpm 11.7.0（~/.local/bin/pnpm） |
| 数据目录 | `~/.dsh/`（settings.yaml、.credentials.yaml、profiles/web/） |
| 日志 | `~/logs/dsh.log` |

## 部署步骤（供重装/迁移参考）

1. **clone 项目**：`git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git ~/deepseek-harness`
2. **装 pnpm**：`npm install -g --prefix ~/.local pnpm@11.7.0`（注意：corepack 提供的 `pnpm` 不在 PATH 中，构建脚本内层 spawn 需要真实二进制）
3. **装依赖 + 构建**：`cd ~/deepseek-harness && pnpm install && pnpm build`（需 PATH 含 `~/.local/bin`）
4. **启动**：见 `scripts/restart-dsh.sh`（`--host 127.0.0.1 --port 3080 --no-open --trusted-host <DOMAIN>`）
5. **开机自启**：用户 crontab `@reboot`（sudo 需要密码，未用 systemd）
6. **nginx 反代**（127.0.0.1:3082 → dsh，Host/Origin 重写为 localhost，含 WS 升级）：
   `/etc/nginx/sites-available/dsh-tunnel`
7. **Cloudflare Dashboard**：`<TUNNEL_NAME>` 的 Published application routes 中
   `<DOMAIN> → http://localhost:3082`；Access 应用负责登录拦截

## ⚠️ 三个关键坑（必读）

### 坑 1：配置平面 loopback-only（服务端限制）
dsh v0.1.0-rc.5 将 `settings/credentials/llm` 配置平面以空信任表过信任围栏，**只接受 loopback Host**；`--trusted-host` 无法解锁；`--host 0.0.0.0` 被故意禁止。
**解决**：nginx 把 Host/Origin 重写为 `localhost`，让 dsh 认为请求来自本机。

### 坑 2：`crypto.randomUUID` 安全上下文（浏览器限制）
`crypto.randomUUID` 仅安全上下文（HTTPS 或 localhost）可用。`http://<IP>:3081`（TailScale 直连反代）会报 `randomUUID is not a function`。
**解决**：公网走 HTTPS（Cloudflare 天然满足），废弃 IP 直连入口。

### 坑 3：前端 isLoopback 判定（最终要补丁的原因）
前端 `client/connection/src/client/index.ts` 用 `window.location.hostname` 判定 loopback，公网域名永远 false → **配置平面前端级禁用**（settings 请求都不发），nginx 重写 Host 无法改变浏览器地址栏。
**解决**：打补丁（见下），1 行白名单。

## 前端补丁（本仓库核心维护物）

**改动**：`packages/client/connection/src/client/index.ts` 的 isLoopback 判定追加域名白名单：

```diff
- isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
+ isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname) || pageLocation.hostname === '<DOMAIN>',
```

**应用脚本**：`scripts/apply-dsh-patch.sh`（幂等，可反复执行；通过环境变量 `DSH_DOMAIN` 注入真实域名）

**验证效果**（nginx access log）：`settings.describe` / `credentials.describe` / `host.listDirectory` 从"请求都不发"变为 HTTP 200。

## 升级 SOP（每次 dsh 版本更新）

```bash
cd ~/deepseek-harness
git pull                        # 1. 拉新版本
export DSH_DOMAIN=<DOMAIN>      # 2. 注入真实域名（服务器上也可写进 shell 配置）
bash ~/apply-dsh-patch.sh       # 3. 恢复补丁（幂等；报"未找到目标行"则手动修 1 行）
export PATH="$HOME/.local/bin:$PATH"
pnpm install                    # 4. 新依赖
pnpm build                      # 5. 重新构建（约 2-5 分钟）
bash ~/restart-dsh.sh           # 6. 重启服务
# 7. 公网 https://<DOMAIN>/ 强制刷新验证
```

## 运维备忘

- **重启**：`bash ~/restart-dsh.sh`（先按端口找 pid kill，再 nohup 启动；勿用 `pkill -f "lib/bin.js"`，会误杀 ssh 会话）
- **改配置生效**：dsh 配置 `applies: restart`，改动后需重启
- **模型凭证**：`~/.dsh/.credentials.yaml`（API key 不提交仓库）
- **日志**：`~/logs/dsh.log`
- **敏感信息**：本仓库不包含任何真实域名 / IP / API key / token / 密码

## 废弃记录

- TailScale 直连反代 `http://<SERVER_IP>:3081`（nginx `dsh-loopback`）：因坑 2 废弃，可删除
- SSH 隧道 `ssh -L 3080:localhost:3080 <USER>@<SERVER_IP>`：本地直连调试备用
