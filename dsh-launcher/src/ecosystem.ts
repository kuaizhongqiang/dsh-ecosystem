// ecosystem.ts —— 生态清单（ecosystem.json）+ `pull` 命令逻辑（M1 / 路线图 Phase 1）。
//
// 决策落点：
//   D3 清单即生态 —— 一切版本与组件由 ecosystem.json 声明；默认清单内嵌随启动器走，
//      `--manifest <url|file>` 指向私有清单做个性化覆盖。
//   P1-7 供应链（强制）—— 清单内每个插件包声明 sha256；pull 执行 install.ps1 前逐文件
//      验哈希；远程清单强制 HTTPS；dsh-plugins 源锁 commit（不依赖 --remote 漂移）。
//   D1 目录边界 —— launcher 只编排：core 走既有 install 流程；插件逐个跑其 install.ps1；
//      技能跑 install-skills.ps1；结果写入 launcher 旁的 ecosystem-state.json。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import * as config from './config.js';
import * as log from './log.js';
import * as node from './node.js';

/** 生态状态文件（D4：生态状态在 launcher 旁，与 launcher.json 同目录）。 */
export const EcosystemStateFileName = 'ecosystem-state.json';

/** 版本 lock 文件（M8/Phase 8：多台机器收敛到同一版本组合）。 */
export const EcosystemLockFileName = 'ecosystem-lock.json';

// ---------------------------------------------------------------- 类型

export type DshSource = node.DshSource;

/** 清单里 core（dsh）的版本策略。 */
export interface ManifestDsh {
  /** 安装源：github（源码构建，默认）| npm。 */
  source: DshSource;
  /** "latest"（取最新 tag）或具体版本（github=tag，npm=版本）。 */
  version: string;
}

/** dsh-plugins 源的锁点（P1-7：锁 commit，禁止随远端 HEAD 漂移）。 */
export interface ManifestPluginsSource {
  repo: string;
  /** 40 位 commit sha（锁死）。 */
  commit: string;
}

/** 单个插件包声明：id、包目录（相对 dsh-plugins 检出根）、待执行文件 sha256。 */
export interface ManifestPluginPackage {
  id: string;
  /** 包目录，如 plugins/audio-read-dsh-plugin。 */
  dir: string;
  /** 相对包目录的文件 → sha256（install.ps1 至少一项；可含载荷文件）。 */
  sha256: Record<string, string>;
}

/** 技能安装声明（相对 dsh-plugins 检出根）。 */
export interface ManifestSkills {
  /** 如 skills/install-skills.ps1。 */
  script: string;
  /** 该脚本 sha256（可选；声明则执行前校验）。 */
  sha256?: string;
}

/** ecosystem.json v1。 */
export interface EcosystemManifest {
  version: 1;
  dsh: ManifestDsh;
  plugins: {
    source: ManifestPluginsSource;
    packages: ManifestPluginPackage[];
  };
  skills?: ManifestSkills;
}

/** 生态状态 v1：pull 结果落盘（launcher 旁 ecosystem-state.json）。 */
export interface EcosystemState {
  version: 1;
  updatedAt: string;
  core: { installed: boolean; version?: string; installDir?: string };
  plugins: Record<string, { ok: boolean; installedAt?: string; error?: string }>;
  skills?: { ok: boolean; installedAt?: string; error?: string };
  manifest: { label: string; pluginsCommit: string };
}

/** `pull` 选项（M1；M8 增 updateLock/trustPluginsDir）。 */
export interface PullOptions {
  /** 清单来源：undefined=默认（lock 优先，其次内嵌）；https://…=远程（强制 HTTPS）；其余按本地文件路径。 */
  manifest?: string;
  /** 插件选择：undefined=全部；空数组=不装插件；数组=指定 id 子集。 */
  plugins?: string[] | null;
  /** 是否处理技能（manifest 声明了 skills 才有效）。默认 true。 */
  skills?: boolean;
  /** 是否补齐 core 缺口（launcher.json 未记录安装时走 install）。默认 true。 */
  core?: boolean;
  /** 只校验与规划，不执行安装、不写状态。 */
  dryRun?: boolean;
  /** 显式 dsh-plugins 检出目录（覆盖环境变量与默认目录；供测试/特殊布局）。 */
  pluginsDir?: string;
  /** M8：pull 成功后把当前清单写入 lock（显式 --manifest 时为「确认升级」语义）。 */
  updateLock?: boolean;
  /** M7/离线：信任 pluginsDir 为既有检出（跳过 .git/锁 commit 校验，用于离线包目录）。 */
  trustPluginsDir?: boolean;
}

