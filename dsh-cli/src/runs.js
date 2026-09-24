/**
 * 任务登记（我们自己的）：taskId → 会话/工作目录/状态/out。
 * 这是 `task.*` 与 `event.poll` 的锚点，也是「CLI 侧是否存在未结束的运行」的来源。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { stateDir } from './paths.js'

const FILE = 'runs.json'
const VERSION = 1

/** 进程内保存 live 子进程（重启后自然消失；记录里的 status 会显示 interrupted）。 */
export const liveChildren = new Map()

/** 生成任务 id。 */
export function newTaskId() {
  return `task-${randomUUID().slice(0, 8)}`
}

/** 读任务表。 */
export function loadRuns() {
  const file = join(stateDir(), FILE)
  if (!existsSync(file)) return { version: VERSION, runs: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed?.version !== VERSION || typeof parsed.runs !== 'object') return { version: VERSION, runs: {} }
    return parsed
  } catch {
    return { version: VERSION, runs: {} }
  }
}

/** 写任务表。 */
export function saveRuns(state) {
  mkdirSync(stateDir(), { recursive: true })
  const file = join(stateDir(), FILE)
  const body = { ...state, version: VERSION }
  writeFileSync(`${file}.tmp-${process.pid}`, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  return body
}

/** 新建/更新一个任务条目。 */
export function upsertRun(taskId, patch) {
  const state = loadRuns()
  state.runs[taskId] = { ...(state.runs[taskId] ?? {}), ...patch }
  saveRuns(state)
  return state.runs[taskId]
}

/** 取一个任务条目。 */
export function getRun(taskId) {
  return loadRuns().runs[taskId]
}

/** 列任务（按开始时间倒序）。 */
export function listRuns(options = {}) {
  const rows = Object.values(loadRuns().runs)
  rows.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
  return options.limit === undefined ? rows : rows.slice(0, options.limit)
}

/** 是否有未结束的 live 运行（归属判定用）。 */
export function hasLiveRun(sessionId) {
  for (const [taskId, child] of liveChildren) {
    const run = getRun(taskId)
    if (run?.sessionId === sessionId && child !== undefined) return true
  }
  return false
}
