/**
 * `dshcli` 命令行入口（cmd 面）。
 *
 * 定位：**人可以直接用**，但对外能力以工具面为准（同一个 `callTool`）。
 * 约定：默认人读；`--json` 输出机器可读的无损 JSON（cmd 面的详细结构见 docs/dsh-cli-design.md §4.1，本阶段先做骨架）。
 * 命令名不叫 `dsh` —— 上游已占用，冲突时 CLI 让路（设计 §2 硬约束 2）。
 */

import { parseArgs } from 'node:util'
import { callTool, toolCatalog } from './tools.js'
import { startServer } from './serve.js'
import { digest } from './tools.js'

const VERSION = '0.1.0'

const USAGE = `dshcli —— 用 dsh 跑任务 / 让别的 agent 调 dsh（单机）

用法:
  dshcli run <任务...>            跑一个任务，直接给 out
  dshcli report [--since ISO]     工作情况汇报（--json 给素材；默认给人读）
  dshcli status                   运行时/任务/会话概览
  dshcli doctor                   环境与上游契约自检（兼容检测）
  dshcli tools                    工具清单（含本阶段未实现的）
  dshcli call <工具> [--args JSON] 直接调一个工具
  dshcli sessions                 列会话（含归属/是否在跑）
  dshcli serve                    起本机工具服务（给别的 agent 用）
  dshcli version                  版本

常用参数:
  --cwd <dir>        工作目录（= 会话的 workplace）
  --provider <name>  本次任务的 provider（生成临时 --patch 覆盖）
  --model <name>     本次任务的 model（同上）
  --session-id <id>  续跑指定会话
  --json             机器可读输出
`

/** 参数解析（容忍 `--k v` 与 `--k=v`；不确定的透传给工具当字符串）。 */
function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      cwd: { type: 'string' },
      workplace: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'session-id': { type: 'string' },
      'task-id': { type: 'string' },
      since: { type: 'string' },
      cursor: { type: 'string' },
      args: { type: 'string' },
      port: { type: 'string' },
      limit: { type: 'string' },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
    },
  })
  return { values, positionals }
}

/** 人读输出：只做最小美化，不改数据（机器读请加 --json）。 */
function human(value) {
  if (value === null || typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return value.map((item) => human(item)).join('\n')
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item)}`)
    .join('\n')
}

function print(value, asJson) {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`)
}

/** 入口。 */
export async function main(argv) {
  const { values, positionals } = parse(argv)
  const command = positionals[0]
  const asJson = values.json === true

  if (values.version === true || command === 'version') {
    const info = await callTool('runtime.version', {}, { version: VERSION })
    print({ dshcli: VERSION, ...info }, asJson)
    return 0
  }
  if (values.help === true || command === undefined || command === 'help') {
    process.stdout.write(USAGE)
    return command === undefined ? 1 : 0
  }

  try {
    switch (command) {
      case 'doctor': {
        const compat = await callTool('compat.check', {})
        const overview = await callTool('status.overview', { cwd: values.cwd })
        const payload = { version: VERSION, ...compat, runtime: overview.runtime, dshBin: (await callTool('runtime.version', {}, { version: VERSION })).dshBin }
        if (asJson) print(payload, true)
        else {
          process.stdout.write(`dshcli ${VERSION}\n契约：${compat.ok ? '全部满足' : `${compat.degraded.length} 项降级`}\n`)
          for (const item of compat.degraded) process.stdout.write(`  - [${item.id}] ${item.what ?? ''}：${item.detail}\n`)
          process.stdout.write(`dsh 可执行：${payload.dshBin === null ? '未找到' : payload.dshBin.source}\n`)
          process.stdout.write(`运行时：${payload.runtime.running ? `在跑（端口 ${payload.runtime.port}）` : '未在跑'}\n`)
        }
        return compat.ok ? 0 : 0
      }
      case 'status': {
        print(await callTool('status.overview', { cwd: values.cwd }), asJson)
        return 0
      }
      case 'tools': {
        const tools = toolCatalog()
        if (asJson) print({ tools }, true)
        else {
          for (const tool of tools) process.stdout.write(`${tool.implemented ? '●' : '○'} ${tool.name.padEnd(18)} ${tool.summary}\n`)
          process.stdout.write(`\n（● 已实现 / ○ 本阶段未实现；共 ${tools.length} 个）\n`)
        }
        return 0
      }
      case 'sessions': {
        print(await callTool('session.list', { cwd: values.cwd, limit: values.limit === undefined ? undefined : Number(values.limit) }), asJson)
        return 0
      }
      case 'tasks': {
        print(await callTool('task.list', { limit: values.limit === undefined ? undefined : Number(values.limit) }), asJson)
        return 0
      }
      case 'run': {
        const prompt = positionals.slice(1).join(' ').trim()
        if (prompt === '') {
          process.stderr.write('dshcli run 需要任务文本\n')
          return 1
        }
        const out = await callTool('task.run', {
          prompt,
          cwd: values.cwd ?? values.workplace,
          provider: values.provider,
          model: values.model,
          sessionId: values['session-id'],
          timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
        })
        if (asJson) print(out, true)
        else process.stdout.write(`${out.text}\n`)
        return out.status === 'ok' ? 0 : 1
      }
      case 'report': {
        const facts = await callTool('report.facts', { since: values.since, cwd: values.cwd })
        if (asJson) print({ facts, text: digest(facts) }, true)
        else process.stdout.write(`${digest(facts)}\n`)
        return 0
      }
      case 'call': {
        const name = positionals[1]
        if (name === undefined) {
          process.stderr.write('dshcli call 需要工具名\n')
          return 1
        }
        const args = values.args === undefined ? {} : JSON.parse(values.args)
        print(await callTool(name, args), asJson)
        return 0
      }
      case 'serve': {
        const server = await startServer({
          port: values.port === undefined ? 0 : Number(values.port),
          version: VERSION,
          log: (line) => process.stdout.write(`${line}\n`),
        })
        process.stdout.write(`${JSON.stringify({ url: server.url, port: server.port, endpoint: 'endpoint.json（含 token，只在本机）' })}\n`)
        return 0
      }
      default:
        process.stderr.write(`未知命令：${command}\n\n${USAGE}`)
        return 1
    }
  } catch (error) {
    const code = error?.code === undefined ? '' : `[${error.code}] `
    process.stderr.write(`${code}${String(error?.message ?? error)}\n`)
    return 1
  }
}

export { VERSION, USAGE }