// ---------------------------------------------------------------- 默认清单

/** 新集合 7 包(PM4 / §8 11→7):id、包目录、install.ps1 sha256。 */
const PACKAGES: Array<{ id: string; dir: string; installPs1: string }> = [
  { id: 'dsh-media', dir: 'plugins/dsh-media-dsh-plugin', installPs1: 'fc8d4ce29486c03079e071138e9f2fcad809e843c699d22c989b7784fd4d91e3' },
  { id: 'dsh-deepseek', dir: 'plugins/dsh-deepseek-dsh-plugin', installPs1: '64821f594bb58516bce53ad9de2470b36ea1e1b115092b8855e3d45fabe7b59f' },
  { id: 'dsh-credentials', dir: 'plugins/credentials-dsh-plugin', installPs1: 'e4d183d676ee2c2e5e6e9cd2bbb85cd37ec77171588ff4226cd60d7e7563214b' },
  { id: 'dsh-github', dir: 'plugins/github-dsh-plugin', installPs1: 'd69340d34628549cb793fc7600632ceeabdf23f1a3fed09bafb6b0afe0414254' },
  { id: 'dsh-stock', dir: 'plugins/stock-dsh-plugin', installPs1: 'e20fed7cac47e4bb4d976dbc752d5c6dd735fc94c215c4920425ba7fe4731a89' },
  { id: 'dsh-unity', dir: 'plugins/unity-mcp-dsh-plugin', installPs1: 'e76e308719dd22c804276e48584c6d5b3c16ce5a2c5a205f3b598165576e02a5' },
  { id: 'dsh-launcher', dir: 'plugins/dsh-launcher-dsh-plugin', installPs1: '5b317ae4981dae20201efce32fe9c09290c4ae5ad6b6d9292834c663d5bba2fc' },
];

/**
 * 默认清单（内嵌，随启动器走）：与 dsh-plugins 锁点 9f47279（新集合 11→7）对齐。
 * 更新流程：在 dsh-plugins 新 commit 上重算各 install.ps1 sha256 → 同步本对象与仓库根 ecosystem.json。
 */
export const DEFAULT_ECOSYSTEM: EcosystemManifest = {
  version: 1,
  dsh: { source: 'github', version: 'latest' },
  plugins: {
    source: {
      repo: 'https://github.com/kuaizhongqiang/dsh-plugins.git',
      commit: '360d1fffeb3a2a2399a0a56e2d8d92b415f0f0da',
    },
    packages: PACKAGES.map((p) => ({
      id: p.id,
      dir: p.dir,
      sha256: { 'install.ps1': p.installPs1 },
    })),
  },
  skills: {
    script: 'skills/install-skills.ps1',
    sha256: '2fc2d4f396b1c5fc1c21437058bf473a107017698c3694511721ba3f7f61e96a',
  },
};

// ---------------------------------------------------------------- 加载与校验

const SHA256_RE = /^[0-9a-f]{64}$/i;
const COMMIT_RE = /^[0-9a-f]{40}$/i;

function relSafe(p: string): boolean {
  return !isAbsolute(p) && !p.split(/[\\/]/).includes('..') && p.length > 0;
}

function failManifest(why: string): never {
  throw new Error(`ecosystem.json 校验失败：${why}`);
}

