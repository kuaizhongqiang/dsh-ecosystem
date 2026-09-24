/**
 * `dshcli` 命令行入口（cmd 面）。
 *
 * 形态（2026-09-24 主人定）——**两个层面**：
 *   层 1 **主命令**：`run` / `continue` / `list` / `info` / `report` / `tools` / `call` / `serve` / `doctor` / `version` / `help`，
 *        各自带一个短开关别名（`-c -l -i -r -t -s -v -h`）；短开关**只在第一位**，修饰符**只在子命令之后**。
 *   层 2 **全工具面**：`dshcli <组> <名> [--参数]`（78 个由参数元数据自动生成）+ `dshcli call <工具> --args '<json>'` 兜底。
 *
 * 主要消费者是 **agent**，所以机器面优先：`--json` 给**无损 JSON**（含 `hint.skill` 指路技能说明）、
 * 退出码稳定（0 成功 / 1 用法或工具错误）、未实现工具明确报 `not_implemented`。
 */

import { readFileSync } from 'node:fs'
import { callTool, toolCatalog, toolGroups, PARAMS } from './tools.js'
import { digest } from './tools.js'
import { skillFilePath, skillFileExists, ensureSkillFile } from './skill.js'

/**
 * 版本：打包时由 esbuild define 注入 `__DSHCLI_VERSION__`（自包含 exe 走这条）；
 * 直接跑源码时退回读 package.json（单一事实来源 = package.json）。
 */
