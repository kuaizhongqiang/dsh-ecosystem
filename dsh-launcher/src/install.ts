// install.ts —— install 子命令：探测 node/npm、安装 @deepseek-ai/dsh、
// 校验并写入 launcher.json；以及 move（移动安装目录）。
// 移植自 Go internal/install（install.go + move.go）。

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import * as config from './config.js';
import * as launch from './launch.js';
import * as log from './log.js';
import * as node from './node.js';

/** 执行完整安装流程。dir 为 --dir 覆盖（空串表示默认 %LOCALAPPDATA%\dsh）。 */
export interface InstallOptions {
  /** 安装源：github（默认，源码构建）| npm（registry 安装）。 */
  source?: node.DshSource;
  /** GitHub 源下指定 tag（缺省自动取最新 dsh tag）。 */
  version?: string;
  /** GitHub 访问代理（git 的 http.proxy/https.proxy）。 */
  proxy?: string;
  /** 离线包目录（M3/Phase 3）：内含 dsh/ 与可选 runtime/，直接本地安装，不依赖网络/git/pnpm。 */
  offlineDir?: string;
}

/** 默认安装目录：%LOCALAPPDATA%\dsh。 */
export function defaultInstallDir(): string {
  return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'dsh') : join(homedir(), 'AppData', 'Local', 'dsh');
}

/** 统一入口：按 source 分发（github 默认 / npm 保留）；offlineDir 优先走离线安装。 */
export async function run(dir: string, spec: node.RegistrySpec, opts: InstallOptions = {}): Promise<void> {
  if (opts.offlineDir) {
    await runOfflineInstall(dir, opts.offlineDir);
    return;
  }
  if (opts.source === 'npm') {
    await runNpmInstall(dir, spec);
    return;
  }
  await runGithubInstall(dir, opts);
}

/**
 * 离线包安装（M3 / Phase 3，真·零依赖）：直接消费本地 offline/ 目录——
 *   offline/dsh/           dsh 安装内容（npm 布局 node_modules/@deepseek-ai/dsh 或 github 布局 deepseek-harness，按内容判定）
 *   offline/runtime/       （可选）便携 Node（node.exe + 旁件），落位 %LOCALAPPDATA%\dsh\runtime
 * 不触发任何网络 / git / pnpm。
 */
export async function runOfflineInstall(dir: string, offlineDir: string): Promise<void> {
  const bundle = resolve(offlineDir);
  const core = join(bundle, 'dsh');
  if (!existsSync(core)) throw new Error(`离线包缺少 dsh 目录：${core}`);
  const abs = resolve(dir || defaultInstallDir());
  log.info(`离线包安装：${bundle} → ${abs}`);
  // 1. 清空旧安装并复制 dsh 内容（与 github 源克隆行为一致：重装即换）
  rmSync(abs, { recursive: true, force: true });
  mkdirSync(abs, { recursive: true });
  cpSync(core, abs, { recursive: true });

  // 2. 判定布局并校验
  const source: node.DshSource = existsSync(join(core, 'deepseek-harness')) ? 'github' : 'npm';
  const bin = node.dshBinPath(abs, source);
  if (!existsSync(bin)) {
    throw new Error(`离线包布局不符：找不到 ${bin}（预期 offline/dsh 内含 npm 布局 node_modules/@deepseek-ai/dsh 或 github 布局 deepseek-harness）`);
  }
  let ver: string;
  try {
    ver = await node.dshVersion(abs, source);
  } catch (e) {
    log.warn(`bin.js --version 校验失败（${(e as Error).message}），回退读取 package.json`);
    ver = node.dshVersionFromPackage(abs, source);
  }
  log.info(`dsh 校验通过（离线包，${source} 布局）：${ver}`);

  // 3. 便携 Node runtime 落位（可选）
  const bundleRuntime = join(bundle, 'runtime');
  if (existsSync(join(bundleRuntime, 'node.exe'))) {
    mkdirSync(node.runtimeRoot(), { recursive: true });
    cpSync(bundleRuntime, node.runtimeRoot(), { recursive: true });
    log.info(`便携 Node runtime 已落位：${node.portableNodeExe()}`);
  } else {
    log.warn('离线包未含 runtime/node.exe：启动时仍将使用系统 Node 或自动下载便携 Node（M3）');
  }

  // 4. 写入 launcher.json
  const cfg: config.Config = {
    dshInstallDir: abs,
    dshVersion: ver,
    port: config.DefaultPort,
    installedAt: new Date().toISOString(),
    source,
  };
  config.save(cfg);
  log.info(`配置已写入 ${config.configPath()}`);
  log.info('完成。之后可运行 dsh-launcher.exe start（dsh 启动将使用便携/系统 Node）。');
}

