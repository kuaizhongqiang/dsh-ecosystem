// cli.ts —— 命令行入口：install / start / stop / move / status / check-update / ui。
// 移植自 Go main.go。无参数（双击 exe）→ 启动 Web UI 并打开浏览器。

import * as config from './config.js';
import * as connections from './connections.js';
import * as ecosystem from './ecosystem.js';
import * as install from './install.js';
import * as launch from './launch.js';
import * as log from './log.js';
import * as node from './node.js';
import * as profile from './profile.js';
import * as registration from './registration.js';
import * as setup from './setup.js';
import { DefaultUIPort, startServer } from './server.js';
import * as update from './update.js';
import { VERSION } from './version.js';
import { openURL } from './win.js';

const usage = `dsh-launcher — dsh 本机安装 / 启动引导器（TS/JS 版）

用法：
  dsh-launcher.exe                  无参数（双击）→ 启动 Web UI 并打开浏览器：
                                     状态展示 + 路径选择 + 安装 + 一键启动
  dsh-launcher.exe install [--dir <目录>] [--source github|npm]
                            [--version <tag>] [--proxy <url>]
                            [--registry <url>] [--mirror] [--no-mirror]
                                     安装 dsh（默认 source=github：克隆
                                     deepseek-ai/deepseek-harness + pnpm 构建，
                                     锁定最新 dsh tag；--version 指定 tag）
  dsh-launcher.exe install --offline <目录> [--dir <安装目录>]
                                     离线包安装（M3）：offline/dsh（npm/github 布局自动识别）
                                     + offline/runtime（便携 Node，可选）本地直装，
                                     不依赖网络 / git / pnpm
                                     默认安装目录 %LOCALAPPDATA%\\dsh
  dsh-launcher.exe move --dir <目录> 把已安装的 dsh 挪到新路径
                                    （跨盘自动复制+删除，运行中禁止）
  dsh-launcher.exe start [--no-browser]  启动 dsh 并保持本进程常驻（dsh 绑定启动器）
  dsh-launcher.exe stop             停止 dsh（结束绑定子进程，或按配置端口回退）
  dsh-launcher.exe restart          重启 dsh（优雅停止→重抓 token 照写；运行中的 launcher
                                    经 REST bridge 转交；remote 连接=重连/重开浏览器）
  dsh-launcher.exe status           显示安装目录、版本与运行状态
  dsh-launcher.exe check-update     检查升级：dsh（GitHub tag / npm registry）与启动器（GitHub Release）
  dsh-launcher.exe pull [--manifest <url|file>] [--plugins a,b] [--all] [--no-core] [--no-skills] [--dry-run]
                                    按 ecosystem.json 清单补齐生态：core 缺口（走 install）+
                                    插件 install.ps1（逐个）+ 技能 install-skills.ps1
                                    结果写 ecosystem-state.json；默认清单内嵌随启动器走
                                    （--manifest 远程仅 https；供应链 sha256 强制校验，P1-7）
  dsh-launcher.exe profile push --dir <pack目录> [--exclude a,b]  个人层 push：白名单（settings.yaml /
                                    补丁 / profiles/web/plugins / skills / 自选+reports）镜像进 pack
  dsh-launcher.exe profile pull --dir <pack目录>  从 pack 恢复到本机（红线文件永不恢复，D2）
  dsh-launcher.exe profile export --out <文件> [--password <口令>]
  dsh-launcher.exe profile import --in <文件> [--password <口令>]
                                    导出/导入加密个人层（AES-256-GCM + scrypt；口令默认取
                                    环境变量 DSH_LAUNCHER_PROFILE_PASSWORD）
  dsh-launcher.exe connections list|add|use|remove  多连接管理（M5）：
                                    add --id <id> --kind local --port <p> [--name <n>]
                                    add --id <id> --kind remote --url <u> [--token <t>] [--name <n>]
                                    use <id> 切换激活（写 .dsh-connection-changed 标记）；remove <id> 删除
                                    激活连接照写 launch-token.json（desktop 完全跟随 / vscode token 跟随）
  dsh-launcher.exe start [--no-browser] [--connection <id>]  按（或指定）激活连接启动：
                                    local=绑子进程启动（D8 端口锁）；remote=健康检查+带 token 开浏览器
  dsh-launcher.exe setup [--manifest <url|file>] [--offline <目录>] [--connection <id>]
                         [--profile-dir <pack> | --profile-in <file> --password <口令>]
                         [--plugins a,b] [--no-start] [--all]
                         新机器一条龙（M7）：core（缺口/离线）→ pull（插件+skills，lock 优先）
                         → 个人层（可选）→ 连接 → start；--update-lock = 确认升级并写 lock（M8）
  dsh-launcher.exe ui [--no-browser] [--port <端口>]  启动 Web UI 服务（默认端口 ${DefaultUIPort}）
  dsh-launcher.exe --version | -v   显示版本
  dsh-launcher.exe --help | -h      显示本帮助

说明：
  - 配置 launcher.json 与 exe 同目录，跟随 exe 走（便携）
  - 运行日志写入 %TEMP%\\dsh-launcher.log（GUI 构建无控制台输出，以此为准）
  - dsh 绑定启动器运行（v0.4.0 起）：启动器持有隐藏控制台，dsh 及其 pwsh
    子进程继承它，执行工具不再弹 PowerShell/cmd 窗口；关闭启动器即停止 dsh
  - v0.1.2+ 的 dsh 采用启动令牌认证：start 会自动抓取 dsh 打印的带 token
    URL 并打开，浏览器自动登录（30 天 cookie）；重启 dsh 后 token 会变化
  - GitHub 源需要 git + pnpm（缺 pnpm 时自动 npm i -g pnpm）；
    网络受限时用 --proxy 或环境变量 DSH_LAUNCHER_PROXY / HTTPS_PROXY 指定代理
  - npm 源（--source npm）保留 registry 自动探测与国内镜像加速：
    环境变量 DSH_LAUNCHER_NPM_REGISTRY / DSH_LAUNCHER_NPM_MIRROR /
    DSH_LAUNCHER_PREFER_MIRROR=1 / DSH_LAUNCHER_NO_MIRROR=1 控制
`;