/** 清单结构校验（版本、字段、sha256 格式、路径不越界）。校验通过后可按类型使用。 */
export function validateManifest(m: unknown): asserts m is EcosystemManifest {
  if (typeof m !== 'object' || m === null) failManifest('不是对象');
  const x = m as Record<string, unknown>;
  if (x.version !== 1) failManifest('version 必须为 1');
  const dsh = (x.dsh ?? failManifest('缺少 dsh')) as ManifestDsh;
  if (dsh.source !== 'github' && dsh.source !== 'npm') failManifest('dsh.source 必须为 github|npm');
  if (typeof dsh.version !== 'string' || dsh.version.length === 0) failManifest('dsh.version 必须为非空字符串');
  const pg = (x.plugins ?? failManifest('缺少 plugins')) as { source?: unknown; packages?: unknown };
  const src = (pg.source ?? failManifest('缺少 plugins.source')) as ManifestPluginsSource;
  if (typeof src.repo !== 'string' || !/^https:\/\//i.test(src.repo)) failManifest('plugins.source.repo 必须为 https URL');
  if (typeof src.commit !== 'string' || !COMMIT_RE.test(src.commit)) failManifest('plugins.source.commit 必须为 40 位 commit sha');
  if (!Array.isArray(pg.packages) || pg.packages.length === 0) failManifest('plugins.packages 必须为非空数组');
  for (const p of pg.packages as ManifestPluginPackage[]) {
    if (typeof p.id !== 'string' || !p.id) failManifest('插件缺少 id');
    if (typeof p.dir !== 'string' || !relSafe(p.dir)) failManifest(`插件 ${String(p.id)} dir 非法（须为相对路径且不含 ..）`);
    if (typeof p.sha256 !== 'object' || p.sha256 === null) failManifest(`插件 ${String(p.id)} 缺少 sha256`);
    for (const [file, hex] of Object.entries(p.sha256)) {
      if (typeof hex !== 'string' || !SHA256_RE.test(hex)) failManifest(`插件 ${String(p.id)} ${file} 的 sha256 格式非法`);
      if (!relSafe(file)) failManifest(`插件 ${String(p.id)} 文件 ${file} 路径越界`);
    }
  }
  const sk = x.skills as ManifestSkills | undefined;
  if (sk !== undefined) {
    if (typeof sk.script !== 'string' || !relSafe(sk.script)) failManifest('skills.script 非法（须为相对路径且不含 ..）');
    if (sk.sha256 !== undefined && (typeof sk.sha256 !== 'string' || !SHA256_RE.test(sk.sha256))) {
      failManifest('skills.sha256 格式非法');
    }
  }
}

function parseManifest(text: string, label: string): EcosystemManifest {
  let json: unknown;
  try {
    let data = text;
    if (data.charCodeAt(0) === 0xfeff) data = data.slice(1); // 去 BOM
    json = JSON.parse(data);
  } catch (e) {
    throw new Error(`清单解析失败（${label}）：${(e as Error).message}`);
  }
  validateManifest(json);
  return json;
}

/**
 * 加载清单。
 * - undefined / "default"：内嵌默认清单（随 launcher 走）；
 * - https://…：远程清单，**强制 HTTPS**（P1-7）；
 * - 其余：本地文件路径（支持 file 绝对/相对路径）。
 */
export async function loadManifest(spec?: string): Promise<{ manifest: EcosystemManifest; label: string }> {
  if (!spec || spec === 'default') {
    validateManifest(DEFAULT_ECOSYSTEM);
    return { manifest: DEFAULT_ECOSYSTEM, label: '默认（内嵌）' };
  }
  if (/^https?:\/\//i.test(spec)) {
    if (/^http:\/\//i.test(spec)) {
      throw new Error(`私有清单强制 HTTPS（P1-7）：收到 http 地址 ${spec}；请改用 https 或本地文件路径`);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const resp = await fetch(spec, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'dsh-launcher/pull', Accept: 'application/json' },
      });
      if (resp.status !== 200) throw new Error(`HTTP ${resp.status}（${spec}）`);
      const text = await resp.text();
      return { manifest: parseManifest(text, spec), label: spec };
    } finally {
      clearTimeout(timer);
    }
  }
  const abs = resolve(spec);
  try {
    return { manifest: parseManifest(readFileSync(abs, 'utf8'), abs), label: abs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`清单文件不存在：${abs}`);
    throw e;
  }
}

// ---------------------------------------------------------------- 源与哈希

/** dsh-plugins 检出根：显式 > 环境变量 > launcher 旁默认。 */
export function pluginsRootDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const env = process.env.DSH_LAUNCHER_PLUGINS_DIR;
  if (env) return resolve(env);
  return join(dirname(config.configPath()), 'dsh-plugins');
}

/**
 * 确保 dsh-plugins 检出在**锁定的 commit**（P1-7）：
 * - 目录不存在 → 克隆并 checkout 锁定 commit；
 * - 目录存在但非 git 检出 → 报错（提示删除后让 pull 克隆，或设置 DSH_LAUNCHER_PLUGINS_DIR）；
 * - 检出 HEAD ≠ 锁定 commit → 报错（不自动漂移）。
 * dryRun 时不做克隆（离线也允许校验既有检出）。
 */
