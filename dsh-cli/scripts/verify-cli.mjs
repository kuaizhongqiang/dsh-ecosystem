// scripts/verify-cli.mjs —— dsh-cli 质量门（**不触网、不依赖 dsh**）。
//
// 覆盖（对应 docs/dsh-cli-design.md 的分段契约 / 归属模型 / out 契约）：
//   1. 多帧 zstd 读取（真实日志就是这个格式：每批 append 一帧，Node 原生只解第一帧）
//   2. 会话发现与读取（按 DSH_HOME 下的 sessions/<项目键>/<session-id>/ 布局）
//   3. 分段契约：一步一条 / 不裁 / 事件不丢（between 与流式分片）
//   4. 归属与写权限：外来会话运行中硬失败
//   5. out 契约：无损 JSON（无 undefined）
//   6. 执行链：用**桩 dsh**（自己写会话日志）跑通 task.run → out → report
//   7. 对外调用面：本机 HTTP + token 鉴权 + 工具路由
//
// 用法：node scripts/verify-cli.mjs

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'src')

let failures = 0
let passed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`) }
  else { failures++; console.error(`  FAIL - ${name}`) }
}

// —— 多帧 zstd 工具（质量门自己用）——
function framesOf(lines) {
  return Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))))
}

const base = mkdtempSync(join(tmpdir(), 'dshcli-verify-'))
const home = join(base, 'dsh-home')
const stateDir = join(base, 'state')
const workdir = join(base, 'work')
for (const dir of [home, stateDir, workdir]) mkdirSync(dir, { recursive: true })
process.env.DSH_HOME = home
process.env.DSHCLI_STATE_DIR = stateDir

// 项目键由被测代码自己算，保证与桩写日志时用的键一致
const { projectKeyFor } = await import(pathToFileURL(join(src, 'paths.js')).href)
const projectKey = projectKeyFor(workdir)

/** 造一个会话目录（头 + 多帧事件日志）。 */
function writeSession({ sessionId, events, createdAt = Date.now(), cwd = workdir }) {
  const dir = join(home, 'sessions', projectKey, sessionId)
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 2, id: sessionId, createdAt, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  writeFileSync(join(dir, 'session.v2.jsonl.zstd'), framesOf([JSON.stringify(header)]))
  writeFileSync(join(dir, 'session.jsonl.zstd'), framesOf(events.map((event) => JSON.stringify(event))))
  return dir
}

const LONG_TEXT = `长文本-${'x'.repeat(9000)}-结尾`
// 时间戳必须是「像真的 epoch 毫秒」——归属判定会按 10 分钟静默阈值区分运行中/被放弃
const T0 = Date.now() - 60_000
const stepEvents = [
  { type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } },
  { type: 'step/start', seq: 2, time: T0 + 1, data: { turn: 1, step: 1 } },
  { type: 'reasoning-chunks', seq: 3, time: T0 + 2, data: { text: '想想' } },
  { type: 'assistant/message', seq: 4, time: T0 + 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: LONG_TEXT }] }, stream: [{ kind: 'text', text: LONG_TEXT }], usage: { inputTokens: 10, outputTokens: 20 } } },
  { type: 'tool/call', seq: 5, time: T0 + 4, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"echo hi"}' } },
  { type: 'tool/result', seq: 6, time: T0 + 5, data: { turn: 1, step: 1, callId: 'c1', content: [{ type: 'text', text: 'hi' }] } },
  { type: 'step/end', seq: 7, time: T0 + 6, data: { turn: 1, step: 1 } },
]
const turnEnd = { type: 'turn/end', seq: 8, time: T0 + 7, data: { turn: 1, reason: 'completed' } }

console.log('1. 多帧 zstd 读取')
const zstd = await import(pathToFileURL(join(src, 'zstd-frames.js')).href)
{
  const buffer = framesOf(['a', 'b', 'c'])
  ok(zstd.walkFrames(buffer).length === 3, '1-1 三帧被识别为三帧')
  ok(zstd.decompressFrames(buffer).toString('utf8') === 'a\nb\nc\n', '1-2 逐帧解码拼回全量（不丢后续帧）')
  const tail = zstd.decompressFramesFrom(buffer, 2)
  ok(tail.text === 'c\n' && tail.nextFrame === 3, '1-3 从第 N 帧增量读取（游标锚点）')
}

console.log('2. 会话发现与读取')
const sessionLog = await import(pathToFileURL(join(src, 'session-log.js')).href)
let sessionDir
{
  sessionDir = writeSession({ sessionId: 'session-stub-old', events: [...stepEvents, turnEnd], createdAt: 5000 })
  const rows = sessionLog.listSessions({ cwd: workdir })
  ok(rows.length === 1 && rows[0].sessionId === 'session-stub-old', '2-1 按 cwd 发现会话')
  ok(rows[0].cwd === workdir && rows[0].agentPreset === 'standard', '2-2 会话头字段可读')
  const { events } = sessionLog.readEvents(sessionDir)
  ok(events.length === 8, `2-3 事件条数=8（实际 ${events.length}）`)
  const tail = sessionLog.readTailEvents(sessionDir, 3)
  ok(tail.length === 3 && tail[2].type === 'turn/end', '2-4 尾部事件读取（帧作检查点）')
}

console.log('3. 分段契约（一步一条 / 不裁 / 不丢）')
const stepRecords = await import(pathToFileURL(join(src, 'step-records.js')).href)
{
  const { events } = sessionLog.readEvents(sessionDir)
  const { records, stats } = stepRecords.buildRecords(events)
  const steps = records.filter((record) => record.kind === 'step')
  ok(steps.length === 1 && steps[0].turn === 1 && steps[0].step === 1, '3-1 一步一条（含 turn/step 编号）')
  ok(JSON.stringify(steps[0].seqRange) === '[2,7]', `3-2 seqRange 覆盖整步（${JSON.stringify(steps[0].seqRange)}）`)
  const kinds = steps[0].cells.map((cell) => cell.kind)
  ok(kinds.join(',') === 'message,tool_call,tool_result', `3-3 单元顺序（${kinds.join(',')}）`)
  ok(JSON.stringify(steps[0].cells[0].data).includes(LONG_TEXT), '3-4 不裁：9000 字长文本原样保留')
  ok(Array.isArray(steps[0].streamChunks) && steps[0].streamChunks[0] === 1, '3-5 流式分片折进 message.stream 后只记计数')
  ok(records.some((record) => record.kind === 'between' && record.events.some((event) => event.type === 'turn/end')), '3-6 不属于步的事件走 between，不静默吞掉')
  ok(stats.steps === 1 && stats.toolCalls === 1 && stats.usage['inputTokens'] === 10, '3-7 聚合：步数/工具数/用量')

  // 没有任何装配消息的步：流式分片必须原样发出（不丢）
  const orphan = stepRecords.buildRecords([
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    { type: 'text-chunks', seq: 2, time: 2, data: { text: '半截输出' } },
    { type: 'step/end', seq: 3, time: 3, data: { turn: 1, step: 1 } },
  ])
  ok(orphan.records[0].cells.some((cell) => cell.kind === 'stream'), '3-8 无装配消息时流式分片原样发出（事件不丢）')
}

console.log('4. 归属与写权限（§5）')
const ownership = await import(pathToFileURL(join(src, 'ownership.js')).href)
{
  writeSession({ sessionId: 'session-foreign-running', events: [stepEvents[0], stepEvents[1]], createdAt: 9000 })
  writeSession({ sessionId: 'session-foreign-idle', events: [...stepEvents, turnEnd], createdAt: 8000 })
  ok(ownership.ownershipOf('session-foreign-running') === 'foreign', '4-1 未登记即外来会话')
  const running = ownership.runState({ tailEvents: sessionLog.readTailEvents(join(home, 'sessions', projectKey, 'session-foreign-running'), 20) })
  ok(running.running === true, `4-2 未闭合轮次判定为运行中（${running.why}）`)
  let threw
  try { ownership.assertWritable('session-foreign-running', true) } catch (error) { threw = error }
  ok(threw?.code === 'readonly', '4-3 外来 + 运行中 → 硬失败 readonly')
  const idle = ownership.runState({ tailEvents: sessionLog.readTailEvents(join(home, 'sessions', projectKey, 'session-foreign-idle'), 20) })
  ok(ownership.writeVerdict('session-foreign-idle', idle.running).writable === true, '4-4 外来 + 空闲 → 允许写（主人拍板）')
  ownership.claim('session-foreign-idle', { cwd: workdir, adopted: true })
  ok(ownership.writeVerdict('session-foreign-idle', true).writable === true, '4-5 认领后即使在跑也可写')
  ownership.forget('session-foreign-idle')
  ok(ownership.ownershipOf('session-foreign-idle') === 'foreign', '4-6 forget 退回外来')

  // 被放弃的轮次不该永久锁死写入：静默超过阈值即视为不在跑
  const STALE = Date.now() - 30 * 60 * 1000
  writeSession({
    sessionId: 'session-foreign-stale',
    events: [{ type: 'turn/start', seq: 1, time: STALE, data: { turn: 1 } }, { type: 'step/start', seq: 2, time: STALE + 1, data: { turn: 1, step: 1 } }],
    createdAt: STALE,
  })
  const stale = ownership.runState({ tailEvents: sessionLog.readTailEvents(join(home, 'sessions', projectKey, 'session-foreign-stale'), 20) })
  ok(stale.running === false && /静默/.test(stale.why), `4-7 静默超阈值的未闭合轮次不锁写入（${stale.why}）`)
}

console.log('5. out 契约（无损 JSON）')
const outMod = await import(pathToFileURL(join(src, 'out.js')).href)
{
  const dirty = { a: 1, b: undefined, c: [1, undefined, NaN], d: { e: undefined, f: new Date('2026-01-01T00:00:00Z') } }
  const clean = outMod.jsonSafe(dirty)
  ok(!('b' in clean) && clean.c[1] === null && clean.c[2] === null, '5-1 undefined 属性剔除、数组空洞与 NaN 归 null')
  ok(clean.d.f === '2026-01-01T00:00:00.000Z', '5-2 Date 转 ISO')
  const out = outMod.makeOut({ status: 'ok', text: 'hi', sessionId: undefined })
  ok(!('sessionId' in out) && out.artifacts.length === 0 && out.degraded.length === 0, '5-3 makeOut 无 undefined 且给默认空数组')
  let bad
  try { outMod.makeOut({ status: 'nope' }) } catch (error) { bad = error }
  ok(bad !== undefined, '5-4 非法 out.status 直接抛')
}

console.log('6. 执行链：桩 dsh 端到端（不触网）')
const stubPath = join(base, 'stub-dsh.mjs')
writeFileSync(stubPath, `import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { projectKeyFor } from ${JSON.stringify(pathToFileURL(join(src, 'paths.js')).href)}