/** GitHub 源码安装：探测环境 → 解析 tag → 浅克隆 → pnpm 构建 → 校验 → 写配置。 */
async function runGithubInstall(dir: string, opts: InstallOptions): Promise<void> {
  // 1. 探测 node / npm（构建需要 node + pnpm）
  const ni = await node.detect();
  if (!node.versionCompatible(ni.nodeVer)) {
    throw new Error(
      `Node.js 版本 ${node.versionString(ni.nodeVer)} 不满足要求（需要 ^22.19 或 >=24），请到 https://nodejs.org 升级后重试`,
    );
  }
  log.info(`检测到 Node.js ${node.versionString(ni.nodeVer)}`);

  // 2. 解析安装目录
  const abs = resolve(dir || defaultInstallDir());
  mkdirSync(abs, { recursive: true });
  log.info(`安装目录：${abs}`);

  // 3. 代理与版本
  const proxy = node.resolveProxy(opts.proxy);
  if (proxy) log.info(`GitHub 代理：${proxy}`);
  const tag = opts.version && opts.version.trim() ? opts.version.trim() : await node.latestDshTag(proxy);
  log.info(`目标版本：${tag}（来源：github.com/deepseek-ai/deepseek-harness）`);

  // 4. 确保 pnpm
  await node.ensurePnpm((line) => log.info(line));

  // 5. 浅克隆
  log.info(`克隆仓库（tag=${tag}，浅克隆，仅该 tag）……`);
  const repoDir = await node.cloneDsh(abs, tag, proxy, (line) => log.info(`git> ${line}`));
  log.info(`克隆完成：${repoDir}`);

  // 6. 安装依赖 + 构建（首次耗时较长）
  const pnpmLine = (l: string): void => {
    const clean = l.replace(/\r/g, '').trim();
    if (!clean) return;
    if (/^[▸▹►▪●○■□=─\-*+ ]+$/.test(clean)) return; // 纯进度条，跳过
    log.info(`pnpm> ${clean}`);
  };
  log.info('安装依赖（pnpm install，首次可能需要数分钟）……');
  try {
    await node.runPnpm(['install', '--frozen-lockfile'], repoDir, pnpmLine);
  } catch {
    log.warn('--frozen-lockfile 失败，改用常规 install 重试……');
    await node.runPnpm(['install'], repoDir, pnpmLine);
  }
  log.info('构建（pnpm run build = build:lib + build:web）……');
  await node.runPnpm(['run', 'build'], repoDir, (l) => {
    const clean = l.replace(/\r/g, '').trim();
    if (!clean) return;
    // 构建输出量大，只透传关键行（错误 / 摘要 / 命令回显）
    if (/error|Error|ERR|failed|Build complete|✔|✓|recorded|^\\$ /i.test(clean)) log.info(`pnpm> ${clean}`);
  });

  // 7. 校验安装结果
  const bin = node.dshBinPath(abs, 'github');
  if (!existsSync(bin)) {
    throw new Error(`构建完成但未找到 ${bin}，构建可能失败，请查看日志`);
  }
  let ver: string;
  try {
    ver = await node.dshVersion(abs, 'github');
  } catch (e) {
    log.warn(`bin.js --version 校验失败（${(e as Error).message}），回退读取 package.json`);
    ver = node.dshVersionFromPackage(abs, 'github');
  }
  log.info(`dsh 校验通过：${node.DshPackage}@${tag}（${ver}）`);

  // 8. 写入 launcher.json
  const cfg: config.Config = {
    dshInstallDir: abs,
    dshVersion: tag,
    port: config.DefaultPort,
    installedAt: new Date().toISOString(),
    source: 'github',
    proxy,
  };
  config.save(cfg);
  log.info(`配置已写入 ${config.configPath()}`);
  log.info('完成。~/.dsh 配置目录保持默认，无需手动处理。');
  log.info('现在可以运行 dsh-launcher.exe（或 dsh-launcher.exe start）启动 dsh。');
}

