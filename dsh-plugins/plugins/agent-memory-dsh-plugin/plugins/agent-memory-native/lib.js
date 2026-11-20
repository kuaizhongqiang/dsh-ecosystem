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

export function defaultTaskBindingPath() {
  return process.env.DSH_MEMORY_TASK_BINDINGS || join(dshHome(), '.dsh-memory-task-bindings.json')
}

/**
 * 会话级 task 绑定存储（P2）。
 *
 * 形状：`{ sessions: { "<session_id>": { task_id, title, bound_at } } }`
 * 落盘原子写（tmp + rename）；读失败一律回落空表，绝不因绑定文件损坏而阻断记忆读写。
 * 绑定只在**当前会话**生效：worker 在别的会话里不会继承这个 task_id。
 */
export function createTaskBindingStore(options = {}) {
  const path = options.path || defaultTaskBindingPath()
  const warn = options.warn ?? (() => {})
  const empty = () => ({ sessions: {} })
  const read = () => {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      if (!raw || typeof raw !== 'object' || !raw.sessions || typeof raw.sessions !== 'object') return empty()
      return { sessions: raw.sessions }
    } catch {
      return empty()
    }
  }
  let data = read()
  const persist = () => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2))
      renameSync(tmp, path)
    } catch (err) {
      warn(`task 绑定写入失败：${err.message}`)
    }
  }
  return {
    path,
    get(sessionId) {
      if (!sessionId) return undefined
      return data.sessions[sessionId]
    },
    set(sessionId, binding) {
      if (!sessionId) throw new Error('task_bind 需要当前会话 id（拿不到 exec.session.id）')
      const taskId = String(binding?.task_id || '').trim()
      if (!taskId) throw new Error('task_bind 需要非空 task_id')
      data = {
        ...data,
        sessions: {
          ...data.sessions,
          [sessionId]: {
            task_id: taskId,
            title: binding.title ? String(binding.title) : undefined,
            bound_at: new Date().toISOString(),
          },
        },
      }
      persist()
      return data.sessions[sessionId]
    },
    clear(sessionId) {
      if (!sessionId || !data.sessions[sessionId]) return false
      const next = { ...data.sessions }
      delete next[sessionId]
      data = { ...data, sessions: next }
      persist()
      return true
    },
    list() {
      return Object.entries(data.sessions).map(([session_id, b]) => ({ session_id, ...b }))
    },
    reload() {
      data = read()
    },
  }
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

/**
 * task_id 解析（P2/P3）：**会话绑定 > 显式配置 > cwd 目录名**。
 *
 * 会话绑定由 `task_bind` 写入（见 createTaskBindingStore）；显式配置是历史行为，
 * 未绑定的会话保持不变，因此旧记忆桶不受影响。
 */
