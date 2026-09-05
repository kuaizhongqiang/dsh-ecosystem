// config.ts —— launcher.json 的读写（与 exe 同目录，便携）。
// 移植自 Go internal/config。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSea } from 'node:sea';

/** dsh web 默认监听端口。 */
export const DefaultPort = 3080;

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

/** 把配置写回 launcher.json。 */
export function save(c: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2) + '\n', 'utf8');
}

/** 是否已记录可用安装目录。 */
export function isInstalled(c: Config | null): boolean {
  return c !== null && c.dshInstallDir !== '';
}
