#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { loadConfig } from './config.js'
import { V3MemoryClient } from './client.js'
import { TaskBindingStore } from './binding.js'
import { composeBrief, digestPersona, trimScenes } from './brief.js'

const config = loadConfig()
const client = new V3MemoryClient({ ...config, userKey: config.userKey })
const bindingStore = new TaskBindingStore(config.taskBindingPath, (message) => {
  console.error(`[mcp-bridge] ${message}`)
})

// 启动时恢复本会话的 task 绑定（TBP）。
const restored = bindingStore.get(config.sessionKey)
if (restored) client.setTaskId(restored.task_id)

/** serve 白名单：只有部署方显式列入 TASK_ADMIN_AGENT_IDS 的 agent 能建/关任务。 */
const isTaskAdmin = config.taskAdminAgentIds.includes(config.agentId)

const TOOLS: Tool[] = [
  {
    name: 'memory_brief',
    description:
      'Session brief for the CURRENT task: bound task info, digested L3 persona, L2 scene index, OPEN work_tasks (status != done, sorted by deadline), ' +
      'and recent work_facts — all capped to a token budget (default ~8000 chars / 2.7K tokens). ' +
      'Call this at the start of a task instead of recall_memory; use recall_memory for specific questions.',
    inputSchema: {
      type: 'object',
      properties: {
        max_chars: { type: 'number', description: 'Budget in characters (default BRIEF_BUDGET_CHARS or 8000)' },
      },
    },
  },
  {
    name: 'recall_memory',
    description:
      'Recall relevant memories for the CURRENT task (project). Returns L1 facts (project-scoped by task_id); L3 persona is OFF by default (opt in, digested), ' +
      'L2 scenes return an INDEX only (path/updated_at), use search_memories or scenario tools for details. ' +
      'Identity (team_id/agent_id/user_id) and task_id are fixed by the MCP server environment — never pass or guess them. ' +
      'Results include a _context block echoing the active isolation domain.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for relevant memories' },
        limit: { type: 'number', description: 'Max L1 facts to return (default 5)' },
        type: { type: 'string', description: 'Filter by L1 type: work_fact / work_method / work_task / work_artifact / episodic / persona / instruction' },
        time_start: { type: 'string', description: 'ISO8601 lower bound (updated_at)' },
        time_end: { type: 'string', description: 'ISO8601 upper bound (updated_at)' },
        include_persona: { type: 'boolean', description: 'Include a DIGESTED L3 persona (default false)' },
        include_scenes: { type: 'boolean', description: 'Include the L2 scene index (path/updated_at only, default false)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'store_memory',
    description:
      'Store a conversation turn into L0 memory (write path, requires a session). ' +
      'Writes under the isolation triple (team_id/agent_id/user_id) and the CURRENT task_id (session binding or config) — no identity or task parameters are accepted. ' +
      'Results include a _context block echoing the active isolation domain.',
    inputSchema: {
      type: 'object',
      properties: {
        user_content: { type: 'string', description: 'User input text' },
        assistant_content: { type: 'string', description: 'Assistant response text' },
        session_key: { type: 'string', description: 'Session key (default: auto per agent+day)' },
      },
      required: ['user_content', 'assistant_content'],
    },
  },
  {
    name: 'search_memories',
    description:
      'Semantic search across L1 atomic memories of the CURRENT task (project-scoped by task_id). ' +
      'Identity and task_id come from the MCP server environment — do not pass agent_id/team_id/user_id/task_id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum number of results' },
        type: { type: 'string', description: 'Filter by memory type' },
        time_start: { type: 'string', description: 'ISO8601 lower bound (updated_at)' },
        time_end: { type: 'string', description: 'ISO8601 upper bound (updated_at)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'task_create',
    description:
      'Create a TASK ENTITY (meta_tasks) — SERVE AGENT ONLY. The deployment must list this AGENT_ID in TASK_ADMIN_AGENT_IDS and provide USER_KEY. ' +
      'The server mints an immutable task_id (task-xxxx); creator is the configured user, and this MCP session is bound to it immediately. ' +
      'Never invent a task_id string.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'What needs to be done' },
        status: { type: 'string', description: 'running (default) | completed' },
        agent_ids: { type: 'array', items: { type: 'string' }, description: 'Linked agent ids (default: this agent)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'task_bind',
    description:
      'Bind the CURRENT MCP session to an existing task (meta_tasks). After binding, every memory read/write in this session uses that task_id. ' +
      'Verifies existence, team, and running status. Idempotent. Workers use this; only serve agents create tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'task-xxxx id from task_create / task_list' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_get',
    description: 'Read one task entity (meta_tasks) and its linked agents. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'task-xxxx id' } },
      required: ['task_id'],
    },
  },
  {
    name: 'task_list',
    description: 'List task entities of this team (meta_tasks). Read-only. Use it to discover the task_id to bind.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'running | completed' },
        limit: { type: 'number', description: 'Max tasks (default 50)' },
      },
    },
  },
  {
    name: 'task_close',
    description:
      'Mark a task completed — SERVE AGENT ONLY (TASK_ADMIN_AGENT_IDS). Only the task creator can close it. ' +
      'Closing does NOT delete memories; the bucket becomes read-only by convention.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'task-xxxx id' } },
      required: ['task_id'],
    },
  },
]