function fail(msg: string): never {
  log.error(msg);
  process.exit(1);
}

interface InstallArgs {
  dir: string;
  spec: node.RegistrySpec;
  source: node.DshSource;
  version: string;
  proxy: string;
  offlineDir: string;
}

/** 解析 install 子命令参数。 */
function parseInstallArgs(rest: string[]): InstallArgs {
  const spec: node.RegistrySpec = {};
  let dir = '';
  let source: node.DshSource = 'github';
  let version = '';
  let proxy = '';
  let offlineDir = '';
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    switch (t) {
      case '--dir':
      case '-d':
        if (i + 1 >= rest.length) fail('--dir 缺少参数');
        dir = rest[++i];
        break;
      case '--source':
        if (i + 1 >= rest.length) fail('--source 缺少参数');
        {
          const s = rest[++i];
          if (s !== 'github' && s !== 'npm') fail(`--source 只支持 github 或 npm，收到 "${s}"`);
          source = s;
        }
        break;
      case '--version':
        if (i + 1 >= rest.length) fail('--version 缺少参数');
        version = rest[++i];
        break;
      case '--proxy':
        if (i + 1 >= rest.length) fail('--proxy 缺少参数');
        proxy = rest[++i];
        break;
      case '--offline':
        if (i + 1 >= rest.length) fail('--offline 缺少参数');
        offlineDir = rest[++i];
        break;
      case '--registry':
        if (i + 1 >= rest.length) fail('--registry 缺少参数');
        spec.registry = rest[++i];
        break;
      case '--mirror':
        spec.preferMirror = true;
        break;
      case '--no-mirror':
        spec.disableAutoSwitch = true;
        break;
      default:
        fail(`install 未知参数：${rest[i]}`);
    }
  }
  return { dir, spec, source, version, proxy, offlineDir };
}