export function resolveTaskId(config, cwd, sessionId, bindingStore) {
  const bound = bindingStore?.get?.(sessionId)
  if (bound?.task_id) {
    if (IDENTITY_PREFIXES.test(bound.task_id)) {
      throw new Error(
        `绑定的 task_id '${bound.task_id}' 是身份 id（agt-/team-/usr-/sk-mem-…）；task_id 必须是项目级标签。`,
      )
    }
    return bound.task_id
  }
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

/** 本次 task_id 的来源：binding | config | cwd（仅用于回显，便于验收）。 */
export function taskSourceOf(config, cwd, sessionId, bindingStore) {
  if (bindingStore?.get?.(sessionId)?.task_id) return 'binding'
  return String(config.taskId ?? '').trim() ? 'config' : 'cwd'
}

/** 回显当前隔离域（不含任何 key），让调用方明确本次落在哪个 (team, agent, user, task)。 */
export function contextEcho(config, cwd, serviceId, sessionId, bindingStore) {
  const echo = {
    team_id: config.teamId,
    agent_id: config.agentId,
    user_id: config.userId,
    service_id: serviceId ?? config.serviceId ?? 'default',
  }
  try {
    echo.task_id = resolveTaskId(config, cwd, sessionId, bindingStore)
    echo.task_source = taskSourceOf(config, cwd, sessionId, bindingStore)
  } catch {
    echo.task_id = config.taskId
  }
  return echo
}

// ───────────────────────── 主记忆：MemoryCore v3 ─────────────────────────

export function createMemoryClient(config, options = {}) {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const serviceId = config.serviceId ?? 'default'
  const base = String(config.memoryEndpoint ?? '').trim()
  /** 会话级 task 绑定（P2）：传进来后，所有读写自动使用绑定值。 */
  const bindingStore = options.bindingStore

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

  /** 兼容旧签名：第 3 参可以是 cwd 字符串，也可以是 `{ cwd, sessionId }`。 */
  const ctxOf = (ctx) => (typeof ctx === 'string' ? { cwd: ctx } : (ctx || {}))

  const isoBody = (ctx = {}, extra = {}) => {
    const c = ctxOf(ctx)
    return {
      team_id: config.teamId,
      agent_id: config.agentId,
      user_id: config.userId,
      task_id: resolveTaskId(config, c.cwd, c.sessionId, bindingStore),
      ...extra,
    }
  }

  const call = (path, body) => httpPost(base, path, body, headers(), timeoutMs)
  const strip = (body, keys) => {
    for (const key of keys) if (body[key] === undefined || body[key] === null) delete body[key]
    return body
  }

  return {
    configured: () => Boolean(base && config.apiKey && config.teamId && config.agentId && config.userId),
    /** 当前生效的 task_id（含绑定来源），供工具回显与测试。 */
    taskIdFor: (ctx) => {
      const c = ctxOf(ctx)
      return resolveTaskId(config, c.cwd, c.sessionId, bindingStore)
    },
    addConversation(messages, sessionId, ctx = {}) {
      require_()
      const c = ctxOf(ctx)
      if (!sessionId) throw new Error('store_memory 需要 session_key（或配置 sessionKey）')
      return call('/v3/conversation/add', isoBody({ ...c, sessionId: c.sessionId ?? sessionId }, { session_id: sessionId, messages }))
    },
    searchAtomic(query, opts = {}, ctx = {}) {
      require_()
      const body = isoBody(ctx, {
        session_id: opts.sessionId ?? config.sessionKey ?? undefined,
        query,
        limit: opts.limit,
        type: opts.type,
        time_start: opts.time_start,
        time_end: opts.time_end,
      })
      return call('/v3/atomic/search', strip(body, ['session_id', 'limit', 'type', 'time_start', 'time_end']))
    },
    /** 分页查询 L1（带 type / 时间窗 / limit），按 updated_time DESC。 */
    atomicQuery(opts = {}, ctx = {}) {
      require_()
      const body = isoBody(ctx, {
        type: opts.type,
        time_start: opts.time_start,
        time_end: opts.time_end,
        limit: opts.limit,
        offset: opts.offset,
      })
      return call('/v3/atomic/query', strip(body, ['type', 'time_start', 'time_end', 'limit', 'offset']))
    },
    atomicCount(opts = {}, ctx = {}) {
      require_()
      const body = isoBody(ctx, { type: opts.type, time_start: opts.time_start, time_end: opts.time_end })
      return call('/v3/atomic/count', strip(body, ['type', 'time_start', 'time_end']))
    },
    readCore(ctx) {
      require_()
      return call('/v3/core/read', isoBody(ctx))
    },
    listScenarios(ctx) {
      require_()
      return call('/v3/scenario/ls', isoBody(ctx, { path_prefix: '' }))
    },
    scenarioRead(path, ctx) {
      require_()
      return call('/v3/scenario/read', isoBody(ctx, { path }))
    },
  }
}

// ───────────────────── 任务注册表：/v3/meta/*（需 user-key） ─────────────────────

/**
 * 元数据通道（P1/P4）：`/v3/meta/task/*` 必须带 `x-tdai-user-key`（见引擎
 * `metadata/router/auth.ts`）。数据面（L0–L3）不需要 user-key，因此这里**只**
 * 给 meta 调用加该头，缩小暴露面。
 *
 * 权限语义（引擎侧）：
 *   - create：team 存在 + caller 是 active member + creator_user_id == caller
 *   - get/list：team 成员可读（v2.0.4 起按 caller/成员过滤）
 *   - update/delete/archive：仅 task creator
 * 所以 serve agent 的 userKey 必须是**真人用户 key**，不能是 memory 系统账号。
 */
export function createMetaClient(config) {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const serviceId = config.serviceId ?? 'default'
  const base = String(config.memoryEndpoint ?? '').trim()

  const require_ = () => {
    if (!base) throw new Error('agent-memory meta 未配置：memoryEndpoint')
    if (!config.apiKey) throw new Error('agent-memory meta 未配置：apiKey')
    if (!config.userKey) {
      throw new Error('agent-memory meta 需要 userKey（AGENT_MEMORY_USER_KEY）：/v3/meta/* 只认 x-tdai-user-key，Bearer 不够')
    }
    if (!config.teamId || !config.userId) throw new Error('agent-memory meta 未配置：teamId/userId')
  }

  const headers = () => ({
    Authorization: `Bearer ${config.apiKey}`,
    'x-tdai-service-id': serviceId,
    'x-tdai-user-key': String(config.userKey),
  })
  const call = (path, body) => {
    require_()
    return httpPost(base, path, body, headers(), timeoutMs)
  }

  return {
    configured: () => Boolean(base && config.apiKey && config.userKey && config.teamId && config.userId),
    createTask(input = {}) {
      const body = {
        team_id: config.teamId,
        creator_user_id: config.userId,
        title: input.title,
        description: input.description,
        source_type: input.source_type,
        source_url: input.source_url,
        status: input.status,
        metadata_json: input.metadata_json,
        linked_agents: input.linked_agents ?? [{ agent_id: config.agentId, role_in_task: 'owner' }],
      }
      for (const key of ['description', 'source_type', 'source_url', 'status', 'metadata_json']) {
        if (body[key] === undefined || body[key] === null) delete body[key]
      }
      return call('/v3/meta/task/create', body)
    },
    getTask(taskId) {
      return call('/v3/meta/task/get', { task_id: taskId })
    },
    listTasks(opts = {}) {
      const body = {
        team_id: config.teamId,
        status: opts.status,
        title: opts.title,
        limit: opts.limit,
        offset: opts.offset,
      }
      for (const key of ['status', 'title', 'limit', 'offset']) {
        if (body[key] === undefined || body[key] === null) delete body[key]
      }
      return call('/v3/meta/task/list', body)
    },
    updateTask(taskId, patch = {}) {
      const body = { task_id: taskId, ...patch }
      for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key]
      return call('/v3/meta/task/update', body)
    },
    archiveTask(taskId) {
      return call('/v3/meta/task/archive', { task_id: taskId })
    },
    linkAgent(taskId, agentId, roleInTask) {
      return call('/v3/meta/task-agent/link', { task_id: taskId, agent_id: agentId, role_in_task: roleInTask })
    },
    async listAgents(taskId) {
      return call('/v3/meta/task-agent/list', { task_id: taskId, limit: 100, offset: 0 })
    },
  }
}