export async function ensurePluginsSource(
  manifest: EcosystemManifest,
  explicit?: string,
  dryRun = false,
  trust = false,
): Promise<string> {
  const src = manifest.plugins.source;
  const dir = pluginsRootDir(explicit);
  if (!existsSync(dir)) {
    if (dryRun) {
      throw new Error(`dry-run：插件检出不存在（${dir}），无法校验；先执行真实 pull 克隆后重试`);
    }
    if (trust && explicit) {
      throw new Error(`信任的插件目录不存在：${dir}（离线包缺少 plugins/？）`);
    }
    log.info(`克隆 dsh-plugins（锁 ${src.commit.slice(0, 8)}）：${src.repo}`);
    await clonePinned(src.repo, src.commit, dir);
    return dir;
  }
  if (trust && explicit) {
    // M7/离线包：显式给的目录按既有内容信任（跳过 git/锁 commit 校验）
    log.info(`使用信任插件目录（跳过锁 commit 校验）：${dir}`);
    return dir;
  }
  if (!existsSync(join(dir, '.git'))) {
    throw new Error(
      `插件源目录 ${dir} 不是 git 检出（缺 .git）。请删除该目录后让 pull 重新克隆，` +
        `或把 DSH_LAUNCHER_PLUGINS_DIR 指向已检出的 dsh-plugins 仓库`,
    );
  }
  const head = (await node.runGit(['rev-parse', 'HEAD'], undefined, dir)).trim();
  if (head !== src.commit) {
    throw new Error(
      `dsh-plugins 检出 HEAD=${head.slice(0, 8)}，清单锁定 ${src.commit.slice(0, 8)}（P1-7 锁 commit，不自动漂移）。` +
        `请在 ${dir} 更新到锁定 commit 后重试 pull`,
    );
  }
  return dir;
}

