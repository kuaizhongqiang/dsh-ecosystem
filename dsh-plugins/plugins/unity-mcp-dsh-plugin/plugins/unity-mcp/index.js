/**
 * unity-mcp supervisor — keeps the MCPForUnity server reachable for this dsh
 * profile.
 *
 * The actual MCP bridge is the separate `mcp-unity` entry using
 * `@deepseek-ai/dsh-mcp-client` (streamable-http against
 * http://127.0.0.1:8080/mcp). This plugin only guarantees the *process* is
 * alive: on activation and on a fixed interval it probes the MCP endpoint; if
 * nothing answers it spawns the server with the exact uvx command the user
 * runs manually, streams its output to a log file, and respawns it a bounded
 * number of times. A server the user started themselves is never killed —
 * only a child this plugin spawned is cleaned up on disposal.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'

export const name = 'unity-mcp-supervisor'
export const inject = []

/** package.json is the single source of truth for the version. */
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
export const version = PKG.version

/** Configuration for the server lifecycle. All fields optional; see apply(). */
export const Config = z.object({
  enabled: z.boolean(),
  /** Endpoint used for the reachability probe (the MCP streamable-http URL). */
  endpointUrl: z.string(),
  /** Executable that starts the server (e.g. the uvx binary). */
  command: z.string(),
  /** Arguments passed to `command`, exactly like the manual invocation. */
  args: z.array(z.string()),
  /** Working directory for the server process (matters for --project-scoped-tools). */
  cwd: z.string(),
  /** Where the spawned server's stdout/stderr is appended. */
  logFile: z.string(),
  /** Probe cadence while the server is up. */
  checkIntervalMs: z.natural(),
  /** How long to wait for the endpoint to answer after spawning. */
  startupTimeoutMs: z.natural(),
  /** Consecutive spawn failures before auto-respawn stops (until next success). */
  maxStartupFailures: z.natural(),
})

const DEFAULTS = {
  endpointUrl: 'http://127.0.0.1:8080/mcp',
  command: 'C:\\Users\\kuai\\.local\\bin\\uvx.exe',
  args: [
    '--from', 'mcpforunityserver==10.1.2',
    'mcp-for-unity',
    '--transport', 'http',
    '--http-url', 'http://127.0.0.1:8080',
    '--project-scoped-tools',
  ],
  cwd: 'G:\\project\\MCV_Module_0802',
  logFile: 'C:\\Users\\kuai\\.dsh\\logs\\unity-mcp-server.log',
  checkIntervalMs: 10_000,
  startupTimeoutMs: 90_000,
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
 * Start the MCPForUnity server and stream its output to the log file.
 * @returns the spawned child, or null if spawning failed synchronously.
 */
function spawnServer(command, args, cwd, logFile, log) {
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
      log.error(`failed to start MCP server: ${error.message}`)
    })
    return child
  } catch (error) {
    log.error(`failed to spawn MCP server: ${error.message}`)
    stream.end()
    return null
  }
}

export function apply(ctx, config) {
  console.info(`[unity-mcp-supervisor] v${version} registered`)
  const log = typeof ctx.logger === 'function' ? ctx.logger('unity-mcp') : console
  const enabled = config.enabled ?? true
  const endpointUrl = config.endpointUrl ?? DEFAULTS.endpointUrl
  const command = config.command ?? DEFAULTS.command
  const args = config.args ?? DEFAULTS.args
  const cwd = config.cwd ?? DEFAULTS.cwd
  const logFile = config.logFile ?? DEFAULTS.logFile
  const checkIntervalMs = config.checkIntervalMs ?? DEFAULTS.checkIntervalMs
  const startupTimeoutMs = config.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs
  const maxStartupFailures = config.maxStartupFailures ?? DEFAULTS.maxStartupFailures

  if (!enabled) {
    log.info('disabled, not supervising the MCP server')
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
    const spawned = spawnServer(command, args, cwd, logFile, log)
    if (spawned === null) return
    child = spawned
    owned = true
    log.info(`spawned MCP server pid=${spawned.pid} (endpoint ${endpointUrl})`)
    // If the endpoint does not answer within the startup window, treat the
    // child as failed: kill it and let its exit handler schedule a retry.
    spawnTimer = setTimeout(() => {
      spawnTimer = null
      if (child === null) return
      probe(endpointUrl, 3_000).then((up) => {
        if (up) return
        log.warn(`MCP server did not become reachable in ${startupTimeoutMs}ms, restarting`)
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
        log.error(`MCP server exited (${code ?? signal ?? '?'}) after ${failures} consecutive failures; auto-respawn paused until the endpoint answers`)
        return
      }
      const backoff = Math.min(1_000 * 2 ** failures, 30_000)
      log.warn(`MCP server exited (code=${code ?? '?'} signal=${signal ?? '?'}); retrying in ${backoff}ms (attempt ${failures}/${maxStartupFailures})`)
      spawnTimer = setTimeout(spawnIfNeeded, backoff)
    })
  }

  const check = async () => {
    if (checking || disposed) return
    checking = true
    try {
      const up = await probe(endpointUrl, 3_000)
      if (up) {
        if (failures !== 0 || exhausted) log.info(`MCP endpoint ${endpointUrl} reachable again`)
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
      log.info(`stopping spawned MCP server pid=${child.pid}`)
      child.kill()
      child = null
      owned = false
    }
  })

  log.info(`active: supervising ${endpointUrl} (${command}) every ${checkIntervalMs}ms`)
}