const server = new Server(
  { name: 'tencent-agent-memory-mcp-bridge', version: '0.5.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

/**
 * 回显当前隔离上下文（不含任何 key）。task_id 取当前生效值（绑定优先），
 * task_source 让调用方确认是 binding 还是 config。
 */
function contextEcho(): Record<string, string | undefined> {
  return {
    team_id: config.teamId,
    agent_id: config.agentId,
    user_id: config.userId,
    task_id: client.currentTaskId(),
    task_source: client.taskSource(),
  }
}

function resolveSession(sessionKey: string | undefined | null): string {
  return sessionKey || config.sessionKey
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'memory_brief': {
        const [persona, scenes, tasks, facts] = await Promise.all([
          client.readCore(),
          client.listScenarios(),
          client.atomicQuery({ type: 'work_task', limit: 100 }),
          client.atomicQuery({ type: 'work_fact', limit: 20 }),
        ])
        const brief = composeBrief(
          { binding: bindingStore.get(config.sessionKey), persona, scenes, tasks, facts },
          { maxChars: (args?.max_chars as number | undefined) ?? config.briefBudgetChars },
        )
        return text({ ...brief, _context: contextEcho() })
      }

      case 'recall_memory': {
        const includePersona = args?.include_persona === true
        const includeScenes = args?.include_scenes === true
        const [facts, persona, scenes] = await Promise.all([
          client.searchAtomic(args?.query as string, {
            limit: args?.limit as number | undefined,
            type: args?.type as string | undefined,
            time_start: args?.time_start as string | undefined,
            time_end: args?.time_end as string | undefined,
          }),
          includePersona ? client.readCore() : Promise.resolve(null),
          includeScenes ? client.listScenarios() : Promise.resolve(null),
        ])
        const result: Record<string, unknown> = { facts: facts.items ?? [] }
        if (includePersona && persona?.content) result.persona_digest = digestPersona(persona.content, 2000)
        if (includeScenes && scenes?.entries?.length) result.scenes = trimScenes(scenes.entries)
        result._context = contextEcho()
        return text(result)
      }

      case 'store_memory': {
        const data = await client.addConversation(
          [
            { role: 'user', content: args?.user_content as string },
            { role: 'assistant', content: args?.assistant_content as string },
          ],
          resolveSession(args?.session_key as string | undefined),
        )
        return text({ ...data, _context: contextEcho() })
      }

      case 'search_memories': {
        const data = await client.searchAtomic(args?.query as string, {
          limit: args?.limit as number | undefined,
          type: args?.type as string | undefined,
          time_start: args?.time_start as string | undefined,
          time_end: args?.time_end as string | undefined,
        })
        return text({ items: data.items ?? [], _context: contextEcho() })
      }

      case 'task_create': {
        if (!isTaskAdmin) {
          throw new Error(
            `task_create 未授权：本 agent（${config.agentId}）不在 TASK_ADMIN_AGENT_IDS 白名单里。` +
              'serve 能力由部署方在 MCP server 环境变量中显式授权；worker 请用 task_list + task_bind。',
          )
        }
        const title = String(args?.title ?? '').trim()
        if (!title) throw new Error('task_create requires a title')
        const agentIds = Array.isArray(args?.agent_ids) && args.agent_ids.length
          ? (args.agent_ids as string[])
          : [config.agentId]
        const task = await client.createTask({
          title,
          description: args?.description as string | undefined,
          status: (args?.status as string | undefined) ?? 'running',
          linked_agents: agentIds.map((id) => ({ agent_id: id, role_in_task: 'owner' })),
        })
        bindingStore.set(config.sessionKey, { task_id: task.task_id, title: task.title })
        client.setTaskId(task.task_id)
        return text({ task, bound: bindingStore.get(config.sessionKey), _context: contextEcho() })
      }

      case 'task_bind': {
        const taskId = String(args?.task_id ?? '').trim()
        if (!taskId) throw new Error('task_bind requires task_id')
        const task = await client.getTask(taskId)
        if (!task?.task_id) throw new Error(`任务不存在：${taskId}（用 task_list 查看）`)
        if (task.team_id !== config.teamId) throw new Error(`任务 ${taskId} 不属于当前 team`)
        if (task.status && task.status !== 'running') {
          throw new Error(`任务 ${taskId} 状态为 ${task.status}，只允许绑定 running 任务`)
        }
        bindingStore.set(config.sessionKey, { task_id: task.task_id, title: task.title })
        client.setTaskId(task.task_id)
        return text({ bound: bindingStore.get(config.sessionKey), task, _context: contextEcho() })
      }

      case 'task_get': {
        const task = await client.getTask(String(args?.task_id ?? ''))
        if (!task?.task_id) throw new Error(`任务不存在：${String(args?.task_id ?? '')}`)
        let agents: unknown = null
        try {
          agents = await client.listTaskAgents(task.task_id)
        } catch {
          /* 关联 agent 查询失败不影响任务本体 */
        }
        return text({ task, agents })
      }

      case 'task_list': {
        const data = await client.listTasks({
          status: args?.status as string | undefined,
          limit: (args?.limit as number | undefined) ?? 50,
        })
        return text({ items: data.items ?? [], total: data.total })
      }

      case 'task_close': {
        if (!isTaskAdmin) {
          throw new Error(
            `task_close 未授权：本 agent（${config.agentId}）不在 TASK_ADMIN_AGENT_IDS 白名单里。`,
          )
        }
        const taskId = String(args?.task_id ?? '').trim()
        const task = await client.updateTask(taskId, { status: 'completed' })
        const bound = bindingStore.get(config.sessionKey)
        const unbound = bound?.task_id === taskId
        if (unbound) {
          bindingStore.clear(config.sessionKey)
          client.setTaskId(null)
        }
        return text({ task, unbound, _context: contextEcho() })
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)

// Re-export types for consumers who import the package
export type { McpConfig } from './config.js'
export { V3MemoryClient, type V3ClientConfig } from './client.js'
export { TaskBindingStore, type TaskBinding } from './binding.js'
export { composeBrief, digestPersona } from './brief.js'
