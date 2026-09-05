// ShellController: wires connect.ts + launcher.ts + windows.ts into the app
// flow. The desktop is a pure shell — it connects to the shared dsh server
// (started by dsh-launcher / dsh-vscode / `dsh web`) and never spawns dsh.
import { shell } from 'electron'
import { spawn } from 'node:child_process'
import {
  baseUrl, preflight, readLaunchToken, resolveTokenUrl, ServerMonitor,
  type ConnectState, type ConnectStatus,
} from './connect.js'
import { DEFAULT_PORT } from './constants.js'
import { findLauncher, startServerViaLauncher, stopServerViaLauncher } from './launcher.js'
import { logs } from './log-store.js'
import { getSettings } from './settings.js'
import { getMainWindow, loadDshUrl, showConnectPage } from './windows.js'

export interface ActionResult {
  ok: boolean
  url?: string
  error?: string
}

export class ShellController {
  private state: ConnectState = {
    status: 'checking',
    port: DEFAULT_PORT,
    baseUrl: baseUrl(DEFAULT_PORT),
    url: null,
  }
  private readonly monitor = new ServerMonitor()
  private readonly listeners = new Set<() => void>()
  private navigated = false

  constructor() {
    this.monitor.on('lost', () => {
      logs.warn('connect', 'shared server lost; returning to connect page')
      this.setStatus('no-server', 'dsh server 已停止（可能由 dsh-launcher / 其他端关闭）。点击「重连」或「启动服务」。')
      showConnectPage(getMainWindow(), 'dsh server 已停止，正在返回连接页…')
    })
  }

  getState(): ConnectState { return this.state }

  onChanged(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  launcherPath(): string { return findLauncher() }

  private setStatus(status: ConnectStatus, detail?: string): void {
    this.state = {
      ...this.state,
      status,
      detail,
      url: status === 'connected' ? this.state.url : null,
    }
    for (const cb of [...this.listeners]) {
      try { cb() } catch { /* never let a listener break the controller */ }
    }
  }

  /**
   * Preflight the shared server and, when it answers dsh, load its UI in the
   * main window (with the shared launch token when valid). Never spawns dsh.
   *
   * `waitForToken`: when we just started the server via dsh-launcher, the
   * launcher writes launch-token.json a moment after the port answers — wait
   * briefly so the window opens with a valid token URL instead of the
   * authentication-required page.
   */
  async connect(waitForToken = false): Promise<ActionResult> {
    const s = getSettings()
    this.setStatus('checking')
    const result = await preflight(s.port)

    if (result.mode === 'dsh') {
      const url = await resolveTokenUrl(s.port, s.dataDir, waitForToken ? 10_000 : 0)
      const record = readLaunchToken(s.dataDir)
      this.state = {
        status: 'connected',
        port: s.port,
        baseUrl: baseUrl(s.port),
        url,
        serverOwner: record?.source,
      }
      for (const cb of [...this.listeners]) {
        try { cb() } catch { /* ignore */ }
      }
      this.monitor.start(url)
      logs.info('connect', `connected to shared dsh server: ${url}${record ? ` (owner=${record.source})` : ''}`)
      this.navigated = true
      await loadDshUrl(getMainWindow(), url)
      return { ok: true, url }
    }

    if (result.mode === 'busy') {
      this.setStatus('busy', result.detail)
      this.navigated = true
      showConnectPage(getMainWindow(), result.detail)
      return { ok: false, error: result.detail }
    }

    // free → show the connect page with a "start" action (delegated to launcher)
    this.setStatus('no-server')
    this.navigated = true
    showConnectPage(getMainWindow())
    return { ok: false, error: '端口上未检测到 dsh server' }
  }

  /** Delegate server start to dsh-launcher, wait for readiness, then connect. */
  async start(): Promise<ActionResult> {
    const s = getSettings()
    this.setStatus('starting')
    showConnectPage(getMainWindow(), '正在通过 dsh-launcher 启动服务…')
    const res = await startServerViaLauncher()
    if (!res.ok) {
      this.setStatus('no-server', res.error)
      showConnectPage(getMainWindow(), res.error)
      return res
    }
    logs.info('connect', `server started via launcher on port ${s.port}`)
    return this.connect(true)
  }

  /** Delegate server stop to dsh-launcher. */
  async stop(): Promise<ActionResult> {
    const res = await stopServerViaLauncher()
    this.monitor.stop()
    this.setStatus('no-server', res.ok ? undefined : res.error)
    showConnectPage(getMainWindow(), res.ok ? undefined : res.error)
    return res
  }

  openInBrowser(): void {
    const target = this.state.url ?? this.state.baseUrl
    void shell.openExternal(target)
  }

  openLauncher(): void {
    const exe = findLauncher()
    if (!exe) {
      logs.warn('launcher', 'openLauncher: launcher not found')
      return
    }
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    } catch (err) {
      logs.error('launcher', `openLauncher failed: ${(err as Error).message}`)
    }
  }

  /** True once the controller has driven the window (connect page or dsh UI). */
  hasNavigated(): boolean { return this.navigated }
}
