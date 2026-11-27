#!/usr/bin/env node
/**
 * selftest.mjs — agent-memory-admin 纯逻辑层自检（mock 引擎，不需要 dsh）。
 * 用法：node selftest.mjs [--live]
 */
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  countLocalL1Rows,
  createAdminClient,
  diagnoseEmptyTeamCount,
  parseMetadata,
  readBindings,
  readCaptureState,
  resolveSecretValue,
  topBy,
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
  apiKey: 'test-key',
  userKey: 'test-user-key',
  adminKey: 'test-admin-key',
  serviceId: 'default',
  teamId: 'team-test',
  userId: 'usr-test',
  agentId: 'agt-test',
  timeoutMs: 5000,
}

function startMock() {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      calls.push({ method: req.method, path: req.url, headers: req.headers, body })
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data }))
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }))
      }
      switch (req.url) {
        case '/v3/atomic/count':
          return send({ total: body?.type === 'work_fact' ? 10 : 3 })
        case '/v3/atomic/query':
          return send({ items: [{ id: 'm1', content: 'c', type: 'work_fact', task_id: 'task-1', agent_id: 'agt-a' }], total: 1 })
        case '/v3/atomic/search':
          return send({ items: [{ id: 'm1', content: 'c', type: 'work_fact', score: 0.5 }] })
        case '/v3/atomic/update':
          return send({ id: body.id, version: 'v2' })
        case '/v3/atomic/delete':
          return send({ deleted_count: body.ids.length })
        case '/v3/meta/task/create':
          return send({ task_id: body.task_id ?? 'task-mock', title: body.title, status: body.status ?? 'running' })
        case '/v3/meta/task/list':
          return send({ items: [{ task_id: 'task-mock', title: 'T', status: 'running' }], total: 1 })
        case '/v3/meta/task/get':
          return send({ task_id: body.task_id, team_id: 'team-test', title: 'T', status: 'running' })
        default:
          return send({})
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

async function main() {
  const mock = await startMock()
  const config = { ...baseConfig, memoryEndpoint: mock.base }
  const client = createAdminClient(config)
  const last = () => mock.calls[mock.calls.length - 1]

  console.log('1. 管理面隔离：默认只带 team_id')
  await client.atomicCount({})
  ok(last().body.team_id === 'team-test' && last().body.scope === 'team', '1-1 atomic/count 带 team_id + scope=team')
  ok(!('agent_id' in last().body) && !('task_id' in last().body), '1-2 默认不带 agent/task（跨任务盘点）')
  await client.atomicQuery({ task_id: 'task-1', agent_id: 'agt-a', limit: 10 })
  ok(last().body.task_id === 'task-1' && last().body.agent_id === 'agt-a' && last().body.limit === 10, '1-3 显式过滤 + limit 透传')
  ok(last().headers['x-tdai-admin-key'] === 'test-admin-key', '1-4 管理请求带 x-tdai-admin-key')

  console.log('2. 编辑/删除')
  await client.atomicUpdate({ id: 'm1', content: 'new', priority: 90 })
  ok(last().body.id === 'm1' && last().body.content === 'new' && last().body.priority === 90 && last().body.team_id === 'team-test', '2-1 update 带 id/content/priority/team')
  await client.atomicDelete(['m1', 'm2'])
  ok(last().body.ids.length === 2 && last().body.team_id === 'team-test', '2-2 delete 带 ids')

  console.log('3. 任务实体')
  const created = await client.taskCreate({ task_id: 'MechanicalDesignManufacturingAutomationVirtualMuseum', title: '博物馆' })
  ok(created.task_id === 'MechanicalDesignManufacturingAutomationVirtualMuseum', '3-1 自定义 task_id 透传')
  ok(last().headers['x-tdai-user-key'] === 'test-user-key', '3-2 meta 请求带 x-tdai-user-key')
  ok(last().body.creator_user_id === 'usr-test' && last().body.linked_agents[0].agent_id === 'agt-test', '3-3 creator/关联 agent 正确')
  const list = await client.taskList({ limit: 5 })
  ok(list.items.length === 1, '3-4 task/list 可用')

  console.log('4. 聚合与解析')
  ok(JSON.stringify(topBy([{ task_id: 'a' }, { task_id: 'a' }, { task_id: 'b' }], 'task_id', 2)) === JSON.stringify([{ value: 'a', count: 2 }, { value: 'b', count: 1 }]), '4-1 topBy 聚合')
  ok(parseMetadata('{"status":"todo"}').status === 'todo' && JSON.stringify(parseMetadata('bad')) === '{}', '4-2 parseMetadata 容错')
  const secret = await resolveSecretValue({ ref: 'X_KEY', inline: 'inline', env: { X_KEY: 'env' } })
  ok(secret.value === 'env' && secret.source === 'env', '4-3 凭证优先级 env > inline')

  console.log('5. 本机文件（绑定/游标）')
  const dir = mkdtempSync(join(tmpdir(), 'mem-admin-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  mkdirSync(join(dir, '.tencent-agent-memory'), { recursive: true })
  writeFileSync(join(dir, '.dsh-memory-task-bindings.json'), JSON.stringify({ sessions: { s1: { task_id: 'task-1', title: 'T' } } }))
  writeFileSync(join(dir, '.dsh-memory-autostore-state.json'), JSON.stringify({ s1: 3, s2: 5 }))
  const bindings = readBindings()
  const capture = readCaptureState()
  ok(bindings.length === 1 && bindings[0].task_id === 'task-1', '5-1 读 DSH 绑定文件')
  ok(capture.sessions === 2 && capture.entries.some((e) => e.session === 's1' && e.turn === 3), '5-2 读 capture 游标')
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  rmSync(dir, { recursive: true, force: true })

  console.log('6. 端点不透传 x-tdai-admin-key 的诊断（静默 0）')
  const diag = diagnoseEmptyTeamCount({ total: 0, localRows: 398, endpoint: 'http://127.0.0.1:3000' })
  ok(typeof diag === 'string' && diag.includes('x-tdai-admin-key') && diag.includes('398'), '6-1 团队级 0 + 本机有行 → 报透传诊断')
  ok(diagnoseEmptyTeamCount({ total: 5, localRows: 398 }) === undefined, '6-2 有数不报警')
  ok(diagnoseEmptyTeamCount({ total: 0, localRows: 398, filters: { task_id: 'task-1' } }) === undefined, '6-3 带收窄条件的 0 不误报')
  ok(diagnoseEmptyTeamCount({ total: 0, localRows: 0 }) === undefined, '6-4 空引擎不误报')
  ok(countLocalL1Rows('/nonexistent-memory-dir') === null, '6-5 读不到本地库时返回 null（不阻塞）')

  mock.server.close()
  console.log(`\n结果：${passed} ok / ${failed} FAIL`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