/** 解析 move 子命令参数。 */
function parseMoveArgs(rest: string[]): string {
  let dir = '';
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dir' || rest[i] === '-d') {
      if (i + 1 >= rest.length) fail('--dir 缺少参数');
      dir = rest[++i];
    } else {
      fail(`move 未知参数：${rest[i]}`);
    }
  }
  if (!dir) fail('move 需要 --dir <目标路径>');
  return dir;
}

async function runInstall(rest: string[]): Promise<void> {
  const { dir, spec, source, version, proxy, offlineDir } = parseInstallArgs(rest);
  await install.run(dir, install.registrySpecFromEnv(spec), { source, version, proxy, offlineDir: offlineDir || undefined });
  log.info('安装完成。现在可以运行 dsh-launcher.exe（或 dsh-launcher.exe start）启动 dsh。');
}

async function runMove(rest: string[]): Promise<void> {
  const dir = parseMoveArgs(rest);
  await install.move(dir);
  log.info('移动完成。');
}

async function runStart(rest: string[]): Promise<void> {
  const noBrowser = rest.includes('--no-browser');
  const ci = rest.indexOf('--connection');
  const connId = ci >= 0 && ci + 1 < rest.length ? rest[ci + 1] : undefined;
  const cfg = config.load();
  if (!cfg || !config.isInstalled(cfg)) {
    fail('未找到 launcher.json：请先运行 dsh-launcher.exe install 完成安装');
  }
  let conn: connections.Connection | undefined;
  if (connId) {
    conn = connections.listConnections(cfg).find((c) => c.id === connId);
    if (!conn) fail(`连接不存在：${connId}（可用：${connections.listConnections(cfg).map((c) => c.id).join(', ')}）`);
  }
  await launch.start(cfg, noBrowser, conn);
  // dsh 绑定启动器：本进程保持常驻，退出时（electron-main 的 exit 钩子）自动停 dsh
  log.info('dsh 已绑定启动器运行（关闭本程序将同时停止 dsh）。Ctrl+C 可退出。');
  await new Promise<void>(() => {});
}

async function runStop(): Promise<void> {
  const cfg = config.load();
  if (!cfg || !config.isInstalled(cfg)) {
    fail('未找到 launcher.json：请先运行 dsh-launcher.exe install 完成安装');
  }
  const { conn } = connections.resolveActive(cfg);
  if (conn.kind === 'remote') {
    log.info(`激活连接 ${conn.id} 为 remote：本机 stop 不作用于远端实例。`);
    return;
  }
  await launch.stop(cfg, conn);
  log.info('停止完成。');
}

async function runStatus(): Promise<void> {
  const cfg = config.load();
  if (!cfg || !config.isInstalled(cfg)) {
    console.log('状态：未安装（缺少 launcher.json 或未记录安装目录）');
    console.log('请先运行：dsh-launcher.exe install');
    return;
  }
  const { conn } = connections.resolveActive(cfg);
  console.log(`安装目录：${cfg.dshInstallDir}`);
  console.log(`dsh 版本：${cfg.dshVersion ?? '-'}`);
  console.log(`激活连接：${conn.id}（${conn.kind}${conn.kind === 'remote' ? `，${conn.url ?? ''}` : `，端口 ${conn.port ?? cfg.port}`}）`);
  console.log(`安装时间：${cfg.installedAt ?? '-'}`);

  if (conn.kind === 'remote') {
    let up = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      try {
        const r = await fetch(conn.url ?? '', { signal: ctrl.signal });
        up = r.status >= 200;
        r.body?.cancel().catch(() => {});
      } finally {
        clearTimeout(timer);
      }
    } catch {
      up = false;
    }
    console.log(`运行状态：${up ? '可达' : '不可达'}（HTTP ping）`);
    return;
  }

  // local：端口跟随连接
  const eff = conn.port && conn.port !== cfg.port ? { ...cfg, port: conn.port } : cfg;
  console.log(`端口：${eff.port}`);
  if (!launch.installDirExists(eff)) {
    console.log('运行状态：未就绪（安装目录不存在，请重新 install）');
    return;
  }
  if (await launch.isRunning(eff)) {
    console.log(`运行状态：运行中（端口 ${eff.port} 有响应）`);
  } else {
    console.log(`运行状态：未运行（端口 ${eff.port} 无响应）`);
  }
}

