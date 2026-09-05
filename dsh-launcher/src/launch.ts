// launch.ts —— dsh 的启动与停止。
// 移植自 Go internal/launch。
// 生命周期设计（v0.4.0 起）：启动器常驻，dsh server 作为启动器的子进程运行，
// 继承启动器的（隐藏）控制台 —— dsh 内部 spawn 的 pwsh 因此继承隐藏控制台，
// 不再每次弹一个可见 PowerShell 窗口。
// 停止 = 直接结束子进程（不再按端口找 PID）；启动器退出时自动停止 dsh。

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, closeSync, existsSync, statSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as connections from './connections.js';
import * as consoleWin from './console.js';
import * as log from './log.js';
import * as node from './node.js';
import { openURL } from './win.js';
import * as registration from './registration.js';
import type { Config } from './config.js';
import * as config from './config.js';
import { clearLaunchToken, dshHome, launchTokenFilePath, readLaunchToken, redactTokenUrl, tokenFromUrl, tokenUrlFromLogText, writeLaunchToken } from './tokenFile.js';

const readyTimeoutMs = 60_000;
const pollIntervalMs = 500;
const httpTimeoutMs = 2000;

/** 当前由本启动器持有的 dsh 子进程（未启动时为 null）。 */
let child: ChildProcess | null = null;

/** 当前持有的本机连接端口（D8 端口锁清理用）。 */
let activeLocalPort: number | undefined;

/** 本次 spawn 前的日志文件偏移：之后只读增量，旧进程打印的 token 不再干扰。 */
let childLogOffset = 0;

/**
 * dsh 子进程 stdout/stderr 的落盘路径(M0:自 %TEMP% 迁至 %DSH_HOME%/logs -
 * 临时目录会被系统清理且权限语义弱;日志与 launch-token 同域管理)。
 */
export function childLogPath(): string {
  return join(dshHome(), 'logs', 'dsh-launcher-child.log');
}

/** 确保子进程日志所在目录存在(首次启动时 %DSH_HOME% 可能尚未创建)。 */
function ensureChildLogDir(): void {
  try {
    mkdirSync(dirname(childLogPath()), { recursive: true });
  } catch {
    // 目录创建失败由后续 openSync 抛错暴露
  }
}

/** 返回配置端口对应的访问地址。 */
export function url(cfg: Config): string {
  return `http://127.0.0.1:${cfg.port}/`;
}

/**
 * dsh v0.1.2+ 启动时会打印一次带进程 token 的访问 URL（`dsh web: http://.../?token=...`）。
 * 浏览器必须通过该 URL 才能换取登录 cookie（直接访问无 token 的 / 会 401）。
 * 只读取本次 spawn 之后追加的日志段——日志文件跨进程追加，旧进程的 token
 * 会永远占据"最后一条"，若不按偏移过滤，新 token 出现前会一直读到旧值。
 * 找不到（旧版 dsh / 尚未打印）返回 undefined。
 */
