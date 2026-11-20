export interface V3ClientConfig {
  endpoint: string
  apiKey: string
  serviceId: string
  teamId: string
  agentId: string
  userId: string
  /** 团队 user_key（meta 面鉴权；无它则 task_* 不可用） */
  userKey?: string
  sessionKey: string
  taskId?: string
  timeoutMs?: number
}

interface V3Envelope<T = unknown> {
  code?: number
  message?: string
  data?: T
}

export interface MemoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AtomicItem {
  id: string
  content: string
  type?: string
  score?: number
  priority?: number
  metadata_json?: string
  updated_at?: string
  created_at?: string
}

export interface CoreFile {
  path?: string
  content: string
  updated_at?: string
}

export interface ScenarioEntry {
  path: string
  summary?: string
  updated_at?: string
}

export interface ConversationAddData {
  accepted_ids?: string[]
  accepted_versions?: string[]
  total_count?: number
}

export interface TaskEntity {
  task_id: string
  team_id: string
  creator_user_id: string
  title: string
  description?: string | null
  status?: string
  source_type?: string
  source_url?: string | null
  created_at?: string
  updated_at?: string
  metadata_json?: string
}

/**
 * v3 strict-isolation 数据面客户端（裸 HTTP，直连 MemoryCore Gateway）。
 *
 * 协议：
 *   - 数据面：`Authorization: Bearer <apiKey>` + `x-tdai-service-id: <spaceId>`
 *   - meta 面（/v3/meta/*）：额外 `x-tdai-user-key: <userKey>`（只有 Bearer 会 401）
 *   - 请求体带隔离三元组 team_id / agent_id / user_id + 当前 task_id
 *   - 写路径（conversation/add）必须带 session_id
 *   - 响应为 envelope { code, message, data }，code!==0 视为失败
 *
 * task_id：会话绑定（TBP）优先于构造时的 config.taskId；绑定通过 setTaskId() 切换。
 */