/** connections 子命令（M5）：list|add|use|remove。 */
/** M7 setup:一条龙编排(core→pull→个人层→连接→start)。 */
async function runSetupCmd(rest: string[]): Promise<void> {
  const val = (flag: string, def = ''): string => {
    const i = rest.indexOf(flag);
    return i >= 0 && i + 1 < rest.length ? rest[i + 1] : def;
  };
  const known = new Set(['--all', '--manifest', '--offline', '--connection', '--profile-dir', '--profile-in', '--password', '--plugins', '--no-start', '--update-lock']);
  for (const a of rest) {
    if (a.startsWith('--') && !known.has(a)) fail(`setup 未知参数：${a}`);
  }
  const pluginsFlag = val('--plugins');
  await setup.runSetup({
    manifest: val('--manifest') || undefined,
    offlineDir: val('--offline') || undefined,
    profileDir: val('--profile-dir') || undefined,
    profileIn: val('--profile-in') || undefined,
    password: val('--password') || undefined,
    connection: val('--connection') || undefined,
    plugins: pluginsFlag ? pluginsFlag.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    noStart: rest.includes('--no-start'),
    updateLock: rest.includes('--update-lock'),
  });
  log.info('一键部署流程结束。');
}

/** M6 restart:优先单实例转交(注册新鲜 + pid 存活 + api 健康 → REST bridge),否则本机执行。 */
async function runRestart(): Promise<void> {
  const reg = registration.readRegistration();
  if (reg && registration.isFresh(reg) && reg.pid && connections.pidAlive(reg.pid) && reg.api && reg.bridgeKey) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      try {
        const resp = await fetch(
          `${reg.api}/api/dsh/restart?key=${encodeURIComponent(reg.bridgeKey)}`,
          { method: 'POST', signal: ctrl.signal },
        );
        if (resp.status === 202) {
          log.info(`restart 已转交运行中的 launcher（${reg.api}），进度见其日志。`);
          return;
        }
        log.warn(`REST bridge 返回 ${resp.status}，改为本机执行 restart……`);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      log.warn('REST bridge 不可达，改为本机执行 restart……');
    }
  }
  await launch.restartActive();
}

