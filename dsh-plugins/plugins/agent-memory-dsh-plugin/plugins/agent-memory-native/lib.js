/**
 * lib.js — agent-memory 原生插件的**纯逻辑层**（零 dsh 依赖，可独立测试）
 *
 * 三块：
 *   1. 裸 HTTP 客户端：MemoryCore v3（主记忆）+ MemoryKnowledge v3（代码图谱）
 *   2. 身份/隔离：team/agent/user 三元组 + task_id（项目级标签，禁止身份前缀）
 *   3. 进程内自动入库：turn/end → L0，去重游标与 autostore 守护共用同一份 state 文件
 *
 * `index.js` 只负责把它接到 cordis（Config / defineTool / ctx.on），本文件可用
 * `node selftest.mjs` 对着 mock 或**真实引擎**直接验证。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_META_TTL_MS = 60_000

/** 身份 id 前缀白名单：这些永远不能当 task_id（项目级标签）用。 */
export const IDENTITY_PREFIXES = /^(agt-|team-|usr-|uky-|sk-mem-|sk-|key-)/i

/**
 * 解析一个凭证值，优先级：内联值 > 官方凭证 seam（按 ref 解析）> 同名环境变量。
 * 纯函数式（seam/brand/env 全部注入），因此可在 selftest 里离线验证。
 * @returns `{ value, source }`，source ∈ inline | seam | env | none
 */
