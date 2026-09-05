/**
 * Local DSH service manager: spawns `dsh web` under a configured directory,
 * waits until it answers RPC, and guarantees the child is killed on stop /
 * extension exit (no orphan processes). Powers the "拉起服务" sidebar entry
 * and the local mode of the settings page.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { join } from 'node:path'
import { DshRpcClient, DshTransportError } from './client/rpc.ts'
import { clearLaunchToken, launchTokenFilePath, redactTokenUrl, tokenFromUrl, tokenUrlFromLogs, writeLaunchToken } from './launchToken.ts'

export type LocalServiceStatus = 'stopped' | 'starting' | 'running' | 'failed'

export interface ValidateResult {
  ok: boolean
  /** 校验失败时的中文原因（ok=false 时）。 */
  error?: string
}

/**
 * 校验本地服务路径（dsh.localServerPath）：应是一个目录，且包含 dsh 启动器
 * （dsh / dsh.cmd / dsh.exe / dsh-launcher.exe / launcher.json）。
 */
export function validateLocalServerPath(path: string): ValidateResult {
  const trimmed = (path ?? '').trim()
  if (trimmed.length === 0) {
    return { ok: false, error: '路径为空' }
  }
  if (!existsSync(trimmed)) {
    return { ok: false, error: `路径不存在：${trimmed}` }
  }
  if (!statSync(trimmed).isDirectory()) {
    return { ok: false, error: `不是目录（应为 dsh 安装根目录，而不是某个文件）：${trimmed}` }
  }
  const launchers = ['dsh', 'dsh.cmd', 'dsh.exe', 'dsh-launcher.exe', 'launcher.json']
  const found = launchers.some((name) => existsSync(join(trimmed, name)))
  if (!found) {
    return {
      ok: false,
      error: `目录中未找到 dsh 启动器（${launchers.join(' / ')}）。请选择 dsh 安装根目录，例如 Windows 的 D:\\dsh 或 macOS/Linux 的 ~/dsh（即运行 \`dsh web\` 时所在的目录，而不是 dsh 数据目录或 node_modules）。`,
    }
  }
  return { ok: true }
}

export interface LocalServiceState {
  status: LocalServiceStatus
  /** 子进程 PID（starting / running 时有）。 */
  pid?: number
  /** 服务实际监听端口（就绪后确定）。 */
  port?: number
  /** 服务实际 base URL（就绪后确定）。 */
  url?: string
  /** 最近日志行（环形缓冲，最多 MAX_LOG_LINES 行）。 */
  logs: string[]
  /** 失败原因（status=failed 时）。 */
  error?: string
  /** 启动时使用的目录。 */
  cwd?: string
  /** true = 未拉起新进程，直接复用了端口上已有的 DSH 实例。 */
  reused?: boolean
}

