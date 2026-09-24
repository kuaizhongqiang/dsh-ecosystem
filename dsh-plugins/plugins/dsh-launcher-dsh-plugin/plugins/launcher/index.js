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
import { createHash } from 'node:crypto'
import { existsSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
const restartIntentPath = () => join(dshHome(), '.dsh-restart-intent.json')

function readJson(file) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 重启意图(%DSH_HOME%\.dsh-restart-intent.json):launcher_restart 触发前落盘,供重启后恢复工作。 */
const readRestartIntent = () => readJson(restartIntentPath())

/** 原子写重启意图(内容无任何 token,红线 D2 合规)。失败不致命:重启照常委托。 */
function writeRestartIntent(reason) {
  const target = restartIntentPath()
  const tmp = `${target}.tmp-${Math.floor(Math.random() * 1e6)}`
  try {
    mkdirSync(dshHome(), { recursive: true })
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, requestedAt: new Date().toISOString(), reason: String(reason ?? ''), byPid: process.pid }, null, 2) + '\n',
      'utf8',
    )
    renameSync(tmp, target)
  } catch {
    /* 意图落盘失败不致命 */
  }
}

/** 清除重启意图(恢复确认后调用)。 */
function clearRestartIntent() {
  try { rmSync(restartIntentPath(), { force: true }) } catch { /* ignore */ }
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

/**
 * 工具输出必须是「无损 JSON」:dsh 侧按**自有属性**校验工具结果,值为 `undefined` 的键会被
 * 判为非法输出(JSON.stringify 只是静默丢键,救不了 —— 见 issue #30:launcher_status 因此 100% 不可用)。
 * 这里在返回前递归清洗:对象剔除 undefined 属性,数组把 undefined 项收窄为 null,
 * NaN/Infinity 归一为 null(Date 转 ISO,不留空壳对象)。
 */
function jsonSafe(value) {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((v) => {
    const safe = jsonSafe(v)
    return safe === undefined ? null : safe
  })
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      const safe = jsonSafe(value[key])
      if (safe !== undefined) out[key] = safe
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined
  return value
}

/** 连接对象脱敏:剔除 token 键(D2 红线:token 不出本机、输出不回显)。 */
function stripToken(conn) {
  if (!conn || typeof conn !== 'object') return conn
  const { token: _token, ...rest } = conn
  return rest
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
  // 用 AbortSignal.timeout 而不是「自制定时器 + ctrl.abort()」：后者在超时时会把 AbortError
  // 抛成未捕获异常（实测能直接把 dsh 进程带崩），这里让 fetch 自己拒绝即可。
  const resp = await fetch('https://api.github.com/repos/kuaizhongqiang/dsh-launcher/releases/latest', {
    headers: { 'User-Agent': 'dsh-launcher-plugin', Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  })
  if (resp.status !== 200) throw new Error(`GitHub API ${resp.status}`)
  return await resp.json()
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

// --- dsh-cli（L1.5 入口层）的安装 / 更新入口 ---------------------------------
// 主人 2026-09-24 追加要求：launcher 必须同时具备 dsh-cli 的【安装入口】与【更新入口】。
// 设计：单文件产物由伞仓 Release 提供；**按平台选资产名**（0.11.4 起同时提供 Linux）：
//   win32  → dshcli.exe / dshcli-<ver>.exe（历史名，保持不变）
//   linux  → dshcli-linux-<arch> / dshcli-<ver>-linux-<arch>
//   darwin → dshcli-darwin-<arch> / dshcli-<ver>-darwin-<arch>（CI 尚未产出，调用时给明确提示）
//      安装落 %DSH_HOME%/bin/dshcli[.exe]，非 Windows 需补可执行位；
//      旁边留一份 dshcli.install.json 记版本/大小/来源（**不含任何 token**）。

const CLI_REPO = 'kuaizhongqiang/dsh-ecosystem'

function cliBinDir() {
  return join(dshHome(), 'bin')
}

/** 平台后缀：'linux-x64' / 'win-x64' / 'darwin-arm64'；未知平台返回 undefined。 */
function cliPlatformTag() {
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined
  return os === undefined ? undefined : `${os}-${process.arch}`
}

/** 本平台缺少预编译产物时的统一提示（不要静默下错平台的包）。 */
function cliNoAssetError(tag) {
  return new Error(
    `launcher_cli: 本平台（${process.platform}/${process.arch}）暂无预编译 dsh-cli 单文件产物`
    + `${tag === undefined ? '' : `（缺资产 dshcli-${tag}）`}；`
    + '请改用 npm 安装：npm i -g @kuaizhongqiang/dsh-cli',
  )
}

function cliExePath() {
  return join(cliBinDir(), process.platform === 'win32' ? 'dshcli.exe' : 'dshcli')
}

function cliStatePath() {
  return join(cliBinDir(), 'dshcli.install.json')
}

/** 稳定资产名（release 的 `latest/download/` 下那个）。 */
function cliStableAsset(tag) {
  return process.platform === 'win32' ? 'dshcli.exe' : `dshcli-${tag}`
}

/** 带版本资产名。 */
function cliVersionedAsset(tag, bare) {
  return process.platform === 'win32' ? `dshcli-${bare}.exe` : `dshcli-${bare}-${tag}`
}

/** 安装来源：默认伞仓 Release 的稳定资产名；给了 version 就用带版本的那个。 */
function cliAssetUrl(version) {
  const tag = cliPlatformTag()
  if (tag === undefined) throw cliNoAssetError(tag)
  if (version === undefined) return `https://github.com/${CLI_REPO}/releases/latest/download/${cliStableAsset(tag)}`
  const ref = String(version).startsWith('v') ? String(version) : `v${version}`
  return `https://github.com/${CLI_REPO}/releases/download/${ref}/${cliVersionedAsset(tag, ref.replace(/^v/, ''))}`
}

/**
 * 问一次最新 Release 里的 dsh-cli 版本号（带平台后缀的资产名是权威来源）。
 * 失败不抛：返回 undefined，调用方退回「稳定资产名 + version 记 latest」的兜底路径。
 */
async function latestCliVersion() {
  const tag = cliPlatformTag()
  if (tag === undefined) return undefined
  try {
    const resp = await fetch(`https://api.github.com/repos/${CLI_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'dsh-launcher-plugin', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (resp.status !== 200) return undefined
    const release = await resp.json()
    const pattern = process.platform === 'win32'
      ? /^dshcli-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.exe$/i
      : new RegExp(`^dshcli-(\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)-${tag}$`, 'i')
    for (const asset of release.assets ?? []) {
      const m = pattern.exec(String(asset.name ?? ''))
      if (m !== null) return m[1]
    }
    return undefined
  } catch {
    // 网络不通/超时/限流都不该让安装失败：退回稳定资产名，版本靠装完后问 exe
    return undefined
  }
}

/** 直接问装好的 dshcli 自己的版本（`version --json` 是我们自己的契约，最可靠）。 */
function probeCliVersion(exe) {
  try {
    const run = spawnSync(exe, ['version', '--json'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    if (run.status !== 0 || typeof run.stdout !== 'string') return undefined
    const parsed = JSON.parse(run.stdout)
    return typeof parsed?.dshcli === 'string' && parsed.dshcli !== '' ? parsed.dshcli : undefined
  } catch {
    return undefined
  }
}

/**
 * 装完把技能说明落到 exe 同级（正文在 exe 里内嵌着，这里只是让它落盘）。
 * 失败**不影响** exe 安装结果，只如实报出来（别让技能问题挡住安装）。
 */
function installCliSkill(exe) {
  try {
    const run = spawnSync(exe, ['skill', '--install', '--json'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    if (run.status !== 0) {
      return { ok: false, reason: `exit ${run.status}: ${String(run.stderr ?? '').trim().slice(0, 200)}` }
    }
    const parsed = JSON.parse(String(run.stdout ?? '{}'))
    return { ok: true, path: parsed.path, bytes: parsed.bytes, changed: parsed.changed === true }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) }
  }
}

/** dsh-cli 现在什么状态（纯本地读，不触网）。 */
function cliState() {
  const exe = cliExePath()
  const installed = existsSync(exe)
  const state = readJson(cliStatePath()) ?? {}
  return {
    installed,
    path: exe,
    version: state.version,
    bytes: installed ? statSyncSafe(exe) : undefined,
    installedAt: state.installedAt,
    source: state.source,
    state,
  }
}

function statSyncSafe(file) {
  try {
    // 只在需要时报大小；单独包一层免得把 fs 依赖撒得到处都是
    return readFileSync(file).length
  } catch {
    return undefined
  }
}

/** 下载或复制一个 exe 到临时文件（from 可为本地路径或 http(s) URL）。 */
async function fetchCliAsset({ from, version }) {
  const source = from ?? cliAssetUrl(version)
  if (/^https?:\/\//i.test(source)) {
    try {
      const resp = await fetch(source, {
        headers: { 'User-Agent': 'dsh-launcher-plugin', Accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(300000),
      })
      if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}（${source}）`)
      return { bytes: Buffer.from(await resp.arrayBuffer()), source }
    } catch (error) {
      throw new Error(`下载 dsh-cli 失败：${error?.message ?? error}（来源 ${source}）`)
    }
  }
  const local = source.replace(/^file:\/\//i, '')
  if (!existsSync(local)) throw new Error(`本地来源不存在：${local}`)
  return { bytes: readFileSync(local), source }
}

/** 安装/更新本体：下载 → 备份旧 exe → 替换 → 记状态。 */
async function installCli({ from, version, force }) {
  const target = cliExePath()
  const dir = cliBinDir()
  mkdirSync(dir, { recursive: true })
  const before = existsSync(target) ? readJson(cliStatePath()) : undefined
  // 版本号必须**记真实的**，否则 update 无从比对：显式 version > 从最新 Release 资产名里读 > 兜底 'latest'
  const resolved = version ?? (from === undefined ? await latestCliVersion() : undefined)
  const wanted = resolved ?? from ?? 'latest'
  if (before?.version !== undefined && resolved !== undefined && before.version === String(resolved).replace(/^v/, '') && force !== true) {
    return jsonSafe({ updated: false, version: before.version, path: target, bytes: statSyncSafe(target), hint: '版本相同，未重装（force=true 可强制）' })
  }
  const { bytes, source } = await fetchCliAsset({ from, version: resolved })
  if (bytes.length < 1024) throw new Error(`来源看起来不是可执行文件（仅 ${bytes.length} 字节）：${source}`)
  const staging = `${target}.download-${Date.now()}`
  writeFileSync(staging, bytes)
  let backedUp
  if (existsSync(target)) {
    backedUp = `${target}.bak-${Date.now()}`
    try {
      renameSync(target, backedUp)
    } catch (error) {
      rmSync(staging, { force: true })
      throw new Error(`替换失败：${target} 可能正在使用（先停掉 dshcli 再试）：${error.message}`)
    }
  }
  renameSync(staging, target)
  // 非 Windows 必须补可执行位：否则下载完直接跑会 EACCES（这正是 Linux 上「装了但不能用」的成因之一）
  if (process.platform !== 'win32') chmodSync(target, 0o755)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  // 版本优先用「问 exe」得到的真实值（Release API 挂了也不影响记准版本）
  const probed = probeCliVersion(target)
  const state = { version: probed ?? String(wanted).replace(/^v/, ''), bytes: bytes.length, sha256, source, installedAt: new Date().toISOString(), platform: process.platform }
  writeFileSync(cliStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return jsonSafe({ updated: true, version: state.version, path: target, bytes: state.bytes, sha256, backedUp, source })
}

export function apply(ctx) {
  // --- launcher_status -----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'launcher_status',
    description: 'launcher / dsh 运行态汇总:launcher 注册(版本/exe/pid/心跳/api)、激活连接(本地端口或 remote)、'
      + 'launch-token 状态、上次重启意图(%DSH_HOME%\\.dsh-restart-intent.json,重启后待恢复的提示)。'
      + 'clearRestartIntent=true 时在报告后清除该意图文件(确认恢复完成)。排查「重启/连接/升级」问题前先调用。',
    parameters: {
      clearRestartIntent: { type: 'boolean', description: '可选:报告后确认并清除重启意图文件(默认 false)' },
    },
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
    async execute(args) {
      const reg = readJson(registrationPath())
      const { active, list, fromFile } = resolveActiveConnection()
      const token = readJson(launchTokenPath())
      const intent = readRestartIntent()
      const cleared = !!(args?.clearRestartIntent && intent)
      if (cleared) clearRestartIntent()
      // 意图是否早于本进程启动(即本进程是重启后的实例 → 提示「待恢复」)
      const procStartMs = Date.now() - process.uptime() * 1000
      const intentAt = Date.parse(intent?.requestedAt ?? '')
      const preProcess = intent ? !Number.isNaN(intentAt) && intentAt < procStartMs : false
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
        connection: { fromFile, active: stripToken(active), count: list.length },
        launchToken: token
          ? { present: true, port: token.port, url: redact(token.url), managedBy: token.managedBy ?? '' }
          : { present: false },
        restartIntent: intent
          ? {
              present: true,
              preProcess,
              requestedAt: intent.requestedAt ?? '',
              reason: intent.reason ?? '',
              byPid: intent.byPid,
            }
          : { present: false },
        dshPid: process.pid,
      }
      const l = detail.launcher
      let summary = l.present
        ? `launcher v${l.version}(${l.running ? '运行中' : '未运行'},pid ${l.pid}${l.pidAlive ? ' 存活' : ' 已退出'}${l.fresh ? ',心跳新鲜' : ',心跳陈旧'})`
        : 'launcher 未注册(发现链不可用,重启需手动)'
      summary += `;激活连接 ${active.id}(${active.kind}${active.kind === 'local' ? ':' + active.port : ''})`
      if (intent) {
        const why = String(intent.reason ?? '').slice(0, 60) || '(未说明)'
        summary += preProcess
          ? `;⚠️ 上次重启意图:${why} —— 重启后待恢复:先 update_goal resume 再继续被中断的工作`
          : `;存在重启意图:${why}`
      }
      if (cleared) summary += ';重启意图已确认并清除'
      // 出口统一清洗(issue #30):值为 undefined 的键会被 dsh 判为非法输出,工具整条失效
      return { summary, detail: jsonSafe(detail) }
    },
    presentCall: (a) => ({ card: 'generic', title: 'launcher_status', kind: 'read', rawInput: a }),
  }))

  // --- launcher_restart ----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'launcher_restart',
    description: '重启 dsh(按 D6 发现链委托 launcher:环境变量/注册文件的 REST bridge 优先,其次 <launcherExe> restart)。'
      + '触发前把 reason 写入 %DSH_HOME%\\.dsh-restart-intent.json(重启编排 seam:重启会杀掉本进程与进行中的回合/后台任务,'
      + '恢复会话后用 launcher_status 查看意图、update_goal resume 后继续未完成工作)。'
      + '优雅停止→等端口释放→重抓 token 照写 launch-token.json,30 天 cookie 下重启后免手动重登;'
      + '激活连接为 remote 时=重连/重开浏览器。发现链不可用时给出手动重启指引。',
    parameters: {
      reason: { type: 'string', description: '可选:重启原因/重启后要恢复的工作摘要(写入重启意图文件,重启后待恢复提示用)' },
    },
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
    async execute(args) {
      writeRestartIntent(args?.reason)
      const channel = await resolveRestartChannel()
      const resumeHint = '重启意图已记录(.dsh-restart-intent.json);重启会中断本进程——恢复会话后先 launcher_status 查看意图,'
        + '再 update_goal resume 继续被中断的工作。'
      if (channel.mode === 'bridge') {
        const r = await callBridge(channel.reg)
        if (r.status === 202) return { mode: 'bridge', message: `已转交运行中的 launcher(${redact(channel.reg.api)})执行 restart,进度见 launcher 日志;约数秒后生效。${resumeHint}` }
        if (r.status === 409) return { mode: 'bridge', message: 'launcher 已在执行 restart,请稍候再查状态。' }
        if (r.status === 403) throw new Error('launcher_restart: bridgeKey 校验失败(注册文件与 launcher 不匹配?),可改用 launcher_check_update/手动重启。')
        throw new Error(`launcher_restart: REST bridge 返回 ${r.status};可尝试手动重启。`)
      }
      const pid = spawnExeRestart(channel.exe)
      return { mode: 'exe', message: `已拉起 "${channel.exe}" restart(PID ${pid});CLI 经单实例检测转交运行中的 launcher。${resumeHint}` }
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

  // --- launcher_cli（dsh-cli 的安装 / 更新入口） ------------------------------
  // 主人 2026-09-24 追加要求:launcher 要能给 dsh-cli 提供安装入口与更新入口。
  ctx.tools.register(defineTool({
    name: 'launcher_cli',
    description: '管理 dsh-cli（终端 CLI + 本机工具服务:让别的 agent 能调 dsh 执行任务）。'
      + 'action=status 看是否已安装/版本/路径（纯本地读,不触网）;'
      + 'action=install 安装或重装（默认从伞仓 GitHub Release 取稳定资产 dshcli.exe;可给 version 指定版本,'
      + '或给 from 用本地 exe / 私有 URL）;action=update 检查并升级（版本相同不重复下载,force=true 可强装）;'
      + 'action=start 拉起 dshcli serve。安装前会把旧 exe 备份成 dshcli.exe.bak-<时间戳>。',
    parameters: {
      action: { type: 'string', description: '必填:status | install | update | start', required: true },
      version: { type: 'string', description: '可选:目标版本(如 0.11.0);缺省取最新 Release' },
      from: { type: 'string', description: '可选:自定义来源(本地 exe 路径或 http(s) URL),内网/离线用' },
      force: { type: 'boolean', description: '可选:版本相同也重装(默认 false)' },
      skill: { type: 'boolean', description: '可选:是否顺带把技能说明(dshcli.SKILL.md)落到 exe 同级(默认 true)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, description: '执行的动作' },
          summary: { type: 'string', required: true, description: '一句话结论' },
          installed: { type: 'boolean', description: '是否已安装' },
          version: { type: 'string', description: '版本' },
          path: { type: 'string', description: 'exe 路径' },
          bytes: { type: 'number', description: '文件大小' },
          updated: { type: 'boolean', description: '本次是否发生安装/替换' },
          backedUp: { type: 'string', description: '旧 exe 备份路径' },
          source: { type: 'string', description: '安装来源' },
          sha256: { type: 'string', description: '安装包 sha256' },
          started: { type: 'boolean', description: '是否已拉起 serve' },
          pid: { type: 'number', description: '拉起后的进程 id' },
          hint: { type: 'string', description: '提示' },
          skillOk: { type: 'boolean', description: '技能说明是否已就位(install/update 时)' },
          skillPath: { type: 'string', description: '技能说明文件路径' },
          skillReason: { type: 'string', description: '技能落盘失败原因(成功时不带)' },
          state: { type: 'object', description: '安装状态文件内容' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary }],
    },
    async execute(args) {
      const action = String(args.action ?? '').toLowerCase()
      if (action === 'status') {
        const s = cliState()
        return jsonSafe({
          action,
          installed: s.installed,
          version: s.version,
          path: s.path,
          bytes: s.bytes,
          state: s.state,
          hint: s.installed ? undefined : '安装来源默认是伞仓 Release 的 dshcli.exe',
          summary: s.installed
            ? `dsh-cli 已安装:${s.version ?? '版本未知'}(${s.path},${s.bytes ?? '?'} 字节)`
            : `dsh-cli 未安装(预期位置 ${s.path});用 launcher_cli action=install 安装`,
        })
      }
      if (action === 'install' || action === 'update') {
        const result = await installCli({ from: args.from, version: args.version, force: args.force === true })
        // 技能与 exe 同级:装完顺手让它落盘(exe 自带正文);skill=false 可关
        const skill = args.skill === false || result.updated !== true ? undefined : installCliSkill(result.path)
        const skillNote = skill === undefined
          ? (args.skill === false ? ';技能未处理(skill=false)' : '')
          : skill.ok
            ? `;技能已就位(${skill.path})`
            : `;技能落盘失败(${skill.reason})`
        return jsonSafe({
          action,
          installed: true,
          version: result.version,
          path: result.path,
          bytes: result.bytes,
          updated: result.updated,
          backedUp: result.backedUp,
          source: result.source,
          sha256: result.sha256,
          hint: result.hint,
          skillOk: skill === undefined ? undefined : skill.ok,
          skillPath: skill?.path,
          skillReason: skill?.ok === true ? undefined : skill?.reason,
          summary: `${result.updated
            ? `${action === 'install' ? '安装' : '升级'}完成:dsh-cli ${result.version}(${result.path})`
            : `已是最新(${result.version}),未重装`}${skillNote}`,
        })
      }
      if (action === 'start') {
        const s = cliState()
        if (!s.installed) {
          return jsonSafe({ action, installed: false, started: false, path: s.path, summary: 'dsh-cli 未安装,无法启动;先 install', hint: 'launcher_cli action=install' })
        }
        const child = spawn(s.path, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        return jsonSafe({
          action,
          installed: true,
          started: true,
          pid: child.pid,
          version: s.version,
          path: s.path,
          summary: `已拉起 dshcli serve(pid ${child.pid});token 见 %DSH_HOME%\\dsh-cli\\endpoint.json`,
        })
      }
      return jsonSafe({ action, summary: `未知 action:${action}(可用 status | install | update | start)`, hint: 'action 必须是 status | install | update | start' })
    },
    presentCall: (a) => ({ card: 'generic', title: `launcher_cli ${a.action}`, kind: 'execute', rawInput: a }),
  }))
}
