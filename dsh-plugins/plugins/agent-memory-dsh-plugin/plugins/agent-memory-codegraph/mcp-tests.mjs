#!/usr/bin/env node
/**
 * agent-memory-codegraph — mock/unit tests + optional real integration run.
 *
 * Unit mode (default): spins up an in-process mock "MemoryKnowledge" HTTP
 * service, spawns the wrapper as an MCP stdio child, and drives it with raw
 * JSON-RPC lines to assert: handshake, tool listing, repo resolution &
 * isolation, body forwarding, explicit-error semantics on unknown repo and on
 * service-down (never silent empty).
 *
 * Integration mode: `REAL=1 node mcp-tests.mjs` runs the same assertions
 * against the live local MemoryKnowledge service (:8421) and prints results —
 * used to collect end-to-end evidence for issue #27.
 *
 * Run:  node mcp-tests.mjs        (mock)
 *        REAL=1 node mcp-tests.mjs (live service)
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const WRAPPER = join(HERE, 'index.mjs')
const REAL = process.env.REAL === '1'
const KNOWLEDGE_ENDPOINT = process.env.KNOWLEDGE_ENDPOINT || 'http://127.0.0.1:8421'

let passed = 0
let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name} ${extra}`)
  }
}

// ─────────────────────────── mock knowledge service ───────────────────────────

const MOCK_INDEXES = [
  {
    code_graph_id: 'cg-mockaaa',
    repo_url: 'https://github.com/kuaizhongqiang/dsh-ecosystem.git',
    branch: 'main',
    sync_status: 'ready',
    summary: 'dsh-ecosystem（main）- 136 个文件、2389 个符号节点',
    updated_at: '2026-09-09T23:16:44Z',
  },
  {
    code_graph_id: 'cg-mockbbb',
    repo_url: 'https://github.com/kuaizhongqiang/other-repo.git',
    branch: 'main',
    sync_status: 'ready',
    summary: 'other-repo（main）- 12 个文件、88 个符号节点',
    updated_at: '2026-09-09T23:16:44Z',
  },
]

async function startMock() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      let payload = {}
      try {
        payload = body ? JSON.parse(body) : {}
      } catch {
        payload = {}
      }
      const url = req.url || ''
      if (url === '/v3/code-graph/list') {
        if (payload.team_id !== 'team-mock') {
          res.end(JSON.stringify({ code: 0, data: { items: [] } }))
          return
        }
        res.end(JSON.stringify({ code: 0, data: { items: MOCK_INDEXES } }))
        return
      }
      const action = url.replace('/v3/code-graph/', '')
      if (['search', 'callers', 'callees', 'impact', 'node', 'explore', 'files', 'status'].includes(action)) {
        if (payload.code_graph_id !== 'cg-mockaaa') {
          res.end(JSON.stringify({ code: 404, message: `no such code_graph_id: ${payload.code_graph_id}` }))
          return
        }
        const text =
          action === 'search'
            ? `**Search Results (1 found)**\n\n**runPull** (function)\ndsh-launcher/src/ecosystem.ts:473\n`
            : `${action} result for ${payload.symbol || payload.query || '?'} (mock)`
        res.end(JSON.stringify({ code: 0, data: { text, isError: false } }))
        return
      }
      res.end(JSON.stringify({ code: 404, message: 'not found' }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return { server, endpoint: `http://127.0.0.1:${port}` }
}

// ─────────────────────────── MCP stdio driver ───────────────────────────

function spawnWrapper(envOverrides = {}) {
  const env = {
    ...process.env,
    TEAM_ID: process.env.TEAM_ID || 'team-mock',
    USER_ID: 'usr-mock',
    SERVICE_ID: 'default',
    KNOWLEDGE_ENDPOINT: envOverrides.KNOWLEDGE_ENDPOINT || KNOWLEDGE_ENDPOINT,
    KNOWLEDGE_HTTP_TIMEOUT_MS: '3000',
    ...envOverrides,
  }
  const child = spawn(process.execPath, [WRAPPER], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const rl = readline.createInterface({ input: child.stdout })
  const pending = new Map()
  let seq = 0
  rl.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id)
      clearTimeout(timer)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else resolve(msg.result)
    }
  })
  child.stderr.on('data', () => {}) // keep drain; logs visible via child.stderr not needed
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting ${method}`))
      }, 8000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  return { child, request, notify }
}

async function withWrapper(fn, envOverrides) {
  const w = spawnWrapper(envOverrides)
  try {
    return await fn(w)
  } finally {
    w.child.kill('SIGTERM')
  }
}

function unwrap(result) {
  // text content may arrive as array of blocks
  if (!result || !result.content) return { text: '', isError: !!result.isError }
  const blocks = Array.isArray(result.content) ? result.content : []
  const text = blocks
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
  return { text, isError: !!result.isError }
}

// ───────────────────────────── test body ─────────────────────────────

console.log(REAL ? '== INTEGRATION (live service) ==' : '== MOCK unit tests ==')

let endpoint = KNOWLEDGE_ENDPOINT
let server
if (!REAL) {
  const mock = await startMock()
  endpoint = mock.endpoint
  server = mock.server
}

const EXPECT_TEAM = process.env.TEAM_ID || 'team-mock'

try {
  // 1. handshake + tools/list
  await withWrapper(async (w) => {
    const init = await w.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
    check('initialize handshake', init && init.protocolVersion === '2024-11-05' && init.capabilities?.tools, JSON.stringify(init).slice(0, 120))
    w.notify('notifications/initialized')
    const list = await w.request('tools/list', {})
    const names = (list.tools || []).map((t) => t.name).sort()
    check('tools/list has 8 code tools', names.length === 8, names.join(','))
    for (const expect of ['code_graph_list', 'code_search', 'code_callers', 'code_callees', 'code_impact', 'code_explore', 'code_node', 'code_files']) {
      check(`tool ${expect} present`, names.includes(expect))
    }
  }, { KNOWLEDGE_ENDPOINT: endpoint })

  // 2. code_graph_list (isolation: only our team's rows visible)
  await withWrapper(async (w) => {
    const res = unwrap(await w.request('tools/call', { name: 'code_graph_list', arguments: {} }))
    check('code_graph_list ok', !res.isError)
    if (REAL) {
      check('code_graph_list returns team indexes', /cg-[a-z0-9]{8}/.test(res.text) && res.text.includes('github.com'), res.text.slice(0, 160))
    } else {
      check('code_graph_list lists both mock indexes', res.text.includes('cg-mockaaa') && res.text.includes('cg-mockbbb'))
    }
    check('code_graph_list echoes team', res.text.includes(EXPECT_TEAM))
  }, { KNOWLEDGE_ENDPOINT: endpoint })

  // 3. code_search with repo short-name resolves to correct cg id (verify forwarded by mock echo)
  await withWrapper(async (w) => {
    const res = unwrap(
      await w.request('tools/call', { name: 'code_search', arguments: { query: 'runPull', repo: 'dsh-ecosystem', kind: 'function' } }),
    )
    check('code_search ok', !res.isError)
    check('code_search returns evidence', res.text.includes('dsh-launcher/src/ecosystem.ts:473'), res.text.slice(0, 200))
    check('code_search header shows repo', res.text.includes('dsh-ecosystem'))
  }, { KNOWLEDGE_ENDPOINT: endpoint })

  // 4. explicit error: unknown repo
  await withWrapper(async (w) => {
    const res = unwrap(await w.request('tools/call', { name: 'code_callers', arguments: { symbol: 'foo', repo: 'no-such-repo' } }))
    check('unknown repo -> explicit isError', res.isError === true)
    check('unknown repo message helpful', /未找到 repo/.test(res.text), res.text.slice(0, 160))
  }, { KNOWLEDGE_ENDPOINT: endpoint })

  // 5. repo omitted + multiple indexes -> explicit guidance (no silent default)
  await withWrapper(async (w) => {
    const res = unwrap(await w.request('tools/call', { name: 'code_search', arguments: { query: 'runPull' } }))
    check('missing repo w/ multiple indexes -> explicit error', res.isError === true)
    check('missing repo message suggests code_graph_list', res.text.includes('code_graph_list'), res.text.slice(0, 200))
  }, { KNOWLEDGE_ENDPOINT: endpoint })

  // 6. service down -> explicit error, never silent empty
  const dead = 'http://127.0.0.1:9'
  await withWrapper(async (w) => {
    const res = unwrap(await w.request('tools/call', { name: 'code_search', arguments: { query: 'x', repo: 'dsh-ecosystem' } }))
    check('service down -> explicit isError', res.isError === true)
    check('service down message mentions channel error', /code-graph 通道错误/.test(res.text), res.text.slice(0, 160))
  }, { KNOWLEDGE_ENDPOINT: dead })

  // 7. unknown tool -> explicit error
  await withWrapper(async (w) => {
    const res = unwrap(await w.request('tools/call', { name: 'nope', arguments: {} }))
    check('unknown tool -> explicit isError', res.isError === true, res.text.slice(0, 120))
  }, { KNOWLEDGE_ENDPOINT: endpoint })

  // Integration-only: prove live real queries for issue #27 evidence
  if (REAL) {
    await withWrapper(async (w) => {
      console.log('\n--- live evidence ---')
      const listRes = unwrap(await w.request('tools/call', { name: 'code_graph_list', arguments: {} }))
      console.log('code_graph_list:', listRes.isError ? 'ERR' : listRes.text.split('\n').slice(0, 5).join('\n'))
      for (const args of [
        { name: 'code_search', arguments: { query: 'runPull', repo: 'dsh-ecosystem' } },
        { name: 'code_callers', arguments: { symbol: 'resolveWebviewView', repo: 'dsh-ecosystem' } },
        { name: 'code_impact', arguments: { symbol: 'runPull', repo: 'dsh-ecosystem', depth: 1 } },
        { name: 'code_files', arguments: { repo: 'dsh-ecosystem', path: 'dsh-launcher/src', format: 'flat', includeMetadata: false } },
      ]) {
        const r = unwrap(await w.request('tools/call', { name: args.name, arguments: args.arguments }))
        console.log(`\n>>> ${args.name}(${JSON.stringify(args.arguments)})`)
        console.log(r.isError ? `  ERR: ${r.text.slice(0, 300)}` : r.text.split('\n').slice(0, 12).join('\n'))
      }
    }, { KNOWLEDGE_ENDPOINT: endpoint })
  }
} finally {
  if (server) server.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
