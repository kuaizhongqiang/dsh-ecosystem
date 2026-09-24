/**
 * 会话日志读取 —— 我们的「唯一真源」通道。
 *
 * dsh 每个会话一个目录，事件日志文件名随上游版本演进（issue #54）：
 *   session.v3.jsonl.zstd  当前格式（上游 v3 起；头部带 `"version":3`，同一文件内含会话头）
 *   session.v2.jsonl.zstd  旧版会话头（id/cwd/createdAt/agentPreset…，通常单帧、很小）
 *   session.jsonl.zstd     旧版事件日志（多帧 zstd，每批 append 一帧）
 * 一律按候选列表取「第一个存在的文件」，避免上游改名后静默读不到任何新会话。
 *
 * 我们**直接读事件日志**，不走 `dsh --profile headless --json` —— 后者会把每条事件裁到
 * 8KiB/32KiB（见 docs/dsh-cli-design.md §6.4），而契约要求「不裁」。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decompressFrames, decompressFramesFrom, walkFrames } from './zstd-frames.js'
import { listProjectDirs, sessionsRoot } from './paths.js'

const HEADER_FILES = ['session.v3.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.jsonl.zstd']
const LOG_FILES = ['session.v3.jsonl.zstd', 'session.jsonl.zstd']

/** 读会话头（小文件，单帧）。文件缺失/损坏返回 undefined。 */
export function readSessionHeader(dir) {
  for (const name of HEADER_FILES) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    try {
      const text = decompressFrames(readFileSync(file)).toString('utf8')
      const first = text.split(/\r?\n/).find((line) => line.trim() !== '')
      if (first === undefined) continue
      const record = JSON.parse(first)
      if (record?.type === 'session' && typeof record.id === 'string') return record
    } catch {
      // 换下一个候选文件
    }
  }
  return undefined
}

/** 某个会话目录下的日志文件路径（不存在则 undefined）。 */
export function logFileOf(dir) {
  return LOG_FILES.map((name) => join(dir, name)).find((file) => existsSync(file))
}

/**
 * 列出会话（扫所有项目目录，按会话头里的 cwd 过滤）。
 * @param options.cwd 只列该工作目录下的会话（缺省=全部）
 * @param options.limit 最多返回多少个（按 createdAt 倒序）
 */
export function listSessions(options = {}) {
  const wanted = options.cwd === undefined ? undefined : String(options.cwd).toLowerCase()
  const rows = []
  for (const project of listProjectDirs()) {
    const projectDir = join(sessionsRoot(), project)
    let entries = []
    try {
      entries = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(projectDir, entry.name)
      const header = readSessionHeader(dir)
      if (header === undefined) continue
      if (wanted !== undefined && String(header.cwd ?? '').toLowerCase() !== wanted) continue
      const logFile = logFileOf(dir)
      rows.push({
        sessionId: header.id,
        cwd: header.cwd,
        createdAt: header.createdAt,
        agentPreset: header.agentPreset,
        delegationDepth: header.delegationDepth ?? 0,
        project,
        dir,
        logFile,
        logBytes: logFile === undefined ? 0 : statSync(logFile).size,
      })
    }
  }
  rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return options.limit === undefined ? rows : rows.slice(0, options.limit)
}

/** 按 sessionId 找会话（可给 cwd 缩小范围）。 */
export function findSession(sessionId, cwd) {
  return listSessions({ cwd }).find((row) => row.sessionId === sessionId)
}

/**
 * 读一个会话的事件日志。
 * @returns `{ events, frameCount }`；日志缺失时 `events: []`
 */
export function readEvents(dir, options = {}) {
  const file = logFileOf(dir)
  if (file === undefined) return { events: [], frameCount: 0 }
  const buffer = readFileSync(file)
  if (options.fromFrame !== undefined) {
    const { text, frameCount } = decompressFramesFrom(buffer, options.fromFrame)
    return { events: parseEvents(text), frameCount }
  }
  const frameCount = walkFrames(buffer).length
  return { events: parseEvents(decompressFrames(buffer).toString('utf8')), frameCount }
}

/** 增量读：从某个帧下标开始取事件（帧就是天然的检查点）。 */
export function readEventsFromFrame(dir, fromFrame) {
  return readEvents(dir, { fromFrame })
}

/**
 * 读会话**尾部**事件 —— 判断「现在是不是处于一个未结束的轮次」要的很便宜：
 * 帧是天然检查点，从最后一帧往前找够 maxEvents 条即可，不用解整个日志。
 * @returns 事件数组（按 seq 升序）
 */
export function readTailEvents(dir, maxEvents = 40) {
  const file = logFileOf(dir)
  if (file === undefined) return []
  let frames
  try {
    frames = walkFrames(readFileSync(file))
  } catch {
    return []
  }
  const collected = []
  for (let index = frames.length - 1; index >= 0 && collected.length < maxEvents; index -= 1) {
    const frame = frames[index]
    let text
    try {
      text = decompressFrames(readFileSync(file).subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      continue
    }
    const batch = parseEvents(text)
    collected.unshift(...batch)
  }
  return collected.slice(-maxEvents)
}

/** 明文 → 事件数组（坏行跳过但计数，便于诊断）。 */
function parseEvents(text) {
  const events = []
  let badLines = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line)
      if (record !== null && typeof record === 'object' && typeof record.type === 'string') {
        // v3 起会话头与事件写在**同一个**文件里（首行是 `type:'session'`、没有 seq）。
        // 它是会话头不是事件，必须剔除，否则会被算进事件条数 / between / seqRange。
        if (record.type === 'session' && typeof record.seq !== 'number') continue
        events.push(record)
      } else badLines += 1
    } catch {
      badLines += 1
    }
  }
  if (badLines > 0) Object.defineProperty(events, 'badLines', { value: badLines, enumerable: false })
  return events
}
