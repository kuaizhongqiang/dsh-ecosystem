// connections.ts —— 多连接启动项(M5 / Phase 5,决策 D5 + D8 协调)。
//
// D5 连接即启动项:所有可连的 dsh 实例(本机不同端口、广域网)统一声明为
//   %DSH_HOME%\connections.json 的连接组;激活连接解析后照写 v1 launch-token.json
//   (desktop 完全跟随;vscode token 跟随,serverUrl 静态不自动切换)。
// D8 协调:① connections.json 原子写(临时文件 + rename);③ active 切换写
//   .dsh-connection-changed 标记;② 端口锁 .dsh-port-<port>.lock(spawn 前检查、退出清理)。
// 红线(D2):connections.json 含各组 token,仅存本地,永不进 profile pack 同步
//   (profile.ts DENY_NAMES 已含)。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as config from './config.js';
import * as log from './log.js';
import { dshHome } from './tokenFile.js';

export type ConnectionKind = 'local' | 'remote';

/** 单个连接组。 */
export interface Connection {
  id: string;
  kind: ConnectionKind;
  name?: string;
  /** local:本机端口。 */
  port?: number;
  /** remote:访问 URL(https)。 */
  url?: string;
  /** remote:启动 token;可空 = 认证交给 Cloudflare Access 等外部机制。 */
  token?: string;
  /** remote:自定义认证头(对齐 dsh-vscode 的 dsh.extraHeaders)。 */
  extraHeaders?: Record<string, string>;
}

/** connections.json v1。 */
export interface ConnectionsFile {
  version: 1;
  active: string;
  connections: Connection[];
}

export const ConnectionsFileName = 'connections.json';
export const ChangedMarkerName = '.dsh-connection-changed';

export function connectionsPath(): string {
  return join(dshHome(), ConnectionsFileName);
}

export function changedMarkerPath(): string {
  return join(dshHome(), ChangedMarkerName);
}

// ---------------------------------------------------------------- 校验

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function failConn(why: string): never {
  throw new Error(`connections 校验失败：${why}`);
}

/** 单连接结构校验(kind 决定必填字段)。 */
export function validateConnection(c: unknown): asserts c is Connection {
  if (typeof c !== 'object' || c === null) failConn('连接不是对象');
  const x = c as Record<string, unknown>;
  if (typeof x.id !== 'string' || !ID_RE.test(x.id)) failConn(`id 非法（须为 [A-Za-z0-9_-]，收到 ${String(x.id)}）`);
  if (x.kind !== 'local' && x.kind !== 'remote') failConn(`${x.id}: kind 必须为 local|remote`);
  if (x.kind === 'local') {
    const port = x.port as unknown;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      failConn(`${x.id}: local 连接需要合法 port`);
    }
  } else {
    if (typeof x.url !== 'string' || !/^https?:\/\//i.test(x.url)) failConn(`${x.id}: remote 连接需要 http(s) url`);
    if (x.token !== undefined && typeof x.token !== 'string') failConn(`${x.id}: token 必须为字符串`);
    if (x.extraHeaders !== undefined && (typeof x.extraHeaders !== 'object' || x.extraHeaders === null)) {
      failConn(`${x.id}: extraHeaders 必须为对象`);
    }
  }
}

function validateFile(f: unknown): asserts f is ConnectionsFile {
  if (typeof f !== 'object' || f === null) failConn('文件不是对象');
  const x = f as Record<string, unknown>;
  if (x.version !== 1) failConn('version 必须为 1');
  if (!Array.isArray(x.connections) || x.connections.length === 0) failConn('connections 必须为非空数组');
  for (const c of x.connections) validateConnection(c);
  const ids = (x.connections as Connection[]).map((c) => c.id);
  if (new Set(ids).size !== ids.length) failConn('连接 id 重复');
  if (typeof x.active !== 'string' || !ids.includes(x.active)) failConn(`active 必须指向存在的连接（收到 ${String(x.active)}）`);
}

// ---------------------------------------------------------------- 读写

/** 读取 connections.json;缺失返回 undefined,损坏则告警并按缺失处理(不阻断启动)。 */
export function loadConnections(): ConnectionsFile | undefined {
  const p = connectionsPath();
  if (!existsSync(p)) return undefined;
  try {
    let data = readFileSync(p, 'utf8');
    if (data.charCodeAt(0) === 0xfeff) data = data.slice(1);
    const f = JSON.parse(data) as ConnectionsFile;
    validateFile(f);
    return f;
  } catch (e) {
    log.warn(`connections.json 读取/校验失败，忽略（${(e as Error).message}）`);
    return undefined;
  }
}

