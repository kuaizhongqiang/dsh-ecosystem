#!/usr/bin/env node
/**
 * selftest.mjs — agent-memory-native 的自检（纯逻辑层 lib.js，不需要 dsh 运行时）
 *
 * 用法：
 *   node selftest.mjs               # mock 引擎，离线自检（默认）
 *   node selftest.mjs --live        # 真实引擎：只读调用（atomic/search、core/read、scenario/ls、code-graph/list、code-graph/search）
 *   node selftest.mjs --live --live-write   # 额外对真实引擎做一次写入（L0 入库），session_id 带 selftest 前缀
 *
 * 真实引擎的配置优先级：环境变量 > 本机 web profile 的 cordis.patch.yml（自动解析，不打印任何 key）。
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createCaptureEngine,
  resolveSecretValue,
  createCodeGraphClient,
  createMemoryClient,
  explainCodeGraphFailure,
  resolveTaskId,
  textOf,
} from './lib.js'

let passed = 0
let failed = 0
const ok = (cond, label) => {
  if (cond) {
    passed += 1
    console.log(`  ok   - ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL - ${label}`)
  }
}

const baseConfig = {
  memoryEndpoint: '',
  knowledgeEndpoint: '',
  apiKey: 'test-key',
  serviceId: 'default',
  teamId: 'team-test',
  agentId: 'agt-test',
  userId: 'usr-test',
  taskId: 'dsh-ecosystem',
  timeoutMs: 5000,
}

// ───────────────────────────── mock 引擎 ─────────────────────────────

function startMock() {
  const calls = []
  const state = { envelopeCode: 0, knowledgeFailure: null }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      calls.push({ path: req.url, headers: req.headers, body })
      // 可控失败：模拟远端网关（401 缺 Bearer / 404 无 code-graph 路由）
      if (state.knowledgeFailure && req.url.startsWith('/v3/code-graph/')) {
        res.writeHead(state.knowledgeFailure.status, { 'Content-Type': 'application/json' })
        res.end(state.knowledgeFailure.body)
        return
      }
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(state.envelopeCode === 0 ? { code: 0, data } : { code: state.envelopeCode, message: 'boom' }))
      }
      switch (req.url) {
        case '/v3/atomic/search':
          return send({ items: [{ id: 'm1', content: 'fact about stock plugin' }] })
        case '/v3/core/read':
          return send({ path: 'core/persona.md', content: 'persona text' })
        case '/v3/scenario/ls':
          return send({ entries: [{ path: 'scene_blocks/a.md', summary: 'A' }] })
        case '/v3/conversation/add':
          return send({ accepted_ids: ['c1'], total_count: 1 })
        case '/v3/code-graph/list':
          return send({ items: [
            { code_graph_id: 'cg-1', repo_url: 'https://github.com/kuaizhongqiang/dsh-ecosystem', sync_status: 'ready', summary: '136 files' },
            { code_graph_id: 'cg-2', repo_url: 'https://github.com/x/other', sync_status: 'ready' },
          ] })
        case '/v3/code-graph/callers':
          return send({ text: 'callers of runPull: 3 hits' })
        default:
          return send({ text: 'mock' })
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, calls, state, base: `http://127.0.0.1:${port}` })
    })
  })
}

// ─────────────────────────── 真实引擎配置 ───────────────────────────

function parseLiveConfig() {
  const cfg = { ...baseConfig, memoryEndpoint: '', knowledgeEndpoint: '' }
  for (const key of ['MEMORY_ENDPOINT', 'KNOWLEDGE_ENDPOINT', 'API_KEY', 'SERVICE_ID', 'TEAM_ID', 'AGENT_ID', 'USER_ID', 'USER_KEY', 'TASK_ID']) {
    if (process.env[key]) cfg[key] = process.env[key]
  }
  cfg.memoryEndpoint = cfg.memoryEndpoint || process.env.MEMORY_ENDPOINT || ''
  cfg.knowledgeEndpoint = cfg.knowledgeEndpoint || process.env.KNOWLEDGE_ENDPOINT || ''
  const patch = join(process.env.DSH_HOME || join(process.env.HOME || '', '.dsh'), 'profiles', 'web', 'cordis.patch.yml')
  if (!existsSync(patch)) return cfg
  const text = readFileSync(patch, 'utf8')
  const blockOf = (id) => text.split(/^- insert:/m).find((b) => b.includes(`id: ${id}`)) || ''
  const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2')
  // native 条目：config 段是 camelCase（memoryEndpoint/teamId/...），8 空格缩进
  const native = blockOf('tool-agent-memory')
  const nativeVal = (key) => {
    const m = native.match(new RegExp(`^\\s+${key}:\\s*(.*?)\\s*$`, 'm'))
    return m ? unquote(m[1]) : ''
  }
  // mcp 条目：env 段是 UPPER_SNAKE（旧模式，保留兼容）
  const readEnv = (id) => {
    const block = blockOf(id)
    const out = {}
    for (const line of block.split('\n')) {
      const m = line.match(/^\s{10}([A-Z_]+):\s*(.*?)\s*$/) || line.match(/^\s+([A-Z_]+):\s*'?([^'\n]*?)'?\s*$/)
      // YAML 单/双引号需要剥掉（否则 Authorization: Bearer 'xxx' 会被引擎判 401）
      if (m && m[2]) out[m[1]] = unquote(m[2])
    }
    return out
  }
  const memory = readEnv('mcp-agent-memory')
  const codegraph = readEnv('mcp-agent-memory-codegraph')
  cfg.memoryEndpoint = cfg.memoryEndpoint || nativeVal('memoryEndpoint') || memory.MEMORY_ENDPOINT || ''
  cfg.apiKey = process.env.API_KEY || nativeVal('apiKey') || memory.API_KEY || cfg.apiKey
  cfg.serviceId = process.env.SERVICE_ID || nativeVal('serviceId') || memory.SERVICE_ID || cfg.serviceId
  cfg.teamId = process.env.TEAM_ID || nativeVal('teamId') || memory.TEAM_ID || cfg.teamId
  cfg.agentId = process.env.AGENT_ID || nativeVal('agentId') || memory.AGENT_ID || cfg.agentId
  cfg.userId = process.env.USER_ID || nativeVal('userId') || memory.USER_ID || cfg.userId
  cfg.taskId = process.env.TASK_ID || nativeVal('taskId') || memory.TASK_ID || cfg.taskId
  cfg.knowledgeEndpoint = cfg.knowledgeEndpoint || nativeVal('knowledgeEndpoint') || codegraph.KNOWLEDGE_ENDPOINT || 'http://127.0.0.1:8421'
  return cfg
}

// ─────────────────────────────── 测试 ───────────────────────────────

async function mockTests() {
  const mock = await startMock()
  const config = { ...baseConfig, memoryEndpoint: mock.base, knowledgeEndpoint: mock.base }
  const memory = createMemoryClient(config)
  const codeGraph = createCodeGraphClient(config)
  const last = () => mock.calls[mock.calls.length - 1]

  console.log('1. 主记忆客户端（MemoryCore v3）')
  const facts = await memory.searchAtomic('stock', { limit: 3 }, '/home/kuai/dsh-project/normal-manager')
  ok(facts.items?.length === 1, '1-1 atomic/search 返回 items')
  ok(last().path === '/v3/atomic/search', '1-2 路径 /v3/atomic/search')
  ok(last().body.team_id === 'team-test' && last().body.agent_id === 'agt-test' && last().body.user_id === 'usr-test', '1-3 请求体带身份三元组')
  ok(last().body.task_id === 'dsh-ecosystem', '1-4 task_id 取显式配置')
  ok(last().body.limit === 3 && last().body.query === 'stock', '1-5 query/limit 透传')
  ok(last().headers.authorization === 'Bearer test-key' && last().headers['x-tdai-service-id'] === 'default', '1-6 鉴权头与 service-id')
  const core = await memory.readCore()
  ok(core.content === 'persona text', '1-7 core/read 返回 persona')
  const scenes = await memory.listScenarios()
  ok(scenes.entries?.length === 1, '1-8 scenario/ls 返回场景索引')
  const added = await memory.addConversation([{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }], 'sess-1')
  ok(added.total_count === 1 && last().body.session_id === 'sess-1' && last().body.messages.length === 2, '1-9 conversation/add 带 session_id 与两段消息')

  console.log('2. 代码图谱客户端（MemoryKnowledge v3）')
  const list = await codeGraph.list()
  ok(list.includes('cg-1') && list.includes('ready'), '2-1 list 列出可见索引')
  ok(last().headers.authorization === 'Bearer test-key', '2-1b code-graph 请求带 Bearer（与 memory 通道对齐，issue #29）')
  const callers = await codeGraph.query('code_callers', { symbol: 'runPull', repo: 'dsh-ecosystem', limit: 5 })
  ok(callers.includes('runPull') && callers.startsWith('[code-graph]'), '2-2 callers 命中并带表头')
  ok(last().body.code_graph_id === 'cg-1', '2-3 repo 短名解析为 code_graph_id')
  ok(last().body.symbol === 'runPull' && last().body.limit === 5, '2-4 参数透传')
  let err = null
  try { await codeGraph.query('code_callers', { symbol: 'x', repo: 'no-such-repo' }) } catch (e) { err = e }
  ok(err && /未找到 repo/.test(err.message), '2-5 未知 repo 显式报错')
  err = null
  try { await codeGraph.query('code_callers', { symbol: 'x', limit: 999 }) } catch (e) { err = e }
  ok(err && /repo 参数必填/.test(err.message), '2-6 多索引时必须给 repo')

  console.log('2b. code-graph 鉴权与失败诊断（issue #29）')
  // 专属 knowledge key 优先于共享 apiKey
  const ownKey = createCodeGraphClient({ ...config, apiKey: 'shared-key', knowledgeApiKey: 'own-key' })
  await ownKey.list()
  ok(last().headers.authorization === 'Bearer own-key', '2b-1 knowledgeApiKey 优先于共享 apiKey')
  // 无任何 key 时不发 Authorization（本机免鉴权的 MemoryKnowledge 仍可用）
  const noKey = createCodeGraphClient({ ...config, apiKey: '', knowledgeApiKey: '' })
  await noKey.list()
  ok(last().headers.authorization === undefined && last().headers['x-tdai-service-id'] === 'default', '2b-2 无 key 时不发 Authorization')
  ok(noKey.configured() === true, '2b-3 无 key 但端点/team 齐备时 configured() 仍为 true')

  const patch = { ...config }
  // 401：网关要求 Bearer
  mock.state.knowledgeFailure = { status: 401, body: '{"code":401,"message":"Unauthorized: missing Bearer token"}' }
  err = null
  try { await createCodeGraphClient(patch).list() } catch (e) { err = e }
  ok(err && /要求鉴权/.test(err.message) && /knowledgeApiKeyRef/.test(err.message), '2b-4 401 → 提示配置 knowledgeApiKeyRef')
  // 404 + code-graph：地址指向了没有 code-graph 路由的网关（典型=MemoryCore）
  mock.state.knowledgeFailure = { status: 404, body: '{"error":"Not found: POST /v3/code-graph/list"}' }
  err = null
  try { await createCodeGraphClient(patch).list() } catch (e) { err = e }
  ok(err && /未暴露 code-graph 路由/.test(err.message) && /MemoryKnowledge/.test(err.message), '2b-5 404 → 指出应指向 MemoryKnowledge 而非 MemoryCore 网关')
  // 连接不可达
  mock.state.knowledgeFailure = null
  const dead = createCodeGraphClient({ ...config, knowledgeEndpoint: 'http://127.0.0.1:1' })
  err = null
  try { await dead.list() } catch (e) { err = e }
  ok(err && /不可达/.test(err.message), '2b-6 连接失败 → 提示 Knowledge 地址不可达')
  // 纯函数分类（不经网络）
  const boom = (msg, extra = {}) => Object.assign(new Error(msg), extra)
  ok(/要求鉴权/.test(explainCodeGraphFailure(boom('/v3/code-graph/list HTTP 401: {"code":401}'), 'http://x')), '2b-7 分类器：401')
  ok(/未暴露 code-graph 路由/.test(explainCodeGraphFailure(boom('/v3/code-graph/list HTTP 404: {"error":"Not found: POST /v3/code-graph/list"}'), 'http://x')), '2b-8 分类器：404 路由缺失')
  ok(/不可达/.test(explainCodeGraphFailure(Object.assign(boom('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'http://x')), '2b-9 分类器：ECONNREFUSED')
  ok(/不可达/.test(explainCodeGraphFailure(Object.assign(boom('This operation was aborted'), { name: 'AbortError' }), 'http://x')), '2b-10 分类器：超时')
  ok(explainCodeGraphFailure(boom('/v3/code-graph/search code=500 message=boom'), 'http://x') === '/v3/code-graph/search code=500 message=boom', '2b-11 分类器：envelope 错误原样透传')

  console.log('3. envelope 错误（code !== 0）')
  mock.state.envelopeCode = 500
  err = null
  try { await memory.searchAtomic('x') } catch (e) { err = e }
  ok(err && /code=500/.test(err.message), '3-1 code!==0 抛错')
  mock.state.envelopeCode = 0

  console.log('4. 进程内自动入库（turn/end → L0）')
  const dir = mkdtempSync(join(tmpdir(), 'am-native-'))
  const statePath = join(dir, 'state.json')
  const debugLogs = []
  const capture = createCaptureEngine(
    { ...config, statePath, sessionKey: '' },
    { memoryClient: memory, debug: (m) => debugLogs.push(m) },
  )
  const session = { id: 'session-selftest', header: { cwd: '/home/kuai/dsh-project/dsh-ecosystem' } }
  // 事件形状按 harness 真实负载：真人是 source.kind==='user' && role==='user'；助手是 message.role==='assistant'
  const human = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text }] } })
  const injected = (text) => ({ type: 'user/message', data: { source: { kind: 'agent' }, role: 'user', content: [{ type: 'text', text }] } })
  const assistant = (text, extra = []) => ({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }, ...extra] } } })

  await capture.handleEvent(session, human('第一问'))
  await capture.handleEvent(session, injected('注入的 AGENTS.md 上下文（不应入库）'))
  await capture.handleEvent(session, assistant('第一答', [{ type: 'image', url: 'x' }]))
  await capture.handleEvent(session, { type: 'turn/end', data: { turn: 7 } })
  ok(last().path === '/v3/conversation/add', '4-1 turn/end 触发 conversation/add')
  ok(last().body.session_id === 'session-selftest', '4-2 session_id = DSH 会话 id')
  ok(last().body.messages[0].content === '第一问' && last().body.messages[1].content === '第一答', '4-3 只取真人输入与 text 块，忽略注入内容/非文本块')
  ok(capture.cursor('session-selftest') === 7, '4-4 游标写入 state')
  const before = mock.calls.length
  await capture.handleEvent(session, human('dup'))
  await capture.handleEvent(session, { type: 'turn/end', data: { turn: 7 } })
  ok(mock.calls.length === before, '4-5 同一 turn 不重复提交（游标去重）')
  await capture.handleEvent(session, { type: 'turn/end', data: { turn: 8 } })
  ok(mock.calls.length === before, '4-6 空轮次不提交')
  await capture.handleEvent(session, injected('又一段注入'))
  await capture.handleEvent(session, assistant('只有助手侧'))
  await capture.handleEvent(session, { type: 'turn/end', data: { turn: 9 } })
  ok(last().path === '/v3/conversation/add' && last().body.messages[0].content === 'dup', '4-7 无新真人输入时沿用上一轮 user 文本（注入不污染）')
  const afterFallback = mock.calls.length
  await capture.handleEvent(session, { type: 'turn/start', data: { turn: 10 } })
  await capture.handleEvent(session, assistant('第二答'))
  await capture.handleEvent(session, { type: 'turn/end', data: { turn: 10 } })
  ok(mock.calls.length === afterFallback + 1 && last().body.messages[1].content === '第二答'
    && last().body.messages[0].content === 'dup', '4-8 无新真人输入时沿用上一轮 user 文本（守护同口径）')
  await capture.handleEvent(session, { type: 'turn/start', data: { turn: 11 } })
  await capture.handleEvent(session, human('长'.repeat(9000)))
  await capture.handleEvent(session, assistant('答'.repeat(9000)))
  await capture.handleEvent(session, { type: 'turn/end', data: { turn: 11 } })
  const longBody = last().body
  ok(longBody.messages[0].content.length <= 8100 && longBody.messages[1].content.length <= 8100
    && longBody.messages[0].content.includes('已截断'), '4-9 超 8192 上限自动截断（避免引擎 400）')
  ok(capture.cursor('session-selftest') === 11, '4-10 正常轮次推进游标到最新')
  rmSync(dir, { recursive: true, force: true })

  console.log('5. task_id 语义')
  ok(resolveTaskId({ taskId: '' }, '/a/b/normal-manager') === 'normal-manager', '5-1 未配置时取 cwd 目录名')
  let tid = null
  try { resolveTaskId({ taskId: 'agt-abc' }, '/x') } catch (e) { tid = e }
  ok(tid && /身份 id/.test(tid.message), '5-2 拒绝身份前缀当 task_id')
  ok(textOf([{ type: 'text', text: 'a' }, { type: 'tool_use' }]) === 'a', '5-3 textOf 只取文本块')

  mock.server.close()
}

async function secretTests() {
  console.log('6. 引用式凭证解析（resolveSecretValue：seam > env > 内联）')
  const seam = (value, source = 'file') => ({ resolve: async () => ({ value, source }) })
  let r = await resolveSecretValue({ ref: 'X_KEY', service: seam('from-seam'), env: { X_KEY: 'from-env' } })
  ok(r.value === 'from-seam' && r.source === 'file', '6-1 凭证 seam 优先于环境变量')
  r = await resolveSecretValue({ ref: 'X_KEY', inline: 'inline-val', service: seam('from-seam') })
  ok(r.value === 'from-seam' && r.source === 'file', '6-2 凭证 seam 优先于内联值（轮换 key 无需改 patch）')
  r = await resolveSecretValue({ ref: 'UNSET_KEY', inline: 'inline-fallback', env: {} })
  ok(r.value === 'inline-fallback' && r.source === 'inline', '6-2b ref 未配置时回落内联值（切换期不中断）')
  r = await resolveSecretValue({ ref: 'X_KEY', env: { X_KEY: 'from-env' } })
  ok(r.value === 'from-env' && r.source === 'env', '6-3 seam 缺失时回落同名环境变量')
  const warns = []
  r = await resolveSecretValue({
    ref: 'X_KEY',
    service: { resolve: async () => { throw new Error('boom') } },
    env: { X_KEY: 'env-after-error' },
    warn: (m) => warns.push(m),
  })
  ok(r.value === 'env-after-error' && warns.length === 1, '6-4 seam 报错时回落 env 并告警（不抛）')
  r = await resolveSecretValue({ ref: 'MISSING_KEY', env: {} })
  ok(r.value === undefined && r.source === 'none', '6-5 全缺时返回 none（不抛错，由调用方决定报错时机）')
}

async function liveTests(write) {
  const config = parseLiveConfig()
  console.log(`7. 真实引擎（${write ? '含写入' : '只读'}）`)
  ok(Boolean(config.memoryEndpoint), `7-1 memoryEndpoint 已配置（${config.memoryEndpoint || '缺失'}）`)
  ok(Boolean(config.teamId && config.agentId && config.userId), '7-2 身份三元组已配置')
  const memory = createMemoryClient(config)
  const codeGraph = createCodeGraphClient(config)

  const facts = await memory.searchAtomic('stock plugin', { limit: 3 })
  ok(Array.isArray(facts?.items), `7-3 atomic/search 可用（命中 ${facts?.items?.length ?? 0} 条）`)
  const core = await memory.readCore()
  ok(core !== null && typeof core === 'object', `7-4 core/read 可用（persona ${core?.content ? '有' : '空'}）`)

  // code-graph 通道单独兜底：远端形态下 memory 通道可用而 Knowledge 不可达是已知形态（issue #29），
  // 此处把失败**显式报 FAIL + 诊断文案**，不抛栈中断整个 live 自检。
  let list = ''
  try {
    list = await codeGraph.list()
    ok(list.includes('code-graph 索引'), `7-5 code-graph/list 可用（knowledgeEndpoint=${config.knowledgeEndpoint}）`)
  } catch (err) {
    ok(false, `7-5 code-graph/list 失败（knowledgeEndpoint=${config.knowledgeEndpoint}）：${err.message}`)
  }
  // list() 末尾附了 JSON（items + _context），据此取一个真实 repo 做查询
  let repo = process.env.TEST_REPO || ''
  try {
    const rows = JSON.parse(list.slice(list.indexOf('{'), list.lastIndexOf('}') + 1)).items ?? []
    repo = repo || rows[0]?.repo_url || ''
  } catch { /* 解析失败则回退到默认短名 */ }
  ok(Boolean(repo), `7-6 取得可用 repo（${repo || '缺失'}）`)
  if (repo) {
    try {
      const search = await codeGraph.query('code_search', { query: 'install', repo, limit: 3 })
      ok(typeof search === 'string' && search.startsWith('[code-graph]'), '7-7 code-graph/search 可用')
    } catch (err) {
      ok(false, `7-7 code-graph/search 失败：${err.message}`)
    }
  } else {
    ok(false, '7-7 code-graph/search 跳过（无 repo）')
  }

  if (write) {
    const dir = mkdtempSync(join(tmpdir(), 'am-native-live-'))
    const statePath = join(dir, 'state.json')
    const capture = createCaptureEngine({ ...config, statePath }, { memoryClient: memory })
    const session = { id: `session-selftest-native-${Date.now()}`, header: { cwd: process.cwd() } }
    // 事件形状按 harness 真实负载：真人是 source.kind==='user' && role==='user'（缺失会被 capture 过滤掉）
    await capture.handleEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: '[selftest] agent-memory-native 写入自检' }] } })
    await capture.handleEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '[selftest] 入库链路 OK' }] } } })
    await capture.handleEvent(session, { type: 'turn/end', data: { turn: 1 } })
    ok(capture.cursor(session.id) === 1, `7-8 真实引擎 L0 写入成功（session=${session.id}）`)
    rmSync(dir, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
const live = args.includes('--live')
const liveWrite = args.includes('--live-write')

console.log(`agent-memory-native selftest（${live ? 'live' : 'mock'} 模式）`)
if (live) await liveTests(liveWrite)
else { await mockTests(); await secretTests() }

console.log(`\n结果：${passed} ok / ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
