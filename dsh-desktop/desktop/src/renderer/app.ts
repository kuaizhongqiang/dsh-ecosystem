// Renderer app for ui.html views: connect / log / settings.
// Talks to main only through window.dshApi (contextBridge).

interface LogEntry { id: number; ts: number; level: 'info' | 'warn' | 'error'; source: string; text: string }
interface Settings { port: number; dataDir: string; launcherPath: string; autoLaunch: boolean; closeToTray: boolean }
interface ConnectState {
  status: 'checking' | 'connected' | 'no-server' | 'busy' | 'starting'
  port: number
  baseUrl: string
  url: string | null
  detail?: string
  serverOwner?: string
}
interface ActionResult { ok: boolean; url?: string; error?: string }

interface DshApi {
  getState(): Promise<{ appVersion: string; connect: ConnectState; launcherPath: string; settings: Settings; updateEnabled: boolean; updateMode: 'github' | 'npm' }>
  onEvent(cb: (ev: unknown) => void): () => void
  getSettings(): Promise<Settings>
  setSettings(p: Partial<Settings>): Promise<Settings>
  chooseDirectory(): Promise<string | null>
  serverConnect(): Promise<ActionResult>
  serverStart(): Promise<ActionResult>
  serverStop(): Promise<ActionResult>
  serverOpenBrowser(): Promise<boolean>
  launcherOpen(): Promise<boolean>
  getLogs(): Promise<LogEntry[]>
  clearLogs(): Promise<boolean>
  exportLogs(): Promise<string | null>
  checkUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  openView(v: string): Promise<boolean>
  quitApp(): Promise<boolean>
}

declare global { interface Window { dshApi: DshApi } }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const q = new URLSearchParams(location.search)
const view = q.get('view') ?? 'connect'
let logsCache: LogEntry[] = []
let lastUpdatePhase = 'idle'
let updateVersion = ''

function show(viewName: string): void {
  for (const el of document.querySelectorAll<HTMLElement>('.view')) el.hidden = true
  const target = $(`view-${viewName}`)
  if (target) target.hidden = false
}

function logLine(entry: LogEntry): string {
  const t = new Date(entry.ts).toLocaleTimeString()
  return `[${t}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.text}`
}

const STATUS_LABEL: Record<ConnectState['status'], string> = {
  checking: '正在检测共享 dsh server…',
  connected: '已连接到 dsh server',
  'no-server': '未检测到 dsh server',
  busy: '端口被其他进程占用',
  starting: '正在通过 dsh-launcher 启动服务…',
}

// ── connect view ──
let lastLauncherPath = ''
function initConnectView(): void {
  const statusEl = $('connect-status')
  const detailEl = $('connect-detail')
  const metaEl = $('connect-meta')

  const render = (s: ConnectState, launcherPath: string): void => {
    statusEl.textContent = STATUS_LABEL[s.status] ?? s.status
    statusEl.className = `connect-status ${s.status}`
    detailEl.textContent = s.detail ?? ''
    const rows: string[] = []
    rows.push(`<div class="env-row"><span>端口</span><span class="muted">${s.port}（${s.baseUrl}）</span></div>`)
    if (s.status === 'connected' && s.url) {
      rows.push(`<div class="env-row ok"><span>服务地址</span><span class="muted">${s.url}</span></div>`)
    }
    if (s.serverOwner) {
      rows.push(`<div class="env-row"><span>服务持有者</span><span class="muted">${s.serverOwner}（先启动的一端）</span></div>`)
    }
    rows.push(`<div class="env-row"><span>dsh-launcher</span><span class="muted">${launcherPath || '未找到（自动查找）'}</span></div>`)
    metaEl.innerHTML = rows.join('')

    $('btn-start').hidden = s.status !== 'no-server'
    $('btn-reconnect').hidden = s.status === 'connected'
    $('btn-stop').hidden = s.status !== 'connected'
    $('btn-open-browser').hidden = !(s.url || s.baseUrl)
  }

  void window.dshApi.getState().then((s) => {
    lastLauncherPath = s.launcherPath
    render(s.connect, s.launcherPath)
    // main drives connect() itself; we only render the state it pushes.
  })
  $('btn-start').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('btn-start')
    btn.disabled = true
    statusEl.textContent = STATUS_LABEL.starting
    const res = await window.dshApi.serverStart()
    if (!res.ok) {
      detailEl.textContent = res.error ?? ''
      btn.disabled = false
    }
    // on success main navigates this window to the dsh UI
  })
  $('btn-reconnect').addEventListener('click', () => { void window.dshApi.serverConnect() })
  $('btn-stop').addEventListener('click', () => { void window.dshApi.serverStop() })
  $('btn-open-browser').addEventListener('click', () => { void window.dshApi.serverOpenBrowser() })
  $('btn-open-launcher').addEventListener('click', () => { void window.dshApi.launcherOpen() })

  window.dshApi.onEvent((ev) => {
    const e = ev as { type: string; state?: ConnectState }
    if (e.type === 'connect' && e.state) render(e.state, lastLauncherPath)
  })
}

