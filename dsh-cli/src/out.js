/** 任务终结产出 `out` 的契约与 JSON 安全化（docs/dsh-cli-design.md §6.1/§6.2）。 */

/**
 * 工具输出必须是「无损 JSON」：dsh 侧（以及调用方）都会把含 `undefined` 值的结果判为非法。
 * 这里递归剔除 `undefined` 属性、把数组里的空洞与非有限数归一为 null。
 */
export function jsonSafe(value) {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value.map((item) => {
      const safe = jsonSafe(item)
      return safe === undefined ? null : safe
    })
  }
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

/** `out.status` 的取值（调用方按这个判断，不要看文本）。 */
export const OUT_STATUS = ['ok', 'failed', 'timeout', 'cancelled', 'readonly', 'unavailable']

/**
 * 组装 `out`（同步/异步同形）。
 * @param fields 允许缺省，缺的键不会出现在结果里（jsonSafe 兜底）
 */
export function makeOut(fields) {
  const out = {
    status: fields.status,
    text: fields.text ?? '',
    sessionId: fields.sessionId,
    taskId: fields.taskId,
    turn: fields.turn,
    artifacts: fields.artifacts ?? [],
    usage: fields.usage,
    error: fields.error,
    degraded: fields.degraded ?? [],
    seqRange: fields.seqRange,
    startedAt: fields.startedAt,
    endedAt: fields.endedAt,
  }
  if (!OUT_STATUS.includes(out.status)) throw new Error(`out.status 非法：${out.status}`)
  return jsonSafe(out)
}
