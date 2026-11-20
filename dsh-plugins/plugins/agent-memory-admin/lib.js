/**
 * agent-memory-admin — 记忆系统运维插件的纯逻辑层（零 dsh 依赖，可独立测试）。
 *
 * 与 agent-memory-native 的区别：
 *   - native 是「工作台」：按当前 task 读写记忆；
 *   - admin 是「控制台」：**不绑定** agent/user/task，可按任意维度跨团队盘点、检索、修改、删除，
 *     并管理 task 实体 / 场景 / 画像 / 提示词 / 健康状态。
 *
 * 鉴权：数据面 Bearer + service-id；meta 面额外 x-tdai-user-key。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_TIMEOUT_MS = 15_000
export const L1_TYPES = [
  'work_fact',
  'work_method',
  'work_task',
  'work_artifact',
  'episodic',
  'persona',
  'instruction',
]

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

export async function resolveSecretValue({ ref, inline, service, brand = (n) => n, env = process.env, warn = () => {} } = {}) {
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

export async function httpRequest(base, path, { method = 'POST', body, headers, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${String(base).replace(/\/+$/, '')}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    const raw = await res.text()
    let json = null
    try {
      json = raw ? JSON.parse(raw) : null
    } catch {
      json = null
    }
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${raw.slice(0, 400)}`)
    if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
      throw new Error(`${path} code=${json.code} message=${json.message ?? ''}`)
    }
    if (json && typeof json === 'object' && 'data' in json) return json.data
    return json
  } finally {
    clearTimeout(timer)
  }
}

export function createAdminClient(config) {
  const base = String(config.memoryEndpoint ?? '').trim()
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const serviceId = config.serviceId ?? 'default'

  const dataHeaders = () => ({ Authorization: `Bearer ${config.apiKey}`, 'x-tdai-service-id': serviceId })
  // 管理面团队级作用域：必须带部署方密钥，否则网关会忽略 scope="team"。
  const adminHeaders = () => ({
    ...dataHeaders(),
    ...(config.adminKey ? { 'x-tdai-admin-key': config.adminKey } : {}),
  })
  const metaHeaders = () => ({
    ...dataHeaders(),
    ...(config.userKey ? { 'x-tdai-user-key': config.userKey } : {}),
  })

  const requireBase = () => {
    if (!base) throw new Error('agent-memory-admin 未配置 memoryEndpoint')
    if (!config.apiKey) throw new Error('agent-memory-admin 未配置 apiKey')
    if (!config.teamId) throw new Error('agent-memory-admin 未配置 teamId')
    if (!config.adminKey) {
      throw new Error(
        'agent-memory-admin 需要 adminKey（AGENT_MEMORY_ADMIN_KEY）：团队级盘点依赖 scope="team" + x-tdai-admin-key',
      )
    }
  }

  /** 管理面默认只带 team_id；agent/user/task 仅在显式传入时收窄。 */
  const filterBody = (filters = {}) => {
    const body = { team_id: config.teamId, scope: 'team' }
    for (const key of ['agent_id', 'user_id', 'task_id']) {
      if (filters[key]) body[key] = filters[key]
    }
    for (const key of ['type', 'time_start', 'time_end']) {
      if (filters[key]) body[key] = filters[key]
    }
    return body
  }

  const post = (path, body) => {
    requireBase()
    return httpRequest(base, path, { body, headers: adminHeaders(), timeoutMs })
  }
  const metaPost = (path, body) => {
    requireBase()
    if (!config.userKey) throw new Error('meta 通道需要 userKey（/v3/meta/* 只认 x-tdai-user-key）')
    return httpRequest(base, path, { body, headers: metaHeaders(), timeoutMs })
  }

  return {
    configured: () => Boolean(base && config.apiKey && config.teamId),
    base,
    serviceId,
    async health() {
      requireBase()
      return httpRequest(base, '/health', { method: 'GET', headers: dataHeaders(), timeoutMs })
    },
    atomicCount(filters) {
      return post('/v3/atomic/count', filterBody(filters))
    },
    atomicQuery(filters = {}) {
      const body = filterBody(filters)
      if (filters.limit !== undefined) body.limit = filters.limit
      if (filters.offset !== undefined) body.offset = filters.offset
      return post('/v3/atomic/query', body)
    },
    atomicSearch(query, filters = {}) {
      const body = filterBody(filters)
      body.query = query
      if (filters.limit !== undefined) body.limit = filters.limit
      return post('/v3/atomic/search', body)
    },
    atomicUpdate(input) {
      const body = { id: input.id, ...filterBody({ agent_id: input.agent_id, user_id: input.user_id, task_id: input.task_id }) }
      if (input.content !== undefined) body.content = input.content
      if (input.background !== undefined) body.background = input.background
      if (input.type !== undefined) body.type = input.type
      if (input.priority !== undefined) body.priority = input.priority
      return post('/v3/atomic/update', body)
    },
    atomicDelete(ids, filters = {}) {
      return post('/v3/atomic/delete', { ...filterBody(filters), ids })
    },
    conversationCount(filters = {}) {
      const body = filterBody(filters)
      if (filters.session_id) body.session_id = filters.session_id
      return post('/v3/conversation/count', body)
    },
    scenarioLs(filters = {}) {
      return post('/v3/scenario/ls', { ...filterBody(filters), path_prefix: filters.path_prefix ?? '' })
    },
    scenarioRead(path, filters = {}) {
      return post('/v3/scenario/read', { ...filterBody(filters), path })
    },
    scenarioWrite(path, content, filters = {}) {
      return post('/v3/scenario/write', { ...filterBody(filters), path, content })
    },
    scenarioRm(path, filters = {}) {
      return post('/v3/scenario/rm', { ...filterBody(filters), path })
    },
    scenarioCount(filters = {}) {
      return post('/v3/scenario/count', filterBody(filters))
    },
    coreRead(filters = {}) {
      return post('/v3/core/read', filterBody(filters))
    },
    coreWrite(content, filters = {}) {
      return post('/v3/core/write', { ...filterBody(filters), content })
    },
    coreCount(filters = {}) {
      return post('/v3/core/count', filterBody(filters))
    },
    promptSettingList(filters = {}) {
      return post('/v3/memory-prompt/setting/list', {
        team_id: config.teamId,
        ...(filters.target_type ? { target_type: filters.target_type } : {}),
        limit: filters.limit ?? 100,
        offset: 0,
      })
    },
    promptGetEffective(layer, filters = {}) {
      return post('/v3/memory-prompt/get', {
        layer,
        team_id: config.teamId,
        ...(filters.agent_id ? { agent_id: filters.agent_id } : {}),
      })
    },
    taskList(filters = {}) {
      const body = { team_id: config.teamId }
      if (filters.status) body.status = filters.status
      if (filters.limit !== undefined) body.limit = filters.limit
      if (filters.offset !== undefined) body.offset = filters.offset
      return metaPost('/v3/meta/task/list', body)
    },
    taskGet(taskId) {
      return metaPost('/v3/meta/task/get', { task_id: taskId })
    },
    taskCreate(input) {
      const body = {
        team_id: config.teamId,
        creator_user_id: config.userId,
        title: input.title,
        ...(input.task_id ? { task_id: input.task_id } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.status ? { status: input.status } : {}),
        linked_agents: input.linked_agents ?? (config.agentId ? [{ agent_id: config.agentId, role_in_task: 'owner' }] : []),
      }
      return metaPost('/v3/meta/task/create', body)
    },
    taskUpdate(taskId, patch) {
      return metaPost('/v3/meta/task/update', { task_id: taskId, ...patch })
    },
    taskAgents(taskId) {
      return metaPost('/v3/meta/task-agent/list', { task_id: taskId, limit: 100, offset: 0 })
    },
  }
}