export function tokenUrlFromLog(): string | undefined {
  try {
    const path = childLogPath();
    const size = statSync(path).size;
    if (size < childLogOffset) childLogOffset = 0; // 日志被轮转/重建
    if (size <= childLogOffset) return undefined;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(size - childLogOffset);
      const bytesRead = readSync(fd, buf, 0, buf.length, childLogOffset);
      return tokenUrlFromLogText(buf.subarray(0, bytesRead).toString('utf8'));
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * 等待子进程日志出现带 token 的 URL：dsh 端口就绪（launcher 的轮询命中）
 * 与 dsh 打印 URL 之间有几毫秒到几百毫秒的间隔，直接读可能拿不到。
 * 轮询等待，超时后返回最后一次尝试结果（可能 undefined，回退普通 URL）。
 */
async function waitForTokenUrl(timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    last = tokenUrlFromLog();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

/**
 * 打开浏览器：优先带 token 的 URL（新版自动登录），否则普通 URL（旧版兼容）。
 * @param pid - 本启动器拉起的 dsh 子进程 PID。有 pid = 刚拉起的实例：从子进程
 *   日志取 token 并写入共享 token 文件（供 dsh-vscode 插件读取）；无 pid =
 *   dsh 已在运行（可能是 vscode 插件拉起的）：自己的日志没有 token，直接读
 *   共享 token 文件兜底，避免空等日志。
 *
 * token 获取顺序（新拉起实例）：先等子进程日志（命中即返回，正常机器 1 秒内），
 * 超时后读共享 token 文件兜底；仍拿不到才打开普通 URL，并记录警告
 * （浏览器会提示 "dsh web authentication required"）。
 */
const TOKEN_WAIT_MS = 10_000;

/** 打开浏览器前自检 token URL：token 有效（303 换 cookie）才打开；避免把 401 甩给浏览器。 */
async function verifyTokenUrl(target: string): Promise<'ok' | 'no-auth' | 'invalid' | 'unreachable'> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), httpTimeoutMs);
    try {
      const resp = await fetch(target, { redirect: 'manual', signal: ctrl.signal });
      if (resp.status === 303 || resp.status === 302) return 'ok';
      if (resp.status === 200) return 'no-auth';
      if (resp.status === 401) return 'invalid';
      return resp.status < 500 ? 'invalid' : 'unreachable';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return 'unreachable';
  }
}

async function openAccessUrl(cfg: Config, pid?: number): Promise<void> {
  const u = url(cfg);
  let tokenUrl: string | undefined;
  let tokenSource: string | undefined;
  if (pid !== undefined) {
    tokenUrl = await waitForTokenUrl(TOKEN_WAIT_MS);
    if (tokenUrl !== undefined) {
      const token = tokenFromUrl(tokenUrl);
      if (token !== undefined) {
        writeLaunchToken({ token, url: tokenUrl, port: cfg.port, pid, source: 'dsh-launcher', managedBy: 'dsh-launcher' });
        log.info(`已写入共享 token 文件 ${launchTokenFilePath()}（供 dsh-vscode 插件读取）`);
      }
      tokenSource = '子进程日志';
    } else {
      // 等 TOKEN_WAIT_MS 仍没在日志看到 token（dsh 启动慢 / 日志延迟）：
      // 读共享 token 文件兜底，避免直接打开不带 token 的 URL 导致浏览器 401。
      const shared = readLaunchToken();
      if (shared !== undefined && tokenFromUrl(shared.url) !== undefined) {
        tokenUrl = shared.url;
        tokenSource = `共享 token 文件（来源 ${shared.source}，pid=${shared.pid ?? '?'}）`;
        log.warn(`等 ${TOKEN_WAIT_MS / 1000}s 未在子进程日志看到 token URL，改用共享 token 文件兜底`);
      }
    }
  } else {
    tokenUrl = readLaunchToken()?.url;
    tokenSource = tokenUrl !== undefined ? '共享 token 文件' : undefined;
  }
  let target = tokenUrl ?? u;
  // 自检：带 token 的 URL 若返回 401，说明 token 已与端口上的进程不匹配
  // （进程重启轮换了 token / 端口被其他实例占用），重新抓一次再试。
  if (tokenUrl !== undefined) {
    const verdict = await verifyTokenUrl(target);
    if (verdict === 'invalid') {
      log.warn(`token URL 自检返回 401（token 与当前端口实例不匹配，可能已轮换或端口被其他实例占用）`);
      if (pid !== undefined) {
        // 本次拉起的实例：等日志出现新 token（日志偏移已隔离旧进程的 token）。
        const retry = await waitForTokenUrl(5_000);
        if (retry !== undefined && retry !== target) {
          const token = tokenFromUrl(retry);
          if (token !== undefined) {
            writeLaunchToken({ token, url: retry, port: cfg.port, pid, source: 'dsh-launcher', managedBy: 'dsh-launcher' });
          }
          tokenUrl = retry;
          tokenSource = '子进程日志（重试）';
          target = retry;
          if (await verifyTokenUrl(target) === 'ok') {
            log.info('重试的 token URL 自检通过');
          } else {
            log.error(`重试后 token URL 仍无效（${target}）。dsh 进程可能反复重启或端口被其他 dsh 实例占用；请停止占用 3080 的进程后重新启动 dsh。`);
          }
        } else {
          log.error(`重试后仍未在子进程日志看到新 token URL（当前 ${target} 无效）。请停止占用 3080 的进程后重新启动 dsh。`);
        }
      } else {
        // 已运行实例：共享文件可能陈旧，重新读一次（可能被 vscode 插件更新过）。
        const shared = readLaunchToken();
        if (shared !== undefined && shared.url !== target) {
          tokenUrl = shared.url;
          tokenSource = '共享 token 文件（重读）';
          target = shared.url;
          log.info(`共享 token 文件已更新，改用新地址：${target}`);
        }
      }
    } else if (verdict === 'unreachable') {
      log.warn(`token URL 自检无法连接（${target}），直接打开浏览器（可能服务尚未就绪）`);
    }
  }
  try {
    await openURL(target);
    if (tokenUrl !== undefined) {
      log.info(`已在默认浏览器打开带 token 的访问地址（自动登录，来源：${tokenSource}）：${redactTokenUrl(target)}`);
    } else {
      log.warn(`未获取到 token URL，已在默认浏览器打开 ${u}；若浏览器提示 "dsh web authentication required"，请重新运行启动器（dsh 重启后 token 会变化）`);
    }
  } catch (e) {
    log.warn(`打开浏览器失败：${(e as Error).message}（可手动访问 ${target}）`);
  }
}