async function runConnections(rest: string[]): Promise<void> {
  const sub = rest[0];
  const args = rest.slice(1);
  const val = (flag: string, def = ''): string => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
  };
  const cfg = config.load();
  switch (sub) {
    case 'list': {
      const { conn: active } = connections.resolveActive(cfg);
      const fromFile = connections.loadConnections() !== undefined;
      if (!fromFile) console.log('（尚无 connections.json：以下为按 launcher.json 合成的默认连接）');
      for (const c of connections.listConnections(cfg)) {
        const mark = c.id === active.id ? '*' : ' ';
        const where = c.kind === 'local' ? `port=${c.port}` : `url=${c.url}${c.token ? ' (token 已配置)' : ' (无 token,交由外部认证)'}`;
        console.log(`${mark} ${c.id}  [${c.kind}]  ${c.name ?? ''}  ${where}`);
      }
      return;
    }
    case 'add': {
      const id = val('--id');
      const kind = val('--kind') as connections.ConnectionKind;
      const name = val('--name') || undefined;
      const portStr = val('--port');
      const url = val('--url') || undefined;
      const token = val('--token') || undefined;
      if (!id) fail('connections add 需要 --id <id>');
      if (kind !== 'local' && kind !== 'remote') fail('connections add 需要 --kind local|remote');
      if (kind === 'local') {
        const port = Number(portStr);
        if (!Number.isInteger(port) || port <= 0) fail('local 连接需要 --port <1-65535>');
        connections.addConnection({ id, kind: 'local', name, port });
        log.info(`已添加 local 连接 ${id}（端口 ${port}）`);
      } else {
        if (!url) fail('remote 连接需要 --url <https://...>');
        connections.addConnection({ id, kind: 'remote', name, url, token });
        log.info(`已添加 remote 连接 ${id}（${url}${token ? '，token 已配置' : '，无 token（交由外部认证）'}）`);
      }
      log.info(`文件：${connections.connectionsPath()}`);
      return;
    }
    case 'use': {
      const id = args[0];
      if (!id) fail('connections use 需要 <id>');
      connections.useConnection(id);
      log.info(`激活连接 → ${id}（已写 .dsh-connection-changed 标记；launch-token 兼容层在启动时照写）`);
      return;
    }
    case 'remove': {
      const id = args[0];
      if (!id) fail('connections remove 需要 <id>');
      connections.removeConnection(id);
      log.info(`已删除连接 ${id}`);
      return;
    }
    default:
      fail(`connections 未知子命令：${sub ?? '(空)'}（支持 list|add|use|remove）`);
  }
}

async function runCheckUpdate(): Promise<void> {
  const cfg = config.load();
  const dshCur = cfg && config.isInstalled(cfg) ? cfg.dshVersion : '';
  const spec = install.registrySpecFromConfig(cfg);
  if (!dshCur) {
    console.log('dsh：未安装（先运行 dsh-launcher.exe install）');
  } else {
    try {
      const { latest, hasUpdate } = await update.checkDsh(dshCur, spec, { source: cfg?.source, proxy: cfg?.proxy });
      if (hasUpdate) {
        console.log(`dsh：当前 ${dshCur} → 最新 ${latest}（可升级，运行 install 即升级到最新）`);
        if (ecosystem.loadLock()) {
          console.log('　　M8 lock 生效中：pull 默认收敛到 lock；确认升级请运行 pull --update-lock');
        }
      } else {
        console.log(`dsh：当前 ${dshCur} 已是最新`);
      }
    } catch (e) {
      console.log(`dsh：升级检测失败：${(e as Error).message}`);
    }
  }
  try {
    const { latest, hasUpdate } = await update.checkLauncher(VERSION);
    if (hasUpdate) {
      console.log(`启动器：当前 v${VERSION} → 最新 ${latest}（可升级，下载页 ${update.LauncherReleaseURL}）`);
    } else {
      console.log(`启动器：当前 v${VERSION} 已是最新`);
    }
  } catch (e) {
    console.log(`启动器：升级检测失败：${(e as Error).message}`);
  }
}