/** 读取已知的会话绑定文件（DSH native + MCP 桥）。 */
export function readBindings() {
  const candidates = [
    join(dshHome(), '.dsh-memory-task-bindings.json'),
    join(homedir(), '.tencent-agent-memory', 'task-bindings.json'),
  ]
  const out = []
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      for (const [session, binding] of Object.entries(raw?.sessions ?? {})) {
        out.push({ source: path, session, task_id: binding?.task_id, title: binding?.title, bound_at: binding?.bound_at })
      }
    } catch {
      out.push({ source: path, error: 'unreadable' })
    }
  }
  return out
}

/** 读取自动入库游标（session → 已提交 turn）。 */
export function readCaptureState() {
  const path = process.env.DSH_AUTOSTORE_STATE || join(dshHome(), '.dsh-memory-autostore-state.json')
  if (!existsSync(path)) return { path, sessions: 0, entries: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const entries = Object.entries(raw).slice(-20).map(([session, turn]) => ({ session, turn }))
    return { path, sessions: Object.keys(raw).length, entries }
  } catch {
    return { path, error: 'unreadable' }
  }
}

/** 按 key 聚合计数，返回降序 top N。 */
export function topBy(items, key, limit = 10) {
  const counts = new Map()
  for (const item of items) {
    const value = item?.[key] || '(empty)'
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }))
}

/** 安全解析 metadata_json。 */
export function parseMetadata(json) {
  if (!json) return {}
  try {
    const value = JSON.parse(String(json))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}
