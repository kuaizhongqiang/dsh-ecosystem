/**
 * launcher seam tools for the native dsh web profile (PM3 / 路线图 §8):
 *   launcher_restart / launcher_status / launcher_connections / launcher_open /
 *   launcher_check_update.
 *
 * 发现链(PLAN D6/M6):① 进程环境变量 DSH_LAUNCHER_EXE(launcher 亲手拉起时注入);
 * ② %DSH_HOME%\launcher-registration.json 持久注册(心跳 ≤30s,>60s 视为陈旧,
 *    必须以 pid 存在性 + api 健康复核);③ 都无 → 提示手动重启。
 * 重启优先走 launcher REST bridge(POST /api/dsh/restart?key=<bridgeKey>,127.0.0.1),
 * 其次 `<launcherExe> restart`(CLI 内部经单实例转交)。
 *
 * 红线(D2):connections.json / launch-token.json 中的 token 只在本机文件间流转,
 * 工具输出一律脱敏(token=***)。
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-launcher'
export const inject = ['tools']

/** 注册心跳陈旧阈值(2× 30s 心跳)。 */
const STALE_MS = 60_000

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}
const registrationPath = () => join(dshHome(), 'launcher-registration.json')
const connectionsPath = () => join(dshHome(), 'connections.json')
const launchTokenPath = () => join(dshHome(), 'launch-token.json')

function readJson(file) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isFresh(reg) {
  const t = Date.parse(reg?.updatedAt ?? '')
  return !Number.isNaN(t) && Date.now() - t < STALE_MS
}

/** 输出脱敏:token 查询参数替换为 ***。 */
function redact(url) {
  return String(url ?? '').replace(/([?&]token=)[^&]+/gi, '$1***')
}

/** 激活连接解析:connections.json 优先;否则按 launch-token 端口合成默认。 */
function resolveActiveConnection() {
  const file = readJson(connectionsPath())
  if (file && file.version === 1 && Array.isArray(file.connections) && file.connections.length > 0) {
    const active = file.connections.find((c) => c.id === file.active) ?? file.connections[0]
    return { active, list: file.connections, fromFile: true }
  }
  const token = readJson(launchTokenPath())
  const port = token?.port ?? 3080
  return {
    active: { id: `local-${port}`, kind: 'local', name: '本机 dsh(合成)', port },
    list: [{ id: `local-${port}`, kind: 'local', name: '本机 dsh(合成)', port }],
    fromFile: false,
  }
}

/**
 * 发现链 → 重启执行通道。
 * @returns `{ mode: 'bridge' | 'exe', detail }`,找不到通道抛错(提示手动)。
 */
async function resolveRestartChannel() {
  const reg = readJson(registrationPath())
  const exe = process.env.DSH_LAUNCHER_EXE ?? reg?.launcherExe

  // ①/②:注册文件给出 api+bridgeKey 且 pid 复核存活(新鲜或陈旧均可,陈旧必须复核——这里就是复核)
  if (reg && reg.api && reg.bridgeKey && pidAlive(reg.pid)) {
    return { mode: 'bridge', reg }
  }
  // ③:环境变量/注册里的 exe 路径(存在性校验)
  if (exe && existsSync(exe)) {
    return { mode: 'exe', exe }
  }
  throw new Error(
    'launcher_restart: 未发现可用的 launcher(既无 DSH_LAUNCHER_EXE/有效注册,注册文件缺失或 pid 已退出)。'
    + ' 请手动重启:停掉本 web 实例后重新运行 dsh-launcher(或 dsh web)。',
  )
}

async function callBridge(reg) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const resp = await fetch(`${String(reg.api).replace(/\/+$/, '')}/api/dsh/restart?key=${encodeURIComponent(reg.bridgeKey)}`, {
      method: 'POST',
      signal: ctrl.signal,
    })
    return { status: resp.status, body: await resp.json().catch(() => ({})) }
  } finally {
    clearTimeout(timer)
  }
}

function spawnExeRestart(exe) {
  const child = spawn(exe, ['restart'], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return child.pid
}

/** 原子写 connections.json(D8 ④)。 */
function saveConnections(file) {
  mkdirSync(dshHome(), { recursive: true })
  const target = connectionsPath()
  const tmp = `${target}.tmp-${Math.floor(Math.random() * 1e6)}`
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
    renameSync(tmp, target)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw e
  }
}

async function openExternal(url) {
  if (process.platform !== 'win32') throw new Error('launcher_open: 仅支持 Windows')
  await new Promise((resolve, reject) => {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  })
}

async function latestLauncherRelease() {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const resp = await fetch('https://api.github.com/repos/kuaizhongqiang/dsh-launcher/releases/latest', {
      headers: { 'User-Agent': 'dsh-launcher-plugin', Accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (resp.status !== 200) throw new Error(`GitHub API ${resp.status}`)
    return await resp.json()
  } finally {
    clearTimeout(timer)
  }
}

function parseSemver(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? '').trim())
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null
}

