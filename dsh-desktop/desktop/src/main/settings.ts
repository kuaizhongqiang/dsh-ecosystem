// Persistent settings. Lightweight JSON store under app.getPath('userData')
// (default %APPDATA%\dsh-desktop); atomic writes via temp file + rename.
import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PORT } from './constants.js'

export interface Settings {
  /** Shared dsh server port (dsh web default 3080; must match the running server). */
  port: number
  /** dsh data root ('' = default ~/.dsh). Read as DSH_HOME: where launch-token.json lives. */
  dataDir: string
  /** dsh-launcher.exe path override ('' = auto-detect: PATH / common locations). */
  launcherPath: string
  /** Start with Windows (app.setLoginItemSettings). */
  autoLaunch: boolean
  /** Closing the window minimizes to tray instead of quitting. */
  closeToTray: boolean
}

const DEFAULTS: Settings = {
  port: DEFAULT_PORT,
  dataDir: '',
  launcherPath: '',
  autoLaunch: false,
  closeToTray: true,
}

let cache: Settings | null = null

export function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): Settings {
  if (cache) return cache
  const merged = { ...DEFAULTS }
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>
    Object.assign(merged, raw)
    // sanity clamp
    if (!Number.isInteger(merged.port) || merged.port < 0 || merged.port > 65535) merged.port = DEFAULT_PORT
  } catch {
    // first run or corrupt file: use defaults
  }
  cache = merged
  return merged
}

export function getSettings(): Settings {
  return loadSettings()
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch }
  if (!Number.isInteger(next.port) || next.port < 0 || next.port > 65535) next.port = DEFAULT_PORT
  cache = next
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const tmp = settingsPath() + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, settingsPath())
  return next
}
