/**
 * 分段契约：把事件流投影成「一步一条」的记录（docs/dsh-cli-design.md §6.4）。
 *
 * 三条硬规则：
 *   1. 不裁 —— 记录里的事件 `data` **原样**带出，不做截断、不做摘要；
 *   2. 不塞二进制 —— 这里只搬事件；二进制内容由调用方按引用自取（见 tools 的 artifact.*）；
 *   3. 不丢事件 —— 不属于任何步的事件走 `between` 记录；流式分片平时已折进
 *      `assistant/message.stream`（只记计数），若某一步**没有**装配好的消息，则原样发出，绝不静默吞掉。
 */

const STREAM_TYPE = /chunk/i

/**
 * 事件流 → 记录数组。
 * @param events 会话事件（按 seq 升序；未排序会先排）
 * @returns `{ records, stats }`
 */
export function buildRecords(events) {
  const sorted = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  const records = []
  let open
  let chunkStats
  let between = []
  let streamAfterMessage = false

  const flushBetween = () => {
    if (between.length === 0) return
    records.push({
      kind: 'between',
      seqRange: [between[0].seq ?? 0, between[between.length - 1].seq ?? 0],
      events: between,
    })
    between = []
  }

  const closeStep = (seq) => {
    if (open === undefined) return
    open.toSeq = seq ?? open.toSeq
    open.seqRange = [open.fromSeq, open.toSeq]
    // 流式分片：有装配好的消息就不重复发（它们在 message.stream 里），只留计数
    if (streamAfterMessage) open.streamChunks = [0, 0, 0, 0].map((_, index) => chunkStats[index])
    else if (chunkStats.some((n) => n > 0)) open.cells.push(...streamCells)
    delete open.fromSeq
    delete open.toSeq
    records.push(open)
    open = undefined
    chunkStats = [0, 0, 0, 0]
    streamCells = []
    streamAfterMessage = false
  }

  let streamCells = []

  for (const event of sorted) {
    const type = event.type
    const data = event.data ?? {}
    if (STREAM_TYPE.test(type)) {
      chunkStats = chunkStats ?? [0, 0, 0, 0]
      chunkStats[chunkIndex(type)] += 1
      if (!streamAfterMessage) streamCells.push({ kind: 'stream', seq: event.seq, type, data })
      continue
    }
    if (type === 'step/start') {
      flushBetween()
      closeStep(event.seq)
      open = { kind: 'step', turn: data.turn, step: data.step, fromSeq: event.seq, toSeq: event.seq, cells: [] }
      chunkStats = [0, 0, 0, 0]
      streamCells = []
      streamAfterMessage = false
      continue
    }
    if (type === 'assistant/message' || type === 'assistant/attempt') {
      streamAfterMessage = type === 'assistant/message' || streamAfterMessage
      const cell = { kind: 'message', seq: event.seq, turn: data.turn, step: data.step, data }
      if (open !== undefined && data.turn === open.turn && data.step === open.step) open.cells.push(cell)
      else (open === undefined ? between : open.cells).push(cell)
      if (data.usage !== undefined && open !== undefined) open.usage = data.usage
      continue
    }
    if (type === 'tool/call') {
      const cell = { kind: 'tool_call', seq: event.seq, turn: data.turn, step: data.step, callId: data.callId, name: data.name, data }
      ;(open === undefined ? between : open.cells).push(cell)
      continue
    }
    if (type === 'tool/result') {
      const cell = { kind: 'tool_result', seq: event.seq, turn: data.turn, step: data.step, callId: data.callId, data }
      ;(open === undefined ? between : open.cells).push(cell)
      continue
    }
    if (type === 'step/end') {
      closeStep(event.seq)
      continue
    }
    // 其余一律不丢：挂到当前步（如果在本步内）或 between
    if (open !== undefined && data.turn === open.turn && data.step === open.step) open.cells.push({ kind: type, seq: event.seq, data })
    else between.push(event)
  }
  closeStep(sorted.length > 0 ? sorted[sorted.length - 1].seq : 0)
  flushBetween()

  records.sort((a, b) => a.seqRange[0] - b.seqRange[0])
  return { records, stats: summarizeRecords(records, sorted) }
}

