/**
 * agent-memory-native — 原生 dsh 插件（cordis），把 TencentDB Agent Memory 接进 DSH：
 *
 *   - 主记忆工具（3）：`recall_memory` / `store_memory` / `search_memories`
 *   - 代码图谱工具（8）：`code_graph_list` / `code_search` / `code_callers` / `code_callees` /
 *       `code_impact` / `code_explore` / `code_node` / `code_files`
 *   - 进程内自动入库：`session/event` 的 `turn/end` 直接提交该轮对话进 L0
 *
 * 与 MCP 模式的区别：不再需要 `npx tencent-agent-memory-mcp-bridge`（MCP 子进程）与
 * 外部 autostore 守护；工具名不带 `mcp__*__` 前缀；完全离线可用（只用 fetch 打引擎 HTTP）。
 * MCP 桥保留给其它平台（Claude Code / CodeBuddy / OpenClaw），`install.sh --mode native|mcp` 二选一。
 *
 * 纯逻辑在 ./lib.js（零 dsh 依赖，可用 `node selftest.mjs` 直接对 mock/真实引擎验证）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  CODE_QUERY_ACTIONS,
  resolveSecretValue,
  contextEcho,
  createCaptureEngine,
  createCodeGraphClient,
  createMemoryClient,
  createMetaClient,
  createTaskBindingStore,
  defaultStatePath,
  defaultTaskBindingPath,
  composeBrief,
  digestPersona,
  jsonText,
} from './lib.js'

/** package.json 是版本唯一来源（热重载按 name 版本号触发）。 */
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))

export const name = 'tool-agent-memory'
export const inject = ['tools']
export const version = PKG.version

export const Config = z.object({
  /** MemoryCore gateway（v3），如 http://127.0.0.1:8422 */
  memoryEndpoint: z.string(),
  /** MemoryKnowledge（code-graph），如 http://127.0.0.1:8421；远端部署时指向 Knowledge 的对外地址（不是 memory 网关） */
  knowledgeEndpoint: z.string(),
  /** 网关门禁 key（Authorization: Bearer）；MemoryCore 与 Knowledge 共用一个网关 key 时用它 */
  apiKey: z.string(),
  /** Knowledge 专属 key（内联）；仅当 Knowledge 与 MemoryCore 的 key 不同时才需要 */
  knowledgeApiKey: z.string(),
  /** 凭证 seam 引用名（如 AGENT_MEMORY_KNOWLEDGE_KEY）；优先于 knowledgeApiKey 与 apiKey */
  knowledgeApiKeyRef: z.string(),
  /** memory 实例 id（x-tdai-service-id） */
  serviceId: z.string(),
  /** v3 身份三元组 */
  teamId: z.string(),
  agentId: z.string(),
  userId: z.string(),
  /** 团队 user_key（可选，meta 面鉴权；也可用 userKeyRef 引用凭证 seam） */
  userKey: z.string(),
  /** 凭证 seam 引用名（如 AGENT_MEMORY_USER_KEY）；优先于内联 userKey */
  userKeyRef: z.string(),
  /** 凭证 seam 引用名（如 AGENT_MEMORY_API_KEY）；优先于内联 apiKey */
  apiKeyRef: z.string(),
  /** 项目级隔离标签 task_id；未配则取会话 cwd 目录名 */
  taskId: z.string(),
  /** 默认 session key（store_memory / capture 未显式给时用）；未配则用 DSH 会话 id */
  sessionKey: z.string(),
  /** 单次请求超时（毫秒） */
  timeoutMs: z.natural(),
  /** code-graph 可见索引缓存 TTL（毫秒） */
  codegraphMetaTtlMs: z.natural(),
  /** 进程内自动入库（turn/end → L0），默认开 */
  capture: z.boolean(),
  /** 入库去重游标文件（与 autostore 守护共用同一份，默认 %DSH_HOME%/.dsh-memory-autostore-state.json） */
  statePath: z.string(),
  /** 允许 task_create / task_close（serve agent 开 true；worker 保持 false，只能 bind/get/list） */
  taskAdmin: z.boolean(),
  /** 会话级 task 绑定文件（默认 %DSH_HOME%/.dsh-memory-task-bindings.json） */
  taskBindingPath: z.string(),
  /** memory_brief 字符预算（默认 6000 ≈ 2K token） */
  briefBudgetChars: z.natural(),
})

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