export async function resolveSecretValue({
  ref,
  inline,
  service,
  brand = (name) => name,
  env = process.env,
  warn = () => {},
} = {}) {
  // 优先级：凭证 seam（ref）> 同名环境变量 > 内联值（向后兼容/兜底）。
  // 这样 ref 一旦配置就自动生效（在 .credentials.yaml 里轮换 key 无需改 patch），
  // 而旧配置里的内联值仍然可用，切换期不会中断。
  if (ref) {
    if (service?.resolve) {
      try {
        const resolved = await service.resolve(brand(ref))
        if (resolved?.value) return { value: resolved.value, source: resolved.source ?? 'seam' }
      } catch (err) {
        warn(`凭证 ref ${ref} 解析失败（继续回落 env/内联）：${err.message}`)
      }
    }
    const fromEnv = env?.[ref]
    if (fromEnv) return { value: fromEnv, source: 'env' }
  }
  if (inline) return { value: inline, source: 'inline' }
  return { value: undefined, source: 'none' }
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function defaultStatePath() {
  return process.env.DSH_AUTOSTORE_STATE || join(dshHome(), '.dsh-memory-autostore-state.json')
}

const jsonText = (value) => JSON.stringify(value, null, 2)
export { jsonText }

/** 会话消息内容块 → 纯文本（与 autostore 守护同一口径）。 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

export function clampInt(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return undefined
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

/**
 * 一次 JSON POST：统一超时、envelope 校验（code !== 0 视为失败）。
 * @returns envelope.data（无 data 时返回原 JSON；空响应返回 null）
 */
export async function httpPost(base, path, body, headers, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${String(base).replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await res.text()
    let json = null
    try {
      json = raw ? JSON.parse(raw) : null
    } catch {
      json = null
    }
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${raw.slice(0, 300)}`)
    if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
      throw new Error(`${path} code=${json.code} message=${json.message ?? ''}`)
    }
    return json && typeof json === 'object' && 'data' in json ? json.data : json
  } finally {
    clearTimeout(timer)
  }
}

/** task_id：显式配置优先，否则取会话 cwd 目录名；两者都拒绝身份前缀。 */
export function resolveTaskId(config, cwd) {
  const explicit = String(config.taskId ?? '').trim()
  if (explicit) {
    if (IDENTITY_PREFIXES.test(explicit)) {
      throw new Error(
        `task_id '${explicit}' 是身份 id（agt-/team-/usr-/sk-mem-…）；task_id 必须是项目级标签（如仓库/项目名）。`,
      )
    }
    return explicit
  }
  const base = String(cwd ?? '').split(/[\\/]/).filter(Boolean).pop()
  return base && base.trim() ? base.trim() : 'default'
}

/** 回显当前隔离域（不含任何 key），让调用方明确本次落在哪个 (team, agent, user, task)。 */
export function contextEcho(config, cwd, serviceId) {
  const echo = {
    team_id: config.teamId,
    agent_id: config.agentId,
    user_id: config.userId,
    service_id: serviceId ?? config.serviceId ?? 'default',
  }
  try {
    echo.task_id = resolveTaskId(config, cwd)
  } catch {
    echo.task_id = config.taskId
  }
  return echo
}

// ───────────────────────── 主记忆：MemoryCore v3 ─────────────────────────

export function createMemoryClient(config) {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const serviceId = config.serviceId ?? 'default'
  const base = String(config.memoryEndpoint ?? '').trim()

  const require_ = () => {
    const missing = []
    if (!base) missing.push('memoryEndpoint')
    if (!config.apiKey) missing.push('apiKey')
    if (!config.teamId) missing.push('teamId')
    if (!config.agentId) missing.push('agentId')
    if (!config.userId) missing.push('userId')
    if (missing.length) {
      throw new Error(`agent-memory 未配置：${missing.join(', ')}（在 cordis.patch.yml 的 tool-agent-memory.config 里填）`)
    }
  }

  const headers = () => ({ Authorization: `Bearer ${config.apiKey}`, 'x-tdai-service-id': serviceId })

  const isoBody = (cwd, extra = {}) => ({
    team_id: config.teamId,
    agent_id: config.agentId,
    user_id: config.userId,
    task_id: resolveTaskId(config, cwd),
    ...extra,
  })

  const call = (path, body) => httpPost(base, path, body, headers(), timeoutMs)

  return {
    configured: () => Boolean(base && config.apiKey && config.teamId && config.agentId && config.userId),
    addConversation(messages, sessionId, cwd) {
      require_()
      if (!sessionId) throw new Error('store_memory 需要 session_key（或配置 sessionKey）')
      return call('/v3/conversation/add', isoBody(cwd, { session_id: sessionId, messages }))
    },
    searchAtomic(query, opts = {}, cwd) {
      require_()
      const body = isoBody(cwd, {
        session_id: opts.sessionId ?? config.sessionKey ?? undefined,
        query,
        limit: opts.limit,
        type: opts.type,
      })
      for (const key of ['session_id', 'limit', 'type']) if (body[key] === undefined) delete body[key]
      return call('/v3/atomic/search', body)
    },
    readCore(cwd) {
      require_()
      return call('/v3/core/read', isoBody(cwd))
    },
    listScenarios(cwd) {
      require_()
      return call('/v3/scenario/ls', isoBody(cwd, { path_prefix: '' }))
    },
  }
}

// ─────────────────────── 代码图谱：MemoryKnowledge v3 ───────────────────────

export const CODE_QUERY_ACTIONS = new Map([
  ['code_search', 'search'],
  ['code_callers', 'callers'],
  ['code_callees', 'callees'],
  ['code_impact', 'impact'],
  ['code_explore', 'explore'],
  ['code_node', 'node'],
  ['code_files', 'files'],
])

const CODE_ARG_LIMITS = { limit: 200, depth: 10, maxFiles: 200, line: 10_000_000 }
const CODE_ARG_PASSTHROUGH = [
  'query', 'symbol', 'kind', 'includeCode', 'file', 'path', 'pattern', 'format', 'includeMetadata', 'maxDepth',
]

/** 从 httpPost 的错误文案里取回 HTTP 状态码（`${path} HTTP ${status}: ${raw}`）。 */
export function httpStatusOf(err) {
  const m = /HTTP (\d{3})/.exec(String(err?.message ?? err ?? ''))
  return m ? Number(m[1]) : undefined
}

/**
 * 把 code-graph 通道的失败翻译成**可执行**的诊断（issue #29）。
 *
 * 三个高频成因必须区分开，否则调用方只看到 401/404 原文、无从下手：
 *   - 401/403：网关要求鉴权但没带上/带错 Bearer（code-graph 此前不带 Authorization）。
 *   - 404 且路径是 /v3/code-graph/*：该地址的网关没有 code-graph 路由 —— 典型是把
 *     `knowledgeEndpoint` 指到了 **MemoryCore 网关**（只有 `/v3/knowledge/*` 元数据），
 *     而 code-graph 查询只由 **MemoryKnowledge**（默认 :8421）提供。
 *   - 连接类错误（ECONNREFUSED/ENOTFOUND/超时）：地址不可达 —— 引擎在远端时客户端
 *     必须有一个可达的 Knowledge 地址；与主记忆通道（memoryEndpoint）互不影响。
 *
 * 其余错误原样透传（保留 envelope `code=…` 等原文）。
 */
export function explainCodeGraphFailure(err, base) {
  const raw = String(err?.message ?? err ?? '')
  const where = base ? `（knowledgeEndpoint=${base}）` : ''
  const status = httpStatusOf(err)
  const netCode = String(err?.cause?.code ?? err?.code ?? '')
  const timedOut = err?.name === 'AbortError' || /abort/i.test(raw)

  if (status === 401 || status === 403) {
    return `Knowledge 网关要求鉴权但请求未通过${where}：配置 knowledgeApiKeyRef（或 apiKeyRef/apiKey）指向 Knowledge 服务接受的 key；`
      + `本机免鉴权的 MemoryKnowledge(:8421) 不需要该 key。原始错误：${raw}`
  }
  if (status === 404 && /code-graph/i.test(raw)) {
    return `该地址未暴露 code-graph 路由${where}：/v3/code-graph/* 只由 MemoryKnowledge 服务提供，`
      + `MemoryCore 网关（memoryEndpoint，仅 /v3/knowledge/* 元数据）不路由它。`
      + `引擎部署在远端时，请把 knowledgeEndpoint 指向 Knowledge 的对外地址（如 https://knowledge.<域名> 或 :8421），不要用 memory.<域名>。`
      + `原始错误：${raw}`
  }
  if (status === 404) {
    return `地址未找到（404）${where}：knowledgeEndpoint 应指向 MemoryKnowledge 服务根（默认 http://127.0.0.1:8421）。原始错误：${raw}`
  }
  if (timedOut || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed/i.test(`${netCode} ${raw}`)) {
    return `Knowledge 服务不可达${where}：引擎在远端时必须给客户端一个可达的 Knowledge 地址`
      + `（在网关上暴露 MemoryKnowledge，或改用本机/内网地址）；主记忆通道（memoryEndpoint）不受影响。`
      + `原始错误：${netCode ? netCode + ' ' : ''}${raw}`
  }
  return raw
}

export function createCodeGraphClient(config) {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const metaTtlMs = config.codegraphMetaTtlMs ?? DEFAULT_META_TTL_MS
  const serviceId = config.serviceId ?? 'default'
  const base = String(config.knowledgeEndpoint ?? '').trim()
  // 与 memory 通道对齐（issue #29）：Knowledge 也可以部署在带鉴权的网关后面。
  // 专属 key（knowledgeApiKey/knowledgeApiKeyRef）优先，未配置则回落共享 apiKey；
  // 两者都没有时不发 Authorization —— 本机免鉴权的 MemoryKnowledge 照常可用。
  const apiKey = config.knowledgeApiKey || config.apiKey

  let cache = { at: 0, rows: [], byUrl: new Map(), bySlug: new Map() }

  const require_ = () => {
    if (!base) throw new Error('agent-memory code-graph 未配置：knowledgeEndpoint')
    if (!config.teamId) throw new Error('agent-memory code-graph 未配置：teamId（身份隔离必需）')
  }

  const headers = () => ({
    'x-tdai-service-id': serviceId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  })

  const post = async (path, body) => {
    try {
      return await httpPost(base, path, body, headers(), timeoutMs)
    } catch (err) {
      throw new Error(explainCodeGraphFailure(err, base), { cause: err })
    }
  }
  const normRepoKey = (v) => String(v || '').trim().toLowerCase().replace(/\/+$/, '')

  async function refreshIndexes(force = false) {
    require_()
    const now = Date.now()
    if (!force && cache.rows.length && now - cache.at < metaTtlMs) return cache
    const data = await post('/v3/code-graph/list', { team_id: config.teamId, limit: 100, offset: 0 })
    const rows = (data && data.items) || []
    const byUrl = new Map()
    const bySlug = new Map()
    for (const row of rows) {
      const id = row.code_graph_id || row.id
      if (!id) continue
      const urlNorm = normRepoKey(row.repo_url || row.name || '').replace(/\.git$/, '')
      if (urlNorm) byUrl.set(urlNorm, row)
      const seg = urlNorm.split('/').pop()
      if (seg) {
        if (!bySlug.has(seg)) bySlug.set(seg, [])
        bySlug.get(seg).push(row)
      }
    }
    cache = { at: now, rows, byUrl, bySlug }
    return cache
  }

  async function resolveIndex(repo) {
    const current = await refreshIndexes()
    if (!repo || !String(repo).trim()) {
      if (current.rows.length === 1) return current.rows[0]
      throw new Error(
        `repo 参数必填（当前 team 可见 ${current.rows.length} 个索引）。先用 code_graph_list 查看可用仓库，再传 repo（URL 或短名，如 dsh-ecosystem）。`,
      )
    }
    const urlKey = normRepoKey(repo).replace(/\.git$/, '')
    const direct = current.byUrl.get(urlKey) || current.byUrl.get(`${urlKey}.git`)
    if (direct) return direct
    const matches = current.bySlug.get(urlKey.split('/').pop()) || []
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      throw new Error(`repo "${repo}" 匹配到多个索引（${matches.map((r) => r.repo_url).join('、')}），请用完整仓库 URL 消歧。`)
    }
    throw new Error(`未找到 repo="${repo}" 的已索引 code-graph（可见索引见 code_graph_list）。`)
  }

  const fmtIndexRow = (row) => {
    const id = row.code_graph_id || row.id
    const status = row.sync_status || row.status || 'unknown'
    const summary = row.summary || ''
    const updated = row.updated_at || ''
    return `- ${id}  ${row.repo_url || row.name || ''}  [${status}]${summary ? '  ' + summary : ''}${updated ? '  (updated ' + updated + ')' : ''}`
  }

  return {
    configured: () => Boolean(base && config.teamId),
    async list() {
      const current = await refreshIndexes(true)
      return [
        `code-graph 索引（team ${config.teamId}，共 ${current.rows.length} 个）：`,
        ...(current.rows.length ? current.rows.map(fmtIndexRow) : ['（无）']),
        '',
        jsonText({ items: current.rows, _context: contextEcho(config, undefined, serviceId) }),
      ].join('\n')
    },
    async query(toolName, args = {}) {
      const action = CODE_QUERY_ACTIONS.get(toolName)
      if (!action) throw new Error(`Unknown code-graph tool: ${toolName}`)
      const index = await resolveIndex(args.repo)
      const body = { code_graph_id: index.code_graph_id || index.id }
      for (const [key, cap] of Object.entries(CODE_ARG_LIMITS)) {
        if (args[key] === undefined || args[key] === null) continue
        const n = clampInt(args[key], 1, toolName === 'code_search' && key === 'limit' ? 100 : cap)
        if (n !== undefined) body[key] = n
      }
      for (const key of CODE_ARG_PASSTHROUGH) {
        if (args[key] === undefined || args[key] === null) continue
        body[key] = args[key]
      }
      const data = await post(`/v3/code-graph/${action}`, body)
      const engineText = data && typeof data.text === 'string' ? data.text : ''
      if (data && data.isError) throw new Error(`code-graph 查询失败: ${engineText || 'unknown'}`)
      const header =
        `[code-graph] ${index.repo_url || index.name || index.code_graph_id || index.id} · ${toolName}` +
        (index.branch ? ` (${index.branch})` : '')
      return engineText ? `${header}\n${engineText}` : `${header}\n（空结果）`
    },
  }
}

// ───────────────────── 进程内自动入库（turn/end → L0） ─────────────────────

/**
 * 与 autostore 守护等价但**在进程内**：按 `session_id + turn` 去重，写入同一份 state 文件，
 * 因此 native 模式与 daemon 模式可以互换而不会重复提交。
 */
export function createCaptureEngine(config, options = {}) {
  const log = options.log ?? (() => {})
  const warn = options.warn ?? (() => {})
  const debug = options.debug ?? (() => {})
  const statePath = config.statePath || defaultStatePath()
  const memoryClient = options.memoryClient ?? createMemoryClient(config)

  const readState = () => {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      return {}
    }
  }

  const writeState = (state) => {
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      const tmp = `${statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2))
      renameSync(tmp, statePath)
    } catch (err) {
      warn(`state 写入失败：${err.message}`)
    }
  }

  let state = readState()
  const buffers = new Map()
  /** 每会话最近一条真人输入：turn 内没有新输入时沿用（与守护的 pendingUser 保留语义一致）。 */
  const lastUserText = new Map()

  const bufferOf = (sessionId, turn) => {
    let buf = buffers.get(sessionId)
    if (!buf || (turn !== undefined && buf.turn !== turn)) {
      buf = { turn, userText: '', assistantText: '' }
      buffers.set(sessionId, buf)
    }
    return buf
  }

  /** 引擎上限：messages[].content <= 8192 字符（实测 400 报错），留余量截断。 */
  const MAX_CONTENT_CHARS = 8000
  const truncate = (text) =>
    text.length <= MAX_CONTENT_CHARS
      ? text
      : `${text.slice(0, MAX_CONTENT_CHARS)}\n…[已截断 ${text.length - MAX_CONTENT_CHARS} 字符]`

  return {
    statePath,
    /** 当前已提交游标（测试/排查用）。 */
    cursor: (sessionId) => state[sessionId],
    async handleEvent(session, event) {
      try {
        const sessionId = session?.id
        if (!sessionId) return
        if (event.type === 'user/message') {
          // 与 autostore 守护同口径：只认**真人**输入（source.kind==='user'），
          // 忽略 agent.inject() 的合成上下文（AGENTS.md/技能/环境提示等，否则会撑爆 8192 上限）。
          const data = event.data
          if (data?.source?.kind === 'user' && data?.role === 'user') {
            const text = textOf(data.content)
            if (text) {
              bufferOf(sessionId).userText = text
              lastUserText.set(sessionId, text)
            }
          }
          return
        }
        if (event.type === 'assistant/message') {
          const data = event.data
          if (data?.message?.role === 'assistant') {
            const text = textOf(data.message.content)
            if (text) bufferOf(sessionId).assistantText = text
          }
          return
        }
        if (event.type === 'turn/start') {
          buffers.set(sessionId, { turn: event.data?.turn, userText: '', assistantText: '' })
          return
        }
        if (event.type !== 'turn/end') return

        const turn = event.data?.turn
        const buf = buffers.get(sessionId) ?? { turn, userText: '', assistantText: '' }
        buffers.delete(sessionId)
        // 与 autostore 守护同口径：无助手文本的轮次不入库；user 侧沿用上一轮的真人输入
        // （注入型 user/message 已被过滤，所以不会把合成上下文带进来）。
        if (buf.assistantText === '') {
          if (buf.userText !== '') debug(`capture 跳过无助手文本轮次 session=${sessionId} turn=${turn}`)
          return
        }
        const userText = buf.userText || lastUserText.get(sessionId) || ''
        if (userText === '') {
          debug(`capture 跳过无真人输入轮次 session=${sessionId} turn=${turn}`)
          return
        }
        if (typeof turn === 'number' && typeof state[sessionId] === 'number' && turn <= state[sessionId]) return
        if (!memoryClient.configured()) {
          warn('capture 跳过：memory 端点/身份未配置完整')
          return
        }
        const cwd = session?.header?.cwd
        const sessionKey = config.sessionKey || sessionId
        await memoryClient.addConversation(
          [
            { role: 'user', content: truncate(userText) },
            { role: 'assistant', content: truncate(buf.assistantText) },
          ],
          sessionKey,
          cwd,
        )
        if (typeof turn === 'number') {
          state[sessionId] = turn
          writeState(state)
        }
        log(`capture 已提交 session=${sessionId} turn=${turn}`)
      } catch (err) {
        warn(`capture 失败（不阻塞会话）：${err.message}`)
      }
    },
  }
}
