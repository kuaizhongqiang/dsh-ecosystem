// Shared constants for dsh-desktop (pure shell). The app never spawns dsh:
// it connects to the shared dsh server (started by dsh-launcher / dsh-vscode /
// `dsh web` — whoever started first owns it). The expected dsh version is
// documented in desktop/config.json (used by scripts + smoke).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_NAME = 'dsh-desktop'
export const APP_ID = 'com.dshdesktop.app'
/** Shared dsh server port (dsh web default; matches launcher.json / vscode default). */
export const DEFAULT_PORT = 3080

// Connect flow (shell side)
/** Max wait for a server started via dsh-launcher to become ready. */
export const READY_TIMEOUT_MS = 60_000
export const PROBE_INTERVAL_MS = 500
/** Health-poll the connected server; after HEALTH_FAIL_LIMIT misses treat it as lost. */
export const HEALTH_INTERVAL_MS = 10_000
export const HEALTH_FAIL_LIMIT = 3
export const LOG_RING_SIZE = 2_000
export const LOG_EXPORT_HEAD = 20

// Shared launch-token file — spec shared with dsh-launcher / dsh-vscode
// ($DSH_HOME/launch-token.json, version 1).
export const LAUNCH_TOKEN_FILE = 'launch-token.json'

// dsh-launcher delegation (desktop never spawns dsh itself)
export const LAUNCHER_EXE = 'dsh-launcher.exe'
export const LAUNCHER_START_ARGS = ['start', '--no-browser']
export const LAUNCHER_STOP_ARGS = ['stop']

const here = dirname(fileURLToPath(import.meta.url))
// desktop/out/main/constants.js -> desktop/
const desktopRoot = join(here, '..', '..')

export interface RuntimeConfigJson {
  /** Expected dsh server version (documented; the launcher installs/updates dsh). */
  dshVersion: string
}

export function loadRuntimeConfig(): RuntimeConfigJson {
  try {
    return JSON.parse(readFileSync(join(desktopRoot, 'config.json'), 'utf8')) as RuntimeConfigJson
  } catch {
    return { dshVersion: '0.1.2-alpha.4' }
  }
}

export const RUNTIME_CONFIG = loadRuntimeConfig()
export const DSH_VERSION = RUNTIME_CONFIG.dshVersion