// ── log view ──
function initLogView(): void {
  const out = $<HTMLPreElement>('log-output')
  const autoscroll = $<HTMLInputElement>('log-autoscroll')
  const renderAll = (): void => {
    out.textContent = logsCache.map(logLine).join('\n')
    if (autoscroll.checked) out.scrollTop = out.scrollHeight
  }
  void window.dshApi.getLogs().then((entries) => { logsCache = entries; renderAll() })
  $('btn-log-clear').addEventListener('click', () => { void window.dshApi.clearLogs().then(() => { logsCache = []; renderAll() }) })
  $('btn-log-export').addEventListener('click', async () => {
    const p = await window.dshApi.exportLogs()
    if (p) alert(`日志已导出：${p}`)
  })
  window.dshApi.onEvent((ev) => {
    const e = ev as { type: string; entry?: LogEntry }
    if (e.type === 'log' && e.entry) { logsCache.push(e.entry); renderAll() }
  })
}

// ── settings view ──
function initSettingsView(): void {
  const form = $<HTMLFormElement>('settings-form')
  void window.dshApi.getSettings().then((s) => {
    $<HTMLInputElement>('set-port').value = String(s.port)
    $<HTMLInputElement>('set-close-tray').checked = s.closeToTray
    $<HTMLInputElement>('set-autolaunch').checked = s.autoLaunch
    $<HTMLInputElement>('set-datadir').value = s.dataDir
    $<HTMLInputElement>('set-launcher').value = s.launcherPath
  })
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const patch: Partial<Settings> = {
      port: Number($<HTMLInputElement>('set-port').value) || 3080,
      closeToTray: $<HTMLInputElement>('set-close-tray').checked,
      autoLaunch: $<HTMLInputElement>('set-autolaunch').checked,
      dataDir: $<HTMLInputElement>('set-datadir').value.trim(),
      launcherPath: $<HTMLInputElement>('set-launcher').value.trim(),
    }
    await window.dshApi.setSettings(patch)
    const saved = $('settings-saved')
    saved.hidden = false
    setTimeout(() => { saved.hidden = true }, 1500)
  })
  $('btn-browse-datadir').addEventListener('click', async () => {
    const dir = await window.dshApi.chooseDirectory()
    if (dir) $<HTMLInputElement>('set-datadir').value = dir
  })
  $('btn-browse-launcher').addEventListener('click', async () => {
    const dir = await window.dshApi.chooseDirectory()
    if (dir) $<HTMLInputElement>('set-launcher').value = dir
  })
  $('btn-update-check').addEventListener('click', () => void window.dshApi.checkUpdates())
  $('btn-update-download').addEventListener('click', () => {
    if (updateMode === 'npm') {
      if (confirm(`将关闭应用并通过 npm 更新到 ${updateVersion}，更新完成后自动重启。继续？`)) {
        void window.dshApi.downloadUpdate()
      }
    } else {
      void window.dshApi.downloadUpdate()
    }
  })
  $('btn-update-install').addEventListener('click', () => void window.dshApi.installUpdate())
  void window.dshApi.getState().then((s) => {
    updateMode = s.updateMode
    renderUpdateStatus()
  })
  renderUpdateStatus()
}

let updateMode: 'github' | 'npm' = 'github'

function renderUpdateStatus(): void {
  const el = $('update-status')
  const dl = $('btn-update-download')
  const inst = $('btn-update-install')
  const map: Record<string, string> = {
    idle: '未检查', checking: '检查中…', 'not-available': '已是最新版本',
    available: `发现新版本 ${updateVersion}`, downloaded: `更新已下载（${updateVersion}）`,
    updating: '正在更新，应用将自动关闭并重启…',
    error: '更新检查失败',
  }
  el.textContent = map[lastUpdatePhase] ?? lastUpdatePhase
  if (updateMode === 'npm') {
    // npm channel: one click does install + restart (downloadUpdate performs it)
    dl.textContent = '立即更新并重启（npm）'
    dl.hidden = lastUpdatePhase !== 'available'
    inst.hidden = true
  } else {
    dl.textContent = '下载更新'
    dl.hidden = lastUpdatePhase !== 'available'
    inst.hidden = lastUpdatePhase !== 'downloaded'
  }
}

// ── global wiring ──
function init(): void {
  show(view)
  void window.dshApi.getState().then((s) => {
    $('server-badge').textContent = `server: ${s.connect.status}`
    $('foot-server').textContent = s.connect.url
      ? `dsh: ${s.connect.url}`
      : s.connect.baseUrl
        ? `dsh: ${s.connect.baseUrl}`
        : ''
  })
  window.dshApi.onEvent((ev) => {
    const e = ev as { type: string; state?: ConnectState; status?: { phase: string; version?: string } }
    if (e.type === 'connect' && e.state) {
      $('server-badge').textContent = `server: ${e.state.status}`
      $('foot-server').textContent = e.state.url ?? e.state.baseUrl ?? ''
    }
    if (e.type === 'update' && e.status) {
      if (e.status.version) updateVersion = e.status.version
      lastUpdatePhase = e.status.phase
      renderUpdateStatus()
      const foot = $('foot-update')
      if (lastUpdatePhase === 'downloaded') foot.textContent = `更新就绪 ${updateVersion}，可在设置页重启安装`
      else if (lastUpdatePhase === 'available') foot.textContent = `发现新版本 ${updateVersion}（设置页可更新）`
      else if (lastUpdatePhase === 'updating') foot.textContent = '正在更新…'
      else foot.textContent = ''
    }
  })
  $('btn-logs').addEventListener('click', () => void window.dshApi.openView('log'))
  $('btn-settings').addEventListener('click', () => void window.dshApi.openView('settings'))
}

if (view === 'log') initLogView()
else if (view === 'settings') initSettingsView()
else initConnectView()
init()
