/**
 * agent-memory-admin — 记忆系统运维控制台（native dsh 插件）。
 *
 * 与 `tool-agent-memory`（工作台）互补：
 *   - 工作台按当前 task 读写；控制台**不绑定** agent/user/task，可跨团队盘点/检索/修改/删除；
 *   - 管理 task 实体、L2 场景、L3 画像、记忆提示词与健康状态。
 *
 * 8 个工具：memory_overview / memory_health / memory_list / memory_search /
 *          memory_get / memory_edit / memory_prompts / memory_tasks
 *
 * 安全：删除类操作必须显式 `confirm: true`，且需要配置 `allowDestructive: true`。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  L1_TYPES,
  createAdminClient,
  jsonText,
  parseMetadata,
  readBindings,
  readCaptureState,
  resolveSecretValue,
  topBy,
} from './lib.js'

const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))

export const name = 'tool-agent-memory-admin'
export const inject = ['tools']
export const version = PKG.version

export const Config = z.object({
  memoryEndpoint: z.string(),
  apiKey: z.string(),
  apiKeyRef: z.string(),
  userKey: z.string(),
  userKeyRef: z.string(),
  /** 管理面团队级作用域密钥（部署方设置 TDAI_ADMIN_KEY + credentials AGENT_MEMORY_ADMIN_KEY） */
  adminKey: z.string(),
  adminKeyRef: z.string(),
  serviceId: z.string(),
  teamId: z.string(),
  /** 运维身份（建任务时的 creator / 默认 owner） */
  userId: z.string(),
  agentId: z.string(),
  /** 本地引擎数据目录（用于展示 vectors.db 大小），缺省 ~/memory-tdai */
  dataDir: z.string(),
  timeoutMs: z.natural(),
  /** 允许删除类操作；默认 true，但仍要求每次 confirm */
  allowDestructive: z.boolean(),
})

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