const argv = process.argv.slice(2)
appendFileSync(process.env.DSHCLI_STUB_ARGV, JSON.stringify(argv) + '\\n')
const home = process.env.DSH_HOME
const cwd = process.cwd()
const prompt = argv[argv.length - 1]
const sessionId = 'session-' + (prompt.includes('FAIL') ? 'fail' : 'ok') + '-' + Date.now()
const dir = join(home, 'sessions', projectKeyFor(cwd), sessionId)
mkdirSync(dir, { recursive: true })
const header = { type: 'session', version: 2, id: sessionId, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
writeFileSync(join(dir, 'session.v2.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify(header) + '\\n')))
const events = [
  { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
  { type: 'step/start', seq: 2, time: Date.now(), data: { turn: 1, step: 1 } },
  { type: 'assistant/message', seq: 3, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '桩答案：' + prompt }] }, usage: { totalTokens: 7 } } },
  { type: 'step/end', seq: 4, time: Date.now(), data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 5, time: Date.now(), data: { turn: 1, reason: 'completed' } },
]
writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.concat(events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\\n')))))
process.stdout.write('桩答案：' + prompt + '\\n')
process.exitCode = prompt.includes('FAIL') ? 1 : 0
`, 'utf8')

process.env.DSHCLI_DSH_BIN = stubPath
process.env.DSHCLI_STUB_ARGV = join(base, 'stub-argv.jsonl')
const dsh = await import(pathToFileURL(join(src, 'dsh.js')).href)
const toolsMod = await import(pathToFileURL(join(src, 'tools.js')).href)
{
  const bin = dsh.findDshBin()
  ok(bin !== undefined && bin.source.startsWith('env:DSHCLI_DSH_BIN'), '6-1 dsh 可执行发现（环境变量优先）')
  const run = await dsh.runHeadless({ prompt: '探针', cwd: workdir, timeoutMs: 20000, extraArgs: ['--patch', join(base, 'fake-patch.yml')] })
  const argv = JSON.parse(readFileSync(process.env.DSHCLI_STUB_ARGV, 'utf8').trim().split(/\r?\n/).pop())
  ok(run.code === 0 && run.stdout.includes('探针'), '6-2 runHeadless 拿到退出码与 stdout')
  ok(argv.includes('--profile') && argv.includes('headless'), '6-3 走的是 headless profile')
  ok(argv.includes('--patch') && argv.includes(join(base, 'fake-patch.yml')), '6-4 provider/model 覆盖走 --patch 层')

  const out = await toolsMod.callTool('task.run', { prompt: '写下测试要点', cwd: workdir, provider: 'p', model: 'm' })
  ok(out.status === 'ok' && out.text.includes('写下测试要点'), `6-5 task.run → out（status=${out.status}）`)
  ok(typeof out.sessionId === 'string' && out.sessionId.startsWith('session-ok-'), '6-6 自动绑定刚产生的会话')
  ok(out.usage?.totalTokens === 7, '6-7 out 带用量')
  const bad = await toolsMod.callTool('task.run', { prompt: 'FAIL 一下', cwd: workdir })
  ok(bad.status === 'failed' && bad.error?.code === 'exit_nonzero', '6-8 失败任务给 failed + 可判错误码')

  const history = await toolsMod.callTool('session.history', { sessionId: out.sessionId, cwd: workdir })
  ok(history.records.length >= 2 && history.records.some((record) => record.kind === 'step'), '6-9 分段记录可回读')
  const polled = await toolsMod.callTool('event.poll', { sessionId: out.sessionId, cwd: workdir, cursor: 2 })
  ok(polled.cursor >= 5 && polled.records.length >= 1, '6-10 event.poll 游标增量')
  const artifacts = await toolsMod.callTool('artifact.list', { sessionId: out.sessionId, cwd: workdir })
  ok(Array.isArray(artifacts.artifacts), '6-11 artifact.list 可用')

  const facts = await toolsMod.callTool('report.facts', {})
  ok(facts.finished.length >= 1 && facts.failed.length >= 1, '6-12 report.facts 聚合完成与失败')
  const digest = await toolsMod.callTool('report.digest', {})
  ok(typeof digest.text === 'string' && digest.text.includes('dsh 工作汇报'), '6-13 report.digest 给人读文本')
  const adopted = await toolsMod.callTool('session.adopt', { sessionId: 'session-foreign-idle', cwd: workdir })
  ok(adopted.owner === 'cli', '6-14 session.adopt 认领外来会话')

  let readonly
  try { await toolsMod.callTool('session.resume', { sessionId: 'session-foreign-running', cwd: workdir, prompt: '插一脚' }) }
  catch (error) { readonly = error }
  ok(readonly?.code === 'readonly', '6-15 外来运行中会话下任务被硬拒（readonly）')

  let notImplemented
  try { await toolsMod.callTool('cred.list', {}) } catch (error) { notImplemented = error }
  ok(notImplemented?.code === 'not_implemented', '6-16 未实现的工具明确报 not_implemented')
}

console.log('7. 对外调用面（本机 HTTP + token）')
const serve = await import(pathToFileURL(join(src, 'serve.js')).href)
{
  const server = await serve.startServer({ version: '0.1.0' })
  try {
    const health = await fetch(`${server.url}/health`).then((response) => response.json())
    ok(health.ok === true && health.service === 'dsh-cli', '7-1 /health 免鉴权可用')
    const denied = await fetch(`${server.url}/tools`)
    ok(denied.status === 401, '7-2 无 token 访问工具面 → 401')
    const listed = await fetch(`${server.url}/tools`, { headers: { authorization: `Bearer ${server.token}` } }).then((response) => response.json())
    ok(listed.ok === true && listed.result.tools.length > 20, '7-3 带 token 列工具清单')
    const called = await fetch(`${server.url}/call/session.list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: workdir }),
    }).then((response) => response.json())
    ok(called.ok === true && Array.isArray(called.result.sessions), '7-4 POST /call/<工具> 正常返回')
    const readonly = await fetch(`${server.url}/call/session.resume`, {
      method: 'POST',
      headers: { 'x-dshcli-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-foreign-running', cwd: workdir, prompt: 'x' }),
    })
    ok(readonly.status === 403, `7-5 写保护经 HTTP 暴露为 403（实际 ${readonly.status}）`)
    const unknown = await fetch(`${server.url}/call/nope`, { method: 'POST', headers: { authorization: `Bearer ${server.token}` } })
    ok(unknown.status === 404, '7-6 未知工具 → 404')
  } finally {
    await server.close()
  }
}

