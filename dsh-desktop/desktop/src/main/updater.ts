// Unified auto-update: GitHub-installed builds update via electron-updater
// (latest.yml on the GitHub Release feed); npm-installed / dev runs update by
// re-running `npm i -g @kuaizhongqiang/dsh-desktop` through a detached helper
// that waits for this app to exit (unlocking files), installs, then relaunches.
//
// Flow (both channels): check on startup → if a newer version exists the UI
// shows it → user clicks update → download/install → app closes and restarts.
import { app } from 'electron'
import updaterPkg from 'electron-updater'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ID } from './constants.js'
import { logs } from './log-store.js'

const { autoUpdater } = updaterPkg

export type UpdateMode = 'github' | 'npm'
export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'not-available' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'updating' }
  | { phase: 'error'; message: string }

type StatusListener = (s: UpdateStatus) => void

const listeners = new Set<StatusListener>()
let current: UpdateStatus = { phase: 'idle' }
/** Latest available version seen (npm mode uses it when the user clicks update). */
let availableVersion: string | null = null

export const NPM_PACKAGE = '@kuaizhongqiang/dsh-desktop'

export function onUpdateStatus(cb: StatusListener): () => void {
  listeners.add(cb)
  cb(current)
  return () => listeners.delete(cb)
}

function set(s: UpdateStatus): void {
  current = s
  for (const cb of listeners) cb(s)
}

/** github = packaged NSIS build (electron-updater); npm = run from the npm package. */
export function updateMode(): UpdateMode {
  return app.isPackaged ? 'github' : 'npm'
}

export function updaterEnabled(): boolean {
  return true
}

// ---- npm registry channel ----

function compareVersions(a: string, b: string): number {
  const part = (v: string): number[] =>
    v.replace(/[+-].*$/, '').split('.').map((n) => Number(n) || 0)
  const pa = part(a)
  const pb = part(b)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1
  }
  // equal base: prerelease sorts lower than release
  const preA = a.includes('-') ? 1 : 0
  const preB = b.includes('-') ? 1 : 0
  return preB - preA
}

async function npmLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const doc = (await res.json()) as { version?: string }
    return doc.version ?? null
  } catch {
    return null
  }
}

/** The npm bin shim next to the global install (…\npm\dsh-desktop.cmd). */
function npmShimPath(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url)) // …\dsh-desktop\out\main
    const pkgDir = join(here, '..', '..') // …\dsh-desktop
    const shim = join(pkgDir, '..', '..', '..', 'dsh-desktop.cmd')
    return existsSync(shim) ? shim : null
  } catch {
    return null
  }
}

async function npmCheck(): Promise<void> {
  set({ phase: 'checking' })
  const latest = await npmLatestVersion()
  const current = app.getVersion()
  if (latest && compareVersions(latest, current) > 0) {
    availableVersion = latest
    set({ phase: 'available', version: latest })
    logs.info('app', `npm update available: ${current} -> ${latest}`)
  } else if (!latest) {
    set({ phase: 'error', message: '检查更新失败（无法访问 npm registry）' })
  } else {
    set({ phase: 'not-available' })
  }
}

/**
 * npm-channel update: spawn a DETACHED helper that waits for this app to exit
 * (unlocking the running electron.exe), runs `npm i -g`, then relaunches the
 * app. This process quits immediately afterwards — "close, update, restart".
 */
function npmUpdateAndRestart(version: string): void {
  const shim = npmShimPath()
  if (!shim) {
    set({ phase: 'error', message: '未找到 dsh-desktop 启动器（npm 全局安装位置异常），无法自动更新' })
    return
  }
  const updaterLog = join(process.env.TEMP ?? '.', 'dsh-desktop-updater.log')
  const ps = [
    `$ErrorActionPreference='Continue'`,
    // wait until the running app is fully gone (files unlocked)
    `$p = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
    `if ($p) { Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue }`,
    `Start-Sleep -Milliseconds 500`,
    // install the new version (globally), then relaunch the shell
    `npm install -g ${NPM_PACKAGE}@${version} --no-audit --no-fund 2>&1 | Out-File -FilePath '${updaterLog}' -Encoding utf8`,
    `Start-Process -FilePath '${shim}'`,
  ].join('; ')
  logs.info('updater', `npm update ${app.getVersion()} -> ${version}; quitting to update…`)
  set({ phase: 'updating' })
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch (err) {
    set({ phase: 'error', message: `无法启动更新进程：${(err as Error).message}` })
    return
  }
  // close the app so the installer can replace the running files
  setImmediate(() => app.quit())
}

// ---- github (electron-updater) channel ----

function initGithubUpdater(): void {
  try {
    autoUpdater.autoDownload = true // download right after check; user picks "restart to install"
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.forceDevUpdateConfig = false
    autoUpdater.channel = 'latest'
    autoUpdater.on('checking-for-update', () => set({ phase: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      availableVersion = info.version
      set({ phase: 'available', version: info.version })
      logs.info('app', `update available: ${info.version}`)
    })
    autoUpdater.on('update-not-available', () => set({ phase: 'not-available' }))
    autoUpdater.on('download-progress', (p) => set({ phase: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => {
      set({ phase: 'downloaded', version: info.version })
      logs.info('app', `update downloaded: ${info.version}`)
    })
    autoUpdater.on('error', (err) => {
      set({ phase: 'error', message: err.message })
      logs.warn('app', `updater error: ${err.message}`)
    })
    autoUpdater.logger = null // keep console clean; our log-store covers it
    // @ts-expect-error - app-update.yml channel id uses appId
    autoUpdater.appId = APP_ID
  } catch (err) {
    logs.warn('app', `updater init failed: ${(err as Error).message}`)
  }
}

// ---- public API ----

export function initUpdater(): void {
  if (updateMode() === 'github') {
    initGithubUpdater()
  } else {
    logs.info('app', 'update channel: npm registry')
  }
}

export async function checkForUpdates(): Promise<void> {
  if (updateMode() === 'github') {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      set({ phase: 'error', message: (err as Error).message })
    }
  } else {
    await npmCheck()
  }
}

export async function downloadUpdate(): Promise<void> {
  if (updateMode() === 'github') {
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      set({ phase: 'error', message: (err as Error).message })
    }
  } else if (availableVersion) {
    npmUpdateAndRestart(availableVersion)
  }
}

export function installUpdate(): void {
  if (updateMode() === 'github') {
    autoUpdater.quitAndInstall(false, true)
  } else if (availableVersion) {
    npmUpdateAndRestart(availableVersion)
  }
}