export class V3MemoryClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly metaHeaders: Record<string, string>
  private readonly baseIso: { team_id: string; agent_id: string; user_id: string }
  private readonly configTaskId?: string
  private boundTaskId?: string
  private readonly sessionKey: string
  private readonly timeoutMs: number

  constructor(config: V3ClientConfig) {
    this.baseUrl = config.endpoint.replace(/\/+$/, '')
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'x-tdai-service-id': config.serviceId,
    }
    this.metaHeaders = {
      ...this.headers,
      ...(config.userKey ? { 'x-tdai-user-key': config.userKey } : {}),
    }
    this.baseIso = {
      team_id: config.teamId,
      agent_id: config.agentId,
      user_id: config.userId,
    }
    this.configTaskId = config.taskId
    this.sessionKey = config.sessionKey
    this.timeoutMs = config.timeoutMs ?? 15000
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = this.headers,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      let envelope: V3Envelope<T>
      try {
        envelope = JSON.parse(text) as V3Envelope<T>
      } catch {
        throw new Error(`MemoryCore ${path} returned non-JSON (${res.status}): ${text.slice(0, 300)}`)
      }
      const code = typeof envelope.code === 'number' ? envelope.code : undefined
      if (!res.ok || (code !== undefined && code !== 0)) {
        throw new Error(`MemoryCore ${path} error (${res.status}${code !== undefined ? ` code=${code}` : ''}): ${envelope.message ?? text.slice(0, 300)}`)
      }
      return (envelope.data ?? {}) as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** meta 面：必须 user-key。 */
  private async metaPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.metaHeaders['x-tdai-user-key']) {
      throw new Error(
        'meta 通道不可用：/v3/meta/* 需要 USER_KEY（x-tdai-user-key）——只有 apiKey/Bearer 不够。',
      )
    }
    return this.post<T>(path, body, this.metaHeaders)
  }

  private baseBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const taskId = this.currentTaskId()
    return { ...this.baseIso, ...(taskId ? { task_id: taskId } : {}), ...extra }
  }

  /** 当前 task_id（绑定优先于配置）。 */
  currentTaskId(): string | undefined {
    return this.boundTaskId ?? this.configTaskId
  }

  /** 当前 task_id 来源，供 _context 回显。 */
  taskSource(): 'binding' | 'config' | 'none' {
    if (this.boundTaskId) return 'binding'
    return this.configTaskId ? 'config' : 'none'
  }

  /** TBP：切换会话绑定；null 表示解绑并回落到 config.taskId。 */
  setTaskId(taskId: string | null): void {
    this.boundTaskId = taskId ?? undefined
  }

  /** 写 L0：把一段对话写入短期记忆 */
  addConversation(messages: MemoryMessage[], sessionId?: string): Promise<ConversationAddData> {
    const sid = sessionId ?? this.sessionKey
    if (!sid) throw new Error('addConversation requires a session_id')
    return this.post('/v3/conversation/add', this.baseBody({ session_id: sid, messages }))
  }

  /** 查 L1：语义搜索原子事实 */
  searchAtomic(
    query: string,
    opts: { limit?: number; type?: string; sessionId?: string; time_start?: string; time_end?: string } = {},
  ): Promise<{ items?: AtomicItem[] }> {
    const body = this.baseBody({
      session_id: opts.sessionId ?? this.sessionKey,
      query,
      limit: opts.limit,
      type: opts.type,
      time_start: opts.time_start,
      time_end: opts.time_end,
    })
    for (const k of ['limit', 'type', 'time_start', 'time_end']) if (body[k] === undefined) delete body[k]
    return this.post('/v3/atomic/search', body)
  }

  /** 分页查 L1（type / 时间窗），updated_time DESC */
  atomicQuery(
    opts: { type?: string; time_start?: string; time_end?: string; limit?: number; offset?: number } = {},
  ): Promise<{ items?: AtomicItem[]; total?: number }> {
    const body = this.baseBody({
      type: opts.type,
      time_start: opts.time_start,
      time_end: opts.time_end,
      limit: opts.limit,
      offset: opts.offset,
    })
    for (const k of ['type', 'time_start', 'time_end', 'limit', 'offset']) if (body[k] === undefined) delete body[k]
    return this.post('/v3/atomic/query', body)
  }

  /** 读 L3：agent 长期画像（persona） */
  readCore(): Promise<CoreFile> {
    return this.post('/v3/core/read', this.baseBody())
  }

  /** 列 L2：场景导航索引 */
  listScenarios(pathPrefix = ''): Promise<{ entries?: ScenarioEntry[] }> {
    return this.post('/v3/scenario/ls', this.baseBody({ path_prefix: pathPrefix }))
  }

  // ── 任务注册表（meta 面，TBP） ──────────────────────────────────────────

  createTask(input: {
    title: string
    description?: string
    status?: string
    linked_agents?: Array<{ agent_id: string; role_in_task?: string }>
  }): Promise<TaskEntity> {
    return this.metaPost('/v3/meta/task/create', {
      team_id: this.baseIso.team_id,
      creator_user_id: this.baseIso.user_id,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.status ? { status: input.status } : {}),
      linked_agents: input.linked_agents ?? [{ agent_id: this.baseIso.agent_id, role_in_task: 'owner' }],
    })
  }

  getTask(taskId: string): Promise<TaskEntity> {
    return this.metaPost('/v3/meta/task/get', { task_id: taskId })
  }

  listTasks(opts: { status?: string; limit?: number; offset?: number } = {}): Promise<{
    items?: TaskEntity[]
    total?: number
  }> {
    const body: Record<string, unknown> = { team_id: this.baseIso.team_id }
    if (opts.status) body.status = opts.status
    if (opts.limit !== undefined) body.limit = opts.limit
    if (opts.offset !== undefined) body.offset = opts.offset
    return this.metaPost('/v3/meta/task/list', body)
  }

  updateTask(taskId: string, patch: Record<string, unknown>): Promise<TaskEntity> {
    return this.metaPost('/v3/meta/task/update', { task_id: taskId, ...patch })
  }

  archiveTask(taskId: string): Promise<unknown> {
    return this.metaPost('/v3/meta/task/archive', { task_id: taskId })
  }

  listTaskAgents(taskId: string): Promise<{ items?: unknown[]; total?: number }> {
    return this.metaPost('/v3/meta/task-agent/list', { task_id: taskId, limit: 100, offset: 0 })
  }
}
