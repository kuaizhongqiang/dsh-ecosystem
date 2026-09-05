// Window management: main window (connect page -> shared dsh Web UI), log and
// settings views. Renderer UI is served through the privileged `app://` scheme
// (out/renderer); the main window loads the shared dsh URL once connected.
import { BrowserWindow, app, protocol, shell } from 'electron'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(here, '..', 'renderer')
const preloadPath = join(app.getAppPath(), 'preload', 'index.mjs')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function dirname(p: string): string { return p.split(/[\\/]/).slice(0, -1).join('/') || '/' }

function registerAppProtocol(): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/' || pathname === '') pathname = '/ui.html'
    const file = normalize(join(rendererRoot, pathname))
    if (!file.startsWith(normalize(rendererRoot) + sep)) {
      return new Response('forbidden', { status: 403 })
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      return new Response('not found', { status: 404 })
    }
    const mime = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    return new Response(Readable.toWeb(createReadStream(file)) as unknown as BodyInit, {
      headers: { 'content-type': mime },
    })
  })
}

let mainWindow: BrowserWindow | null = null
let logWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

function webPreferences(): Electron.WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    webSecurity: true,
  }
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'dsh-desktop',
    icon: join(app.getAppPath(), 'assets', 'icon.ico'),
    webPreferences: webPreferences(),
  })
  mainWindow = win
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://') && !url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:')) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })
  win.on('closed', () => { mainWindow = null })
  win.once('ready-to-show', () => win.show())
  return win
}

/** Show the shell connect page (no shared server, busy, starting, or lost). */
export function showConnectPage(win: BrowserWindow | null, detail?: string): void {
  if (!win || win.isDestroyed()) return
  const query = detail ? `?view=connect&detail=${encodeURIComponent(detail)}` : '?view=connect'
  void win.loadURL(`app://renderer/ui.html${query}`)
}

export async function loadDshUrl(win: BrowserWindow | null, url: string): Promise<void> {
  if (!win || win.isDestroyed()) return
  try {
    await win.loadURL(url)
  } catch (err) {
    // shared server went away mid-load → back to the connect page
    showConnectPage(win, `加载 ${url} 失败：${(err as Error).message}`)
  }
}

export function openView(view: string): void {
  const opts: Electron.BrowserWindowConstructorOptions = {
    width: 760,
    height: 560,
    show: false,
    title: view === 'log' ? '日志' : '设置',
    webPreferences: webPreferences(),
  }
  if (view === 'log') {
    if (logWindow && !logWindow.isDestroyed()) { logWindow.focus(); return }
    logWindow = new BrowserWindow(opts)
    logWindow.on('closed', () => { logWindow = null })
    void logWindow.loadURL('app://renderer/ui.html?view=log')
    logWindow.once('ready-to-show', () => logWindow?.show())
  } else if (view === 'settings') {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return }
    settingsWindow = new BrowserWindow(opts)
    settingsWindow.on('closed', () => { settingsWindow = null })
    void settingsWindow.loadURL('app://renderer/ui.html?view=settings')
    settingsWindow.once('ready-to-show', () => settingsWindow?.show())
  }
}

export function getMainWindow(): BrowserWindow | null { return mainWindow }

export function broadcastEvent(ev: unknown): void {
  const targets = [mainWindow, logWindow, settingsWindow].filter(
    (w): w is BrowserWindow => !!w && !w.isDestroyed(),
  )
  for (const w of targets) w.webContents.send('app:event', ev)
}

export function initWindows(): void {
  app.whenReady().then(() => {
    registerAppProtocol()
  })
}
