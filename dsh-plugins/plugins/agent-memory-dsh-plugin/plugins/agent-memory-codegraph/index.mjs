#!/usr/bin/env node
/**
 * agent-memory-codegraph — MemoryCore code-graph MCP channel (local enhancement).
 *
 * A dependency-free MCP stdio server that exposes the code-graph query surface
 * of the local MemoryKnowledge service (:8421, /v3/code-graph/*) as tools, so
 * that agents can ask "符号被谁调用 / 模块依赖 / 变更影响面 / 代码在哪" and get
 * citable answers — the retrieval channel designed in dsh-ecosystem milestone #3
 * (issue #24/#25/#26).
 *
 * Design (see package README for the full decision record):
 *  - Upstream `tencent-agent-memory-mcp-bridge` stays untouched (official
 *    lightweight baseline). This server is the LOCAL ENHANCEMENT LAYER, loaded
 *    as an extra mcp-client instance in the web profile (cordis.patch.yml) with
 *    its own serverName `agent-memory-codegraph`.
 *  - Identity & isolation are inherited from the profile env: TEAM_ID / USER_ID
 *    (and AGENT_ID where available) are the only scope used when listing which
 *    code-graph indexes are visible. Callers can never supply identity.
 *  - Failure semantics (issue #26): when the graph service is unreachable or a
 *    query fails, tools return an EXPLICIT error (isError) — never a silent
 *    empty result.
 *
 * Wire protocol: minimal JSON-RPC 2.0 over stdio, one JSON object per line
 * (same framing as @modelcontextprotocol/sdk StdioServerTransport). Supports
 * initialize / ping / tools/list / tools/call; ignores notifications.
 * No third-party dependencies on purpose: runs anywhere `node` exists.
 */

import { createHash } from 'node:crypto'

// ───────────────────────────── config ─────────────────────────────

const KNOWLEDGE_ENDPOINT = (process.env.KNOWLEDGE_ENDPOINT || 'http://127.0.0.1:8421').replace(/\/+$/, '')
const SERVICE_ID = process.env.SERVICE_ID || 'default'
const TEAM_ID = process.env.TEAM_ID || ''
const USER_ID = process.env.USER_ID || ''
const AGENT_ID = process.env.AGENT_ID || ''
const HTTP_TIMEOUT_MS = Number(process.env.KNOWLEDGE_HTTP_TIMEOUT_MS || 12000)
const META_TTL_MS = Number(process.env.KNOWLEDGE_META_TTL_MS || 60000)

if (!TEAM_ID) {
  // A team-scoped memory server without an identity cannot isolate. Fail loud
  // at startup instead of leaking cross-team indexes later.
  console.error('[agent-memory-codegraph] fatal: TEAM_ID env is required (identity isolation)')
  process.exit(1)
}

// ───────────────────────────── helpers ─────────────────────────────

function log(...parts) {
  // Never write to stdout — that is the MCP channel.
  console.error('[agent-memory-codegraph]', ...parts)
}

function contextEcho() {
  const ctx = { team_id: TEAM_ID }
  if (USER_ID) ctx.user_id = USER_ID
  if (AGENT_ID) ctx.agent_id = AGENT_ID
  ctx.service_id = SERVICE_ID
  return ctx
}

