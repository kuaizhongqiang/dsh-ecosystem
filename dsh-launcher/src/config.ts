// config.ts —— launcher.json 的读写（与 exe 同目录，便携）。
// 移植自 Go internal/config。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSea } from 'node:sea';

/** dsh web 默认监听端口。 */
export const DefaultPort = 3080;

/** 单个可折叠块的展开状态（key = 卡片/子块 id，value = 是否展开）。 */
export type CollapseMap = Record<string, boolean>;

/** 日志区偏好。 */
export interface UiLogSettings {
  /** 过滤：all=全部 / warn-err=警告+错误 / err=仅错误。 */
  errorsOnly?: 'all' | 'warn-err' | 'err';
  /** 环形缓冲行数上限。 */
  maxLines?: number;
}

/** UI 本地状态（#18 展开状态记忆；可选顶层字段，读写都经后端桥）。 */
export interface UiSettings {
  collapsed?: CollapseMap;
  log?: UiLogSettings;
  layout?: Record<string, unknown>;
}

export interface Config {
  dshInstallDir: string;
  dshVersion?: string;
  port: number;
  installedAt?: string;
  /** 安装源：github = 源码构建（默认）；npm = registry 安装（旧布局兼容）。 */
  source?: 'github' | 'npm';
  /** M6:关窗行为——'tray'(默认)=隐藏到托盘,dsh 继续跑;'exit'=关窗即停(旧行为)。 */
  closeAction?: 'tray' | 'exit';
  /** GitHub 访问代理（可选，git 走 socks5/http）。 */
  proxy?: string;
  // 下载源配置（可选，仅 npm 安装使用）
  registry?: string;
  registryMirror?: string;
  preferMirror?: boolean;
  /** UI 本地状态（#18/#19：折叠记忆、日志偏好等；可选）。 */
  ui?: UiSettings;
}

const DEFAULT_UI: UiSettings = { collapsed: {}, log: { errorsOnly: 'all', maxLines: 2000 }, layout: {} };

function deepMergeUi(base: UiSettings, patch: Partial<UiSettings>): UiSettings {
  return {
    collapsed: { ...(base.collapsed ?? {}), ...(patch.collapsed ?? {}) },
    log: { ...(base.log ?? {}), ...(patch.log ?? {}) },
    layout: { ...(base.layout ?? {}), ...(patch.layout ?? {}) },
  };
}

/**
 * launcher.json 路径（便携：跟随 exe 走）。
 * 优先级：
 *   1. DSH_LAUNCHER_CONFIG_DIR（显式覆盖，测试用）
 *   2. PORTABLE_EXECUTABLE_DIR（electron-builder portable：用户放置 exe 的目录）
 *   3. SEA 单文件 exe：与 exe 同目录
 *   4. Electron 打包版：与 exe 同目录
 *   5. dev 模式（node dist/launcher.cjs）：当前工作目录
 */
export function configPath(): string {
  const dir =
    process.env.DSH_LAUNCHER_CONFIG_DIR ??
    process.env.PORTABLE_EXECUTABLE_DIR ??
    (isSea() || process.versions.electron !== undefined ? dirname(process.execPath) : process.cwd());
  return join(dir, 'launcher.json');
}

/** 读取 launcher.json；文件不存在返回 null。容忍 UTF-8 BOM。 */
export function load(): Config | null {
  try {
    let data = readFileSync(configPath(), 'utf8');
    if (data.charCodeAt(0) === 0xfeff) data = data.slice(1); // 去 BOM
    const c = JSON.parse(data) as Config;
    if (!c.port || c.port <= 0) c.port = DefaultPort;
    return c;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** 把配置写回 launcher.json（tmp + rename 原子写；rename 失败兜底直接写）。 */
export function save(c: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const body = JSON.stringify(c, null, 2) + '\n';
  try {
    const tmp = p + '.tmp-' + process.pid + '-' + Date.now().toString(36);
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, p);
  } catch {
    // 个别环境（如被占用）rename 不可用：兜底直接写，保持行为不变量。
    writeFileSync(p, body, 'utf8');
  }
}

/** 读取 UI 状态；文件缺失或未存 ui 字段时返回默认值（不落盘）。 */
export function loadUi(): UiSettings {
  const c = load();
  return c?.ui ? deepMergeUi(DEFAULT_UI, c.ui) : { ...DEFAULT_UI, collapsed: {}, log: { ...DEFAULT_UI.log } };
}

/**
 * 合并保存 UI 状态（load → merge → save，防 config.save() 全量覆盖互相丢字段）。
 * launcher.json 尚不存在时不落盘（避免伪造安装前配置），仅返回合并结果。
 */
export function saveUi(patch: Partial<UiSettings>): UiSettings {
  const c = load();
  if (!c) return deepMergeUi(DEFAULT_UI, patch);
  const next = deepMergeUi(c.ui ?? DEFAULT_UI, patch);
  c.ui = next;
  save(c);
  return next;
}

/** 是否已记录可用安装目录。 */
export function isInstalled(c: Config | null): boolean {
  return c !== null && c.dshInstallDir !== '';
}