/** 原子写(D8 ④):临时文件 + rename 覆盖。 */
export function saveConnections(f: ConnectionsFile): void {
  validateFile(f);
  mkdirSync(dshHome(), { recursive: true });
  const target = connectionsPath();
  const tmp = `${target}.tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try {
    writeFileSync(tmp, JSON.stringify(f, null, 2) + '\n', 'utf8');
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** 无 connections.json 时按 launcher.json 合成默认本机连接(不落盘,向后兼容)。 */
export function synthFromConfig(cfg: config.Config | null): Connection {
  const port = cfg?.port ?? config.DefaultPort;
  return { id: `local-${port}`, kind: 'local', name: '本机 dsh', port };
}

/** 解析激活连接:connections.json 优先;否则按 launcher.json 合成。 */
export function resolveActive(cfg: config.Config | null): { conn: Connection; file?: ConnectionsFile } {
  const f = loadConnections();
  if (f && f.connections.length > 0) {
    const conn = f.connections.find((c) => c.id === f.active) ?? f.connections[0];
    return { conn, file: f };
  }
  return { conn: synthFromConfig(cfg) };
}

/** 全部连接(无文件时返回合成默认单条)。 */
export function listConnections(cfg: config.Config | null): Connection[] {
  const f = loadConnections();
  if (f) return f.connections;
  return [synthFromConfig(cfg)];
}

/** D8 ③:active 变更标记(消费端重连前检查)。 */
function touchChangedMarker(active: string): void {
  try {
    mkdirSync(dshHome(), { recursive: true });
    writeFileSync(
      changedMarkerPath(),
      JSON.stringify({ active, changedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
  } catch {
    /* 标记失败不致命 */
  }
}

/** 新增连接(幂等拒绝重复 id);首个连接自动成为 active。 */
export function addConnection(input: Connection): ConnectionsFile {
  validateConnection(input);
  const f = loadConnections() ?? { version: 1, active: input.id, connections: [] };
  if (f.connections.some((c) => c.id === input.id)) failConn(`连接 id 已存在：${input.id}（先 remove 再 add）`);
  f.connections.push(input);
  saveConnections(f);
  touchChangedMarker(f.active);
  return f;
}

/** 切换激活连接。 */
export function useConnection(id: string): ConnectionsFile {
  const f = loadConnections();
  if (!f) throw new Error('connections.json 不存在：先用 connections add 添加连接');
  if (!f.connections.some((c) => c.id === id)) {
    throw new Error(`连接不存在：${id}（可用：${f.connections.map((c) => c.id).join(', ')}）`);
  }
  f.active = id;
  saveConnections(f);
  touchChangedMarker(id);
  return f;
}

/** 删除连接;删除 active 时回退到第一个连接。 */
export function removeConnection(id: string): ConnectionsFile {
  const f = loadConnections();
  if (!f) throw new Error('connections.json 不存在');
  const idx = f.connections.findIndex((c) => c.id === id);
  if (idx < 0) throw new Error(`连接不存在：${id}`);
  f.connections.splice(idx, 1);
  if (f.active === id) {
    f.active = f.connections[0].id;
    touchChangedMarker(f.active);
  }
  saveConnections(f);
  return f;
}

// ---------------------------------------------------------------- D8 ② 端口锁

interface PortLock {
  pid: number;
  source: string;
  startedAt: string;
}

export function portLockPath(port: number): string {
  return join(dshHome(), `.dsh-port-${port}.lock`);
}

/** 进程是否存活。 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * spawn 前检查端口锁(D8 ②):
 *   - 他组监督者持有且进程存活 → 拒绝(防 token 误删/连接漂移竞态);
 *   - 自身 pid(currentPid)→ 放行(重入);
 *   - 陈旧锁(进程已死/损坏)→ 告警后放行,由 writePortLock 覆盖。
 */
export function checkPortLock(port: number, currentPid?: number): void {
  const p = portLockPath(port);
  if (!existsSync(p)) return;
  let lock: PortLock | undefined;
  try {
    lock = JSON.parse(readFileSync(p, 'utf8')) as PortLock;
  } catch {
    log.warn(`端口锁损坏，覆盖：${p}`);
    return;
  }
  if (typeof lock?.pid !== 'number' || lock.pid <= 0) return;
  if (currentPid !== undefined && lock.pid === currentPid) return;
  if (pidAlive(lock.pid)) {
    throw new Error(
      `端口 ${port} 已由其他监督者持有（PID ${lock.pid}，source=${lock.source ?? '?'}）。` +
        `如确认没有运行中的 dsh，请删除 ${p} 后重试（D8 端口锁）`,
    );
  }
  log.warn(`发现陈旧端口锁（端口 ${port}，PID ${lock.pid} 已退出），覆盖`);
}

/** 写端口锁(原子写)。 */
export function writePortLock(port: number, pid: number, source = 'dsh-launcher'): void {
  const lock: PortLock = { pid, source, startedAt: new Date().toISOString() };
  const p = portLockPath(port);
  const tmp = `${p}.tmp-${Math.floor(Math.random() * 1e6)}`;
  try {
    mkdirSync(dshHome(), { recursive: true });
    writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch (e) {
    rmSync(tmp, { force: true });
    log.warn(`端口锁写入失败（不阻断）：${(e as Error).message}`);
  }
}

/** 清理端口锁(退出/停止时)。 */
export function clearPortLock(port: number): void {
  try {
    rmSync(portLockPath(port), { force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- remote 工具

/** remote 连接的带 token 访问地址(纯函数,供测试):token 空则原样 url。 */
export function buildRemoteTarget(conn: Connection): string {
  if (conn.kind !== 'remote' || !conn.url) failConn('remote 连接需要 url');
  if (!conn.token) return conn.url;
  return conn.url + (conn.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(conn.token);
}