function readVersion() {
  if (typeof __DSHCLI_VERSION__ === 'string') return __DSHCLI_VERSION__
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

const VERSION = readVersion()

/** 层 1 主命令表（帮助与短开关别名的唯一来源）。 */
export const COMMANDS = [
  { name: 'run', alias: [], usage: 'run <任务…>', summary: '跑一个任务，直接给 out', tool: 'task.run' },
  { name: 'continue', alias: ['-c'], usage: 'continue [-S 会话] <任务…>', summary: '续跑会话（默认最近一个）', tool: 'session.resume' },
  { name: 'list', alias: ['-l'], usage: 'list [tasks|sessions|all]', summary: '列任务 / 会话', tool: 'task.list + session.list' },
  { name: 'info', alias: ['-i'], usage: 'info [会话id]', summary: '会话详情 + 最近几步', tool: 'session.get + session.history' },
  { name: 'report', alias: ['-r'], usage: 'report [--since ISO]', summary: '工作情况汇报', tool: 'report.facts + report.digest' },
  { name: 'tools', alias: ['-t'], usage: 'tools [工具] [--group G] [--pending]', summary: '工具清单 / 单工具参数详情', tool: 'toolCatalog()' },
  { name: 'call', alias: [], usage: 'call <工具> [--args JSON | --参数 …]', summary: '直接调任意工具（兜底）', tool: 'callTool' },
  { name: 'serve', alias: ['-s'], usage: 'serve [--port N]', summary: '起本机工具服务（给别的 agent 用）', tool: 'startServer' },
  { name: 'status', alias: [], usage: 'status', summary: '运行时 / 任务 / 会话概览', tool: 'status.overview' },
  { name: 'doctor', alias: [], usage: 'doctor', summary: '环境与上游契约自检', tool: 'compat.check' },
  { name: 'version', alias: ['-v', '--version'], usage: 'version', summary: '版本（dshcli / dsh / 契约表）', tool: 'runtime.version' },
  { name: 'skill', alias: [], usage: 'skill [--install|--where]', summary: '技能说明：打印 / 落盘 / 查状态', tool: 'skill' },
  { name: 'help', alias: ['-h', '--help'], usage: 'help', summary: '分组帮助', tool: '' },
]

const ALIAS = new Map(COMMANDS.flatMap((command) => command.alias.map((token) => [token, command.name])))

/** 全局开关（所有命令可用）。 */
const GLOBAL_FLAGS = {
  json: { flag: '-j|--json', type: 'boolean', desc: '机器可读输出（无损 JSON）' },
  help: { flag: '-h|--help', type: 'boolean', desc: '只看该命令/工具的用法' },
}

/** CLI 自己的开关（不是工具参数）。 */
const CLI_FLAGS = {
  group: { flag: '--group', type: 'string', desc: '只看某一组' },
  pending: { flag: '--pending', type: 'boolean', desc: '只看未实现的' },
  port: { flag: '--port', type: 'number', desc: '端口（0 = 随机）' },
  args: { flag: '--args', type: 'string', desc: 'JSON 形式的参数（call 用）' },
}

/** 参数声明查找：先工具参数池，再 CLI 自己的开关。 */
function flagSpec(key) {
  return PARAMS[key] ?? CLI_FLAGS[key]
}

/** 用法错误（退出码 1；消息里带怎么改）。 */
function usageError(message, hint) {
  const error = new Error(hint === undefined ? message : `${message}\n提示：${hint}`)
  error.code = 'usage'
  return error
}

/** 由「参数键集合 + 全局开关」拼出解析规格。 */
function buildSpec(paramKeys) {
  const flags = new Map()
  const booleans = new Set()
  const types = new Map()
  const add = (key, spec) => {
    for (const token of spec.flag.split('|')) flags.set(token, key)
    types.set(key, spec.type)
    if (spec.type === 'boolean') booleans.add(key)
  }
  for (const [key, spec] of Object.entries(GLOBAL_FLAGS)) add(key, spec)
  for (const key of paramKeys) {
    const spec = flagSpec(key)
    if (spec === undefined) throw usageError(`内部错误：未声明的参数 ${key}`)
    add(key, spec)
  }
  return { flags, booleans, types }
}

/**
 * 解析 argv：支持 `--k v`、`--k=v`、短开关（`-n 5`、`-y`）、`--` 之后全当位置参数。
 * 未知开关**直接报错**并提示 `dshcli <组> <名> --help`（不静默吞）。
 */
function parseArgv(argv, spec) {
  const values = {}
  const positionals = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    const isFlag = /^--?[A-Za-z]/.test(token)
    if (!isFlag) {
      positionals.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq > 0 ? token.slice(0, eq) : token
    const inline = eq > 0 ? token.slice(eq + 1) : undefined
    const key = spec.flags.get(name)
    if (key === undefined) throw usageError(`未知开关：${name}`, '看全部用法：dshcli -h；看某命令参数：dshcli tools <工具>')
    if (spec.booleans.has(key)) {
      values[key] = inline === undefined ? true : inline !== 'false'
      continue
    }
    const raw = inline ?? argv[++index]
    if (raw === undefined) throw usageError(`开关 ${name} 缺少值`)
    if (spec.types.get(key) === 'number') {
      const num = Number(raw)
      if (!Number.isFinite(num)) throw usageError(`开关 ${name} 需要数字，收到：${raw}`)
      values[key] = num
      continue
    }
    values[key] = raw
  }
  return { values, positionals }
}

/** 位参数按声明顺序绑定到 args 键。 */
function bindPositionals(tool, positionals) {
  const keys = tool.positional ?? []
  const args = {}
  const rest = []
  positionals.forEach((value, index) => {
    if (index < keys.length) args[keys[index]] = value
    else rest.push(value)
  })
  return { args, rest }
}

/** 技能提示：人读三行 / 机器读结构化（agent 据此去读技能）。 */
export function skillHint() {
  const file = skillFilePath()
  return {
    skill: file,
    installed: skillFileExists(),
    advice: '本工具自带技能说明，建议先读（含两层命令、契约与红线、未实现工具怎么处理）',
    print: 'dshcli skill',
  }
}

/** 人读输出：数组逐行，对象 k: v（机器读请加 --json）。 */
function human(value, indent = '') {
  if (value === null || value === undefined) return `${indent}${String(value)}`
  if (Array.isArray(value)) return value.map((item) => human(item, indent)).join('\n')
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${indent}${key}: ${item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item)}`)
      .join('\n')
  }
  return `${indent}${String(value)}`
}

/** 人读的「先看技能」提示（三行）。 */
function printHint() {
  const info = skillHint()
  process.stdout.write(`\n提示：${info.advice}\n  ${info.skill}${info.installed ? '' : '（尚未落盘）'}\n  打印：${info.print}；机器读：加 --json 看 hint.skill\n`)
}

/** 统一出口：`--json` 走无损 JSON，否则人读；提示只在需要指路的命令上加。 */
function output(value, { json, hint = false }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(hint ? { ...value, hint: skillHint() } : value, null, 2)}\n`)
    return
  }
  process.stdout.write(`${human(value)}\n`)
  if (hint) printHint()
}