console.log('8. 命令行（cmd 面骨架）')
const cli = await import(pathToFileURL(join(src, 'cli.js')).href)
{
  const code = await cli.main(['version', '--json'])
  ok(code === 0, '8-1 dshcli version 退出码 0')
  const message = await cli.main(['definitely-not-a-command'])
  ok(message === 1, '8-2 未知命令退出码 1')
  const binary = spawnSync(process.execPath, [join(root, 'bin', 'dshcli.js'), 'tools'], { encoding: 'utf8' })
  ok(binary.status === 0 && binary.stdout.includes('session.list'), '8-3 bin/dshcli.js 可直接执行')
}

console.log('9. 契约快照 + T3/T4 工具（形状取自真实日志的夹具）')
{
  const fixture = readFileSync(join(root, 'tests', 'fixtures', 'session-sample.jsonl'), 'utf8')
  const events = fixture.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  const { records, stats } = stepRecords.buildRecords(events)
  const steps = records.filter((record) => record.kind === 'step')
  ok(steps.length === 2, `9-1 夹具：2 步 → ${steps.length} 条步记录`)
  ok(JSON.stringify(steps[0].seqRange) === '[4,9]' && JSON.stringify(steps[1].seqRange) === '[10,16]', '9-2 夹具：seqRange 与事件序号一致')
  ok(steps[1].cells.filter((cell) => cell.kind === 'tool_call').length === 2, '9-3 夹具：一步内多个工具调用都保留')
  const cellWithMeta = steps[1].cells.find((cell) => cell.kind === 'tool_result' && cell.data?.meta !== undefined)
  ok(cellWithMeta !== undefined && JSON.stringify(cellWithMeta.data.meta).includes('diff'), '9-4 夹具：工具私有 meta（呈现元数据）原样保留')
  ok(stats.toolFailures.length === 1 && stats.toolFailures[0].code === 'ExitCodeError', `9-5 失败判定校准：error 键即失败（${JSON.stringify(stats.toolFailures[0])}）`)
  ok(stats.usage.inputTokens === 15677 && stats.usage.reasoningTokens === 169, `9-6 usage 累加（${JSON.stringify(stats.usage)}）`)
  ok(records.some((record) => record.kind === 'between' && record.events.some((event) => event.type === 'todo/write')), '9-7 夹具：todo/write 等轮次间事件走 between')

  const healthy = dsh.checkContract({ sampleEvents: events })
  ok(healthy.ok === true, '9-8 契约自检对真实形状样本判定 ok')
  const mutated = events.map((event, index) => (index === 6 ? { ...event, seq: undefined } : event))
  ok(dsh.checkContract({ sampleEvents: mutated }).degraded.some((item) => item.id === 'event-shape'), '9-9 仿真「上游改字段」→ 明确报 event-shape 降级')
  const noTools = events.filter((event) => event.type !== 'tool/call' && event.type !== 'tool/result')
  ok(dsh.checkContract({ sampleEvents: noTools }).degraded.some((item) => item.id === 'event-vocabulary'), '9-10 仿真「词表缺失」→ 明确报 event-vocabulary 降级')

  const statsTools = await toolsMod.callTool('stats.tools', { cwd: workdir })
  ok(statsTools.sessions >= 1 && statsTools.toolCalls >= 1, `9-11 stats.tools 聚合（${statsTools.toolCalls} 次调用 / ${statsTools.sessions} 个会话）`)
  const statsUsage = await toolsMod.callTool('stats.usage', {})
  ok(Object.keys(statsUsage.usage).some((key) => /token/i.test(key)), '9-12 stats.usage 聚合 token 字段')

  const repo = join(base, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (gitArgs) => spawnSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8' })
  git(['init'])
  writeFileSync(join(repo, 'a.txt'), 'one\n', 'utf8')
  git(['add', 'a.txt'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'])
  writeFileSync(join(repo, 'a.txt'), 'two\n', 'utf8')
  const diff = await toolsMod.callTool('artifact.diff', { cwd: repo })
  ok(diff.available === true && diff.diff.includes('-one') && diff.diff.includes('+two'), '9-13 artifact.diff 取到真实 git diff（不裁）')

  const narrated = await toolsMod.callTool('report.narrate', {})
  ok(typeof narrated.text === 'string' && narrated.text.includes('桩答案'), '9-14 report.narrate 走一次 dsh 任务（桩验证）')

  const compat = await toolsMod.callTool('status.compat', {})
  ok(compat.tools.total > compat.tools.implemented && Array.isArray(compat.tools.pending), `9-15 status.compat 报出已实现/待实现（${compat.tools.implemented}/${compat.tools.total}）`)
}

console.log('10. 命令面两层（主命令 / 短开关别名 / 生成子命令 / hint）')
{
  // 用子进程跑 bin/dshcli.js：干净环境 + 临时 DSH_HOME（不碰主人机器），退出码也能直接断言
  const env = { ...process.env, DSH_HOME: home, DSHCLI_DSH_BIN: stubPath }
  const run = (args) => spawnSync(process.execPath, [join(root, 'bin', 'dshcli.js'), ...args], { encoding: 'utf8', env, timeout: 90000 })

  const help = run(['-h'])
  ok(help.status === 0 && /层 1 主命令/.test(help.stdout) && /层 2 全工具面/.test(help.stdout), '10-1 -h 给两层帮助')
  ok(/dshcli\.SKILL\.md/.test(help.stdout), '10-2 -h 带「先看技能说明」提示（绝对路径）')

  const helpJson = JSON.parse(run(['-h', '--json']).stdout)
  ok(typeof helpJson.hint?.skill === 'string' && helpJson.hint.skill.endsWith('dshcli.SKILL.md'), '10-3 --json 给结构化 hint.skill')

  const aliasOut = run(['-l', '--json'])
  const nameOut = run(['list', '--json'])
  ok(aliasOut.status === 0 && aliasOut.stdout === nameOut.stdout, '10-4 短开关 -l ≡ list（输出一致）')

  const infoJson = JSON.parse(run(['-i', '--json']).stdout)
  ok(typeof infoJson === 'object' && infoJson.hint?.skill !== undefined, '10-5 -i 可用且带 hint')

  const generated = run(['session', 'list', '-n', '3', '--json'])
  ok(generated.status === 0 && Array.isArray(JSON.parse(generated.stdout).sessions), '10-6 生成子命令 session list -n 3')

  const toolHelp = run(['task', 'run', '--help'])
  ok(toolHelp.status === 0 && /位置参数：prompt/.test(toolHelp.stdout) && /--timeout-ms/.test(toolHelp.stdout), '10-7 子命令 --help 给位置参数与开关')

  const pending = run(['cred', 'list'])
  ok(pending.status === 1 && /not_implemented/.test(pending.stderr), '10-8 未实现工具报 not_implemented 且不崩（退出码 1）')

  const unknownFlag = run(['tools', '--nope'])
  ok(unknownFlag.status === 1 && /未知开关/.test(unknownFlag.stderr), '10-9 未知开关给可读报错')

  const unknownTool = run(['session', 'nosuch'])
  ok(unknownTool.status === 1 && /该组有/.test(unknownTool.stderr), '10-10 组内不存在的工具给出候选清单')

  const catalogJson = JSON.parse(run(['tools', '--json']).stdout)
  const shaped = catalogJson.tools.every((tool) => Array.isArray(tool.params) && Array.isArray(tool.positional))
  ok(catalogJson.total === 78 && shaped, `10-11 78 个工具全部带 positional/params（${catalogJson.total} 个）`)

  const oneTool = JSON.parse(run(['tools', 'task.run', '--json']).stdout)
  ok(oneTool.params.some((param) => param.name === 'cwd' && param.flag.includes('--cwd')), '10-12 单工具详情带参数声明')

  const argsCall = run(['call', 'task.list', '--args', '{"limit":1}', '--json'])
  ok(argsCall.status === 0 && Array.isArray(JSON.parse(argsCall.stdout).tasks), '10-13 call --args 走 JSON（旧用法不破）')
}

console.log('11. 技能（与 exe 同级 / 内嵌 / 落盘 / 提示）')
{
  const skillMod = await import(pathToFileURL(join(src, 'skill.js')).href)
  const text = skillMod.embeddedSkill()
  ok(typeof text === 'string' && text.includes('dshcli') && /归属/.test(text) && /out/.test(text) && /not_implemented/.test(text), '11-1 技能正文含关键契约（归属 / out / 未实现处理）')
  ok(skillMod.SKILL_FILENAME === 'dshcli.SKILL.md', '11-2 文件名与 exe 同级不撞名')

  const status = skillMod.skillStatus()
  ok(status.installed === true && status.matches === true, '11-3 首次运行已自动落盘，且与内嵌一致')

  const dest = join(base, 'skill-dest')
  const installed = skillMod.installSkill({ to: dest })
  ok(installed.changed === true && existsSync(join(dest, 'dshcli.SKILL.md')), '11-4 skill --install --to 可指定目标目录')

  // 手工写坏 → 必须提示「与内嵌不一致，去刷新」（exe 升级后的常见态）
  const file = skillMod.skillFilePath()
  writeFileSync(file, 'stale-content', 'utf8')
  const stale = skillMod.skillStatus()
  ok(stale.matches === false && /刷新/.test(stale.advice), `11-5 落盘与内嵌不一致时给刷新提示（${stale.advice}）`)

  const cliSkill = spawnSync(process.execPath, [join(root, 'bin', 'dshcli.js'), 'skill', '--where', '--json'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, timeout: 60000 })
  ok(cliSkill.status === 0 && JSON.parse(cliSkill.stdout).path.endsWith('dshcli.SKILL.md'), '11-6 dshcli skill --where --json 可用')
}

console.log('12. 会话日志文件名兼容（上游 v3 起改用 session.v3.jsonl.zstd）')
{
  const v3Work = join(base, 'work-v3')
  mkdirSync(v3Work, { recursive: true })
  const v3Key = projectKeyFor(v3Work)
  const writeAt = (id, layout) => {
    const dir = join(home, 'sessions', v3Key, id)
    mkdirSync(dir, { recursive: true })
    const header = { type: 'session', version: layout === 'v3' ? 3 : 2, id, createdAt: 5000, cwd: v3Work, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
    const body = [...stepEvents, turnEnd]
    if (layout === 'v3') {
      // v3：会话头与事件在**同一个**文件里（首行即会话头），文件名带 v3
      writeFileSync(join(dir, 'session.v3.jsonl.zstd'), framesOf([JSON.stringify(header), ...body.map((event) => JSON.stringify(event))]))
    } else {
      writeFileSync(join(dir, 'session.v2.jsonl.zstd'), framesOf([JSON.stringify(header)]))
      writeFileSync(join(dir, 'session.jsonl.zstd'), framesOf(body.map((event) => JSON.stringify(event))))
    }
    return dir
  }
  const v3Dir = writeAt('session-stub-v3', 'v3')
  writeAt('session-stub-v2', 'legacy')
  const rows = sessionLog.listSessions({ cwd: v3Work })
  ok(rows.length === 2, `12-1 v3 与旧版会话都要被发现（实际 ${rows.length}；漏掉 v3 就是 1 —— issue #54 的回归点）`)
  ok(rows.some((row) => row.sessionId === 'session-stub-v3'), '12-2 v3 文件名 session.v3.jsonl.zstd 未被漏掉')
  ok(sessionLog.logFileOf(v3Dir)?.endsWith('session.v3.jsonl.zstd') === true, '12-3 logFileOf 命中 v3 文件')
  const v3Header = sessionLog.readSessionHeader(v3Dir)
  ok(v3Header?.id === 'session-stub-v3' && v3Header.version === 3, '12-4 v3 单文件里的首行会话头可解析')
  const v3Events = sessionLog.readEvents(v3Dir)
  ok(v3Events.events.length === 8, `12-5 v3 事件可全量读出（实际 ${v3Events.events.length}）`)
}

console.log('13. 兼容门：会话目录在却一个都读不到 → 必须报 sessions-layout 降级')
{
  const blindHome = join(base, 'dsh-home-blind')
  const blindWork = join(base, 'work-blind')
  mkdirSync(blindWork, { recursive: true })
  const blindDir = join(blindHome, 'sessions', projectKeyFor(blindWork), 'session-blind')
  mkdirSync(blindDir, { recursive: true })
  // 仿真「上游又改了一次日志文件名」：目录在、文件也在，但候选名一个都不认
  writeFileSync(join(blindDir, 'session.v9.jsonl.zstd'), framesOf(['{"type":"session","version":9}']))
  const { checkContract } = await import(pathToFileURL(join(src, 'dsh.js')).href)
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = blindHome
  try {
    const blind = checkContract({ dshBin: process.execPath })
    ok(blind.ok === false && blind.degraded.some((item) => item.id === 'sessions-layout'), '13-1 报出 sessions-layout 降级（否则就是「doctor 全绿但读不到任何会话」的静默态）')
  } finally {
    process.env.DSH_HOME = savedHome
  }
}

console.log('14. dsh 落点解析：SEA 自包含产物里 process.execPath 不是 node')
{
  const dsh = await import(pathToFileURL(join(src, 'dsh.js')).href)
  ok(dsh.isNodeInterpreter(process.execPath) === true, '14-1 认出真 node 解释器（JS 安装下 process.execPath 就是 node）')

  // 造一个「像 dshcli 一样」的可执行文件：能跑、退出 0，但 --version 不是 vX.Y.Z
  const fake = join(base, process.platform === 'win32' ? 'fake-dshcli.cmd' : 'fake-dshcli')
  writeFileSync(fake, process.platform === 'win32' ? '@echo dshcli: 9.9.9\r\n' : '#!/bin/sh\necho "dshcli: 9.9.9"\n')
  if (process.platform !== 'win32') chmodSync(fake, 0o755)
  ok(dsh.isNodeInterpreter(fake) === false, '14-2 不把 dshcli 自包含产物误认成 node 解释器')
  ok(dsh.isNodeInterpreter(join(base, 'definitely-missing')) === false, '14-3 不存在的路径返回 false')

  // 不变式：凡是以 .js 为参数去 spawn 的候选，command 必须是**真 node**。
  // 旧实现用 process.execPath，SEA 产物里会变成 `dshcli <bin.js>` → 「未知命令」→ run 必失败。
  const shimDir = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(join(shimDir, 'bin.js'), '// stub dsh bin（只为让 findDshBin 命中 npm-shim 候选）\n')
  const savedHome = process.env.DSH_HOME
  const savedEnvBin = process.env.DSHCLI_DSH_BIN
  process.env.DSH_HOME = home
  delete process.env.DSHCLI_DSH_BIN
  try {
    const candidate = dsh.findDshBin()
    if (candidate === undefined) {
      ok(false, '14-4 造了 shim 却解析不出候选（findDshBin 逻辑有问题）')
    } else {
      const usesJs = (candidate.args ?? []).some((arg) => /\.(mjs|cjs|js)$/i.test(arg))
      ok(usesJs && dsh.isNodeInterpreter(candidate.command) === true,
        `14-4 .js shim 的 command 必须是真 node（source=${candidate.source}, command=${candidate.command}）`)
    }
  } finally {
    process.env.DSH_HOME = savedHome
    if (savedEnvBin !== undefined) process.env.DSHCLI_DSH_BIN = savedEnvBin
  }
}

rmSync(base, { recursive: true, force: true })
console.log(`\n结果：${passed} 通过，${failures} 失败`)
process.exit(failures === 0 ? 0 : 1)