/** npm registry 安装（旧方式，保留作后备）。 */
async function runNpmInstall(dir: string, spec: node.RegistrySpec): Promise<void> {
  // 1. 探测 node / npm
  const ni = await node.detect();
  if (!node.versionCompatible(ni.nodeVer)) {
    throw new Error(
      `Node.js 版本 ${node.versionString(ni.nodeVer)} 不满足要求（需要 ^22.19 或 >=24），请到 https://nodejs.org 升级后重试`,
    );
  }
  log.info(`检测到 Node.js ${node.versionString(ni.nodeVer)}`);
  log.info(`检测到 npm ${ni.npmVer}`);

  // 2. 解析安装目录
  const abs = resolve(dir || defaultInstallDir());
  mkdirSync(abs, { recursive: true });
  log.info(`安装目录：${abs}`);

  // 2.5 提示：npm 全局已装过 dsh 的话可以跳过本次安装
  await hintGlobalInstall();

  // 3. 选择下载源并 npm install（失败自动换另一源重试一次）
  const chosen = await node.chooseRegistry(spec);
  log.info(`下载源：${chosen.registry}（${chosen.probe}）`);
  if (chosen.viaMirror) {
    log.info(`已使用国内镜像 ${chosen.registry} 下载（国内用户加速）`);
  }
  const installOnce = async (r: string): Promise<string> => {
    log.info(`正在通过 ${r} 安装 ${node.DshPackage}（首次需要下载，请耐心等待）……`);
    return node.installStream(node.DshPackage, abs, r, (line) => log.info(`npm> ${line}`));
  };

  let registry = chosen.registry;
  let out = '';
  try {
    out = await installOnce(registry);
  } catch (e) {
    const installErr = e as Error;
    if (!spec.preferMirror && !spec.disableAutoSwitch) {
      // 自动回退：主源失败且镜像未尝试 → 镜像；镜像失败 → 主源
      const { primary, mirror } = node.specEffective(spec);
      const alt = registry === primary ? mirror : registry === mirror ? primary : '';
      if (alt && alt !== registry) {
        log.warn(`从 ${registry} 下载失败，自动切换 ${alt} 重试……`);
        try {
          out = await installOnce(alt);
          registry = alt;
        } catch {
          out = '';
        }
      }
    }
    if (!out) {
      log.error(`npm install 失败：${installErr.message}`);
      throw new Error(`npm install 失败，详情见日志 ${log.logPath()}`);
    }
  }
  log.info(`npm install 完成（registry：${registry}）`);

  // 4. 校验安装结果
  const bin = node.dshBinPath(abs, 'npm');
  if (!existsSync(bin)) {
    throw new Error(`安装完成但未找到 ${bin}，安装可能不完整，请重试 install`);
  }
  let ver: string;
  try {
    ver = await node.dshVersion(abs, 'npm');
  } catch (e) {
    log.warn(`bin.js --version 校验失败（${(e as Error).message}），回退读取 package.json`);
    ver = node.dshVersionFromPackage(abs, 'npm');
  }
  log.info(`dsh 校验通过：${node.DshPackage}@${ver}`);

  // 5. 写入 launcher.json（含下载源信息，供后续 install 复用）
  const cfg: config.Config = {
    dshInstallDir: abs,
    dshVersion: ver,
    port: config.DefaultPort,
    installedAt: new Date().toISOString(),
    source: 'npm',
    registry: primaryOrDefault(spec.registry),
    registryMirror: mirrorOrDefault(spec.mirror),
    preferMirror: spec.preferMirror,
  };
  config.save(cfg);
  log.info(`配置已写入 ${config.configPath()}`);
  log.info('完成。~/.dsh 配置目录保持默认，无需手动处理。');
  log.info('现在可以运行 dsh-launcher.exe（或 dsh-launcher.exe start）启动 dsh。');
}

/** 返回显式主源（未设置则留空，表示 npm 默认）。 */
function primaryOrDefault(r?: string): string | undefined {
  if (!r || r === node.DefaultNpmRegistry) return undefined;
  return r;
}

/** 返回显式镜像（未设置则留空，表示默认 npmmirror）。 */
function mirrorOrDefault(m?: string): string | undefined {
  if (!m || m === node.DefaultNpmMirror) return undefined;
  return m;
}

/** 用环境变量补齐下载源策略（CLI 已显式设置的字段不被覆盖）。 */
export function registrySpecFromEnv(s: node.RegistrySpec): node.RegistrySpec {
  if (process.env.DSH_LAUNCHER_NPM_REGISTRY && !s.registry) s.registry = process.env.DSH_LAUNCHER_NPM_REGISTRY;
  if (process.env.DSH_LAUNCHER_NPM_MIRROR && !s.mirror) s.mirror = process.env.DSH_LAUNCHER_NPM_MIRROR;
  if (process.env.DSH_LAUNCHER_PREFER_MIRROR) s.preferMirror = true;
  if (process.env.DSH_LAUNCHER_NO_MIRROR) s.disableAutoSwitch = true;
  return s;
}