/** 层 1 帮助。 */
function usageText() {
  const lines = [
    `dshcli ${VERSION} —— 用 dsh 跑任务 / 让别的 agent 调 dsh（单机）`,
    '',
    '层 1 主命令（短开关是别名，只能在第一位）：',
  ]
  for (const command of COMMANDS) {
    const alias = command.alias.length > 0 ? ` [${command.alias.filter((a) => a.startsWith('-') && !a.startsWith('--')).join(' ')}]` : ''
    lines.push(`  ${command.usage.padEnd(40)}${command.summary}${alias}`)
  }
  lines.push('', '层 2 全工具面（78 个，由参数元数据生成）：')
  for (const [group, tools] of toolGroups()) {
    const done = tools.filter((tool) => tool.implemented).length
    lines.push(`  dshcli ${group} <名>   （${done}/${tools.length} 已实现：${tools.map((tool) => tool.name.split('.')[1]).join(' ')}）`)
  }
  lines.push('', '  兜底：dshcli call <工具> --args \'{"k":v}\'；清单：dshcli tools --json；单工具参数：dshcli tools <工具>')
  lines.push('', '通用修饰符：-j/--json -m/--model -p/--provider -w/--workplace -n/--limit（只在子命令之后）')
  return lines.join('\n')
}

/** 层 2：把某个工具的声明渲染成一段帮助。 */
function toolUsage(tool) {
  const positional = (tool.positional ?? []).map((key) => `<${key}>`).join(' ')
  const lines = [
    `${tool.name} —— ${tool.summary}`,
    `  用法：dshcli ${tool.group} ${tool.name.split('.')[1]}${positional === '' ? '' : ` ${positional}`}${tool.params.length === 0 ? '' : ' [开关…]'}`,
    `  状态：${tool.implemented ? '已实现' : '未实现（调用会明确报 not_implemented）'}${tool.write === true ? '；写类（受归属与写权限约束）' : ''}${tool.p0 === true ? '；★P0' : ''}`,
  ]
  if (tool.positional.length > 0) lines.push(`  位置参数：${tool.positional.join(', ')}`)
  if (tool.params.length > 0) {
    lines.push('  开关：')
    for (const param of tool.params) lines.push(`    ${param.flag.padEnd(24)}${param.desc}`)
  }
  return lines.join('\n')
}

/** 最近的 CLI/本机会话 id（`continue` / `info` 缺 id 时用）。 */
async function newestSessionId(cwd) {
  const listed = await callTool('session.list', { cwd, limit: 1 })
  const first = listed.sessions?.[0]
  return first?.sessionId
}

