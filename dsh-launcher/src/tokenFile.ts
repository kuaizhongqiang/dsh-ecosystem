// tokenFile.ts —— 与 dsh-vscode 插件共享的启动 token 文件（$DSH_HOME/launch-token.json）。
//
// dsh v0.1.2+ 每次启动生成随机 launch token，只打印到日志（`dsh web: http://.../?token=...`），
// 浏览器须经 /?token= 换取登录 cookie。launcher 与 vscode 插件都可能拉起 dsh web，
// 但各自只能从**自己子进程的日志**里看到 token —— 因此落盘共享，双方读写，
// 谁拉起 dsh 谁写入，另一方直接读取（规范见 DSH-LAUNCH-TOKEN-FILE.md）。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LAUNCH_TOKEN_FILE = 'launch-token.json';
export const LAUNCH_TOKEN_VERSION = 1;

/** 日志脱敏（M0/P1-6）:把文本里 `?token=…` / `&token=…` 的 token 值替换为 `***`,用于打印/记录带 token 的地址。 */
export function redactTokenUrl(text: string): string {
  return text.replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1***');
}

export type LaunchTokenSource = 'dsh-launcher' | 'dsh-vscode';

export interface LaunchTokenRecord {
  /** 固定 1；读取方版本不符视为无效。 */
  version: typeof LAUNCH_TOKEN_VERSION;
  /** `dsh web` 打印的 `?token=` 值（裸 token）。 */
  token: string;
  /** dsh web 监听端口（可选）。 */
  port?: number;
  /** 带 token 的规范访问 URL，如 http://127.0.0.1:3080/?token=... */
  url: string;
  /** 写入方 spawn 的 dsh 进程 PID（可选，用于清理归属判断）。 */
  pid?: number;
  /** 写入时间（ISO 8601）。 */
  writtenAt: string;
  /** 写入方：dsh-launcher / dsh-vscode。 */
  source: LaunchTokenSource;
  /** M6 重启 seam（可选）：由 launcher 写入时标记管理方；读取方忽略未知字段，向后兼容。 */
  managedBy?: 'dsh-launcher';
}

/** DSH_HOME 解析（与 dsh-vscode 的 dshHome 同一规则）。 */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** 共享 token 文件的绝对路径。 */
export function launchTokenFilePath(): string {
  return join(dshHome(), LAUNCH_TOKEN_FILE);
}

/** dsh 打印的带 token URL 行，如 `dsh web: http://127.0.0.1:3080/?token=abc...`。 */
export const TOKEN_URL_RE = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_-]+)/g;

/** 从一段文本（dsh 子进程日志）提取**最新**一条带 token 的 URL。 */
export function tokenUrlFromLogText(text: string): string | undefined {
  const matches = [...text.matchAll(TOKEN_URL_RE)];
  return matches.length === 0 ? undefined : matches[matches.length - 1]?.[1];
}

/** 从带 token 的 URL 里解析出裸 token（解析失败返回 undefined）。 */
export function tokenFromUrl(url: string): string | undefined {
  try {
    const token = new URL(url).searchParams.get('token');
    return token !== null && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** 读取共享 token 文件；缺失 / 损坏 / 版本不符返回 undefined。 */
export function readLaunchToken(): LaunchTokenRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(launchTokenFilePath(), 'utf8')) as LaunchTokenRecord;
    if (record.version !== LAUNCH_TOKEN_VERSION) return undefined;
    if (typeof record.token !== 'string' || record.token.length === 0) return undefined;
    if (typeof record.url !== 'string' || record.url.length === 0) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

/** 写入共享 token 文件（整文件覆盖）。POSIX 权限 0600；失败不抛出（仅降级自动认证）。 */
export function writeLaunchToken(record: Omit<LaunchTokenRecord, 'version' | 'writtenAt'>): void {
  const full: LaunchTokenRecord = {
    ...record,
    version: LAUNCH_TOKEN_VERSION,
    writtenAt: new Date().toISOString(),
  };
  const path = launchTokenFilePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(full, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // 写入失败不致命：调用方继续用日志里的 token，只是对方应用读不到。
  }
}

/**
 * 清理共享 token 文件（M0 / 决策 D8 原子化，修 P0-4 竞态）。
 *
 * 仅在文件记录与调用方「归属」匹配时删除:
 *   - source 必须一致（launcher 不清 vscode 维护的记录，反之亦然）;
 *   - 记录带 pid 时，pid 必须与调用方持有的子进程 pid 一致
 *     （同 source 的旧实例/其他实例记录不可误删）;
 *   - 记录无 pid（旧版写入）时按 source 归属判断;
 *   - 调用方未知 pid 时，只清「无 pid 的旧版记录」，pid 明确的记录不碰。
 *
 * 删除前**复读确认**:read → 归属判断 → 再次 read → 两次内容一致才 rmSync。
 * 收窄「读到旧记录后、删除前文件被另一监督者改写」的 TOCTOU 窗口
 * （读 A 认定归属 → vscode/新进程改写了文件 → 误删新记录）:
 * 复读发现文件已被改写为其他内容/归属即放弃删除，重试至多 3 次
 * —— 宁可残留陈旧记录（读取方有 401 自检/兜底），不可误删他人 token。
 *
 * @param source 调用方来源（dsh-launcher / dsh-vscode）。
 * @param pid    调用方持有的 dsh 子进程 PID（可选;记录带 pid 时必须匹配）。
 */
export function clearLaunchToken(source: LaunchTokenSource, pid?: number): void {
  const path = launchTokenFilePath();
  for (let attempt = 0; attempt < 3; attempt++) {
    const record = readLaunchToken();
    if (record === undefined) return; // 无文件 / 损坏 / 版本不符:无事可做
    if (!recordOwnedBy(record, source, pid)) return; // 不属于调用方:不动
    // 删除前复读确认:两次读取之间文件被改写 → 放弃本次，重试
    const reread = readLaunchToken();
    if (reread === undefined) return; // 已被并发清理
    if (
      reread.source !== record.source ||
      reread.pid !== record.pid ||
      reread.token !== record.token ||
      reread.writtenAt !== record.writtenAt
    ) {
      continue; // 被其他监督者改写，重读后再判归属
    }
    try {
      rmSync(path, { force: true });
      return;
    } catch {
      return; // 删除失败不致命，交由下次启动清理
    }
  }
}

/** 归属判断:source 必须一致;pid 匹配规则见 clearLaunchToken 注释。 */
function recordOwnedBy(record: LaunchTokenRecord, source: LaunchTokenSource, pid?: number): boolean {
  if (record.source !== source) return false;
  if (record.pid === undefined) return true; // 旧版无 pid 记录:按 source 归属
  return pid !== undefined && record.pid === pid;
}