/** 校验配置中的安装目录可用（bin.js 存在且可执行）。 */
export async function verifyInstall(cfg: Config): Promise<void> {
  if (!cfg.dshInstallDir) {
    throw new Error('未检测到已安装的 dsh：请先安装');
  }
  const bin = node.dshBinPath(cfg.dshInstallDir, cfg.source);
  if (!existsSync(bin)) {
    throw new Error(`dsh 安装目录损坏：找不到 ${bin}，请重新安装`);
  }
  try {
    const ver = await node.dshVersion(cfg.dshInstallDir, cfg.source);
    log.info(`dsh 版本校验通过：${ver}`);
  } catch (e) {
    // 回退：package.json 存在即视为可用（部分版本 bin.js 可能不响应 --version）
    try {
      const ver = node.dshVersionFromPackage(cfg.dshInstallDir, cfg.source);
      log.warn(`bin.js --version 未通过（${(e as Error).message}），按 package.json 版本 ${ver} 继续`);
    } catch (verErr) {
      throw new Error(`dsh 校验失败（${(e as Error).message}），请重新安装`);
    }
  }
}

/**
 * remote 连接启动语义（M5 / Phase 5）：不 spawn；健康检查（含 token 自检）后带 token
 * 打开浏览器；激活连接解析后**照写 v1 launch-token.json**（desktop 完全跟随；vscode
 * token 跟随，serverUrl 静态不自动切换）。token 失效(401)提示更新且不打开坏 token URL。
 */
async function startRemote(conn: connections.Connection): Promise<boolean> {
  const target = connections.buildRemoteTarget(conn);
  log.info(`remote 连接 ${conn.id} → ${redactTokenUrl(target)}（不 spawn，健康检查后打开浏览器）`);
  const verdict = await verifyTokenUrl(target);
  if (verdict === 'ok') {
    if (conn.token) {
      // 兼容层：照写 v1 launch-token.json（url/token/source 规范不变）
      writeLaunchToken({ token: conn.token, url: target, source: 'dsh-launcher', managedBy: 'dsh-launcher' });
      log.info(`已照写共享 token 文件（remote ${conn.id}；dsh-desktop 完全跟随，dsh-vscode token 跟随）`);
    }
  } else if (verdict === 'invalid') {
    log.error(
      `remote token 自检 401（token 与远端实例不匹配）：请更新该组 token ` +
        `（connections remove/add，或编辑 ${connections.connectionsPath()}）`,
    );
  } else if (verdict === 'no-auth') {
    log.warn('remote 返回 200（无 token 拦截）：认证可能由 Cloudflare Access 等外部机制接管');
  } else {
    log.warn(`remote 健康检查不可达（${redactTokenUrl(target)}），仍尝试打开浏览器`);
  }
  try {
    await openURL(verdict === 'invalid' ? conn.url ?? target : target);
  } catch (e) {
    log.warn(`打开浏览器失败：${(e as Error).message}`);
  }
  return true;
}