/** 主入口。 */
export async function main(argv) {
  // 首次运行尽量把技能落到 exe 同级（失败静默；只读目录也该能干活）
  if (argv[0] !== 'skill') ensureSkillFile()
  const raw = [...argv]
  if (raw[0] !== undefined && ALIAS.has(raw[0])) raw[0] = ALIAS.get(raw[0])
  const command = raw[0]
  const rest = raw.slice(1)

  try {
    if (command === undefined) {
      if (raw.includes('--json')) output({ commands: COMMANDS }, { json: true, hint: true })
      else {
        process.stdout.write(`${usageText()}\n`)
        printHint()
      }
      return 1
    }
    if (command === 'help') {
      if (rest.includes('--json')) {
        output({ commands: COMMANDS, groups: [...toolGroups()].map(([group, tools]) => ({ group, count: tools.length, implemented: tools.filter((tool) => tool.implemented).length })) }, { json: true, hint: true })
      } else {
        process.stdout.write(`${usageText()}\n`)
        printHint()
      }
      return 0
    }

    // 层 2：`dshcli <组> <名>`
    // 组名与主命令可能撞名（`report` / `status` / `skill`）—— 规则：第二个词能匹配到该组的工具就走层 2，
    // 否则（没第二个词、或第二个词是开关、或匹配不到）交给主命令。这样 `skill list` 调工具、`skill --where` 走主命令。
    const catalog = toolCatalog()
    const matched = catalog.find((tool) => tool.group === command && tool.name === `${command}.${rest[0]}`)
    // 注意 `return await`：直接 return promise 会绕过外层 try/catch（not_implemented 会变成未捕获异常）
    if (matched !== undefined) return await runTool(matched, rest.slice(1), catalog)
    const groupTools = toolGroups().get(command)
    const isMainCommand = COMMANDS.some((entry) => entry.name === command)
    if (groupTools !== undefined && !isMainCommand) {
      if (rest.length === 0) {
        process.stdout.write(`${groupTools.map((tool) => toolUsage(tool)).join('\n\n')}\n`)
        return 0
      }
      throw usageError(`没有这个工具：${command}.${rest[0]}`, `该组有：${groupTools.map((tool) => tool.name.split('.')[1]).join(' / ')}`)
    }
    if (groupTools !== undefined && isMainCommand && rest.length > 0 && !rest[0].startsWith('-')) {
      throw usageError(
        `没有这个工具：${command}.${rest[0]}`,
        `该组有：${groupTools.map((tool) => tool.name.split('.')[1]).join(' / ')}；要走主命令：dshcli ${command}`,
      )
    }

    switch (command) {
      case 'version': {
        const info = await callTool('runtime.version', {}, { version: VERSION })
        output({ dshcli: VERSION, ...info }, { json: rest.includes('--json'), hint: true })
        return 0
      }
      case 'doctor': {
        const { values } = parseArgv(rest, buildSpec(['cwd']))
        const compat = await callTool('compat.check', {})
        const overview = await callTool('status.overview', { cwd: values.cwd })
        const tools = toolCatalog()
        output({
          dshcli: VERSION,
          ok: compat.ok,
          degraded: compat.degraded,
          tools: { total: tools.length, implemented: tools.filter((tool) => tool.implemented).length },
          runtime: overview.runtime,
          dshBin: (await callTool('runtime.version', {}, { version: VERSION })).dshBin,
        }, { json: values.json, hint: true })
        return 0
      }
      case 'status': {
        const { values } = parseArgv(rest, buildSpec(['cwd']))
        output(await callTool('status.overview', { cwd: values.cwd }), { json: values.json })
        return 0
      }
      case 'list': {
        const { values, positionals } = parseArgv(rest, buildSpec(['cwd', 'limit', 'status']))
        const what = positionals[0] ?? 'all'
        if (!['tasks', 'sessions', 'all'].includes(what)) throw usageError(`list 只认 tasks | sessions | all，收到：${what}`)
        const payload = {}
        if (what !== 'sessions') payload.tasks = (await callTool('task.list', { status: values.status, limit: values.limit, cwd: values.cwd })).tasks
        if (what !== 'tasks') payload.sessions = (await callTool('session.list', { cwd: values.cwd, limit: values.limit })).sessions
        output(payload, { json: values.json })
        return 0
      }
      case 'info': {
        const { values, positionals } = parseArgv(rest, buildSpec(['cwd', 'tail']))
        const sessionId = positionals[0] ?? (await newestSessionId(values.cwd))
        if (sessionId === undefined) {
          output({ sessions: [] }, { json: values.json })
          if (!values.json) process.stdout.write('（没有可看的会话）\n')
          return 0
        }
        const detail = await callTool('session.get', { sessionId, tail: values.tail ?? 3, cwd: values.cwd })
        output(detail, { json: values.json, hint: true })
        return 0
      }
      case 'run': {
        const { values, positionals } = parseArgv(rest, buildSpec(['cwd', 'provider', 'model', 'sessionId', 'timeoutMs']))
        const prompt = positionals.join(' ').trim()
        if (prompt === '') throw usageError('run 需要任务文本', '例如：dshcli run "把 README 里过期的版本号改掉"')
        const out = await callTool('task.run', { prompt, cwd: values.cwd, provider: values.provider, model: values.model, sessionId: values.sessionId, timeoutMs: values.timeoutMs })
        if (values.json) output(out, { json: true })
        else process.stdout.write(`${out.text}\n`)
        return out.status === 'ok' ? 0 : 1
      }
      case 'continue': {
        const { values, positionals } = parseArgv(rest, buildSpec(['sessionId', 'cwd', 'provider', 'model', 'timeoutMs']))
        const prompt = positionals.join(' ').trim()
        if (prompt === '') throw usageError('continue 需要任务文本（续跑也要说明继续做什么）', '例如：dshcli -c "把刚才那处也一起改了"')
        const sessionId = values.sessionId ?? (await newestSessionId(values.cwd))
        if (sessionId === undefined) throw usageError('没有可续的会话，用 dshcli run 新建一个')
        const out = await callTool('session.resume', { sessionId, prompt, cwd: values.cwd, provider: values.provider, model: values.model, timeoutMs: values.timeoutMs })
        if (values.json) output(out, { json: true })
        else process.stdout.write(`${out.text}\n`)
        return out.status === 'ok' ? 0 : 1
      }
      case 'report': {
        const { values } = parseArgv(rest, buildSpec(['since', 'cwd']))
        const facts = await callTool('report.facts', { since: values.since, cwd: values.cwd })
        if (values.json) output({ facts, text: digest(facts) }, { json: true })
        else process.stdout.write(`${digest(facts)}\n`)
        return 0
      }
      case 'tools': {
        const { values, positionals } = parseArgv(rest, buildSpec(['group', 'pending']))
        const wanted = positionals[0]
        if (wanted !== undefined) {
          const tool = catalog.find((item) => item.name === wanted || `${item.group}.${wanted}` === item.name)
          if (tool === undefined) throw usageError(`没有这个工具：${wanted}`, '看全部：dshcli tools')
          if (values.json) output(tool, { json: true })
          else process.stdout.write(`${toolUsage(tool)}\n`)
          return 0
        }
        const filtered = catalog.filter((tool) => (values.group === undefined || tool.group === values.group) && (values.pending !== true || !tool.implemented))
        output({ total: catalog.length, implemented: catalog.filter((tool) => tool.implemented).length, tools: filtered }, { json: values.json })
        if (!values.json) {
          process.stdout.write(`${filtered.map((tool) => `${tool.implemented ? '●' : '○'} ${tool.name.padEnd(20)} ${tool.summary}`).join('\n')}\n`)
          process.stdout.write(`\n（● 已实现 / ○ 未实现；共 ${filtered.length} 个）\n`)
        }
        return 0
      }
      case 'call': {
        const name = rest[0]
        if (name === undefined) throw usageError('call 需要工具名', '例如：dshcli call session.list --args \'{"limit":5}\'')
        const tool = catalog.find((item) => item.name === name)
        return await runTool(tool, rest.slice(1), catalog, { forceCall: true })
      }
      case 'serve': {
        const { values } = parseArgv(rest, buildSpec(['port']))
        const { startServer } = await import('./serve.js')
        const server = await startServer({ port: values.port ?? 0, version: VERSION, log: (line) => process.stdout.write(`${line}\n`) })
        output({ url: server.url, port: server.port, endpoint: 'endpoint.json（含 token，只在本机）' }, { json: values.json })
        return 0
      }
      case 'skill': {
        const { skillCommand } = await import('./skill-command.js')
        return skillCommand(rest, { output })
      }
      default:
        throw usageError(`未知命令：${command}`, '看全部：dshcli -h')
    }
  } catch (error) {
    const code = error?.code === undefined || error.code === 'usage' ? '' : `[${error.code}] `
    process.stderr.write(`${code}${String(error?.message ?? error)}\n`)
    return 1
  }
}