async function httpPost(path, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(`${KNOWLEDGE_ENDPOINT}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tdai-service-id': SERVICE_ID,
      },
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
    if (!res.ok) {
      throw new Error(`knowledge service HTTP ${res.status}: ${raw.slice(0, 300)}`)
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

function checkEnvelope(json) {
  if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
    throw new Error(`knowledge service error: code=${json.code} message=${json.message || ''}`)
  }
  return json && typeof json === 'object' && 'data' in json ? json.data : json
}

function clampi(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return undefined
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

function normRepoKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\/+$/, '')
}

// ───────────────────── index discovery (isolated) ─────────────────────

/** Cache of visible indexes keyed by normalized repo url / name segment. */
let indexCache = { at: 0, rows: [], byUrl: new Map(), bySlug: new Map() }

async function refreshIndexes(force = false) {
  const now = Date.now()
  if (!force && indexCache.rows.length && now - indexCache.at < META_TTL_MS) return indexCache
  const data = checkEnvelope(
    await httpPost('/v3/code-graph/list', { team_id: TEAM_ID, limit: 100, offset: 0 }),
  )
  const rows = (data && (data.items || [])) || []
  const byUrl = new Map()
  const bySlug = new Map()
  for (const row of rows) {
    const id = row.code_graph_id || row.id
    if (!id) continue
    const url = (row.repo_url || row.name || '').trim()
    const urlNorm = normRepoKey(url).replace(/\.git$/, '')
    if (urlNorm) byUrl.set(urlNorm, row)
    // last path segment of the url, e.g. dsh-ecosystem
    const seg = urlNorm.split('/').pop()
    if (seg) {
      if (!bySlug.has(seg)) bySlug.set(seg, [])
      bySlug.get(seg).push(row)
    }
  }
  indexCache = { at: now, rows, byUrl, bySlug }
  return indexCache
}

async function resolveIndex(repo) {
  const cache = await refreshIndexes()
  if (!repo || !String(repo).trim()) {
    if (cache.rows.length === 1) return cache.rows[0]
    throw new Error(
      `repo 参数必填（当前 team 下可见 ${cache.rows.length} 个索引）。先用 code_graph_list 查看可用仓库，再传 repo（仓库 URL 或短名，如 dsh-ecosystem）。`,
    )
  }
  const key = normRepoKey(repo)
  const urlKey = key.replace(/\.git$/, '')
  const direct = cache.byUrl.get(urlKey) || cache.byUrl.get(`${urlKey}.git`)
  if (direct) return direct
  const slug = urlKey.split('/').pop()
  const matches = cache.bySlug.get(slug) || []
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(
      `repo "${repo}" 匹配到多个索引（${matches.map((r) => r.repo_url).join('、')}），请用完整仓库 URL 消歧。`,
    )
  }
  throw new Error(
    `未找到 repo="${repo}" 的已索引 code-graph（可见索引见 code_graph_list）。可能未索引或不属于当前 team。`,
  )
}

function fmtIndexRow(row) {
  const id = row.code_graph_id || row.id
  const url = row.repo_url || row.name || ''
  const status = row.sync_status || row.status || 'unknown'
  const summary = row.summary || ''
  const updated = row.updated_at || ''
  return `- ${id}  ${url}  [${status}]${summary ? '  ' + summary : ''}${updated ? '  (updated ' + updated + ')' : ''}`
}

// ───────────────────────────── tools ─────────────────────────────

const SCHEMA_T = { string: 'string', integer: 'integer', boolean: 'boolean' }

const TOOLS = [
  {
    name: 'code_graph_list',
    description:
      '列出当前 team 可见的 code-graph 索引（仓库 URL、code_graph_id、同步状态、符号/文件规模）。其他 code_* 工具的 repo 参数以这里返回的仓库为准。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'code_search',
    description:
      '在指定仓库的代码图谱中做符号/语义搜索（按关键词找函数、类、接口、变量等定义位置）。返回命中符号与文件位置。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（符号名/语义片段）' },
        repo: { type: 'string', description: '仓库 URL 或短名（如 dsh-ecosystem）；先用 code_graph_list 查看' },
        kind: { type: 'string', description: '符号类型过滤：function/method/class/interface/type/variable/route/component' },
        limit: { type: 'integer', description: '返回上限 1–100（默认 10）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'code_callers',
    description: '查“XX 符号被谁调用/引用”——给定符号名，返回其调用方位置清单（带证据文件:行）。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '符号名，如 runPull' },
        repo: { type: 'string', description: '仓库 URL 或短名（默认缺省=当前唯一索引）' },
        limit: { type: 'integer', description: '返回上限 1–200（默认 20）' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'code_callees',
    description: '查“XX 调用了哪些符号”——给定符号名，返回其内部调用的目标清单。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '符号名' },
        repo: { type: 'string', description: '仓库 URL 或短名' },
        limit: { type: 'integer', description: '返回上限 1–200（默认 20）' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'code_impact',
    description: '估算变更影响面：给定符号，沿调用链向外扩散（depth 层）列出受影响符号。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '符号名' },
        repo: { type: 'string', description: '仓库 URL 或短名' },
        depth: { type: 'integer', description: '扩散层数 1–10（默认 2）' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'code_explore',
    description: '按语义探索定位相关文件：给定自然语言或符号片段，返回最相关的文件集合。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '语义查询' },
        repo: { type: 'string', description: '仓库 URL 或短名' },
        maxFiles: { type: 'integer', description: '最多文件数 1–200（默认 12）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'code_node',
    description: '查单个符号的定义详情（含签名与文件:行，可选 includeCode 返回源码片段）。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '符号名' },
        repo: { type: 'string', description: '仓库 URL 或短名' },
        includeCode: { type: 'boolean', description: '是否附带源码片段（默认 false）' },
        file: { type: 'string', description: '当符号同名歧义时限定文件路径' },
        line: { type: 'integer', description: '当符号同名歧义时限定行号' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'code_files',
    description: '浏览仓库文件结构：树/平铺/分组格式，可按路径或 glob 过滤，附文件元数据。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库 URL 或短名' },
        path: { type: 'string', description: '目录/文件路径定位' },
        pattern: { type: 'string', description: 'glob 过滤模式' },
        format: { type: 'string', description: 'tree/flat/grouped（默认 tree）' },
        includeMetadata: { type: 'boolean', description: '是否附带元数据（默认 true）' },
        maxDepth: { type: 'integer', description: '树最大深度' },
      },
      additionalProperties: false,
    },
  },
]

const QUERY_ACTIONS = new Map([
  ['code_search', 'search'],
  ['code_callers', 'callers'],
  ['code_callees', 'callees'],
  ['code_impact', 'impact'],
  ['code_explore', 'explore'],
  ['code_node', 'node'],
  ['code_files', 'files'],
])

const FIELD_TO_PARAM = {
  query: ['query'],
  symbol: ['symbol'],
  repo: null, // resolved to code_graph_id
  limit: ['limit'],
  kind: ['kind'],
  depth: ['depth'],
  maxFiles: ['maxFiles'],
  includeCode: ['includeCode'],
  file: ['file'],
  line: ['line'],
  path: ['path'],
  pattern: ['pattern'],
  format: ['format'],
  includeMetadata: ['includeMetadata'],
  maxDepth: ['maxDepth'],
}

// ───────────────────── MCP stdio server (minimal) ─────────────────────

let stdinBuf = ''
const serverInfo = { name: 'agent-memory-codegraph', version: '1.0.0' }

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function result(id, resultObj) {
  send({ jsonrpc: '2.0', id, result: resultObj })
}

function jsonRpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function okText(text) {
  return { content: [{ type: 'text', text }] }
}

async function handleToolCall(rawName, args) {
  const toolArgs = args && typeof args === 'object' ? args : {}
  if (rawName === 'code_graph_list') {
    const cache = await refreshIndexes(true)
    const lines = [
      `code-graph 索引（team ${TEAM_ID}，共 ${cache.rows.length} 个）：`,
      ...(cache.rows.length ? cache.rows.map(fmtIndexRow) : ['（无）']),
      '',
      JSON.stringify({ items: cache.rows, _context: contextEcho() }, null, 2),
    ]
    return okText(lines.join('\n'))
  }

  const action = QUERY_ACTIONS.get(rawName)
  if (!action) throw new Error(`Unknown tool: ${rawName}`)

  const index = await resolveIndex(toolArgs.repo)
  const body = { code_graph_id: index.code_graph_id || index.id }
  for (const [key, wire] of Object.entries(FIELD_TO_PARAM)) {
    if (key === 'repo') continue
    const v = toolArgs[key]
    if (v === undefined || v === null) continue
    const [param] = wire
    if (param === 'limit') {
      const n = clampi(v, 1, rawName === 'code_search' ? 100 : 200)
      if (n !== undefined) body[param] = n
    } else if (param === 'depth') {
      const n = clampi(v, 1, 10)
      if (n !== undefined) body[param] = n
    } else if (param === 'maxFiles') {
      const n = clampi(v, 1, 200)
      if (n !== undefined) body[param] = n
    } else if (param === 'line') {
      const n = clampi(v, 1, 10_000_000)
      if (n !== undefined) body[param] = n
    } else {
      body[param] = v
    }
  }

  const data = checkEnvelope(await httpPost(`/v3/code-graph/${action}`, body))
  const engineText = data && typeof data.text === 'string' ? data.text : ''
  if (data && data.isError) {
    return { content: [{ type: 'text', text: `code-graph 查询失败: ${engineText || 'unknown'}` }], isError: true }
  }
  const header =
    `[code-graph] ${index.repo_url || index.name || index.code_graph_id || index.id} · ${rawName}` +
    (index.branch ? ` (${index.branch})` : '')
  const text = engineText ? `${header}\n${engineText}` : `${header}\n（空结果）`
  return { content: [{ type: 'text', text }], isError: false }
}

async function dispatch(req) {
  const method = req.method
  if (req.id !== undefined && req.id !== null && typeof req.id !== 'string' && typeof req.id !== 'number') {
    // protocol requires string|number|null
  }
  try {
    if (method === 'initialize') {
      const params = (req.params && typeof req.params === 'object') ? req.params : {}
      const requested = params.protocolVersion
      return result(req.id, {
        protocolVersion: typeof requested === 'string' ? requested : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo,
      })
    }
    if (method === 'ping') return result(req.id, {})
    if (method === 'tools/list') {
      return result(req.id, { tools: TOOLS })
    }
    if (method === 'tools/call') {
      const params = (req.params && typeof req.params === 'object') ? req.params : {}
      const rawName = String(params.name || '')
      const out = await handleToolCall(rawName, params.arguments)
      return send({ jsonrpc: '2.0', id: req.id, result: out })
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return // notifications carry no id and expect no response
    }
    // unknown request
    if (req.id !== undefined) {
      return jsonRpcError(req.id, -32601, `Method not found: ${method}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`tool '${method}' failed:`, message)
    if (req.id !== undefined) {
      const isToolCall = method === 'tools/call'
      if (isToolCall) {
        // Failure semantics: explicit error, never a silent empty result.
        return send({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: `code-graph 通道错误: ${message}` }], isError: true },
        })
      }
      return jsonRpcError(req.id, -32603, message)
    }
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk
  let idx
  while ((idx = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, idx).trim()
    stdinBuf = stdinBuf.slice(idx + 1)
    if (!line) continue
    let req
    try {
      req = JSON.parse(line)
    } catch {
      continue // non-JSON noise on stdin: ignore
    }
    if (req && typeof req === 'object' && req.method) {
      dispatch(req).catch((err) => {
        log('dispatch error:', err && err.message ? err.message : String(err))
        if (req.id !== undefined) jsonRpcError(req.id, -32603, String(err && err.message ? err.message : err))
      })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

// Keep the process alive waiting on stdin (no timers needed).
log(`ready: endpoint=${KNOWLEDGE_ENDPOINT} service=${SERVICE_ID} team=${TEAM_ID} tools=${TOOLS.length}`)