/**
 * 启动 dsh（M5：语义跟随激活连接）：
 *   - remote 连接 → 不 spawn，健康检查 + 打开浏览器（startRemote）
 *   - local 连接 → 在连接端口绑子进程启动（连接端口覆盖 launcher.json 端口），
 *     spawn 前 D8 端口锁检查、spawn 后写锁、子进程退出清理
 *   - dsh 已在运行（端口有响应）→ 不重复启动，直接打开浏览器，返回 alreadyRunning=true
 */
export async function start(cfg: Config, noBrowser: boolean, conn?: connections.Connection): Promise<boolean> {
  const effective = conn ?? connections.resolveActive(cfg).conn;
  if (effective.kind === 'remote') {
    return startRemote(effective);
  }
  // local：连接端口优先
  const lcfg: Config = effective.port && effective.port !== cfg.port ? { ...cfg, port: effective.port } : cfg;
  await verifyInstall(lcfg);
  const u = url(lcfg);

  if (await isRunning(lcfg)) {
    log.info(`dsh 已在运行：${u}`);
    if (!noBrowser) {
      // dsh 可能由 vscode 插件等拉起：openAccessUrl 内部会读共享 token 文件。
      await openAccessUrl(lcfg);
    }
    return true;
  }

  // 持有隐藏控制台：让 dsh（及它的 pwsh 子进程）继承，避免弹窗。
  // 注意：必须在 spawn 之前调用，且 spawn 不能带 windowsHide（否则子进程
  // 拿不到控制台，pwsh 又会各自弹新窗口）。
  // 若无法提供隐藏控制台（koffi 不可用等），退回 windowsHide 防 node 自身弹窗。
  const hasHiddenConsole = consoleWin.ensureHiddenConsole();
  const windowsHide = !hasHiddenConsole;

  const bin = node.dshBinPath(cfg.dshInstallDir, cfg.source);

  // D8 ② 端口锁：spawn 前检查（他组监督者持有且存活则拒绝）
  connections.checkPortLock(lcfg.port);

  // 子进程输出写入日志文件；先记录当前偏移，之后只读本次进程的增量输出
  // （旧进程留在日志里的 token 不会干扰新进程的 token 提取）。
  try {
    ensureChildLogDir();
    childLogOffset = statSync(childLogPath()).size;
  } catch {
    childLogOffset = 0;
  }
  const childLog = openSync(childLogPath(), 'a');

  // M3 运行时自持：优先便携 runtime，其次系统 node（满足版本），都没有才下载便携 Node。
  // 子进程继承其目录 PATH（dsh 及其工具链子进程可见），不污染系统。
  const { cmd: nodeCmd, portable: nodePortable } = await node.resolveNodeExe();
  if (nodePortable) log.info(`使用便携 Node runtime：${nodeCmd}`);
  const nodeEnv = node.childEnvForNode(nodeCmd);

  // M6 重启 seam:注入发现链环境变量(dsh 侧经此委托 launcher 重启)
  const launcherExe = registration.launcherExePath();
  const spawnEnv: NodeJS.ProcessEnv = { ...nodeEnv };
  if (launcherExe) {
    spawnEnv.DSH_LAUNCHER_EXE = launcherExe;
    spawnEnv.DSH_LAUNCHER_PID = String(process.pid);
    spawnEnv.DSH_LAUNCHER_CONNECTION = effective.id;
  }

  await new Promise<void>((resolve, reject) => {
    // 显式传 --port：dsh web 监听 launcher.json 配置的端口（而非 dsh 自己的默认值）；
    // 传 --no-open：浏览器由 launcher 统一控制打开，避免 dsh 自开一次 + launcher 再开一次。
    const args = [bin, 'web', '--port', String(lcfg.port), '--no-open'];
    const cp = spawn(nodeCmd, args, {
      env: spawnEnv,
      // 不 detached：作为本进程子进程，继承（隐藏）控制台。
      // stdio 指向日志文件（无控制台时绝不能继承无效句柄）。
      stdio: ['ignore', childLog, childLog],
      windowsHide,
    });
    cp.on('error', (e) => {
      closeSync(childLog);
      reject(new Error(`启动 dsh 失败：${e.message}`));
    });
    cp.on('spawn', () => {
      child = cp;
      activeLocalPort = lcfg.port;
      if (cp.pid) connections.writePortLock(lcfg.port, cp.pid);
      cp.once('exit', () => connections.clearPortLock(lcfg.port));
      // M6:注册 + 心跳(spawn 成功后)
      registration.registerLauncher(lcfg.dshInstallDir, { pid: cp.pid, running: true });
      registration.startHeartbeat(() => ({ pid: child?.pid, running: !!child && !child.killed }));
      log.info(`dsh 子进程已启动（PID ${cp.pid}）：node ${args.join(' ')}`);
      resolve();
    });
  });

  // 等待就绪；子进程提前退出 → 立即失败（不用干等超时）
  log.info(`等待 ${u} 就绪（超时 60s）……`);
  const ready = await waitReadyOrChildExit(u, readyTimeoutMs, pollIntervalMs);
  closeSync(childLog);
  if (!ready) {
    const reason = childExited ? 'dsh 进程提前退出' : '等待超时（60s）';
    throw new Error(`${reason}，子进程日志：${childLogPath()}`);
  }
  log.info(`${u} 已就绪`);

  if (!noBrowser) {
    // 就绪时子进程必然存活；child?.pid 仅满足 TS 收窄（null 分支实际不可达）。
    await openAccessUrl(lcfg, child?.pid);
  }

  log.info(`dsh 已启动并绑定启动器：${u}（关闭启动器将同时停止 dsh）`);
  return false;
}