/** 启动 Web UI 服务；端口占用时顺延尝试。 */
async function runUI(rest: string[]): Promise<void> {
  const noBrowser = rest.includes('--no-browser');
  let port = DefaultUIPort;
  const pi = rest.indexOf('--port');
  if (pi >= 0 && pi + 1 < rest.length) {
    port = Number(rest[pi + 1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`非法端口：${rest[pi + 1]}`);
  }
  if (rest.some((a) => a === '--help' || a === '-h')) {
    console.log(usage);
    return;
  }

  // 端口占用则顺延（最多试 10 个）
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  for (let p = port; p < port + 10; p++) {
    try {
      server = await startServer(p);
      break;
    } catch (e) {
      log.warn(`端口 ${p} 不可用（${(e as Error).message}），尝试下一个……`);
    }
  }
  if (!server) {
    fail(`启动 UI 服务失败：端口 ${port}–${port + 9} 均不可用`);
  }

  log.info('dsh-launcher Web UI 已就绪。关闭浏览器不会停止本服务；用「退出」按钮或结束进程停止。');
  if (!noBrowser) {
    try {
      await openURL(server.url);
      log.info(`已在默认浏览器打开 ${server.url}`);
    } catch (e) {
      log.warn(`打开浏览器失败：${(e as Error).message}（可手动访问 ${server.url}）`);
    }
  }
  // 服务保持运行（进程不退出）
  await new Promise<void>(() => {});
}

/** pull 子命令参数（M1 / Phase 1）。 */
interface PullArgs {
  manifest?: string;
  plugins?: string[] | null;
  skills?: boolean;
  core?: boolean;
  dryRun?: boolean;
}

function parsePullArgs(rest: string[]): PullArgs {
  const a: PullArgs = {};
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    switch (t) {
      case '--manifest':
        if (i + 1 >= rest.length) fail('--manifest 缺少参数');
        a.manifest = rest[++i];
        break;
      case '--plugins': {
        if (i + 1 >= rest.length) fail('--plugins 缺少参数');
        a.plugins = rest[++i].split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--all':
        break; // 默认即 core+全部插件+技能，--all 为显式全量
      case '--no-core':
        a.core = false;
        break;
      case '--no-skills':
        a.skills = false;
        break;
      case '--dry-run':
        a.dryRun = true;
        break;
      default:
        fail(`pull 未知参数：${t}`);
    }
  }
  return a;
}

async function runProfileCmd(rest: string[]): Promise<void> {
  const sub = rest[0];
  const args = rest.slice(1);
  const val = (flag: string, def = ''): string => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
  };
  switch (sub) {
    case 'push': {
      const dir = val('--dir');
      if (!dir) fail('profile push 需要 --dir <pack目录>');
      const exclude = val('--exclude').split(',').map((s) => s.trim()).filter(Boolean);
      profile.pushProfilePack(dir, exclude);
      return;
    }
    case 'pull': {
      const dir = val('--dir');
      if (!dir) fail('profile pull 需要 --dir <pack目录>');
      profile.pullProfilePack(dir);
      return;
    }
    case 'export': {
      const out = val('--out');
      if (!out) fail('profile export 需要 --out <文件>');
      const pwd = val('--password');
      profile.exportProfilePack(out, pwd || undefined);
      return;
    }
    case 'import': {
      const infile = val('--in');
      if (!infile) fail('profile import 需要 --in <文件>');
      const pwd = val('--password');
      profile.importProfilePack(infile, pwd || undefined);
      return;
    }
    default:
      fail(`profile 未知子命令：${sub ?? '(空)'}（支持 push|pull|export|import）`);
  }
}

async function runPullCmd(rest: string[]): Promise<void> {
  const a = parsePullArgs(rest);
  await ecosystem.runPull(a);
  log.info('生态拉齐流程结束（细节见 ecosystem-state.json）。');
}

export async function dispatch(args: string[]): Promise<void> {
  if (args.length === 0) {
    await runUI([]);
    return;
  }
  switch (args[0]) {
    case '--help':
    case '-h':
    case 'help':
      log.raw(usage);
      return;
    case '--version':
    case '-v':
      log.raw(`dsh-launcher v${VERSION}\n`);
      return;
    case 'install':
      await runInstall(args.slice(1));
      return;
    case 'move':
      await runMove(args.slice(1));
      return;
    case 'pull':
      await runPullCmd(args.slice(1));
      return;
    case 'profile':
      await runProfileCmd(args.slice(1));
      return;
    case 'connections':
      await runConnections(args.slice(1));
      return;
    case 'setup':
      await runSetupCmd(args.slice(1));
      return;
    case 'start':
      await runStart(args.slice(1));
      return;
    case 'stop':
      await runStop();
      return;
    case 'restart':
      await runRestart();
      return;
    case 'status':
      await runStatus();
      return;
    case 'check-update':
      await runCheckUpdate();
      return;
    case 'ui':
      await runUI(args.slice(1));
      return;
    default:
      log.raw(usage);
      fail(`未知命令：${args[0]}`);
  }
}