/** 克隆仓库并 checkout 锁定 commit（fetch 指定 sha，GitHub 允许可达 sha 的浅取）。 */
async function clonePinned(repo: string, commit: string, target: string): Promise<void> {
  const fsP = await import('node:fs/promises');
  await fsP.rm(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  await fsP.mkdir(target, { recursive: true });
  const proxy = node.resolveProxy(undefined, config.load()?.proxy);
  const run = (args: string[]): Promise<string> => node.runGit(args, undefined, target);
  await run(['init', '-q']);
  await run(['remote', 'add', 'origin', ...node.gitProxyArgs(proxy), repo]);
  await run(['fetch', '-q', '--depth', '1', 'origin', commit]);
  await run(['checkout', '-q', 'FETCH_HEAD']);
  const head = (await run(['rev-parse', 'HEAD'])).trim();
  if (head !== commit) throw new Error(`克隆后 HEAD=${head.slice(0, 8)} ≠ 锁定 ${commit.slice(0, 8)}`);
}

/** 单文件 sha256（hex）。 */
export function fileSha256(abs: string): string {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

/**
 * 供应链校验（P1-7）：执行 install.ps1 前逐文件验哈希。
 * 校验范围内任一文件缺失/不匹配即抛错（不做任何执行）。
 */
export function verifyHashes(manifest: EcosystemManifest, rootDir: string, pkgIds: string[]): void {
  const src = manifest.plugins.source;
  for (const pkg of manifest.plugins.packages) {
    if (pkgIds.length > 0 && !pkgIds.includes(pkg.id)) continue;
    const base = join(rootDir, pkg.dir);
    for (const [rel, hex] of Object.entries(pkg.sha256)) {
      const file = join(base, rel);
      if (!existsSync(file)) {
        throw new Error(`供应链校验失败：${pkg.dir}/${rel} 不存在（锁 ${src.commit.slice(0, 8)}）`);
      }
      const actual = fileSha256(file);
      if (actual.toLowerCase() !== hex.toLowerCase()) {
        throw new Error(
          `供应链校验失败：${pkg.dir}/${rel} sha256 不匹配（清单 ${hex}，实际 ${actual}）。` +
            `检出与清单不一致或已被篡改，拒绝执行`,
        );
      }
      log.info(`sha256 ✓ ${pkg.dir}/${rel}`);
    }
  }
  if (manifest.skills?.sha256) {
    const file = join(rootDir, manifest.skills.script);
    if (!existsSync(file)) throw new Error(`供应链校验失败：${manifest.skills.script} 不存在`);
    const actual = fileSha256(file);
    if (actual.toLowerCase() !== manifest.skills.sha256.toLowerCase()) {
      throw new Error(
        `供应链校验失败：${manifest.skills.script} sha256 不匹配（清单 ${manifest.skills.sha256}，实际 ${actual}）`,
      );
    }
    log.info(`sha256 ✓ ${manifest.skills.script}`);
  }
}

// ---------------------------------------------------------------- pull

/** 生态状态文件路径（与 launcher.json 同目录）。 */
export function ecosystemStatePath(): string {
  return join(dirname(config.configPath()), EcosystemStateFileName);
}

// ---------------------------------------------------------------- 版本 lock（M8）

/** ecosystem-lock.json v1：多机收敛的版本组合快照。 */
export interface EcosystemLock {
  version: 1;
  lockedAt: string;
  label: string;
  manifest: EcosystemManifest;
}

export function ecosystemLockPath(): string {
  return join(dirname(config.configPath()), EcosystemLockFileName);
}

/** 读取 lock（缺失/损坏返回 undefined）。 */
export function loadLock(): EcosystemLock | undefined {
  try {
    const lock = JSON.parse(readFileSync(ecosystemLockPath(), 'utf8')) as EcosystemLock;
    if (lock.version !== 1 || !lock.manifest) return undefined;
    return lock;
  } catch {
    return undefined;
  }
}

/** 写 lock（pull 成功后 / `--update-lock` 确认升级时）。 */
export function writeLock(manifest: EcosystemManifest, label: string): void {
  validateManifest(manifest);
  const lock: EcosystemLock = { version: 1, lockedAt: new Date().toISOString(), label, manifest };
  writeFileSync(ecosystemLockPath(), JSON.stringify(lock, null, 2) + '\n', 'utf8');
  log.info(`生态 lock 已更新：${ecosystemLockPath()}（${label}）`);
}

/**
 * `pull` 主流程：core（缺口时）→ 插件 install.ps1（逐个）→ 技能 install-skills.ps1 → 写状态。
 * 供应链校验通过才执行对应脚本；失败项记录到状态与汇总错误。
 */
export async function runPull(opts: PullOptions = {}): Promise<void> {
  const { manifest: manifestSpec, plugins: pluginSel, skills = true, core = true, dryRun = false, pluginsDir, updateLock = false, trustPluginsDir = false } = opts;
  // M8：无显式清单时 lock 优先（多机收敛同一版本组合）；lock 不存在才用默认内嵌
  const specExplicit = !!manifestSpec && manifestSpec !== 'default';
  let manifest: EcosystemManifest;
  let label: string;
  let lockUsed = false;
  if (!specExplicit) {
    const lock = loadLock();
    if (lock) {
      validateManifest(lock.manifest);
      manifest = lock.manifest;
      label = `lock（${lock.label} @ ${lock.lockedAt}）`;
      lockUsed = true;
    } else {
      ({ manifest, label } = await loadManifest(manifestSpec));
    }
  } else {
    ({ manifest, label } = await loadManifest(manifestSpec));
  }
  log.info(`生态清单：${label}（dsh=${manifest.dsh.source}/${manifest.dsh.version}）`);
  log.info(`插件源锁定：${manifest.plugins.source.commit.slice(0, 8)}（${manifest.plugins.source.repo}）`);

  // 0. 插件选择
  const allIds = manifest.plugins.packages.map((p) => p.id);
  let selected: string[] = allIds;
  if (pluginSel !== undefined && pluginSel !== null) {
    if (pluginSel.length === 0) selected = [];
    else {
      const unknown = pluginSel.filter((id) => !allIds.includes(id));
      for (const u of unknown) log.warn(`清单中没有插件 ${u}，跳过`);
      selected = pluginSel.filter((id) => allIds.includes(id));
    }
  }

  // 1. core 缺口（复用既有 install；不在 dry-run 里执行）
  let cfg = config.load();
  const coreState = { installed: !!(cfg && config.isInstalled(cfg)), version: cfg?.dshVersion, installDir: cfg?.dshInstallDir };
  if (core && !coreState.installed) {
    if (dryRun) {
      log.info('core：未安装 → 真实 pull 将执行 install（dsh=' + manifest.dsh.source + '）');
    } else {
      log.info(`core 未安装，按清单执行 install（source=${manifest.dsh.source}）……`);
      const install = await import('./install.js');
      await install.run(install.defaultInstallDir(), {}, {
        source: manifest.dsh.source,
        version: manifest.dsh.version === 'latest' ? undefined : manifest.dsh.version,
      });
      cfg = config.load();
      coreState.installed = !!(cfg && config.isInstalled(cfg));
      coreState.version = cfg?.dshVersion;
      coreState.installDir = cfg?.dshInstallDir;
    }
  } else if (core && coreState.installed) {
    log.info(`core：已安装（${cfg?.dshVersion ?? ''} @ ${cfg?.dshInstallDir ?? ''}），跳过`);
  }

  // 2. 插件源 + 供应链校验
  const pluginFailures: string[] = [];
  if (selected.length > 0) {
    const root = await ensurePluginsSource(manifest, pluginsDir, dryRun, trustPluginsDir && !!pluginsDir);
    verifyHashes(manifest, root, selected);
    for (const id of selected) {
      const pkg = manifest.plugins.packages.find((p) => p.id === id)!;
      if (dryRun) {
        log.info(`[dry-run] 将执行 install.ps1：${pkg.dir}`);
        continue;
      }
      log.info(`安装插件 ${id}（${pkg.dir}/install.ps1）……`);
      try {
        await node.runPowerShellFile(join(root, pkg.dir, 'install.ps1'), [], join(root, pkg.dir), (l) =>
          log.info(`[${id}] ${l}`),
        );
        log.info(`插件 ${id} 安装完成`);
      } catch (e) {
        pluginFailures.push(id);
        log.error(`插件 ${id} 安装失败：${(e as Error).message}`);
      }
    }
  } else {
    log.info('插件：未选择任何包，跳过');
  }

  // 3. 技能（与插件选择无关：清单声明了即处理）
  let skillsRes: { ok: boolean; installedAt?: string; error?: string } | undefined;
  if (skills && manifest.skills) {
    const root = await ensurePluginsSource(manifest, pluginsDir, dryRun, trustPluginsDir && !!pluginsDir);
    if (dryRun) {
      log.info(`[dry-run] 将执行技能安装：${manifest.skills.script}`);
    } else {
      log.info(`安装技能（${manifest.skills.script}）……`);
      try {
        await node.runPowerShellFile(join(root, manifest.skills.script), [], root, (l) => log.info(`[skills] ${l}`));
        skillsRes = { ok: true, installedAt: new Date().toISOString() };
        log.info('技能安装完成');
      } catch (e) {
        skillsRes = { ok: false, error: (e as Error).message };
        log.error(`技能安装失败：${skillsRes.error}`);
      }
    }
  } else if (skills && !manifest.skills) {
    log.info('技能：清单未声明 skills，跳过');
  }

  // 4. 状态落盘
  if (!dryRun) {
    const now = new Date().toISOString();
    const pluginsState: EcosystemState['plugins'] = {};
    for (const id of selected) {
      pluginsState[id] = pluginFailures.includes(id)
        ? { ok: false, error: 'install.ps1 执行失败' }
        : { ok: true, installedAt: now };
    }
    const state: EcosystemState = {
      version: 1,
      updatedAt: now,
      core: coreState,
      plugins: pluginsState,
      ...(skillsRes || manifest.skills ? { skills: skillsRes ?? { ok: false, error: '未执行' } } : {}),
      manifest: { label, pluginsCommit: manifest.plugins.source.commit },
    };
    writeFileSync(ecosystemStatePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
    log.info(`生态状态已写入 ${ecosystemStatePath()}`);
  } else {
    log.info('[dry-run] 未执行任何安装、未写状态');
  }

  if (pluginFailures.length > 0 || (skillsRes && !skillsRes.ok)) {
    const bad: string[] = [...pluginFailures];
    if (skillsRes && !skillsRes.ok) bad.push('skills');
    throw new Error(`pull 完成但存在失败项：${bad.join(', ')}（详见上方日志）`);
  }
  // M8:lock 落盘 —— 首次 pull(无 lock)自动写;显式 --manifest + --update-lock = 确认升级;
  // 已用 lock 时不重写(除非 updateLock 刷新)
  if (!dryRun && (updateLock || (!specExplicit && !lockUsed))) {
    writeLock(manifest, label);
  }
  log.info(`pull 完成：core=${coreState.installed ? '已装' : '跳过/未装'}，插件 ${selected.length} 个${dryRun ? '(dry-run)' : ''}`);
}
