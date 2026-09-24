/**
 * 会话归属与写权限（docs/dsh-cli-design.md §5）。
 *
 * 规则（主人拍板）：
 *   · CLI 自己维护「哪些 session 是 CLI 开的」记录；
 *   · `owner=cli`      → 可读可写；
 *   · `owner=foreign`  → **始终可读**；**运行中一律不可写**（空闲时可写）；
 *   · 记录丢失（换机/重装）→ 那些会话回退成 foreign，只读。
 *   · 写类工具遇到越界必须**硬失败**并说清原因，不静默降级。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './paths.js'

const REGISTRY = 'sessions.json'
const VERSION = 1

/** 归属记录文件路径。 */
export function registryPath() {
  return join(stateDir(), REGISTRY)
}

/** 读归属记录（缺失/损坏 → 空表，等价「全部是外来会话」）。 */
export function loadRegistry() {
  const file = registryPath()
  if (!existsSync(file)) return { version: VERSION, sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed?.version !== VERSION || typeof parsed.sessions !== 'object') return { version: VERSION, sessions: {} }
    return parsed
  } catch {
    return { version: VERSION, sessions: {} }
  }
}

/** 写归属记录（原子：先写临时文件再改名）。 */
export function saveRegistry(registry) {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  const file = registryPath()
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    // Windows 上目标被占用时退化为直写（内容仍完整）
    writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    rmSync(tmp, { force: true })
  }
  return registry
}

/** 认领：把某会话登记为 CLI 所有（新建会话时调用；用户显式 adopt 时也走这里）。 */
export function claim(sessionId, info = {}) {
  const registry = loadRegistry()
  registry.sessions[sessionId] = {
    claimedAt: new Date().toISOString(),
    cwd: info.cwd,
    purpose: info.purpose,
    dshVersion: info.dshVersion,
    adopted: info.adopted === true ? true : undefined,
  }
  saveRegistry(registry)
  return registry.sessions[sessionId]
}

/** 取消认领（从记录里删掉 → 该会话退回「外来只读」）。 */
export function forget(sessionId) {
  const registry = loadRegistry()
  const existed = sessionId in registry.sessions
  delete registry.sessions[sessionId]
  saveRegistry(registry)
  return existed
}

/** 归属：`cli` 或 `foreign`。 */
export function ownershipOf(sessionId, registry = loadRegistry()) {
  return sessionId in registry.sessions ? 'cli' : 'foreign'
}

/**
 * 写权限判定。
 * @param sessionId 目标会话
 * @param running 该会话现在是否在跑（由调用方用尾部事件判断）
 * @returns `{ writable, owner, reason }`；失败时 reason 是给人和机器看的原因
 */
export function writeVerdict(sessionId, running, registry = loadRegistry()) {
  const owner = ownershipOf(sessionId, registry)
  if (owner === 'cli') return { writable: true, owner }
  if (running) {
    return {
      writable: false,
      owner,
      reason: {
        code: 'readonly',
        message: `会话 ${sessionId} 不是 dshcli 开的，且正在运行 —— 只读（设计 §5：外来会话运行中不可写）`,
      },
    }
  }
  return { writable: true, owner, note: '外来会话但当前空闲，按约定允许写入' }
}

/** 越界就抛（硬失败）。 */
export function assertWritable(sessionId, running) {
  const verdict = writeVerdict(sessionId, running)
  if (!verdict.writable) {
    const error = new Error(verdict.reason.message)
    error.code = verdict.reason.code
    throw error
  }
  return verdict
}

/**
 * 判断「现在是否在跑」：先看我们自己的运行登记，再看会话尾部是否有未闭合的轮次。
 * @param tailEvents 该会话尾部事件（缺省不判，视为未知=不在跑）
 * @returns `{ running, why }`
 */
export function runState({ liveRuns, tailEvents } = {}) {
  if (liveRuns === true) return { running: true, why: 'dshcli 侧有未结束的运行' }
  if (!Array.isArray(tailEvents) || tailEvents.length === 0) return { running: false, why: 'no-events' }
  let open = 0
  let lastType = undefined
  let lastTime = 0
  for (const event of tailEvents) {
    if (event.type === 'turn/start') open += 1
    if (event.type === 'turn/end') open -= 1
    lastType = event.type
    if (typeof event.time === 'number') lastTime = Math.max(lastTime, event.time)
  }
  const stale = lastTime > 0 && Date.now() - lastTime > 10 * 60 * 1000
  if (open > 0 && !stale) return { running: true, why: `尾部有未闭合的轮次（最后事件 ${lastType}）` }
  if (open > 0 && stale) return { running: false, why: `有未闭合的轮次但已静默 ${Math.round((Date.now() - lastTime) / 60000)} 分钟` }
  return { running: false, why: `轮次已闭合（最后事件 ${lastType}）` }
}
