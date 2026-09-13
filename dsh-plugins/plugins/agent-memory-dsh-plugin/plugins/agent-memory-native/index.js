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
  contextEcho,
  createCaptureEngine,
  createCodeGraphClient,
  createMemoryClient,
  defaultStatePath,
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
  /** MemoryKnowledge（code-graph），如 http://127.0.0.1:8421 */
  knowledgeEndpoint: z.string(),
  /** 网关门禁 key（Authorization: Bearer） */
  apiKey: z.string(),
  /** memory 实例 id（x-tdai-service-id） */
  serviceId: z.string(),
  /** v3 身份三元组 */
  teamId: z.string(),
  agentId: z.string(),
  userId: z.string(),
  /** 团队 user_key（可选，meta 面鉴权） */
  userKey: z.string(),
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
 * @param ctx - cordis 上下文（inject: tools）。
 * @param config - 见 {@link Config}。
 */
export function apply(ctx, config) {
  const log = (...parts) => console.log('[agent-memory]', ...parts)
  const warn = (...parts) => console.warn('[agent-memory]', ...parts)

  const memory = createMemoryClient(config)
  const codeGraph = createCodeGraphClient(config)
  const capture = createCaptureEngine(config, { log, warn, memoryClient: memory })

  const register = (spec) =>
    ctx.tools.register(
      defineTool({
        ...spec,
        output: textOutput,
        presentCall: () => ({ card: 'generic', title: spec.name, kind: 'other' }),
      }),
    )

  const cwdOf = (exec) => exec?.session?.header?.cwd

  // ── 主记忆 ────────────────────────────────────────────────────────────

  register({
    name: 'recall_memory',
    description:
      'Recall relevant memories for the CURRENT task (project): L1 atomic facts (project-scoped by task_id), optionally L3 persona and the L2 scene index. '
      + 'Identity (team_id/agent_id/user_id) and task_id come from the plugin config — never pass or guess them. '
      + 'agent_id is the platform identity (agt-*), task_id is the project label; they differ and must not be mixed.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query for relevant memories' },
      limit: { type: 'number', description: 'Max L1 facts to return (default 5)' },
      include_persona: { type: 'boolean', description: 'Include L3 persona (default true)' },
      include_scenes: { type: 'boolean', description: 'Include L2 scene index (default false)' },
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const [facts, persona, scenes] = await Promise.all([
        memory.searchAtomic(args.query, { limit: args.limit }, cwd),
        args.include_persona === false ? Promise.resolve(null) : memory.readCore(cwd),
        args.include_scenes === true ? memory.listScenarios(cwd) : Promise.resolve(null),
      ])
      const result = { facts: facts?.items ?? [] }
      if (args.include_persona !== false && persona?.content) result.persona = persona.content
      if (args.include_scenes === true && scenes?.entries?.length) result.scenes = scenes.entries
      result._context = contextEcho(config, cwd)
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
      const cwd = cwdOf(exec)
      const sessionId = args.session_key || config.sessionKey || exec?.session?.id
      const data = await memory.addConversation(
        [
          { role: 'user', content: args.user_content },
          { role: 'assistant', content: args.assistant_content },
        ],
        sessionId,
        cwd,
      )
      return { text: jsonText({ ...data, _context: contextEcho(config, cwd) }) }
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
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const data = await memory.searchAtomic(args.query, { limit: args.limit, type: args.type }, cwd)
      return { text: jsonText({ items: data?.items ?? [], _context: contextEcho(config, cwd) }) }
    },
  })

  // ── 代码图谱（只读） ──────────────────────────────────────────────────

  const codeTool = (toolName, description, parameters) =>
    register({
      name: toolName,
      description,
      parameters,
      async execute(args) {
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

  const captureOn = config.capture !== false
  if (captureOn) {
    // 关键：profile 级插件必须用 { global: true } —— `session/event` 是「会话作用域」事件，
    // 不带该选项的监听器收不到任何事件（harness 官方订阅均如此，见 core/tools/invariant.ts）。
    ctx.on('session/event', (session, event) => {
      capture.handleEvent(session, event).catch((err) => warn(`session/event 处理异常：${err.message}`))
    }, { global: true })
  }

  log(
    `ready v${version}: tools=${3 + CODE_QUERY_ACTIONS.size + 1} capture=${captureOn ? 'on' : 'off'} `
    + `memory=${config.memoryEndpoint || '(unset)'} knowledge=${config.knowledgeEndpoint || '(unset)'} `
    + `team=${config.teamId || '(unset)'} state=${captureOn ? config.statePath || defaultStatePath() : '-'}`,
  )
}