function chunkIndex(type) {
  if (/reason/i.test(type)) return 0
  if (/text/i.test(type)) return 1
  if (/tool/i.test(type)) return 2
  return 3
}

/** 取增量：返回「结束 seq 大于游标」的记录（event.poll 用）。 */
export function recordsSince(records, cursorSeq) {
  const cursor = Number(cursorSeq ?? 0)
  return records.filter((record) => record.seqRange[1] > cursor)
}

/** 汇报素材用的聚合（report.facts 用；只做加法，不做摘要、不改内容）。 */
export function summarizeRecords(records, events) {
  const turns = new Set()
  const toolHistogram = {}
  const toolFailures = []
  let steps = 0
  let toolCalls = 0
  let betweenEvents = 0
  let usage = {}
  let first = Infinity
  let last = 0
  for (const record of records) {
    first = Math.min(first, record.seqRange[0])
    last = Math.max(last, record.seqRange[1])
    if (record.kind === 'between') {
      betweenEvents += record.events.length
      continue
    }
    if (record.kind !== 'step') continue
    steps += 1
    if (record.turn !== undefined) turns.add(record.turn)
    if (record.usage !== undefined) usage = addUsage(usage, record.usage)
    for (const cell of record.cells) {
      if (cell.kind === 'tool_call') {
        toolCalls += 1
        const name = String(cell.name ?? 'unknown')
        toolHistogram[name] = (toolHistogram[name] ?? 0) + 1
      }
      if (cell.kind === 'tool_result') {
        const failure = failureOf(cell.data)
        if (failure !== undefined) toolFailures.push({ seq: cell.seq, callId: cell.callId, ...failure })
      }
    }
  }
  const source = Array.isArray(events) ? events : []
  const times = source.map((event) => event.time).filter((time) => typeof time === 'number')
  return {
    turns: turns.size,
    steps,
    toolCalls,
    toolHistogram,
    toolFailures: toolFailures.slice(0, 50),
    toolFailureCount: toolFailures.length,
    betweenEvents,
    usage,
    eventCount: source.length,
    seqRange: first === Infinity ? [0, 0] : [first, last],
    startedAt: times.length > 0 ? Math.min(...times) : undefined,
    endedAt: times.length > 0 ? Math.max(...times) : undefined,
  }
}

/**
 * 一条 tool/result 的失败信息（校准过真实日志）。
 *
 * 实测 `tool/result.data` 只有三种键组合：
 *   `message,meta,step,turn`（305×，带呈现元数据）/ `message,step,turn`（216×）/ **`error,message,step,turn`（12× = 失败）**。
 * 即：**`error` 键出现即失败**；另保留若干保守启发式，兼容字段改名。
 * @returns `undefined`（成功）或 `{ code, message }`
 */
export function failureOf(data) {
  if (data === null || typeof data !== 'object') return undefined
  if (data.error !== undefined && data.error !== null) {
    const error = data.error
    if (typeof error === 'string') return { code: 'tool_error', message: error }
    return { code: String(error.code ?? error.name ?? 'tool_error'), message: String(error.message ?? JSON.stringify(error).slice(0, 500)) }
  }
  if (data.isError === true || data.ok === false || data.failed === true) {
    return { code: 'tool_error', message: String(data.reason ?? data.message?.content?.[0]?.text ?? '').slice(0, 500) }
  }
  const status = data.status ?? data.reason
  if (status === 'error' || status === 'failed' || status === 'denied') return { code: String(status), message: '' }
  return undefined
}

/** 兼容旧名（此前只返回布尔）。 */
export function looksFailed(data) {
  return failureOf(data) !== undefined
}

/** 累加任意形如 *token* 的数值字段（字段名以平台为准，这里只做加法，不猜语义）。 */
export function addUsage(total, usage) {
  const out = { ...total }
  const walk = (value, prefix) => {
    if (value === null || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      if (typeof item === 'number' && /token/i.test(key)) out[path] = (out[path] ?? 0) + item
      else if (item !== null && typeof item === 'object') walk(item, path)
    }
  }
  walk(usage, '')
  return out
}