export function apply(ctx, config) {
  const log = (...parts) => console.log('[agent-memory-admin]', ...parts)
  const warn = (...parts) => console.warn('[agent-memory-admin]', ...parts)

  const credentialService = () => {
    if (typeof ctx.get !== 'function') return undefined
    return ctx.get('credentials') ?? ctx.get('credentials', false)
  }
  const resolveSecret = async (ref, inline) => {
    let brand = (n) => n
    try {
      const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
      brand = credentialRef
    } catch {
      /* seam 不可用时回落 env */
    }
    const { value } = await resolveSecretValue({ ref, inline, service: credentialService(), brand, warn })
    return value
  }

  let client
  let readyPromise = null
  const ensureReady = () => (readyPromise ??= (async () => {
    const apiKey = await resolveSecret(config.apiKeyRef, config.apiKey)
    const userKey = await resolveSecret(config.userKeyRef, config.userKey)
    const adminKey = await resolveSecret(config.adminKeyRef, config.adminKey)
    client = createAdminClient({ ...config, apiKey, userKey, adminKey })
    if (!client.configured()) {
      warn('未配置完整（memoryEndpoint/apiKey/teamId），工具将在调用时报错')
    }
    return client
  })().catch((err) => {
    warn(`初始化失败：${err.message}`)
    readyPromise = null
    throw err
  }))

  for (const delay of [1500, 5000, 12000]) {
    const timer = setTimeout(() => { ensureReady().catch(() => {}) }, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const destructiveAllowed = config.allowDestructive !== false
  const requireConfirm = (confirm, what) => {
    if (!destructiveAllowed) throw new Error(`本插件未启用删除类操作（allowDestructive: false）：${what}`)
    if (confirm !== true) throw new Error(`危险操作需要显式 confirm: true：${what}`)
  }

  const register = (spec) =>
    ctx.tools.register(defineTool({ ...spec, output: textOutput, presentCall: () => ({ card: 'generic', title: spec.name, kind: 'other' }) }))

  const compactFact = (item) => ({
    id: item.id,
    type: item.type,
    task_id: item.task_id || '(empty)',
    agent_id: item.agent_id || '(empty)',
    priority: item.priority,
    metadata: parseMetadata(item.metadata_json),
    updated_at: item.updated_at,
    content: String(item.content ?? '').slice(0, 300),
  })

  /** 本地 profiles 目录口径的 L2/L3 计数（scenario/core API 按 team+agent 作用域，团队级需要落盘口径）。 */
  const countLocalProfiles = (dataDir) => {
    let scenes = 0
    let personas = 0
    try {
      for (const entry of readdirSync(join(dataDir, 'profiles'), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const root = join(dataDir, 'profiles', entry.name)
        try {
          if (statSync(join(root, 'persona.md')).isFile()) personas += 1
        } catch {
          /* 无画像 */
        }
        try {
          scenes += readdirSync(join(root, 'scene_blocks')).filter((file) => file.endsWith('.md')).length
        } catch {
          /* 无场景目录 */
        }
      }
    } catch {
      return null
    }
    return { scenes, personas }
  }

  // ── 盘点 ──────────────────────────────────────────────────────────────

  register({
    name: 'memory_overview',
    description:
      'One-shot inventory of the memory system: engine health, L0/L1/L2/L3 counts, L1 by type, top tasks/agents (sampled), '
      + 'task entities, session bindings, capture cursors, and local vectors.db size. Use this instead of browsing memory.',
    parameters: {
      sample: { type: 'number', description: 'L1 rows to sample for per-task/agent aggregation (default 500, max 2000)' },
    },
    async execute(args) {
      await ensureReady()
      const sampleSize = Math.min(Math.max(Math.trunc(args.sample ?? 500), 50), 2000)
      const typeCounts = await Promise.all(
        L1_TYPES.map(async (type) => {
          try {
            const data = await client.atomicCount({ type })
            return [type, data?.total ?? 0]
          } catch {
            return [type, null]
          }
        }),
      )
      // atomic/query 单页上限 100：按需分页抽样，避免 300/500 被 400 拒掉。
      const pages = Math.max(1, Math.ceil(sampleSize / 100))
      const samplePages = await Promise.all(
        Array.from({ length: pages }, (_, index) =>
          client.atomicQuery({ limit: 100, offset: index * 100 }).catch((err) => ({ error: err.message, items: [] })),
        ),
      )
      const sample = {
        items: samplePages.flatMap((page) => page?.items ?? []),
        error: samplePages.find((page) => page?.error)?.error,
      }
      const [health, conversations, scenes, cores, l1Total, tasks] = await Promise.all([
        client.health().catch((err) => ({ error: err.message })),
        client.conversationCount().catch((err) => ({ error: err.message })),
        client.scenarioCount().catch((err) => ({ error: err.message })),
        client.coreCount().catch((err) => ({ error: err.message })),
        client.atomicCount().catch((err) => ({ error: err.message })),
        client.taskList({ limit: 100 }).catch((err) => ({ error: err.message, items: [] })),
      ])
      const items = sample?.items ?? []
      const dataDir = config.dataDir || join(homedir(), 'memory-tdai')
      const localProfiles = countLocalProfiles(dataDir)
      let vectorsDbBytes = null
      try {
        vectorsDbBytes = statSync(join(dataDir, 'vectors.db')).size
      } catch {
        vectorsDbBytes = null
      }
      const result = {
        engine: {
          endpoint: client.base,
          status: health?.status,
          version: health?.version,
          stores: health?.stores,
          queue: health?.services?.pipelineWorker
            ? {
                consumed: health.services.pipelineWorker.tasksConsumed,
                completed: health.services.pipelineWorker.tasksCompleted,
                failed: health.services.pipelineWorker.tasksFailed,
                parked: health.services.pipelineWorker.parkedTasks,
              }
            : undefined,
          error: health?.error,
        },
        counts: {
          L0: conversations?.total ?? null,
          L1: l1Total?.total ?? null,
          L2: localProfiles?.scenes ?? scenes?.total ?? null,
          L3: localProfiles?.personas ?? cores?.total ?? null,
          L1_by_type: Object.fromEntries(typeCounts),
        },
        sample: {
          size: items.length,
          error: sample?.error,
          top_tasks: topBy(items, 'task_id', 10),
          top_agents: topBy(items, 'agent_id', 10),
        },
        tasks: {
          total: tasks?.total ?? (tasks?.items?.length ?? null),
          items: (tasks?.items ?? []).map((task) => ({
            task_id: task.task_id,
            title: task.title,
            status: task.status,
            creator_user_id: task.creator_user_id,
            updated_at: task.updated_at,
          })),
          error: tasks?.error,
        },
        bindings: readBindings(),
        capture: readCaptureState(),
        storage: { dataDir, vectorsDbBytes, l2_l3_source: localProfiles ? 'profiles/' : 'api' },
      }
      return { text: jsonText(result) }
    },
  })

  register({
    name: 'memory_health',
    description: 'Engine health (stores/queue) + capture cursors + session bindings + L1/L0 counts. Read-only diagnostics.',
    parameters: {},
    async execute() {
      await ensureReady()
      const [health, l0, l1, bindings, capture] = await Promise.all([
        client.health().catch((err) => ({ error: err.message })),
        client.conversationCount().catch((err) => ({ error: err.message })),
        client.atomicCount().catch((err) => ({ error: err.message })),
        Promise.resolve(readBindings()),
        Promise.resolve(readCaptureState()),
      ])
      return { text: jsonText({ health, counts: { L0: l0?.total, L1: l1?.total }, bindings, capture }) }
    },
  })

  // ── 检索 ──────────────────────────────────────────────────────────────

  register({
    name: 'memory_list',
    description:
      'List L1 memory records across the whole team (or narrowed by task_id / agent_id / user_id / type / time window). '
      + 'Paged, newest first. Use this to audit a project bucket; use memory_search for keyword queries.',
    parameters: {
      task_id: { type: 'string', description: 'Narrow to one task_id (omit = all tasks)' },
      agent_id: { type: 'string', description: 'Narrow to one agent_id' },
      user_id: { type: 'string', description: 'Narrow to one user_id' },
      type: { type: 'string', description: 'L1 type filter (work_fact / work_method / work_task / work_artifact / episodic / persona / instruction)' },
      time_start: { type: 'string', description: 'ISO8601 lower bound (updated_at)' },
      time_end: { type: 'string', description: 'ISO8601 upper bound (updated_at)' },
      limit: { type: 'number', description: 'Page size (default 20, max 100)' },
      offset: { type: 'number', description: 'Offset (default 0)' },
    },
    async execute(args) {
      await ensureReady()
      const data = await client.atomicQuery({
        task_id: args.task_id,
        agent_id: args.agent_id,
        user_id: args.user_id,
        type: args.type,
        time_start: args.time_start,
        time_end: args.time_end,
        limit: Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 100),
        offset: Math.max(Math.trunc(args.offset ?? 0), 0),
      })
      return { text: jsonText({ total: data?.total, items: (data?.items ?? []).map(compactFact) }) }
    },
  })

  register({
    name: 'memory_search',
    description:
      'Team-wide keyword/semantic search over L1 (no current-task restriction), optional filters. Returns score + type + task/agent.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query' },
      task_id: { type: 'string', description: 'Narrow to one task_id' },
      agent_id: { type: 'string', description: 'Narrow to one agent_id' },
      type: { type: 'string', description: 'L1 type filter' },
      time_start: { type: 'string', description: 'ISO8601 lower bound' },
      time_end: { type: 'string', description: 'ISO8601 upper bound' },
      limit: { type: 'number', description: 'Max results (default 20, max 100)' },
    },
    async execute(args) {
      await ensureReady()
      const data = await client.atomicSearch(args.query, {
        task_id: args.task_id,
        agent_id: args.agent_id,
        type: args.type,
        time_start: args.time_start,
        time_end: args.time_end,
        limit: Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 100),
      })
      return {
        text: jsonText({
          items: (data?.items ?? []).map((item) => ({ ...compactFact(item), score: item.score })),
        }),
      }
    },
  })

  register({
    name: 'memory_get',
    description: 'Read one object: kind=l2 (scenario path), kind=l3 (agent persona), or kind=task (task entity + linked agents).',
    parameters: {
      kind: { type: 'string', required: true, description: 'l2 | l3 | task' },
      path: { type: 'string', description: 'L2 scene path (kind=l2)' },
      agent_id: { type: 'string', description: 'Agent id (kind=l3, required)' },
      task_id: { type: 'string', description: 'Task id (kind=task, required)' },
    },
    async execute(args) {
      await ensureReady()
      if (args.kind === 'l2') {
        if (!args.path) throw new Error('kind=l2 需要 path')
        const data = await client.scenarioRead(args.path, { agent_id: args.agent_id })
        return { text: jsonText(data) }
      }
      if (args.kind === 'l3') {
        if (!args.agent_id) throw new Error('kind=l3 需要 agent_id（画像按 team+agent 隔离）')
        const data = await client.coreRead({ agent_id: args.agent_id })
        return { text: jsonText(data) }
      }
      if (args.kind === 'task') {
        if (!args.task_id) throw new Error('kind=task 需要 task_id')
        const [task, agents] = await Promise.all([
          client.taskGet(args.task_id),
          client.taskAgents(args.task_id).catch(() => null),
        ])
        return { text: jsonText({ task, agents }) }
      }
      throw new Error(`未知 kind: ${args.kind}（l2 | l3 | task）`)
    },
  })

  // ── 修改 / 删除 ───────────────────────────────────────────────────────

  register({
    name: 'memory_edit',
    description:
      'Mutate memory: l1_update (content/type/priority), l1_delete (ids; confirm), l2_write (path+content), '
      + 'l2_delete (path; confirm), l3_write (agent persona content). Deletions require confirm:true and allowDestructive.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'l1_update | l1_delete | l2_write | l2_delete | l3_write',
      },
      id: { type: 'string', description: 'L1 record id (l1_update)' },
      ids: { type: 'array', items: { type: 'string' }, description: 'L1 record ids (l1_delete)' },
      content: { type: 'string', description: 'New content (l1_update / l2_write / l3_write)' },
      background: { type: 'string', description: 'L1 background (l1_update)' },
      type: { type: 'string', description: 'L1 type (l1_update)' },
      priority: { type: 'number', description: 'L1 priority 0-100 (l1_update)' },
      agent_id: { type: 'string', description: 'Scope agent (l2/l3 writes require it)' },
      task_id: { type: 'string', description: 'Scope task (optional)' },
      path: { type: 'string', description: 'L2 scene path (l2_write / l2_delete)' },
      confirm: { type: 'boolean', description: 'Must be true for deletions' },
    },
    async execute(args) {
      await ensureReady()
      switch (args.action) {
        case 'l1_update': {
          if (!args.id) throw new Error('l1_update 需要 id')
          const data = await client.atomicUpdate({
            id: args.id,
            content: args.content,
            background: args.background,
            type: args.type,
            priority: args.priority,
            agent_id: args.agent_id,
            task_id: args.task_id,
          })
          return { text: jsonText({ updated: data }) }
        }
        case 'l1_delete': {
          const ids = (args.ids ?? []).filter(Boolean)
          if (!ids.length) throw new Error('l1_delete 需要 ids')
          requireConfirm(args.confirm, `删除 ${ids.length} 条 L1`)
          const data = await client.atomicDelete(ids, { agent_id: args.agent_id, task_id: args.task_id })
          return { text: jsonText({ deleted: data }) }
        }
        case 'l2_write': {
          if (!args.path || args.content === undefined) throw new Error('l2_write 需要 path + content')
          if (!args.agent_id) throw new Error('l2_write 需要 agent_id（L2 按 team+agent 隔离）')
          const data = await client.scenarioWrite(args.path, args.content, { agent_id: args.agent_id })
          return { text: jsonText({ written: data }) }
        }
        case 'l2_delete': {
          if (!args.path) throw new Error('l2_delete 需要 path')
          if (!args.agent_id) throw new Error('l2_delete 需要 agent_id')
          requireConfirm(args.confirm, `删除 L2 场景 ${args.path}`)
          await client.scenarioRm(args.path, { agent_id: args.agent_id })
          return { text: jsonText({ deleted: true, path: args.path }) }
        }
        case 'l3_write': {
          if (args.content === undefined) throw new Error('l3_write 需要 content')
          if (!args.agent_id) throw new Error('l3_write 需要 agent_id')
          const data = await client.coreWrite(args.content, { agent_id: args.agent_id })
          return { text: jsonText({ written: data }) }
        }
        default:
          throw new Error(`未知 action: ${args.action}`)
      }
    },
  })

  // ── 提示词 / 任务 ─────────────────────────────────────────────────────

  register({
    name: 'memory_prompts',
    description:
      'Inspect effective memory prompts (L1/L2/L3) and applied settings for this team. Read-only; edits stay in Panel.',
    parameters: {
      layer: { type: 'string', description: 'l1 | l2 | l3 (omit = all three)' },
      agent_id: { type: 'string', description: 'Resolve effective prompt for one agent instead of team default' },
    },
    async execute(args) {
      await ensureReady()
      const layers = args.layer ? [args.layer] : ['l1', 'l2', 'l3']
      const effective = await Promise.all(
        layers.map(async (layer) => {
          const data = await client.promptGetEffective(layer, { agent_id: args.agent_id }).catch((err) => ({ error: err.message }))
          return [layer, { source: data?.source, version: data?.version, prompt: String(data?.prompt ?? '').slice(0, 800) }]
        }),
      )
      const settings = await client.promptSettingList({}).catch((err) => ({ error: err.message, items: [] }))
      return { text: jsonText({ effective: Object.fromEntries(effective), settings: settings?.items ?? [], error: settings?.error }) }
    },
  })

  register({
    name: 'memory_tasks',
    description:
      'Manage task entities: list / get / create / close. Create accepts an optional custom task_id (serve-only control plane); '
      + 'omit it to let the server mint task-xxxx. close only marks completed (memories are kept).',
    parameters: {
      action: { type: 'string', required: true, description: 'list | get | create | close' },
      task_id: { type: 'string', description: 'Task id (get/close, or custom id on create)' },
      title: { type: 'string', description: 'Task title (create)' },
      description: { type: 'string', description: 'Task description (create)' },
      status: { type: 'string', description: 'running | completed (list filter / create status)' },
      agent_ids: { type: 'array', items: { type: 'string' }, description: 'Linked agent ids (create; default this agent)' },
      limit: { type: 'number', description: 'List page size (default 50)' },
    },
    async execute(args) {
      await ensureReady()
      switch (args.action) {
        case 'list': {
          const data = await client.taskList({ status: args.status, limit: args.limit ?? 50 })
          return { text: jsonText({ total: data?.total, items: data?.items ?? [] }) }
        }
        case 'get': {
          if (!args.task_id) throw new Error('get 需要 task_id')
          const [task, agents] = await Promise.all([
            client.taskGet(args.task_id),
            client.taskAgents(args.task_id).catch(() => null),
          ])
          return { text: jsonText({ task, agents }) }
        }
        case 'create': {
          if (!args.title) throw new Error('create 需要 title')
          const agents = Array.isArray(args.agent_ids) && args.agent_ids.length ? args.agent_ids : undefined
          const task = await client.taskCreate({
            task_id: args.task_id,
            title: args.title,
            description: args.description,
            status: args.status || 'running',
            linked_agents: agents?.map((id) => ({ agent_id: id, role_in_task: 'owner' })),
          })
          return { text: jsonText({ task }) }
        }
        case 'close': {
          if (!args.task_id) throw new Error('close 需要 task_id')
          const task = await client.taskUpdate(args.task_id, { status: 'completed' })
          return { text: jsonText({ task }) }
        }
        default:
          throw new Error(`未知 action: ${args.action}`)
      }
    },
  })

  log(
    `ready v${version}: tools=8 memory=${config.memoryEndpoint || '(unset)'} team=${config.teamId || '(unset)'} `
    + `secrets=${config.apiKeyRef || config.userKeyRef || config.adminKeyRef ? 'ref(' + [config.apiKeyRef, config.userKeyRef, config.adminKeyRef].filter(Boolean).join(',') + ')' : 'inline'} `
    + `destructive=${destructiveAllowed ? 'on(confirm required)' : 'off'}`,
  )
}
