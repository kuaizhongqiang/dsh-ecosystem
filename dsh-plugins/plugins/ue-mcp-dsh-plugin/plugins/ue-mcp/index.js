/**
 * ue-mcp supervisor - keeps the Unreal MCP server reachable for this dsh
 * profile.
 *
 * Unreal MCP (UE 5.8+) is embedded in the Unreal Editor process: with the
 * ModelContextProtocol plugin enabled, starting the editor with
 * -ModelContextProtocolStartServer (or running the console command
 * ModelContextProtocol.StartServer) makes it listen on
 * http://127.0.0.1:8000/mcp.
 *
 * The actual bridge to dsh is the separate `mcp-ue` entry using
 * `@deepseek-ai/dsh-mcp-client` (streamable-http against that endpoint).
 * This plugin only guarantees the endpoint is reachable: on activation and on
 * a fixed interval it probes the endpoint; if nothing answers it starts the
 * Unreal Editor with -ModelContextProtocolStartServer, streams the editor's
 * stdout/stderr to a log file, and retries a bounded number of times.
 *
 * An editor the user started themselves is never killed - only a child this
 * plugin spawned is cleaned up on disposal.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'

export const name = 'ue-mcp-supervisor'
export const inject = []

/** package.json is the single source of truth for the version. */
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
export const version = PKG.version

/** Configuration for the editor/server lifecycle. All fields optional; see apply(). */
export const Config = z.object({
  // Default OFF (opt-in): set enabled: true in the profile patch entry (and
  // restart web) to let this supervisor auto-start the Unreal Editor.
  enabled: z.boolean().default(false),
  /** Endpoint used for the reachability probe (the MCP streamable-http URL). */
  endpointUrl: z.string(),
  /** Executable that starts the server (the Unreal Editor binary). */
  command: z.string(),
  /** Arguments passed to `command` (uproject + -ModelContextProtocolStartServer). */
  args: z.array(z.string()),
  /** Working directory for the editor process. */
  cwd: z.string(),
  /** Where the spawned editor's stdout/stderr is appended. */
  logFile: z.string(),
  /** Probe cadence while the endpoint is up. */
  checkIntervalMs: z.natural(),
  /** How long to wait for the endpoint to answer after spawning the editor. */
  startupTimeoutMs: z.natural(),
  /** Consecutive spawn failures before auto-respawn stops (until next success). */
  maxStartupFailures: z.natural(),
})

const DEFAULTS = {
  endpointUrl: 'http://127.0.0.1:8000/mcp',
  command: 'E:\\Unreal\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor.exe',
  args: [
    'D:\\UEProject\\UE_MCP_Test\\UE_MCP.uproject',
    '-ModelContextProtocolStartServer',
  ],
  cwd: 'D:\\UEProject\\UE_MCP_Test',
  logFile: 'C:\\Users\\kuai\\.dsh\\logs\\ue-mcp-editor.log',
  checkIntervalMs: 10_000,
  startupTimeoutMs: 180_000,
  maxStartupFailures: 3,
}

/** Lightweight reachability probe: any HTTP response means the server is up. */
async function probe(url, timeoutMs) {
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

/**
 * Start the Unreal Editor (with the MCP server flag) and stream its output to
 * the log file.
 * @returns the spawned child, or null if spawning failed synchronously.
 */
function spawnEditor(command, args, cwd, logFile, log) {
  mkdirSync(dirname(logFile), { recursive: true })
  const stream = createWriteStream(logFile, { flags: 'a' })
  stream.write(`\n=== spawn ${new Date().toISOString()} ===\n`)
  try {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.pipe(stream)
    child.stderr.pipe(stream)
    child.on('error', (error) => {
      log.error(`failed to start Unreal Editor: ${error.message}`)
    })
    return child
  } catch (error) {
    log.error(`failed to spawn Unreal Editor: ${error.message}`)
    stream.end()
    return null
  }
}

export function apply(ctx, config) {
  console.info(`[ue-mcp-supervisor] v${version} registered`)
  const log = typeof ctx.logger === 'function' ? ctx.logger('ue-mcp') : console
  const enabled = config.enabled ?? false
  const endpointUrl = config.endpointUrl ?? DEFAULTS.endpointUrl
  const command = config.command ?? DEFAULTS.command
  const args = config.args ?? DEFAULTS.args
  const cwd = config.cwd ?? DEFAULTS.cwd
  const logFile = config.logFile ?? DEFAULTS.logFile
  const checkIntervalMs = config.checkIntervalMs ?? DEFAULTS.checkIntervalMs
  const startupTimeoutMs = config.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs
  const maxStartupFailures = config.maxStartupFailures ?? DEFAULTS.maxStartupFailures

  if (!enabled) {
    log.info('disabled, not supervising the Unreal MCP server')
    return
  }

  let child = null
  let owned = false
  let failures = 0
  let exhausted = false
  let checking = false
  let spawnTimer = null
  let disposed = false

  const cancelPendingSpawn = () => {
    if (spawnTimer !== null) {
      clearTimeout(spawnTimer)
      spawnTimer = null
    }
  }

  const spawnIfNeeded = () => {
    if (disposed || owned || child !== null || exhausted) return
    const spawned = spawnEditor(command, args, cwd, logFile, log)
    if (spawned === null) return
    child = spawned
    owned = true
    log.info(`spawned Unreal Editor pid=${spawned.pid} (endpoint ${endpointUrl})`)
    // If the endpoint does not answer within the startup window, treat the
    // child as failed: kill it and let its exit handler schedule a retry.
    spawnTimer = setTimeout(() => {
      spawnTimer = null
      if (child === null) return
      probe(endpointUrl, 3_000).then((up) => {
        if (up) return
        log.warn(`Unreal MCP did not become reachable in ${startupTimeoutMs}ms, restarting`)
        const dying = child
        child = null
        dying.kill()
      })
    }, startupTimeoutMs)
    spawned.on('exit', (code, signal) => {
      if (!owned) return
      owned = false
      child = null
      cancelPendingSpawn()
      if (disposed) return
      failures += 1
      if (failures > maxStartupFailures) {
        exhausted = true
        log.error(`Unreal Editor exited (${code ?? signal ?? '?'}) after ${failures} consecutive failures; auto-respawn paused until the endpoint answers`)
        return
      }
      const backoff = Math.min(1_000 * 2 ** failures, 30_000)
      log.warn(`Unreal Editor exited (code=${code ?? '?'} signal=${signal ?? '?'}); retrying in ${backoff}ms (attempt ${failures}/${maxStartupFailures})`)
      spawnTimer = setTimeout(spawnIfNeeded, backoff)
    })
  }

  const check = async () => {
    if (checking || disposed) return
    checking = true
    try {
      const up = await probe(endpointUrl, 3_000)
      if (up) {
        if (failures !== 0 || exhausted) log.info(`Unreal MCP endpoint ${endpointUrl} reachable again`)
        failures = 0
        exhausted = false
        return
      }
      spawnIfNeeded()
    } finally {
      checking = false
    }
  }

  const timer = setInterval(check, checkIntervalMs)
  check() // immediate first pass

  ctx.on('dispose', () => {
    disposed = true
    clearInterval(timer)
    cancelPendingSpawn()
    if (owned && child !== null) {
      log.info(`stopping spawned Unreal Editor pid=${child.pid}`)
      child.kill()
      child = null
      owned = false
    }
  })

  log.info(`active: supervising ${endpointUrl} (${command}) every ${checkIntervalMs}ms`)
}