/** 层 2 通用执行：按工具声明解析参数 → callTool（`--help` 只打用法）。 */
async function runTool(tool, argv, catalog, options = {}) {
  if (tool === undefined) {
    const named = argv[0] === undefined ? '' : argv[0]
    const guessed = catalog.find((item) => item.name.endsWith(`.${named}`))
    throw usageError(
      named === '' ? '这个工具不存在' : guessed === undefined ? `没有这个工具：${named}` : `组不匹配：想调 ${guessed.name} 请写 dshcli ${guessed.group} ${guessed.name.split('.')[1]}`,
      '清单：dshcli tools --json',
    )
  }
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${toolUsage(tool)}\n`)
    return 0
  }
  // call 兜底：--args 走 JSON（先于声明解析，避免未知开关报错）
  const argsIndex = argv.indexOf('--args')
  if (options.forceCall === true && argsIndex >= 0 && argv[argsIndex + 1] !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(argv[argsIndex + 1])
    } catch (error) {
      throw usageError(`--args 不是合法 JSON：${error.message}`)
    }
    const { values: extra } = parseArgv([...argv.slice(0, argsIndex), ...argv.slice(argsIndex + 2)], buildSpec([]))
    output(await callTool(tool.name, parsed), { json: extra.json ?? false })
    return 0
  }
  const keys = tool.params.map((param) => param.name)
  const { values, positionals } = parseArgv(argv, buildSpec(keys))
  const translated = {}
  for (const param of tool.params) {
    if (values[param.name] !== undefined) translated[param.name] = values[param.name]
  }
  const bound = bindPositionals(tool, positionals)
  Object.assign(translated, bound.args)
  if (bound.rest.length > 0) throw usageError(`${tool.name} 位置参数多了：${bound.rest.join(' ')}`, `用法见 dshcli tools ${tool.name}`)
  if (!tool.implemented) {
    // 未实现也照常报错，但把「怎么查它」一并给出
    process.stderr.write(`提示：${tool.name} 本阶段未实现（清单里打 ○）。\n`)
  }
  const result = await callTool(tool.name, translated)
  output(result, { json: values.json })
  return 0
}

export { VERSION, usageText, toolUsage }