/** 兼容旧名：startDetached → start（语义已变：子进程绑定，非独立进程）。 */
export const startDetached = start;

/** 子进程是否已提前退出（waitReady 用）。 */
let childExited = false;

/** 结束当前持有的 dsh 子进程（无则按端口回退）。M5：语义跟随激活连接（remote 为 no-op）。 */
export async function stop(cfg: Config, conn?: connections.Connection): Promise<void> {
  const effective = conn ?? connections.resolveActive(cfg).conn;
  if (effective.kind === 'remote') {
    log.info(`激活连接 ${effective.id} 为 remote：本机 stop 不作用于远端实例（远端重启请在远端执行）`);
    return;
  }
  const port = effective.port ?? cfg.port;
  if (child && !child.killed) {
    const pid = child.pid;
    if (pid) {
      log.info(`结束 dsh 子进程 PID ${pid}……`);
      try {
        await killPID(pid);
        // 子进程已结束：其 launch token 随之失效，清理共享文件（pid 匹配才删）。
        clearLaunchToken('dsh-launcher', pid);
      } catch (e) {
        log.warn(`结束 PID ${pid} 失败：${(e as Error).message}`);
      }
    }
    child = null;
    connections.clearPortLock(port);
    activeLocalPort = undefined;
    registration.unregisterLauncher();
    return;
  }
  // 回退：按端口定位（例如上次启动器异常退出遗留的独立进程）
  const pids = await findPIDsByPort(port);
  if (pids.length === 0) {
    throw new Error(`端口 ${port} 上没有监听中的进程，dsh 可能未在运行`);
  }
  for (const pid of pids) {
    log.info(`结束进程 PID ${pid}……`);
    try {
      await killPID(pid);
    } catch (e) {
      log.warn(`结束 PID ${pid} 失败：${(e as Error).message}`);
    }
  }
  connections.clearPortLock(port);
  registration.unregisterLauncher();
}

/**
 * M6 重启：优雅 stop → 等端口释放 → start（重抓 token 并照写 launch-token.json，
 * 30 天 cookie 机制下重启后免手动重登）；remote 连接 = 重连/重开浏览器，不重启远端。
 */