/**
 * @param ctx - cordis 上下文（inject: tools；credentials 可选，用于引用式凭证）。
 * @param config - 见 {@link Config}。
 */
export function apply(ctx, config) {
  const log = (...parts) => console.log('[agent-memory]', ...parts)
  const warn = (...parts) => console.warn('[agent-memory]', ...parts)

  /**
   * 引用式凭证：secret 优先从官方凭证 seam（`ctx.get('credentials')`）按 ref 解析，
   * 其次回落到同名环境变量，最后才用 config 里的内联值。
   * 这样 cordis.patch.yml 里可以只写 `apiKeyRef: AGENT_MEMORY_API_KEY`，
   * 真值放 `%DSH_HOME%/.credentials.yaml`（0600、热更新、永不回显）。
   */
  /**
   * 取 credentials 服务：`ctx.get(name)` 在提供方 fiber 未 active 时返回 undefined（cordis reflect.get 语义），
   * 因此先严格取、失败再非严格取（拿已注册但尚未激活的实例）。
   */
  const credentialService = () => {
    if (typeof ctx.get !== 'function') return undefined
    const strict = ctx.get('credentials')
    return strict ?? ctx.get('credentials', false)
  }
  const resolveSecret = async (ref, inline) => {
    let brand = (name) => name
    try {
      const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
      brand = credentialRef
    } catch { /* seam 包不可用时直接回落 env */ }
    const { value } = await resolveSecretValue({ ref, inline, service: credentialService(), brand, warn })
    return value
  }

  let memory
  let codeGraph
  let meta
  let capture
  const bindingStore = createTaskBindingStore({
    path: config.taskBindingPath || defaultTaskBindingPath(),
    warn,
  })
  let readyPromise = null
  const warmupTimers = []
  /**
   * 惰性初始化：**必须在 apply 之后**再解析凭证 —— cordis 的 `ctx.get('credentials')`
   * 在插件树加载期可能还没挂载 credentials 服务（实测：apply 期拿到 undefined，
   * 工具调用期才拿得到，官方 credentials 插件正是在工具调用时才 `ctx.get`）。
   * 因此这里 memoize 成 promise，并在启动后延迟预热一次；解析失败则清空 promise 以便重试。
   */
  const ensureReady = () => (readyPromise ??= (async () => {
    const apiKey = await resolveSecret(config.apiKeyRef, config.apiKey)
    const userKey = await resolveSecret(config.userKeyRef, config.userKey)
    // code-graph 专属 key：没配就回落共享 apiKey（与 memory 通道对齐，见 issue #29）。
    const resolvedKnowledgeKey = await resolveSecret(config.knowledgeApiKeyRef, config.knowledgeApiKey)
    const knowledgeApiKey = resolvedKnowledgeKey || apiKey
    const effective = { ...config, apiKey, userKey, knowledgeApiKey }
    memory = createMemoryClient(effective, { bindingStore })
    codeGraph = createCodeGraphClient(effective)
    meta = createMetaClient(effective)
    capture = createCaptureEngine(effective, { log, warn, memoryClient: memory })
    log(
      `clients ready: secrets=${effective.apiKey ? 'apiKey✓' : 'apiKey✗'}${effective.userKey ? ' userKey✓' : ''} `
      + `knowledgeKey=${resolvedKnowledgeKey ? 'own✓' : knowledgeApiKey ? 'inherit(apiKey)' : '✗'} `
      + `refs=${[config.apiKeyRef, config.userKeyRef, config.knowledgeApiKeyRef].filter(Boolean).join(',') || '-'} `
      + `capture=${effective.capture !== false ? 'on' : 'off'}`,
    )
    if (!effective.apiKey) {
      warn(`未能解析 apiKey（ref=${config.apiKeyRef || '-'}）——将在首次使用时重试`)
      readyPromise = null
    }
    return effective
  })().catch((err) => {
    warn(`初始化失败：${err.message}`)
    readyPromise = null
    return config
  }))

  // 启动后按退避节奏预热（credentials 提供方在 boot 期间才 active，单次 1.5s 往往太早）；
  // 任一次成功即停；全部失败也不影响——工具调用/会话事件时还会再重试。unref 不阻塞退出。
  for (const delay of [1500, 5000, 12000, 25000]) {
    const timer = setTimeout(() => {
      ensureReady().then((effective) => {
        if (effective.apiKey) for (const t of warmupTimers) clearTimeout(t)
      }).catch(() => {})
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    warmupTimers.push(timer)
  }

  if (config.capture !== false) {
    // 关键：profile 级插件必须用 { global: true } —— `session/event` 是「会话作用域」事件，
    // 不带该选项的监听器收不到任何事件（harness 官方订阅均如此，见 core/tools/invariant.ts）。
    // 订阅在 apply 期同步挂载，事件按序等待 ready（凭证解析）完成后再处理。
    ctx.on('session/event', (session, event) => {
      ensureReady()
        .then(() => capture.handleEvent(session, event))
        .catch((err) => warn(`session/event 处理异常：${err.message}`))
    }, { global: true })
  }

  const register = (spec) =>
    ctx.tools.register(
      defineTool({
        ...spec,
        output: textOutput,
        presentCall: () => ({ card: 'generic', title: spec.name, kind: 'other' }),
      }),
    )

  const cwdOf = (exec) => exec?.session?.header?.cwd
  const sessionIdOf = (exec) => exec?.session?.id
  /** 统一的隔离上下文：读写都要带 sessionId，绑定才生效。 */
  const ctxOf = (exec) => ({ cwd: cwdOf(exec), sessionId: sessionIdOf(exec) })
  const echoOf = (ctx) => contextEcho(config, ctx.cwd, undefined, ctx.sessionId, bindingStore)

  // ── 主记忆 ────────────────────────────────────────────────────────────

  register({
    name: 'recall_memory',
    description:
      'Recall relevant memories for the CURRENT task (project): L1 atomic facts, filtered by task_id (session binding, config, or cwd). '
      + 'L3 persona is OFF by default (it can be tens of KB) — opt in with include_persona; L2 scenes returns an INDEX only (path/updated_at), '
      + 'use scenario_read to fetch a scene body. Identity (team_id/agent_id/user_id) and task_id are fixed by the plugin — never pass them. '
      + 'Prefer memory_brief at the start of work, then recall for specific questions.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query for relevant memories' },
      limit: { type: 'number', description: 'Max L1 facts to return (default 5, max 100)' },
      type: { type: 'string', description: 'Filter by L1 type: work_fact / work_method / work_task / work_artifact / episodic / persona / instruction' },
      time_start: { type: 'string', description: 'ISO8601 lower bound (updated_at)' },
      time_end: { type: 'string', description: 'ISO8601 upper bound (updated_at)' },
      include_persona: { type: 'boolean', description: 'Include a DIGESTED L3 persona (default false; full persona is ~36KB)' },
      include_scenes: { type: 'boolean', description: 'Include the L2 scene index (path/updated_at only, default false)' },
    },
    async execute(args, exec) {
      await ensureReady()
      const ctx = ctxOf(exec)
      const [facts, persona, scenes] = await Promise.all([
        memory.searchAtomic(args.query, {
          limit: args.limit,
          type: args.type,
          time_start: args.time_start,
          time_end: args.time_end,
        }, ctx),
        args.include_persona === true ? memory.readCore(ctx) : Promise.resolve(null),
        args.include_scenes === true ? memory.listScenarios(ctx) : Promise.resolve(null),
      ])
      const result = { facts: facts?.items ?? [] }
      if (args.include_persona === true && persona?.content) {
        result.persona_digest = digestPersona(persona.content, 2000)
      }
      if (args.include_scenes === true && scenes?.entries?.length) {
        result.scenes = scenes.entries.slice(0, 30).map((e) => ({
          path: e.path,
          updated_at: e.updated_at,
          ...(e.summary ? { has_summary: true } : {}),
        }))
      }
      result._context = echoOf(ctx)
      return { text: jsonText(result) }
    },
  })

  register({
    name: 'store_memory',
    description:
      'Store a conversation turn into L0 memory (write path). The isolation triple (team_id/agent_id/user_id) and task_id are fixed by the plugin config — no identity parameters are accepted. '
      + 'task_id is the project label, NOT the agent_id. Turns are also captured automatically at turn/end; use this to store something explicitly.',
    parameters: {
      user_content: { type: 'string', required: true, description: 'User input text' },
      assistant_content: { type: 'string', required: true, description: 'Assistant response text' },
      session_key: { type: 'string', description: 'Session key (default: plugin sessionKey / DSH session id)' },
    },
    async execute(args, exec) {
      await ensureReady()
      const ctx = ctxOf(exec)
      const sessionId = args.session_key || config.sessionKey || ctx.sessionId
      const data = await memory.addConversation(
        [
          { role: 'user', content: args.user_content },
          { role: 'assistant', content: args.assistant_content },
        ],
        sessionId,
        { ...ctx, sessionId: ctx.sessionId ?? sessionId },
      )
      return { text: jsonText({ ...data, _context: echoOf(ctx) }) }
    },
  })

  register({
    name: 'search_memories',
    description:
      'Semantic search across L1 atomic memories of the CURRENT task (project-scoped by task_id). Identity and task_id come from the plugin config — do not pass agent_id/team_id/user_id/task_id.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query' },
      limit: { type: 'number', description: 'Maximum number of results' },
      type: { type: 'string', description: 'Filter by memory type' },
      time_start: { type: 'string', description: 'ISO8601 lower bound (updated_at)' },
      time_end: { type: 'string', description: 'ISO8601 upper bound (updated_at)' },
    },
    async execute(args, exec) {
      await ensureReady()
      const ctx = ctxOf(exec)
      const data = await memory.searchAtomic(args.query, {
        limit: args.limit,
        type: args.type,
        time_start: args.time_start,
        time_end: args.time_end,
      }, ctx)
      return { text: jsonText({ items: data?.items ?? [], _context: echoOf(ctx) }) }
    },
  })

  // ── 任务协议（P1–P4）：serve agent 发号，worker 绑定 ────────────────────
  //
  // 约定：
  //   - 只有配置了 `taskAdmin: true` 的 agent（serve agent）能 task_create / task_close；
  //   - 任何会话都能 task_bind / task_get / task_list；
  //   - 绑定是**会话级**的：绑定后该会话所有读写（含自动入库）都用这个 task_id；
  //   - 绑定值来自服务端 task 实体（meta_tasks），worker 不允许自造字符串。

  const requireMeta = () => {
    if (!meta?.configured()) {
      throw new Error(
        'meta 通道不可用：/v3/meta/task/* 需要 userKey（AGENT_MEMORY_USER_KEY）——Bearer 不够。'
        + '请配置 userKeyRef 后重启。',
      )
    }
  }

  register({
    name: 'memory_brief',
    description:
      'Session brief for the CURRENT task: bound task info, digested L3 persona, L2 scene index, OPEN work_tasks (status != done, sorted by deadline), '
      + 'and recent work_facts — all capped to a token budget (default ~6000 chars / 2K tokens). '
      + 'Call this at the start of a task instead of recall_memory; use recall_memory for specific questions.',
    parameters: {
      max_chars: { type: 'number', description: 'Budget in characters (default config briefBudgetChars, else 6000)' },
    },
    async execute(args, exec) {
      await ensureReady()
      const ctx = ctxOf(exec)
      const [persona, scenes, tasks, facts] = await Promise.all([
        memory.readCore(ctx),
        memory.listScenarios(ctx),
        memory.atomicQuery({ type: 'work_task', limit: 100 }, ctx),
        memory.atomicQuery({ type: 'work_fact', limit: 20 }, ctx),
      ])
      const brief = composeBrief(
        { binding: bindingStore.get(ctx.sessionId), persona, scenes, tasks, facts },
        { maxChars: args.max_chars ?? config.briefBudgetChars ?? 8000 },
      )
      return { text: jsonText({ ...brief, _context: echoOf(ctx) }) }
    },
  })

  register({
    name: 'task_create',
    description:
      'Create a TASK ENTITY (meta_tasks) — serve-agent only (config taskAdmin: true). The server mints an immutable task_id (task-xxxx); '
      + 'creator is fixed to the configured user, and the creating session is bound to it immediately. '
      + 'Never invent a task_id string: workers must receive it from this tool or from task_list.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short task title' },
      description: { type: 'string', description: 'What needs to be done' },
      status: { type: 'string', description: 'running (default) | completed' },
      agent_ids: { type: 'array', items: { type: 'string' }, description: 'Linked agent ids (default: this agent)' },
    },
    async execute(args, exec) {
      await ensureReady()
      if (config.taskAdmin !== true) {
        throw new Error('task_create 未授权：只有 serve agent（config taskAdmin: true）可以创建任务；worker 请用 task_list + task_bind。')
      }
      requireMeta()
      const ctx = ctxOf(exec)
      const title = String(args.title || '').trim()
      if (!title) throw new Error('task_create 需要 title')
      const agentIds = Array.isArray(args.agent_ids) && args.agent_ids.length ? args.agent_ids : [config.agentId]
      const task = await meta.createTask({
        title,
        description: args.description,
        status: args.status || 'running',
        linked_agents: agentIds.map((id) => ({ agent_id: id, role_in_task: 'owner' })),
      })
      bindingStore.set(ctx.sessionId, { task_id: task.task_id, title: task.title })
      return { text: jsonText({ task, bound: bindingStore.get(ctx.sessionId), _context: echoOf(ctx) }) }
    },
  })

  register({
    name: 'task_bind',
    description:
      'Bind the CURRENT SESSION to an existing task (meta_tasks). After binding, every memory read/write in this session (including automatic L0 capture) '
      + 'uses that task_id. Verifies the task exists, belongs to this team, and is running. Idempotent.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'task-xxxx id from task_create / task_list' },
    },
    async execute(args, exec) {
      await ensureReady()
      requireMeta()
      const ctx = ctxOf(exec)
      const taskId = String(args.task_id || '').trim()
      if (!taskId) throw new Error('task_bind 需要 task_id')
      const task = await meta.getTask(taskId)
      if (!task?.task_id) throw new Error(`任务不存在：${taskId}（用 task_list 查看）`)
      if (task.team_id !== config.teamId) throw new Error(`任务 ${taskId} 不属于当前 team`)
      if (task.status !== 'running') throw new Error(`任务 ${taskId} 状态为 ${task.status}，只允许绑定 running 任务`)
      bindingStore.set(ctx.sessionId, { task_id: task.task_id, title: task.title })
      return { text: jsonText({ bound: bindingStore.get(ctx.sessionId), task, _context: echoOf(ctx) }) }
    },
  })

  register({
    name: 'task_get',
    description: 'Read one task entity (meta_tasks) and its linked agents. Read-only.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'task-xxxx id' },
    },
    async execute(args) {
      await ensureReady()
      requireMeta()
      const task = await meta.getTask(args.task_id)
      if (!task?.task_id) throw new Error(`任务不存在：${args.task_id}`)
      let agents = null
      try { agents = await meta.listAgents(args.task_id) } catch { /* 关联 agent 查询失败不影响任务本体 */ }
      return { text: jsonText({ task, agents }) }
    },
  })

  register({
    name: 'task_list',
    description: 'List task entities of this team (meta_tasks). Read-only. Use it to discover the task_id to bind.',
    parameters: {
      status: { type: 'string', description: 'running | completed' },
      limit: { type: 'number', description: 'Max tasks (default 50)' },
    },
    async execute(args) {
      await ensureReady()
      requireMeta()
      const data = await meta.listTasks({ status: args.status, limit: args.limit ?? 50 })
      return { text: jsonText({ items: data?.items ?? [], total: data?.total }) }
    },
  })

  register({
    name: 'task_close',
    description:
      'Mark a task completed (serve-agent only, config taskAdmin: true). Only the task creator can close it. '
      + 'Closing does NOT delete memories: the task bucket becomes read-only by convention; promote reusable lessons to L2/L3 first.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'task-xxxx id' },
    },
    async execute(args, exec) {
      await ensureReady()
      if (config.taskAdmin !== true) {
        throw new Error('task_close 未授权：只有 serve agent（config taskAdmin: true）可以关闭任务')
      }
      requireMeta()
      const ctx = ctxOf(exec)
      const task = await meta.updateTask(args.task_id, { status: 'completed' })
      const bound = bindingStore.get(ctx.sessionId)
      if (bound?.task_id === args.task_id) bindingStore.clear(ctx.sessionId)
      return { text: jsonText({ task, unbound: bound?.task_id === args.task_id, _context: echoOf(ctx) }) }
    },
  })

  // ── 代码图谱（只读） ──────────────────────────────────────────────────

  const codeTool = (toolName, description, parameters) =>
    register({
      name: toolName,
      description,
      parameters,
      async execute(args) {
        await ensureReady()
        return { text: toolName === 'code_graph_list' ? await codeGraph.list() : await codeGraph.query(toolName, args) }
      },
    })

  codeTool(
    'code_graph_list',
    '列出当前 team 可见的 code-graph 索引（仓库 URL、code_graph_id、同步状态、符号/文件规模）。其他 code_* 工具的 repo 参数以这里返回的仓库为准。只读。',
    {},
  )
  codeTool(
    'code_search',
    '在指定仓库的代码图谱中做符号/语义搜索（按关键词找函数、类、接口、变量等定义位置）。返回命中符号与文件位置。只读。',
    {
      query: { type: 'string', required: true, description: '搜索关键词（符号名/语义片段）' },
      repo: { type: 'string', description: '仓库 URL 或短名（如 dsh-ecosystem）；先用 code_graph_list 查看' },
      kind: { type: 'string', description: '符号类型过滤：function/method/class/interface/type/variable/route/component' },
      limit: { type: 'integer', description: '返回上限 1–100（默认 10）' },
    },
  )
  codeTool('code_callers', '查“XX 符号被谁调用/引用”——给定符号名，返回其调用方位置清单（带证据文件:行）。只读。', {
    symbol: { type: 'string', required: true, description: '符号名，如 runPull' },
    repo: { type: 'string', description: '仓库 URL 或短名（缺省=当前唯一索引）' },
    limit: { type: 'integer', description: '返回上限 1–200（默认 20）' },
  })
  codeTool('code_callees', '查“XX 调用了哪些符号”——给定符号名，返回其内部调用的目标清单。只读。', {
    symbol: { type: 'string', required: true, description: '符号名' },
    repo: { type: 'string', description: '仓库 URL 或短名' },
    limit: { type: 'integer', description: '返回上限 1–200（默认 20）' },
  })
  codeTool('code_impact', '估算变更影响面：给定符号，沿调用链向外扩散（depth 层）列出受影响符号。只读。', {
    symbol: { type: 'string', required: true, description: '符号名' },
    repo: { type: 'string', description: '仓库 URL 或短名' },
    depth: { type: 'integer', description: '扩散层数 1–10（默认 2）' },
  })
  codeTool('code_explore', '按语义探索定位相关文件：给定自然语言或符号片段，返回最相关的文件集合。只读。', {
    query: { type: 'string', required: true, description: '语义查询' },
    repo: { type: 'string', description: '仓库 URL 或短名' },
    maxFiles: { type: 'integer', description: '最多文件数 1–200（默认 12）' },
  })
  codeTool('code_node', '查单个符号的定义详情（含签名与文件:行，可选 includeCode 返回源码片段）。只读。', {
    symbol: { type: 'string', required: true, description: '符号名' },
    repo: { type: 'string', description: '仓库 URL 或短名' },
    includeCode: { type: 'boolean', description: '是否附带源码片段（默认 false）' },
    file: { type: 'string', description: '当符号同名歧义时限定文件路径' },
    line: { type: 'integer', description: '当符号同名歧义时限定行号' },
  })
  codeTool('code_files', '浏览仓库文件结构：树/平铺/分组格式，可按路径或 glob 过滤，附文件元数据。只读。', {
    repo: { type: 'string', description: '仓库 URL 或短名' },
    path: { type: 'string', description: '目录/文件路径定位' },
    pattern: { type: 'string', description: 'glob 过滤模式' },
    format: { type: 'string', description: 'tree/flat/grouped（默认 tree）' },
    includeMetadata: { type: 'boolean', description: '是否附带元数据（默认 true）' },
    maxDepth: { type: 'string', description: '树最大深度（整数）' },
  })

  // ── 进程内自动入库 ────────────────────────────────────────────────────
  // 订阅在 ready 里完成（见上）：先把凭证 ref 解析成客户端，再挂 global 事件监听。

  log(
    `ready v${version}: tools=${3 + CODE_QUERY_ACTIONS.size + 1 + 6} capture=${config.capture !== false ? 'on' : 'off'} `
    + `memory=${config.memoryEndpoint || '(unset)'} knowledge=${config.knowledgeEndpoint || '(unset)'} `
    + `team=${config.teamId || '(unset)'} `
    + `secrets=${config.apiKeyRef || config.userKeyRef || config.knowledgeApiKeyRef ? 'ref(' + [config.apiKeyRef, config.userKeyRef, config.knowledgeApiKeyRef].filter(Boolean).join(',') + ')' : 'inline'} `
    + `state=${config.capture !== false ? config.statePath || defaultStatePath() : '-'} `
    + `taskAdmin=${config.taskAdmin === true ? 'on' : 'off'} bindings=${bindingStore.path}`,
  )
}
