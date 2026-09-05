// setup.ts —— 新机器一条龙(M7 / Phase 7):setup 命令与 GUI「一键部署」的编排层。
//
// 流程:core(缺口时,支持 --offline)→ pull(插件+skills,默认清单/lock/--manifest)
//       → 个人层(可选:--profile-dir 明文 pack / --profile-in 加密容器)
//       → 连接(--connection <id> 切换激活;无文件则用合成默认)
//       → start(跟随激活连接;--no-start 跳过,供脚本化部署分步执行)。

import * as config from './config.js';
import * as connections from './connections.js';
import * as ecosystem from './ecosystem.js';
import * as install from './install.js';
import * as launch from './launch.js';
import * as log from './log.js';
import * as profile from './profile.js';

export interface SetupOptions {
  /** 清单来源(--manifest);缺省 lock 优先,其次内嵌默认。 */
  manifest?: string;
  /** 离线包目录(--offline):core 走离线安装,插件源取 <offline>/plugins(信任目录)。 */
  offlineDir?: string;
  /** 明文个人层 pack(--profile-dir)。 */
  profileDir?: string;
  /** 加密个人层容器(--profile-in,配 --password)。 */
  profileIn?: string;
  /** 加密容器口令(--password / 环境变量 DSH_LAUNCHER_PROFILE_PASSWORD)。 */
  password?: string;
  /** 切换激活连接(--connection <id>)。 */
  connection?: string;
  /** 插件子集(--plugins a,b)。 */
  plugins?: string[] | null;
  /** 跳过最后的 start(--no-start)。 */
  noStart?: boolean;
  /** pull 后写/刷新版本 lock(--update-lock,M8)。 */
  updateLock?: boolean;
}

/** setup 主流程。 */
export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  const steps: string[] = [];

  // 0. 预载清单(仅日志用;pull 内部会再按 lock 语义解析)
  if (opts.manifest) log.info(`setup：清单 ${opts.manifest}`);

  // 1. core 缺口
  let cfg = config.load();
  if (!cfg || !config.isInstalled(cfg)) {
    log.info('setup 1/5：安装 core ……');
    if (opts.offlineDir) {
      await install.run('', {}, { offlineDir: opts.offlineDir });
    } else {
      const { manifest } = await ecosystem.loadManifest(opts.manifest);
      await install.run(install.defaultInstallDir(), {}, {
        source: manifest.dsh.source,
        version: manifest.dsh.version === 'latest' ? undefined : manifest.dsh.version,
      });
    }
    steps.push('core:安装');
  } else {
    log.info(`setup 1/5：core 已安装（${cfg.dshVersion ?? ''}），跳过`);
    steps.push('core:已装');
  }

  // 2. pull(插件 + skills;lock 优先)
  log.info('setup 2/5：拉齐插件与技能(pull)……');
  await ecosystem.runPull({
    manifest: opts.manifest,
    plugins: opts.plugins,
    skills: true,
    core: false,
    updateLock: opts.updateLock,
    ...(opts.offlineDir ? { pluginsDir: `${opts.offlineDir}/plugins`.replace(/\//g, '\\'), trustPluginsDir: true } : {}),
  });
  steps.push('pull:完成');

  // 3. 个人层(可选)
  if (opts.profileDir) {
    log.info('setup 3/5：恢复个人层(明文 pack)……');
    profile.pullProfilePack(opts.profileDir);
    steps.push('profile:pack');
  } else if (opts.profileIn) {
    log.info('setup 3/5：恢复个人层(加密容器)……');
    profile.importProfilePack(opts.profileIn, opts.password);
    steps.push('profile:加密容器');
  } else {
    log.info('setup 3/5：个人层未提供,跳过(新机可后置 profile pull/import)');
    steps.push('profile:跳过');
  }

  // 4. 连接
  if (opts.connection) {
    connections.useConnection(opts.connection);
    log.info(`setup 4/5：激活连接 → ${opts.connection}`);
    steps.push(`connection:${opts.connection}`);
  } else {
    const { conn } = connections.resolveActive(config.load());
    log.info(`setup 4/5：连接保持 ${conn.id}（无 connections.json 时为合成默认）`);
    steps.push(`connection:${conn.id}`);
  }

  // 5. start
  if (opts.noStart) {
    log.info('setup 5/5：--no-start,跳过启动(脚本化部署可再执行 start)');
    steps.push('start:跳过');
  } else {
    const c = config.load();
    if (!c || !config.isInstalled(c)) throw new Error('setup：core 安装校验失败(launcher.json 缺失)');
    log.info('setup 5/5：启动 dsh(跟随激活连接;remote=健康检查+开浏览器)……');
    const { conn } = connections.resolveActive(c);
    await launch.start(c, false, conn);
    steps.push('start:完成');
  }

  log.info(`setup 完成：${steps.join(' → ')}`);
}