export async function restartActive(): Promise<void> {
  const cfg = config.load();
  if (!cfg || !config.isInstalled(cfg)) {
    throw new Error('未找到 launcher.json：请先运行 dsh-launcher.exe install 完成安装');
  }
  const { conn } = connections.resolveActive(cfg);
  if (conn.kind === 'remote') {
    log.info(`restart：remote 连接 ${conn.id} → 重连/重开浏览器（不重启远端）`);
    await startRemote(conn);
    return;
  }
  const lcfg: Config = conn.port && conn.port !== cfg.port ? { ...cfg, port: conn.port } : cfg;
  log.info('restart：优雅停止 → 等待端口释放 → 重新启动……');
  try {
    await stop(lcfg, conn);
  } catch (e) {
    log.warn(`restart：stop 阶段（${(e as Error).message}），继续启动`);
  }
  for (let i = 0; i < 40; i++) {
    if (!(await isRunning(lcfg))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await start(lcfg, false, conn);
  log.info('restart 完成（token 已重抓并照写 launch-token.json）。');
}

/** 启动器退出时调用：静默结束子进程（不抛错）。退出钩子里不能异步，用同步 taskkill。 */
export function stopChildSilently(): void {
  const pid = child?.pid;
  child = null;
  if (activeLocalPort !== undefined) {
    connections.clearPortLock(activeLocalPort);
    activeLocalPort = undefined;
  }
  registration.unregisterLauncher();
  if (!pid) return;
  // 退出即停服务：其 launch token 随之失效，清理共享文件（pid 匹配才删）。
  clearLaunchToken('dsh-launcher', pid);
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
  } catch {
    // 进程可能已退出，忽略
  }
}

/** 用 netstat 找监听端口的 PID。 */
export async function findPIDsByPort(port: number): Promise<number[]> {
  const out = await node.runNoWindow('netstat', ['-ano']);
  const marker = `:${port}`;
  const pids: number[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.includes(marker) || !line.includes('LISTENING')) continue;
    const fields = line.split(/\s+/);
    const last = fields[fields.length - 1];
    const pid = Number(last);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/** 强制结束进程（taskkill /F /T 连带进程树）。以「进程是否真的消失」为准，不解析本地化输出。 */
async function killPID(pid: number): Promise<void> {
  await node.runNoWindow('taskkill', ['/F', '/T', '/PID', String(pid)]);
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // 进程已消失
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`taskkill 未能结束 PID ${pid}（进程仍在）`);
}

/** 轮询 url 直到有 HTTP 响应；持有子进程时若其提前退出则立即返回 false。 */
async function waitReadyOrChildExit(url: string, timeoutMs: number, pollMs: number): Promise<boolean> {
  childExited = false;
  const deadline = Date.now() + timeoutMs;
  let exitUnsub: (() => void) | null = null;
  if (child) {
    exitUnsub = onChildExit(() => {
      childExited = true;
      log.warn(`dsh 子进程提前退出（exit code ${child?.exitCode ?? '?'}），见 ${childLogPath()}`);
    });
  }
  try {
    while (Date.now() < deadline) {
      if (childExited) return false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), httpTimeoutMs);
        try {
          const resp = await fetch(url, { signal: ctrl.signal });
          resp.body?.cancel().catch(() => {});
          if (resp.status >= 200) return true;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // 未就绪，继续轮询
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  } finally {
    exitUnsub?.();
  }
}

/** 订阅子进程退出（返回取消函数）。 */
function onChildExit(fn: () => void): () => void {
  if (!child) return () => {};
  child.once('exit', fn);
  return () => {
    child?.removeListener('exit', fn);
  };
}

/** 报告配置端口当前是否有服务响应。 */
export async function isRunning(cfg: Config): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), httpTimeoutMs);
    try {
      const resp = await fetch(url(cfg), { signal: ctrl.signal });
      resp.body?.cancel().catch(() => {});
      return resp.status >= 200;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** 安装目录是否存在（辅助状态展示）。 */
export function installDirExists(cfg: Config): boolean {
  if (!cfg.dshInstallDir) return false;
  try {
    return statSync(cfg.dshInstallDir).isDirectory();
  } catch {
    return false;
  }
}