// ─────────────────────── brief：预算化的会话简报 ───────────────────────

/** 解析 L1 metadata_json（失败一律空对象）。 */
export function parseMetadata(json) {
  if (!json) return {}
  if (typeof json === 'object') return json
  try {
    const v = JSON.parse(String(json))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

const DONE_STATUS = new Set(['done', 'completed', 'cancelled', 'canceled', 'closed'])
const cap = (text, max) => {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…[截断 ${s.length - max} 字符]` : s
}

/**
 * 从 L1 work_task 里筛「未结」并按 deadline 升序、priority 降序。
 * 判定依据是 `metadata_json.status`（引擎抽取时已写入 `{"status":"todo","deadline":...}`）；
 * 缺失 status 的旧记录按「未结」处理（宁可多报，不可漏报）。
 */
export function openWorkTasks(items = []) {
  return items
    .filter((it) => it && it.type === 'work_task')
    .map((it) => ({ ...it, meta: parseMetadata(it.metadata_json) }))
    .filter((it) => !DONE_STATUS.has(String(it.meta.status || '').toLowerCase()))
    .sort((a, b) => {
      const da = Date.parse(a.meta.deadline || '') || Number.POSITIVE_INFINITY
      const db = Date.parse(b.meta.deadline || '') || Number.POSITIVE_INFINITY
      if (da !== db) return da - db
      return (Number(b.priority) || 0) - (Number(a.priority) || 0)
    })
}

/** L2 场景只保留索引（path/updated_at），**丢掉 summary** —— summary 是召回 token 炸弹。 */
export function trimScenes(entries = [], max = 30) {
  return entries.slice(0, max).map((e) => ({
    path: e.path,
    updated_at: e.updated_at,
    ...(e.summary ? { has_summary: true } : {}),
  }))
}

/**
 * L3 画像摘要：取 Operating Thesis 行 + 各级标题 + 每个标题下的第一条要点。
 * 目的是把 36KB 画像压到 ~1.2KB，而不是整份注入。
 */
export function digestPersona(text, maxChars = 1200) {
  const lines = String(text || '').split('\n')
  const picked = []
  let sinceHeading = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^>\s*\*\*Operating Thesis\*\*/.test(line)) {
      picked.push(line)
      continue
    }
    if (/^#{1,3}\s/.test(line)) {
      picked.push(line)
      sinceHeading = 0
      continue
    }
    if (sinceHeading === 0 && /^[-*]\s/.test(line)) {
      picked.push(line)
      sinceHeading += 1
    }
    if (picked.join('\n').length >= maxChars) break
  }
  return cap(picked.join('\n'), maxChars)
}

/**
 * composeBrief —— A 方案的核心：把「画像摘要 + 场景索引 + 未结任务 + 最近事实」
 * 压进一个预算（默认 6000 字符 ≈ 2K token），按优先级逐段裁剪。
 *
 * 输入都是引擎原始响应（`/core/read`、`/scenario/ls`、`/atomic/query`）。
 */
export function composeBrief(input = {}, opts = {}) {
  const budget = Number(opts.maxChars) || 8000
  const binding = input.binding || null
  const personaText = input.persona?.content || ''
  const scenes = trimScenes(input.scenes?.entries || [], 20)
  const tasks = openWorkTasks(input.tasks?.items || []).slice(0, 8)
  const facts = (input.facts?.items || []).filter((f) => f && f.type !== 'work_task').slice(0, 8)

  const openTasks = tasks.map((t) => ({
    id: t.id,
    content: cap(t.content, 300),
    deadline: t.meta.deadline || undefined,
    priority: t.priority,
    status: t.meta.status || undefined,
  }))
  const recentFacts = facts.map((f) => ({
    id: f.id,
    type: f.type,
    content: cap(f.content, 200),
    updated_at: f.updated_at,
  }))

  const brief = {
    task: binding ? { task_id: binding.task_id, title: binding.title, bound_at: binding.bound_at } : null,
    persona_digest: digestPersona(personaText, 1400),
    open_tasks: openTasks,
    scenes,
    recent_facts: recentFacts,
  }

  // 预算裁剪顺序：场景索引（可再取）→ 最近事实 → 未结任务 → 画像摘要。
  // 任务与画像优先保留（它们回答「在做什么/怎么干」），场景只是导航入口。
  const sizeOf = () => JSON.stringify(brief).length
  while (sizeOf() > budget && brief.scenes.length > 0) brief.scenes.pop()
  while (sizeOf() > budget && brief.recent_facts.length > 0) brief.recent_facts.pop()
  while (sizeOf() > budget && brief.open_tasks.length > 0) brief.open_tasks.pop()
  if (sizeOf() > budget && brief.persona_digest) brief.persona_digest = cap(brief.persona_digest, Math.max(200, budget - sizeOf() + brief.persona_digest.length - 200))
  brief._size_chars = sizeOf()
  brief._budget_chars = budget
  return brief
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
          { cwd, sessionId },
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