const MAX_LOG_LINES = 80
const READY_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 500
const CALL_TIMEOUT_MS = 2_000
const DEFAULT_PORT = 3080
const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`
const URL_RE = /https?:\/\/127\.0\.0\.1:\d+/g

export class LocalServerManager {
  private child: ChildProcess | undefined
  private state: LocalServiceState = { status: 'stopped', logs: [] }
  private readonly listeners = new Set<() => void>()
  private readonly extraHeaders: () => Record<string, string>
  private disposed = false
  /** 子进程原始输出的滚动缓冲（未脱敏，仅用于提取带 token 的启动 URL）。 */
  private rawOutputTail = ''
  /** 尚未以换行结束的半行日志（补齐后再脱敏输出，防 token 值被 chunk 截断）。 */
  private pendingLogLine = ''

  constructor(extraHeaders: () => Record<string, string>) {
    this.extraHeaders = extraHeaders
  }

  getState(): LocalServiceState {
    return this.state
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Ensure a local `dsh web` process is running under `cwd` and ready to serve
   * RPC. Resolves with the ready base URL. Rejects on spawn failure / timeout.
   *
   * Idempotent: if the configured port already answers DSH RPC (an instance is
   * already running), it is reused instead of spawning a duplicate that would
   * die with EADDRINUSE.
   */
  async start(cwd: string): Promise<{ url: string; reused?: boolean }> {
    const validation = validateLocalServerPath(cwd)
    if (!validation.ok) {
      this.setState({ ...this.state, status: 'failed', error: validation.error, logs: [validation.error ?? ''] })
      throw new Error(validation.error)
    }
    if (this.state.status === 'running' && this.child !== undefined) {
      return { url: this.state.url ?? DEFAULT_URL, reused: this.state.reused }
    }
    if (this.state.status === 'starting') {
      return this.waitUntilReady()
    }

    // 预检端口：已有 DSH 实例 → 直接复用（不重复拉起，避免 EADDRINUSE）；
    // 端口被非 DSH 进程占用 → 明确报错。
    const preflight = await this.preflight()
    if (preflight.mode === 'reuse') {
      this.setState({
        ...this.state,
        status: 'running',
        url: preflight.url,
        port: portOf(preflight.url),
        pid: undefined,
        error: undefined,
        reused: true,
        cwd,
      })
      this.appendLog(`检测到已有 DSH 实例 ${preflight.url}，直接复用（未重新拉起进程）`)
      return { url: preflight.url, reused: true }
    }
    if (preflight.mode === 'busy') {
      this.setState({ ...this.state, status: 'failed', error: preflight.error, logs: [preflight.error] })
      throw new Error(preflight.error)
    }

    this.stop()

    this.setState({
      status: 'starting',
      pid: undefined,
      port: undefined,
      url: undefined,
      error: undefined,
      logs: [],
      cwd,
    })
    this.appendLog(`启动本地 DSH 服务：dsh web（cwd=${cwd}）`)

    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn('dsh.cmd', ['web'], { cwd, shell: true, windowsHide: true })
      : spawn('dsh', ['web'], { cwd, windowsHide: true })

    this.child = child
    this.setState({ ...this.state, pid: child.pid })

    child.stdout?.on('data', (chunk: Buffer) => this.handleChildOutput(String(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => this.handleChildOutput(String(chunk)))
    child.on('error', (error) => {
      this.appendLog(`启动失败：${error.message}`)
      this.fail(`无法启动 dsh 进程：${error.message}`)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return // 已被 stop() 替换
      this.child = undefined
      // dsh 进程已退出：其 launch token 随之失效，清理共享 token 文件（source+pid 双匹配才删）。
      clearLaunchToken('dsh-vscode', child.pid)
      if (this.state.status === 'starting') {
        this.appendLog(`进程提前退出：code=${code ?? ''} signal=${signal ?? ''}`)
        this.fail(`本地 dsh web 进程提前退出（exit=${code ?? signal ?? 'unknown'}），请检查日志`)
      } else if (this.state.status === 'running') {
        this.appendLog('进程已退出')
        this.setState({ ...this.state, status: 'stopped', pid: undefined, port: undefined, url: undefined })
      }
    })

    try {
      return await this.waitUntilReady()
    } catch (error) {
      // 超时或就绪检查失败：终止进程，避免残留。
      this.killChild()
      throw error
    }
  }

  stop(): void {
    this.killChild()
    this.setState({ ...this.state, status: 'stopped', pid: undefined, port: undefined, url: undefined, error: undefined })
    this.appendLog('本地服务已停止')
  }

  dispose(): void {
    this.disposed = true
    this.killChild()
    this.listeners.clear()
  }

  // ---- Internals ----

  /**
   * 检查默认端口（3080，dsh web 的固定监听端口）：
   * - 端口上已有可用 DSH 实例 → 复用（不重复拉起，避免 EADDRINUSE）
   * - 端口被非 DSH 进程占用 → 报错（拉起必然失败）
   * - 端口空闲 → 允许拉起新进程
   *
   * 注意：`dsh web` 实际绑定的是 profile 默认端口 3080，与 launcher.json
   * 的 port 字段无关（那是 dsh-launcher 托盘程序的配置）。
   */
  private async preflight(): Promise<
    { mode: 'reuse'; url: string } | { mode: 'busy'; port: number; error: string } | { mode: 'free'; port: number }
  > {
    if (await isPortListening(DEFAULT_PORT)) {
      if (await this.ping(DEFAULT_URL)) {
        return { mode: 'reuse', url: DEFAULT_URL }
      }
      return {
        mode: 'busy',
        port: DEFAULT_PORT,
        error: `端口 ${DEFAULT_PORT} 已被其他进程占用（不是可用的 DSH 服务）。请先停止占用端口的进程，或在「进入配置」中检查 dsh.localServerPath；若 DSH 正在启动中，请稍后重试。`,
      }
    }
    return { mode: 'free', port: DEFAULT_PORT }
  }

  private async waitUntilReady(): Promise<{ url: string }> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    let detectedUrl: string | undefined
    const tryUrls = (): string[] => {
      const urls = new Set<string>()
      if (detectedUrl !== undefined) urls.add(detectedUrl)
      const fromLogs = this.state.logs.join('\n').match(URL_RE)
      for (const m of fromLogs ?? []) urls.add(m)
      urls.add(DEFAULT_URL)
      return [...urls]
    }
    while (Date.now() < deadline) {
      if (this.state.status === 'failed') throw new Error(this.state.error ?? '本地服务启动失败')
      if (this.child === undefined && this.state.status !== 'running') {
        throw new Error(this.state.error ?? '本地 dsh web 进程已退出')
      }
      const urls = tryUrls()
      for (const url of urls) {
        if (await this.ping(url)) {
          // 只认本进程拉起的实例：spawn 的进程还活着才算就绪，
          // 避免端口被预先存在的其他实例占用时误判为"拉起成功"。
          if (this.child === undefined || this.child.exitCode !== null) {
            this.appendLog(`端口上的服务并非本次启动的进程（本进程已退出），忽略 ${url}`)
            break
          }
          this.setState({
            ...this.state,
            status: 'running',
            url,
            port: portOf(url),
            reused: false,
          })
          this.appendLog(`本地服务就绪：${url}`)
          // dsh 打印 token URL 与端口就绪几乎同时；等几秒确保原始输出里能取到，
          // 再写入共享 token 文件（供 dsh-launcher 等应用读取，避免手动抄 token）。
          const tokenUrl = await this.waitForTokenFromLogs(3_000)
          if (tokenUrl !== undefined) {
            this.persistLaunchToken(tokenUrl)
          }
          return { url }
        }
      }
      await sleep(POLL_INTERVAL_MS)
    }
    this.appendLog('等待本地服务就绪超时')
    throw new Error(`本地 dsh web 在 ${READY_TIMEOUT_MS / 1000}s 内未就绪。请检查 dsh.localServerPath 是否正确，以及服务日志。`)
  }

  /** Probe the server with a real RPC call; any DSH /api answer counts as up. */
  private async ping(url: string): Promise<boolean> {
    const rpc = new DshRpcClient(url, this.extraHeaders())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
    try {
      // 新版 DSH 移除了 host.describe，用 session/list 探测。
      await rpc.call<unknown>('session/list', { _request: {} }, controller.signal)
      return true
    } catch (error) {
      // HTTP 401 = 端口上是 DSH，只是未带会话 cookie（本地也需要 token）。
      // 这也证明该端口被 DSH 占用 → 应复用，而非报"被其他进程占用"。
      if (error instanceof DshTransportError && error.status === 401) return true
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  private fail(error: string): void {
    // 附上最近几条日志（如 EADDRINUSE 堆栈首行），方便直接定位原因。
    const tail = this.state.logs.slice(-4).map((l) => l.trim()).filter((l) => l.length > 0).join('\n')
    const full = tail.length > 0 ? `${error}\n${tail}` : error
    this.setState({ ...this.state, status: 'failed', error: full })
  }

  /**
   * 处理 dsh 子进程的一截输出：
   * 1. 追加到原始滚动缓冲（供 token URL 提取，避免日志脱敏后无法取到 token）；
   * 2. 按完整行脱敏后进日志缓冲，避免 token 值被 chunk 边界截断泄漏明文
   *    （红线：日志与 UI 中一律脱敏为 token=***）。
   */
  private handleChildOutput(text: string): void {
    this.rawOutputTail = (this.rawOutputTail + text).slice(-256 * 1024)
    const pending = (this.pendingLogLine + text).split('\n')
    this.pendingLogLine = pending.pop() ?? ''
    for (const line of pending) this.appendLog(redactTokenUrl(line))
    // 无换行的极长输出兜底：强制处理并丢弃积压，避免内存增长。
    if (this.pendingLogLine.length > 64 * 1024) {
      this.appendLog(redactTokenUrl(this.pendingLogLine))
      this.pendingLogLine = ''
    }
  }

  /**
   * 等待子进程原始输出出现带 token 的 URL（dsh 打印 token 行与端口就绪之间有
   * 毫秒级间隔，直接读可能拿不到）。
   */
  private async waitForTokenFromLogs(timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs
    let last: string | undefined
    while (Date.now() < deadline) {
      last = tokenUrlFromLogs(this.rawOutputTail)
      if (last !== undefined) return last
      await sleep(150)
    }
    return last
  }

  /** 把本次拉起的 dsh 的 launch token 写入共享文件（供 dsh-launcher 等应用读取）。 */
  private persistLaunchToken(tokenUrl: string): void {
    const pid = this.child?.pid
    if (pid === undefined) return
    const token = tokenFromUrl(tokenUrl)
    if (token === undefined) return
    writeLaunchToken({ token, url: tokenUrl, port: this.state.port, pid, source: 'dsh-vscode' })
    this.appendLog(`已写入共享 token 文件 ${launchTokenFilePath()}（供 dsh-launcher 等应用读取）`)
  }

  private killChild(): void {
    const child = this.child
    this.child = undefined
    if (child === undefined || child.pid === undefined) return
    // 本进程拉起的 dsh 被停止：其 launch token 随之失效，清理共享文件（source+pid 双匹配才删）。
    clearLaunchToken('dsh-vscode', child.pid)
    if (child.exitCode !== null || child.signalCode !== null) return // 已退出
    if (process.platform === 'win32') {
      // Windows 下杀整个进程树，避免残留子进程。
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        return
      } catch {
        // fall through to plain kill
      }
    }
    try {
      child.kill()
    } catch {
      // ignore
    }
  }

  private appendLog(line: string): void {
    const trimmed = line.replace(/\r/g, '').trimEnd()
    if (trimmed.length === 0) return
    const logs = [...this.state.logs, ...trimmed.split('\n')].slice(-MAX_LOG_LINES)
    this.setState({ ...this.state, logs })
  }

  private setState(state: LocalServiceState): void {
    if (this.disposed) return
    this.state = state
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // never let a listener break the manager
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 探测 127.0.0.1:port 是否已有进程监听（不区分是不是 DSH）。 */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host: '127.0.0.1' })
    const done = (result: boolean): void => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 从 base URL 提取端口；解析失败返回 undefined。 */
function portOf(url: string): number | undefined {
  try {
    const port = new URL(url).port
    return port.length > 0 ? Number(port) : undefined
  } catch {
    return undefined
  }
}
