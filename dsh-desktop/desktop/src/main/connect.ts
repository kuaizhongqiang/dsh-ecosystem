// Shared-server connect logic for the pure-shell desktop.
//
// The desktop never spawns dsh. It connects to the shared dsh server (default
// http://127.0.0.1:3080) that was started by dsh-launcher, dsh-vscode or
// `dsh web` — whoever started first owns the process. Detection mirrors
// dsh-vscode's localServer preflight: port listening + dsh answering = reuse;
// port busy by a non-dsh process = explicit error; port free = "start it"
// (delegated to dsh-launcher, never spawned here).
//
// Authentication reuses the shared launch-token file ($DSH_HOME/launch-token.json,
// spec shared with dsh-launcher / dsh-vscode): the writer (whoever spawned dsh)
// persists the token; we read it to build the `/?token=...` URL that mints the
// 30-day session cookie for the embedded window.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HEALTH_FAIL_LIMIT, HEALTH_INTERVAL_MS, LAUNCH_TOKEN_FILE } from './constants.js'
import { logs } from './log-store.js'

export type ConnectStatus = 'checking' | 'connected' | 'no-server' | 'busy' | 'starting'

export interface ConnectState {
  status: ConnectStatus
  port: number
  /** Base server URL (no token), e.g. http://127.0.0.1:3080/ */
  baseUrl: string
  /** URL the window should load (token URL when available). */
  url: string | null
  detail?: string
  /** Who wrote the launch-token file (dsh-launcher / dsh-vscode) — "server owner". */
  serverOwner?: string
}

// ---- DSH_HOME / shared token file (same rules as dsh-launcher & dsh-vscode) ----

export function dshHome(dataDir: string): string {
  const dir = dataDir.trim()
  if (dir) return dir
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function launchTokenFilePath(dataDir: string): string {
  return join(dshHome(dataDir), LAUNCH_TOKEN_FILE)
}

export interface LaunchTokenRecord {
  version: number
  token: string
  port?: number
  url: string
  pid?: number
  writtenAt: string
  source: string
}

/** Read the shared token file; missing / corrupt / wrong version → undefined. */
export function readLaunchToken(dataDir: string): LaunchTokenRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(launchTokenFilePath(dataDir), 'utf8')) as LaunchTokenRecord
    if (record.version !== 1) return undefined
    if (typeof record.token !== 'string' || record.token.length === 0) return undefined
    if (typeof record.url !== 'string' || record.url.length === 0) return undefined
    return record
  } catch {
    return undefined
  }
}

// ---- preflight ----

export function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}/`
}

/** Is anything listening on 127.0.0.1:port? */
export function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    const done = (v: boolean): void => { sock.destroy(); resolve(v) }
    sock.setTimeout(800)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

export type PreflightResult =
  | { mode: 'dsh'; port: number }
  | { mode: 'busy'; port: number; detail: string }
  | { mode: 'free'; port: number }

/**
 * Probe the configured port:
 * - listening + dsh answers (GET / returns any HTTP status incl. 401 = needs
 *   token, or 3xx/200) → 'dsh' (reuse)
 * - listening but not dsh → 'busy' (explicit error, never spawn on top)
 * - not listening → 'free' (offer to start via dsh-launcher)
 */
export async function preflight(port: number): Promise<PreflightResult> {
  if (!(await portListening(port))) return { mode: 'free', port }
  const url = baseUrl(port)
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
    // 401 = dsh present but needs session cookie (new auth); 2xx/3xx = reachable.
    if (res.status === 401 || (res.status >= 200 && res.status < 500)) {
      return { mode: 'dsh', port }
    }
    return { mode: 'busy', port, detail: `端口 ${port} 上的服务返回 HTTP ${res.status}，不是可用的 dsh 服务。` }
  } catch {
    return { mode: 'busy', port, detail: `端口 ${port} 已被其他进程占用，但不是 dsh 服务。请先释放该端口。` }
  }
}

// ---- token URL resolution ----

async function verifyTokenUrl(target: string): Promise<'ok' | 'invalid' | 'unreachable'> {
  try {
    const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
    if (res.status === 303 || res.status === 302 || res.status === 200) return 'ok'
    if (res.status === 401) return 'invalid'
    return res.status < 500 ? 'invalid' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

/**
 * Build the URL the embedded window should load:
 * 1. shared token file (if any) → verify `/?token=` URL against the live server
 *    (303/200 = valid, 401 = stale) → use it when valid;
 * 2. otherwise fall back to the plain base URL (old dsh without token auth,
 *    or server not yet authenticated — the UI will handle it).
 *
 * `waitMs > 0` polls for a *valid* token (dsh-launcher writes the shared file a
 * moment AFTER the port answers — spawn → ready → token-in-logs → file write),
 * so a server just started via the launcher is not loaded without its token.
 */
export async function resolveTokenUrl(port: number, dataDir: string, waitMs = 0): Promise<string> {
  const base = baseUrl(port)
  const deadline = Date.now() + waitMs
  for (;;) {
    const record = readLaunchToken(dataDir)
    if (record) {
      if (record.port !== undefined && record.port !== port) {
        logs.warn('connect', `launch-token.json 记录的端口 ${record.port} 与当前 ${port} 不一致，忽略`)
      } else {
        const verdict = await verifyTokenUrl(record.url)
        if (verdict === 'ok') return record.url
        if (verdict === 'invalid') {
          logs.warn('connect', '共享 token 已失效（服务可能重启轮换了 token），等待新 token 写入…')
        }
        // 'unreachable' → transient; keep polling while within waitMs
      }
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 300))
  }
  const record = readLaunchToken(dataDir)
  if (record) {
    const verdict = await verifyTokenUrl(record.url)
    if (verdict === 'ok') return record.url
    if (verdict === 'invalid') logs.warn('connect', '共享 token 无效，改用普通 URL')
  }
  return base
}

// ---- health monitor ----

/** Emits 'lost' after HEALTH_FAIL_LIMIT consecutive failed probes. */
export class ServerMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private fails = 0
  private active = false

  start(url: string): void {
    if (this.active) return
    this.active = true
    this.fails = 0
    this.timer = setInterval(() => {
      void (async () => {
        if (!this.active) return
        const ok = await this.probe(url)
        if (ok) { this.fails = 0; return }
        this.fails += 1
        if (this.fails >= HEALTH_FAIL_LIMIT) {
          logs.warn('connect', `health probe failed ${this.fails}/${HEALTH_FAIL_LIMIT}; server lost`)
          this.stop()
          this.emit('lost')
        }
      })()
    }, HEALTH_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    this.active = false
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async probe(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
      return res.status === 401 || (res.status >= 200 && res.status < 500)
    } catch {
      return false
    }
  }
}