function isNewer(a, b) {
  if (!a || !b) return false
  if (a.major !== b.major) return a.major > b.major
  if (a.minor !== b.minor) return a.minor > b.minor
  return a.patch > b.patch
}

export function apply(ctx) {
  // --- launcher_status -----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'launcher_status',
    description: 'launcher / dsh 运行态汇总:launcher 注册(版本/exe/pid/心跳/api)、激活连接(本地端口或 remote)、'
      + 'launch-token 状态。排查「重启/连接/升级」问题前先调用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: '人读摘要(token 已脱敏)' },
          detail: { type: 'object', additionalProperties: true, required: true, description: '结构化明细' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary }],
    },
    async execute() {
      const reg = readJson(registrationPath())
      const { active, list, fromFile } = resolveActiveConnection()
      const token = readJson(launchTokenPath())
      const detail = {
        launcher: reg
          ? {
              present: true,
              version: reg.launcherVersion ?? '',
              exe: reg.launcherExe ?? '',
              pid: reg.pid,
              pidAlive: pidAlive(reg.pid),
              fresh: isFresh(reg),
              running: !!reg.running,
              api: reg.api,
              updatedAt: reg.updatedAt,
            }
          : { present: false, hint: '未注册(dsh 非由 launcher 拉起,或 launcher 版本过旧)' },
        env: { DSH_LAUNCHER_EXE: process.env.DSH_LAUNCHER_EXE ?? '' },
        connection: { fromFile, active: { ...active, token: undefined }, count: list.length },
        launchToken: token
          ? { present: true, port: token.port, url: redact(token.url), managedBy: token.managedBy ?? '' }
          : { present: false },
        dshPid: process.pid,
      }
      const l = detail.launcher
      const summary = l.present
        ? `launcher v${l.version}(${l.running ? '运行中' : '未运行'},pid ${l.pid}${l.pidAlive ? ' 存活' : ' 已退出'}${l.fresh ? ',心跳新鲜' : ',心跳陈旧'})`
        : 'launcher 未注册(发现链不可用,重启需手动)'
      return { summary: `${summary};激活连接 ${active.id}(${active.kind}${active.kind === 'local' ? ':' + active.port : ''})`, detail }
    },
    presentCall: (a) => ({ card: 'generic', title: 'launcher_status', kind: 'read', rawInput: a }),
  }))

  // --- launcher_restart ----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'launcher_restart',
    description: '重启 dsh(按 D6 发现链委托 launcher:环境变量/注册文件的 REST bridge 优先,其次 <launcherExe> restart)。'
      + '优雅停止→等端口释放→重抓 token 照写 launch-token.json,30 天 cookie 下重启后免手动重登;'
      + '激活连接为 remote 时=重连/重开浏览器。发现链不可用时给出手动重启指引。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true, description: '执行结果说明' },
          mode: { type: 'string', required: true, description: "'bridge' | 'exe' | 'manual'" },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute() {
      const channel = await resolveRestartChannel()
      if (channel.mode === 'bridge') {
        const r = await callBridge(channel.reg)
        if (r.status === 202) return { mode: 'bridge', message: `已转交运行中的 launcher(${redact(channel.reg.api)})执行 restart,进度见 launcher 日志;约数秒后生效。` }
        if (r.status === 409) return { mode: 'bridge', message: 'launcher 已在执行 restart,请稍候再查状态。' }
        if (r.status === 403) throw new Error('launcher_restart: bridgeKey 校验失败(注册文件与 launcher 不匹配?),可改用 launcher_check_update/手动重启。')
        throw new Error(`launcher_restart: REST bridge 返回 ${r.status};可尝试手动重启。`)
      }
      const pid = spawnExeRestart(channel.exe)
      return { mode: 'exe', message: `已拉起 "${channel.exe}" restart(PID ${pid});CLI 经单实例检测转交运行中的 launcher。` }
    },
    presentCall: (a) => ({ card: 'generic', title: 'launcher_restart', kind: 'action', rawInput: a }),
  }))

  // --- launcher_connections ------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'launcher_connections',
    description: '列出或切换 %DSH_HOME%\\connections.json 连接组(local=本机端口,remote=广域网;token 不回显)。'
      + 'action=use 时切换激活连接,可选 restart=true 立即按新连接重启/重连。',
    parameters: {
      action: { type: 'string', description: "'list'(默认)或 'use'" },
      id: { type: 'string', description: "action=use 时的目标连接 id" },
      restart: { type: 'boolean', description: 'action=use 后是否立即重启/重连(默认 false)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true, description: '结果说明(token 已脱敏)' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute(args) {
      const action = args.action ?? 'list'
      if (action === 'list') {
        const { active, list, fromFile } = resolveActiveConnection()
        const lines = list.map((c) => `${c.id === active.id ? '*' : ' '} ${c.id} [${c.kind}]${c.kind === 'local' ? ` port=${c.port}` : ` url=${redact(c.url)}`}${c.token ? ' (token 已配置)' : ''}`)
        return { message: (fromFile ? 'connections.json:' : '无 connections.json,以下为合成默认:') + '\n' + lines.join('\n') }
      }
      if (action === 'use') {
        if (!args.id) throw new Error('launcher_connections: action=use 需要 id')
        const file = readJson(connectionsPath())
        if (!file || !Array.isArray(file.connections)) throw new Error('connections.json 不存在或无效:请先在 launcher 侧 connections add')
        const target = file.connections.find((c) => c.id === args.id)
        if (!target) throw new Error(`连接不存在:${args.id}(可用:${file.connections.map((c) => c.id).join(', ')})`)
        file.active = target.id
        saveConnections(file)
        // D8 ③:active 变更标记
        try {
          writeFileSync(join(dshHome(), '.dsh-connection-changed'), JSON.stringify({ active: target.id, changedAt: new Date().toISOString() }, null, 2), 'utf8')
        } catch { /* 标记失败不致命 */ }
        let restartNote = ''
        if (args.restart) {
          const channel = await resolveRestartChannel()
          if (channel.mode === 'bridge') {
            const r = await callBridge(channel.reg)
            restartNote = r.status === 202 ? ';已触发 restart' : r.status === 409 ? ';launcher 已在 restart 中' : `;restart 触发失败(HTTP ${r.status})`
          } else {
            spawnExeRestart(channel.exe)
            restartNote = ';已触发 restart(经 launcherExe)'
          }
        }
        return { message: `激活连接 → ${target.id}(${target.kind})${restartNote};desktop 完全跟随,vscode 需同步 serverUrl。` }
      }
      throw new Error("launcher_connections: action 只支持 'list' | 'use'")
    },
    presentCall: (a) => ({ card: 'generic', title: 'launcher_connections', kind: 'action', rawInput: { ...a } }),
  }))

  // --- launcher_open -------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'launcher_open',
    description: '按激活连接打开浏览器(带 token 自动登录;remote 组带 token 或交由 Cloudflare Access)。'
      + 'url 只以脱敏形式回显。',
    parameters: {
      connection: { type: 'string', description: '可选:指定连接 id;缺省用激活连接' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true, description: '打开结果(token 已脱敏)' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute(args) {
      let target
      if (args.connection) {
        const { list } = resolveActiveConnection()
        const c = list.find((x) => x.id === args.connection)
        if (!c) throw new Error(`launcher_open: 连接不存在 ${args.connection}`)
        target = c.kind === 'remote'
          ? (c.url + (c.token ? (c.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(c.token) : ''))
          : `http://127.0.0.1:${c.port ?? 3080}/`
      } else {
        const shared = readJson(launchTokenPath())
        if (shared?.url) target = shared.url
        else {
          const { active } = resolveActiveConnection()
          target = active.kind === 'remote'
            ? (active.url + (active.token ? (active.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(active.token) : ''))
            : `http://127.0.0.1:${active.port ?? 3080}/`
        }
      }
      await openExternal(target)
      return { message: `已在默认浏览器打开:${redact(target)}` }
    },
    presentCall: (a) => ({ card: 'generic', title: 'launcher_open', kind: 'action', rawInput: { ...a } }),
  }))

  // --- launcher_check_update ----------------------------------------------
  ctx.tools.register(defineTool({
    name: 'launcher_check_update',
    description: '检查 launcher 自身升级(GitHub Release 最新版 vs 注册文件记录的当前版本);'
      + '提示下载页。升级需用户主动确认后执行(M8 lock 语义)。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true, description: '检查结果' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute() {
      const reg = readJson(registrationPath())
      const current = reg?.launcherVersion ?? ''
      const rel = await latestLauncherRelease()
      const latest = rel.tag_name ?? ''
      const cur = parseSemver(current)
      const lat = parseSemver(latest)
      const hasUpdate = isNewer(lat, cur)
      const page = rel.html_url ?? 'https://github.com/kuaizhongqiang/dsh-launcher/releases/latest'
      if (!current) return { message: `launcher 未注册,无法得知当前版本;最新 Release:${latest}(${page})` }
      return hasUpdate
        ? { message: `发现新版本:当前 v${current.replace(/^v/, '')} → ${latest}(升级需主动确认;下载页 ${page})` }
        : { message: `launcher 已是最新(${current})。` }
    },
    presentCall: (a) => ({ card: 'generic', title: 'launcher_check_update', kind: 'read', rawInput: a }),
  }))
}
