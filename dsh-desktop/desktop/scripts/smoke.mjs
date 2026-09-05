// Standalone smoke test (no Electron): verifies the shared-server protocol the
// pure-shell desktop depends on.
//   1. dsh (from --dsh, or auto-installed @deepseek-ai/dsh@<config.dshVersion>) boots
//   2. GET / answers 401 (dsh v0.1.2+ launch-token auth enabled)
//   3. dsh prints a `?token=` URL; GET /?token= → 303 Set-Cookie
//   4. POST /api/session/list with the cookie is authenticated (not 401)
//
// Child output goes to a temp file (not pipes) so the token can be read back
// reliably on any environment. No curl dependency.
// Usage: node scripts/smoke.mjs [--dsh <path-to-bin.js>]
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, openSync, readFileSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))))
const args = process.argv.slice(2)
const dshArg = args.includes('--dsh') ? args[args.indexOf('--dsh') + 1] : null
const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
const dshVersion = config.dshVersion

const TOKEN_URL_RE = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_-]+)/g
const isWin = process.platform === 'win32'

async function ensureDshEntry() {
  if (dshArg) {
    if (!existsSync(dshArg)) {
      console.error(`[smoke] --dsh 路径不存在：${dshArg}`)
      process.exit(2)
    }
    return dshArg
  }
  // Auto-install the pinned dsh into a STABLE dir (desktop/.ci-dsh) so CI can
  // cache it across runs (a cold full-tree install takes 4-10+ min); reuse when
  // already present. Env override: DSH_SMOKE_PREFIX.
  const prefix = process.env.DSH_SMOKE_PREFIX ?? join(root, '.ci-dsh')
  const bin = join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) {
    console.log(`[smoke] installing @deepseek-ai/dsh@${dshVersion} (npm, prefix=${prefix})…`)
    execFileSync(isWin ? 'npm.cmd' : 'npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', prefix, `@deepseek-ai/dsh@${dshVersion}`], {
      // First CI run after a dsh bump is a cold full-tree install (4-10+ min on
      // slow runners); desktop/.ci-dsh is cached by CI afterwards. Never kill early.
      stdio: 'inherit', windowsHide: true, shell: isWin, timeout: 900_000,
    })
  } else {
    console.log(`[smoke] reusing dsh install at ${prefix}`)
  }
  return bin
}

function preAllocatePort() {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer()
    srv.once('error', rejectP)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolveP(port))
    })
  })
}

async function probe(url, timeoutMs) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    return res.status
  } catch {
    return -1
  }
}

const entry = await ensureDshEntry()
const port = await preAllocatePort()
console.log(`[smoke] entry=${entry}`)
console.log(`[smoke] port=${port} dshVersion=${dshVersion}`)

const dshHome = join(tmpdir(), `dsh-smoke-${Date.now()}`)
const childLog = join(tmpdir(), `dsh-smoke-child-${Date.now()}.log`)
const logFd = openSync(childLog, 'w')

// Child output goes to a file (no pipes): robust token extraction anywhere.
const child = spawn(process.execPath, [entry, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
  env: { ...process.env, DSH_HOME: dshHome },
})
child.on('error', (e) => {
  console.error(`[smoke] spawn failed: ${e.message}`)
  process.exit(2)
})

const base = `http://127.0.0.1:${port}`
const deadline = Date.now() + 60_000
let rootStatus = -1
while (Date.now() < deadline) {
  if (child.exitCode !== null) break
  rootStatus = await probe(`${base}/`, 1500)
  if (rootStatus === 401 || rootStatus === 200 || rootStatus === 303) break
  await new Promise((r) => setTimeout(r, 400))
}

function childLogText() {
  try { return readFileSync(childLog, 'utf8') } catch { return '' }
}

// dsh prints the token URL a moment AFTER the port answers HTTP; on a slow/busy
// CI runner the gap can be hundreds of ms — poll the log file for the token
// (still open, child still writing) before closing the fd.
const tokenDeadline = Date.now() + 8_000
let tokenUrl = null
while (Date.now() < tokenDeadline) {
  const matches = [...childLogText().matchAll(TOKEN_URL_RE)]
  if (matches.length > 0) { tokenUrl = matches[matches.length - 1][1]; break }
  await new Promise((r) => setTimeout(r, 200))
}
closeSync(logFd)

console.log(`[smoke] root status=${rootStatus} (401/200/303 = dsh up)`)
console.log(`[smoke] token-url=${tokenUrl ? 'found' : 'none'} (dsh < v0.1.2? or log not yet flushed)`)

let ok = rootStatus === 401 || rootStatus === 200 || rootStatus === 303
let tokenVerdict = 'n/a'
let rpcVerdict = 'n/a'

if (ok && tokenUrl) {
  // token exchange: GET /?token= → 303 + Set-Cookie
  try {
    const res = await fetch(tokenUrl, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
    tokenVerdict = res.status === 303 || res.status === 302 ? 'ok' : `status=${res.status}`
    ok = ok && tokenVerdict === 'ok'
    // authenticated RPC: session/list with the cookie must NOT be 401
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    const cookie = (setCookies[0] ?? res.headers.get('set-cookie') ?? '').split(';')[0]
    if (!cookie) {
      rpcVerdict = 'no-session-cookie'
      ok = false
    } else {
      const rpc = await fetch(`${base}/api/session/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'session/list', payload: { args: {} } }),
        signal: AbortSignal.timeout(3000),
      })
      rpcVerdict = rpc.status !== 401 ? `authed(status=${rpc.status})` : '401-unauthed'
      ok = ok && rpc.status !== 401
    }
  } catch (e) {
    rpcVerdict = `exchange-failed: ${e instanceof Error ? e.message : String(e)}`
    ok = false
  }
} else {
  ok = false
}

console.log(`[smoke] token-exchange=${tokenVerdict}`)
console.log(`[smoke] authed-rpc=${rpcVerdict}`)
console.log('[smoke] stdout tail:', childLogText().split('\n').filter(Boolean).slice(-4).join(' | '))

// cleanup
try { child.kill('SIGTERM') } catch { /* noop */ }
await new Promise((r) => setTimeout(r, 1500))
if (child.exitCode === null && child.pid) {
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}
await new Promise((r) => setTimeout(r, 800))

console.log(ok ? '[smoke] PASS' : '[smoke] FAIL')
process.exit(ok ? 0 : 1)