/** 从既有 launcher.json 配置 + 环境变量构建下载源策略（GUI 安装用）。 */
export function registrySpecFromConfig(cfg: config.Config | null): node.RegistrySpec {
  const s: node.RegistrySpec = {
    registry: cfg?.registry,
    mirror: cfg?.registryMirror,
    preferMirror: cfg?.preferMirror,
  };
  return registrySpecFromEnv(s);
}

/** 检测 npm 全局是否已装 dsh，有则提示可跳过。 */
async function hintGlobalInstall(): Promise<void> {
  try {
    const { stdout } = await node.runNpm(['root', '-g']);
    const root = stdout.trim();
    if (!root) return;
    const pkgDir = join(root, '@deepseek-ai', 'dsh');
    if (existsSync(pkgDir)) {
      log.info(`提示：npm 全局已安装 dsh（${pkgDir}）。若不想重复安装，可终止本次 install 直接运行 start。`);
    }
  } catch {
    /* 忽略 */
  }
}

// ---------- move ----------

/** 把 dsh 安装目录移动到 newDir（任意路径，跨盘自动复制+删除）。 */
export async function move(newDir: string): Promise<void> {
  const cfg = config.load();
  if (!cfg) throw new Error('未找到 launcher.json，请先运行 install');
  if (!cfg.dshInstallDir) throw new Error('未记录安装目录，请先运行 install');

  const old = cfg.dshInstallDir;
  const newAbs = resolve(newDir);
  if (old.replace(/[\\/]+$/, '').toLowerCase() === newAbs.replace(/[\\/]+$/, '').toLowerCase()) {
    throw new Error(`目标路径与当前安装目录相同：${old}`);
  }
  if (!existsSync(old)) {
    throw new Error(`当前安装目录不存在：${old}`);
  }
  // 目标路径校验：不存在，或存在但为空目录
  if (existsSync(newAbs)) {
    if (!statSync(newAbs).isDirectory()) {
      throw new Error(`目标路径已存在且不是目录：${newAbs}`);
    }
    const entries = readdirSync(newAbs);
    if (entries.length > 0) {
      throw new Error(`目标目录已存在且非空：${newAbs}（可能是上次移动中断的残留，请先删除该目录后再试）`);
    }
  }
  // 运行中禁止移动（端口有响应即拒绝）
  if (await launch.isRunning(cfg)) {
    throw new Error(`端口 ${cfg.port} 有服务响应（可能是 dsh 或其他服务在运行），请先停止 dsh 后再移动`);
  }

  log.info(`开始移动 dsh：${old} → ${newAbs}`);
  mkdirSync(dirname(newAbs), { recursive: true });
  await moveDir(old, newAbs);

  // 更新配置；失败则回滚目录
  cfg.dshInstallDir = newAbs;
  try {
    config.save(cfg);
  } catch (e) {
    await moveDir(newAbs, old).catch(() => {});
    throw new Error(`更新 launcher.json 失败（已尝试回滚）：${(e as Error).message}`);
  }
  log.info(`launcher.json 已更新：${newAbs}`);

  // 移动后校验
  await verifyMoved(newAbs, cfg.source);
  log.info(`完成。dsh 已移动到 ${newAbs}`);
}

/** 校验新位置的 dsh 可用（bin.js --version，回退 package.json）。 */
async function verifyMoved(newAbs: string, source?: node.DshSource): Promise<void> {
  const bin = node.dshBinPath(newAbs, source);
  if (!existsSync(bin)) {
    log.warn(`移动后未找到 ${bin}，请手动确认安装完整性`);
    return;
  }
  try {
    const ver = await node.dshVersion(newAbs, source);
    log.info(`移动后校验通过：${node.DshPackage}@${ver}`);
    return;
  } catch {
    /* fallthrough */
  }
  try {
    const pver = node.dshVersionFromPackage(newAbs, source);
    log.info(`移动后校验通过：${node.DshPackage}@${pver}（package.json）`);
    return;
  } catch {
    /* fallthrough */
  }
  log.warn('移动后版本校验失败，请手动确认安装完整性');
}

/** 移动目录：同盘直接 rename；跨盘（或失败）回退为复制 + 删除。 */
async function moveDir(src: string, dst: string): Promise<void> {
  try {
    // rename 跨盘会抛 EXDEV；同盘 rename 目录即可
    await import('node:fs/promises').then(({ rename }) => rename(src, dst));
    return;
  } catch {
    // 跨盘：复制 + 删除
  }
  log.info('目标与源不在同一磁盘，使用复制方式（大目录可能较慢）……');
  cpSync(src, dst, { recursive: true });
  await import('node:fs/promises').then(({ rm }) => rm(src, { recursive: true, force: true }));
}
