// registration.ts —— launcher-registration.json(M6 重启 seam:持久注册 + 心跳)。
//
// PLAN Phase 6:
//   - 安装即注册、卸载(进程退出)即注销、挪移/升级时更新、运行中心跳(≤30s 刷新 updatedAt)
//   - 内容 { version, launcherExe, launcherVersion, dshInstallDir, pid?, api?, bridgeKey?, running, registeredAt, updatedAt }
//   - 文件 0600(与 launch-token 同规范;Windows 依赖 NTFS 默认 ACL)
//   - 消费者判定:updatedAt 距今 > 2× 心跳间隔(≥60s)即视为陈旧,必须以 pid 存在性 + api 健康检查复核
//   - 便携版:launcherExe 记录用户放置 exe 的原始路径(经 PORTABLE_EXECUTABLE_DIR 解析),绝不记录临时解压路径
//   - dev(node dist/launcher.cjs)无 exe 可注册 → 跳过注册(所有写入静默 no-op)

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as log from './log.js';
import { dshHome } from './tokenFile.js';
import { VERSION } from './version.js';

export const RegistrationFileName = 'launcher-registration.json';

/** 心跳间隔(≤30s)。 */
export const HEARTBEAT_MS = 30_000;
/** 陈旧判定阈值(2× 心跳间隔)。 */
export const STALE_MS = 60_000;

export interface LauncherRegistration {
  version: 1;
  launcherExe: string;
  launcherVersion: string;
  dshInstallDir: string;
  pid?: number;
  /** REST bridge 基址(含端口,如 http://127.0.0.1:3177)。 */
  api?: string;
  bridgeKey?: string;
  running: boolean;
  registeredAt: string;
  updatedAt: string;
}

export function registrationPath(): string {
  return join(dshHome(), RegistrationFileName);
}

/**
 * 解析本 launcher 的 exe 原始路径:
 *   便携版(electron-builder portable)→ PORTABLE_EXECUTABLE_DIR/dsh-launcher.exe(用户放置的原始路径);
 *   NSIS/SEA → process.execPath;
 *   dev(node dist/launcher.cjs)→ undefined(跳过注册)。
 */
export function launcherExePath(): string | undefined {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) return join(portableDir, 'dsh-launcher.exe');
  if (process.versions.electron !== undefined) return process.execPath;
  return undefined;
}

function writeReg(reg: LauncherRegistration): void {
  mkdirSync(dshHome(), { recursive: true });
  const target = registrationPath();
  const tmp = `${target}.tmp-${Math.floor(Math.random() * 1e6)}`;
  try {
    writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8');
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    log.warn(`launcher-registration 写入失败（不阻断）：${(e as Error).message}`);
  }
}

export function readRegistration(): LauncherRegistration | undefined {
  const p = registrationPath();
  if (!existsSync(p)) return undefined;
  try {
    const reg = JSON.parse(readFileSync(p, 'utf8')) as LauncherRegistration;
    if (reg.version !== 1) return undefined;
    return reg;
  } catch {
    return undefined;
  }
}

/** 注册是否新鲜(≤2× 心跳间隔);调用方仍须以 pid 存在性 + api 健康复核。 */
export function isFresh(reg: LauncherRegistration): boolean {
  const t = Date.parse(reg.updatedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < STALE_MS;
}

// 本进程是否拥有注册(stop/exit 时只有拥有者才注销,防误删其他 launcher 实例的注册)
let ownedByThisProcess = false;

/** REST bridge 信息(server 就绪后设置;注册时合并写入)。 */
let bridge: { api?: string; bridgeKey?: string } = {};

/** server 就绪后调用:记录 api/bridgeKey,并补写进既有注册文件。 */
export function setBridge(api: string, bridgeKey: string): void {
  bridge = { api, bridgeKey };
  patchRegistration({ api, bridgeKey });
}

/** 注册/更新(start 成功、挪移/升级后)。dev 无 exe → no-op。 */
export function registerLauncher(
  dshInstallDir: string,
  patch: { pid?: number; running?: boolean } = {},
): void {
  const exe = launcherExePath();
  if (!exe) return;
  ownedByThisProcess = true;
  const prev = readRegistration();
  const now = new Date().toISOString();
  const reg: LauncherRegistration = {
    version: 1,
    launcherExe: exe,
    launcherVersion: VERSION,
    dshInstallDir,
    pid: patch.pid ?? prev?.pid,
    api: bridge.api ?? prev?.api,
    bridgeKey: bridge.bridgeKey ?? prev?.bridgeKey,
    running: patch.running ?? false,
    registeredAt: prev?.registeredAt ?? now,
    updatedAt: now,
  };
  writeReg(reg);
}

/** 心跳段补写(仅已存在的注册;未注册/dev 静默跳过)。 */
export function patchRegistration(patch: { api?: string; bridgeKey?: string; pid?: number; running?: boolean }): void {
  const prev = readRegistration();
  if (!prev) return;
  writeReg({
    ...prev,
    ...(patch.api !== undefined ? { api: patch.api } : {}),
    ...(patch.bridgeKey !== undefined ? { bridgeKey: patch.bridgeKey } : {}),
    ...(patch.pid !== undefined ? { pid: patch.pid } : {}),
    ...(patch.running !== undefined ? { running: patch.running } : {}),
    updatedAt: new Date().toISOString(),
  });
}

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

/** 运行中心跳(≤30s;启停即时刷新由 register/patch 承担)。仅拥有者进程有效。 */
export function startHeartbeat(getState: () => { pid?: number; running: boolean }): void {
  stopHeartbeat();
  if (!ownedByThisProcess) return;
  const beat = (): void => {
    const prev = readRegistration();
    if (!prev) return;
    const st = getState();
    writeReg({ ...prev, pid: st.pid ?? prev.pid, running: st.running, updatedAt: new Date().toISOString() });
  };
  beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

/** 注销(仅本进程拥有注册时执行,防误删其他实例的注册)。 */
export function unregisterLauncher(): void {
  stopHeartbeat();
  if (!ownedByThisProcess) return;
  ownedByThisProcess = false;
  try {
    rmSync(registrationPath(), { force: true });
  } catch {
    /* ignore */
  }
}
