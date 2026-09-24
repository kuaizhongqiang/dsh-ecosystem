/**
 * 适配层（单点适配）—— 所有对 dsh 本体的引用都集中在这一个文件 + 下面那张契约表，
 * 上游一变只改这里（docs/dsh-cli-design.md §9.2）。
 *
 * 分工：
 *   · **执行**：spawn `dsh --profile headless <prompt>`（cwd = workplace），只为拿到退出码；
 *   · **读取**：一律走会话事件日志（session-log.js），**不用** headless 的 `--json`
 *     （它会把事件裁到 8KiB/32KiB），保证「不裁」。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { dshHome, sessionsRoot } from './paths.js'

/** 依赖的上游契约（断言表）：id / 依赖什么 / 怎么判 / 不满足时的后果。 */
export const CONTRACT = {
  version: 1,
  dependsOn: [
    {
      id: 'dsh-cli',
      what: 'dsh 可执行文件（@deepseek-ai/dsh 的 bin: dsh）',
      consequence: '无法执行任务（task.run/task.run_async 不可用）',
    },
    {
      id: 'profile-headless',
      what: '`dsh --profile headless <prompt>` 一次性执行',
      consequence: '无法下发任务',
    },
    {
      id: 'sessions-layout',
      what: '`%DSH_HOME%/sessions/<项目键>/<session-id>/session.jsonl.zstd`',
      consequence: '读不到事件真源：分段记录、汇报、历史全部不可用',
    },
    {
      id: 'zstd-multiframe',
      what: '会话日志为多帧 zstd（每批 append 一帧）',
      consequence: '日志读不全（只会拿到第一帧）',
    },
    {
      id: 'event-shape',
      what: '事件记录形如 `{ type, seq, time, data }`',
      consequence: '分段契约无法投影',
    },
    {
      id: 'event-vocabulary',
      what: '事件词表：turn/start · step/start · assistant/message · tool/call · tool/result · step/end · turn/end',
      consequence: '轮/步划分不准',
    },
  ],
}

/** 找 dsh 可执行文件：环境变量 → 常见安装位 → PATH。 */
export function findDshBin() {
  const candidates = []
  if (process.env.DSHCLI_DSH_BIN) {
    const raw = process.env.DSHCLI_DSH_BIN
    // 允许指向一个 .js/.mjs/.cjs 脚本（质量门用的桩就是这么塞进来的）
    if (/\.(mjs|cjs|js)$/i.test(raw)) candidates.push({ command: process.execPath, args: [raw], source: 'env:DSHCLI_DSH_BIN(js)' })
    else candidates.push({ command: raw, args: [], source: 'env:DSHCLI_DSH_BIN' })
  }
  const appData = process.env.APPDATA ?? ''
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  for (const base of [join(dshHome(), 'profiles', 'node_modules'), join(appData, 'npm', 'node_modules')]) {
    const bin = join(base, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(bin)) candidates.push({ command: process.execPath, args: [bin], source: `npm-shim:${bin}` })
  }
  for (const probe of ['dsh.cmd', 'dsh']) {
    const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [probe], { encoding: 'utf8', windowsHide: true })
    const first = (found.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
    if (found.status === 0 && first !== undefined) candidates.push({ command: first, args: [], source: `PATH:${first}` })
  }
  if (home !== '') {
    for (const bin of [join(home, '.npm-global', 'bin', 'dsh'), join(home, '.local', 'bin', 'dsh')]) {
      if (existsSync(bin)) candidates.push({ command: bin, args: [], source: `home:${bin}` })
    }
  }
  return candidates[0]
}

/** 读 launcher 的注册文件（launcher 亲手拉起 dsh 时会写）。 */
export function readLauncherRegistration() {
  const file = join(dshHome(), 'launcher-registration.json')
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 读 launcher 的 launch-token（**只取端口/url 等元信息，绝不回显 token**）。 */
export function readLaunchToken() {
  const file = join(dshHome(), 'launch-token.json')
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { present: true, port: parsed?.port, url: typeof parsed?.url === 'string' ? redact(parsed.url) : undefined, managedBy: parsed?.managedBy }
  } catch {
    return { present: true, parseError: true }
  }
}

/** 脱敏：token 查询参数替换为 ***。 */
export function redact(url) {
  return String(url ?? '').replace(/([?&]token=)[^&]+/gi, '$1***')
}

/** TCP 探活：本机端口是否有人在听（判断「实例在不在跑」）。 */
export function probePort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 运行时现状：注册文件 + 端口探活（`status.overview` / `doctor` 用）。 */
export async function instanceState() {
  const registration = readLauncherRegistration()
  const token = readLaunchToken()
  const port = token?.port ?? registration?.port ?? 3080
  const listening = await probePort(port)
  return {
    launcher: registration === undefined
      ? { present: false }
      : {
          present: true,
          version: registration.launcherVersion,
          pid: registration.pid,
          running: registration.running === true,
          updatedAt: registration.updatedAt,
          api: registration.api,
        },
    launchToken: token ?? { present: false },
    port,
    listening,
    running: listening,
  }
}

/** 执行一条任务：spawn `dsh --profile headless`（cwd = workplace），只为退出码。 */
export function runHeadless(options) {
  const bin = findDshBin()
  if (bin === undefined) {
    const error = new Error('找不到 dsh 可执行文件（见 dshcli doctor）；无法执行任务')
    error.code = 'unavailable'
    throw error
  }
  const args = [
    ...bin.args,
    ...(options.extraArgs ?? []),
    '--profile', 'headless',
    ...(options.sessionId !== undefined ? ['--session-id', options.sessionId] : []),
    options.prompt,
  ]
  const child = spawn(bin.command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  return new Promise((resolve) => {
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut, bin: bin.source, args: args.slice(0, -1) })
    })
  })
}

/**
 * 契约自检：能查的当场查（可执行、会话目录、事件形状），查不了的标 `unavailable`。
 * @returns `{ ok, degraded: [{ id, what, consequence, detail }] }`
 */
export function checkContract(probe = {}) {
  const degraded = []
  const dshBin = probe.dshBin ?? findDshBin()
  if (dshBin === undefined) {
    degraded.push({ id: 'dsh-cli', detail: '未找到 dsh 可执行文件', ...pick('dsh-cli') })
  }
  if (!existsSync(sessionsRoot())) {
    degraded.push({ id: 'sessions-layout', detail: `会话目录不存在：${sessionsRoot()}`, ...pick('sessions-layout') })
  }
  const sample = probe.sampleEvents
  if (Array.isArray(sample) && sample.length > 0) {
    // 注意：日志首行是**会话头**（`type:'session'`，没有 seq，不是事件）—— 别把它算成形状不符
    const bad = sample.filter((event) => event.type !== 'session' && (typeof event.type !== 'string' || typeof event.seq !== 'number'))
    if (bad.length > 0) degraded.push({ id: 'event-shape', detail: `样本里有 ${bad.length} 条事件不符合 {type,seq,time,data}`, ...pick('event-shape') })
    const vocabulary = new Set(['turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end'])
    const missing = [...vocabulary].filter((type) => !sample.some((event) => event.type === type))
    if (missing.length === vocabulary.size) {
      degraded.push({ id: 'event-vocabulary', detail: '样本里一个已知事件类型都没有（上游词表可能变了）', ...pick('event-vocabulary') })
    } else if (missing.length > 0) {
      degraded.push({ id: 'event-vocabulary', detail: `样本里缺少这些事件类型：${missing.join(', ')}`, ...pick('event-vocabulary') })
    }
  }
  return { ok: degraded.length === 0, degraded }

  function pick(id) {
    const entry = CONTRACT.dependsOn.find((item) => item.id === id)
    return entry === undefined ? {} : { what: entry.what, consequence: entry.consequence }
  }
}
