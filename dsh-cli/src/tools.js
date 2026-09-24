/**
 * 工具清单与实现（docs/dsh-cli-design.md §7）。
 *
 * 写类工具（`write: true`）受归属规则约束（§5）：外来会话运行中一律拒绝，且**硬失败**。
 * 本阶段实现 P0/P1 子集；清单里其余条目返回 `not_implemented`（明确报出，不静默）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { CONTRACT, checkContract, findDshBin, instanceState, runHeadless } from './dsh.js'
import { makeOut } from './out.js'
import { assertWritable, claim, loadRegistry, ownershipOf, runState } from './ownership.js'
import { dshHome, stateDir } from './paths.js'
import { findSession, listSessions, readEvents, readTailEvents } from './session-log.js'
import { buildRecords, recordsSince, summarizeRecords } from './step-records.js'
import { getRun, hasLiveRun, liveChildren, listRuns, newTaskId, upsertRun } from './runs.js'

/** 默认单任务上限（主人拍板：30 分钟，超时标记但继续跑）。 */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 命令面参数池 —— **层 2 子命令 / `--help` / `GET /tools` 自描述的唯一事实来源**。
 *
 * `flag` 里短开关（`-x`）只在子命令之后可用，长开关（`--long`）任意位置；`type` 决定 CLI 的取值转换：
 * `path`（原样字符串，但帮助里标成路径）/ `number` / `boolean` / `iso`（时间）/ `secret`（只写不回显）。
 */
export const PARAMS = {
  prompt: { flag: '--prompt', type: 'string', desc: '任务文本' },
  cwd: { flag: '-w|--workplace|--cwd', type: 'path', desc: '工作目录（= 会话 workplace）' },
  provider: { flag: '-p|--provider', type: 'string', desc: 'provider（本次任务 / 会话）' },
  model: { flag: '-m|--model', type: 'string', desc: 'model（provider 之内）' },
  preset: { flag: '--preset', type: 'string', desc: 'agent preset（默认 standard）' },
  sessionId: { flag: '-S|--session', type: 'string', desc: '会话 id' },
  taskId: { flag: '-T|--task', type: 'string', desc: '任务 id' },
  name: { flag: '--name', type: 'string', desc: '名字（provider / model / preset / 凭证等）' },
  id: { flag: '--id', type: 'string', desc: '标识（插件 / 技能 / 回调）' },
  key: { flag: '--key', type: 'string', desc: '配置键' },
  value: { flag: '--value', type: 'secret', desc: '值（凭证类：只写、永不回显）' },
  path: { flag: '--path', type: 'path', desc: '文件 / 目录路径' },
  to: { flag: '--to', type: 'path', desc: '目标目录或文件' },
  source: { flag: '--source', type: 'string', desc: '来源（从哪里装）' },
  url: { flag: '--url', type: 'string', desc: '回调地址' },
  text: { flag: '--text', type: 'string', desc: '正文' },
  events: { flag: '--events', type: 'string', desc: '事件类型（逗号分隔）' },
  title: { flag: '--title', type: 'string', desc: '标题 / 名字' },
  version: { flag: '--version', type: 'string', desc: '目标版本' },
  status: { flag: '--status', type: 'string', desc: '按状态过滤' },
  since: { flag: '--since', type: 'iso', desc: '时间窗起点（ISO；增量汇报用）' },
  limit: { flag: '-n|--limit', type: 'number', desc: '最多返回多少条' },
  tail: { flag: '--tail', type: 'number', desc: '只看最近 N 条' },
  cursor: { flag: '--cursor', type: 'number', desc: '增量游标（上次返回的 cursor）' },
  timeoutMs: { flag: '--timeout-ms', type: 'number', desc: '本次等待上限（默认 30 分钟）' },
  confirm: { flag: '-y|--yes|--confirm', type: 'boolean', desc: '确认危险操作（删除类必填）' },
  force: { flag: '--force', type: 'boolean', desc: '强制执行（忽略幂等判断）' },
  dryRun: { flag: '--dry-run', type: 'boolean', desc: '只演练不落地' },
  core: { flag: '--core', type: 'boolean', desc: '是否含 dsh 本体' },
  plugins: { flag: '--plugins', type: 'boolean', desc: '是否含插件集' },
  skills: { flag: '--skills', type: 'boolean', desc: '是否含技能' },
}

/**
 * 工具清单（78 个，含未实现的条目 —— 便于调用方与 doctor 对照）。
 *
 * `positional` 是位置参数绑定的 **args 键名**（顺序即位置顺序）；`params` 引用 `PARAMS` 里的键。
 * **已实现的 28 个 = 真实契约；未实现的 50 个 = 已声明契约**（调用明确报 `not_implemented`，不静默）。
 */
export const TOOLS = [
  // A. 任务（11）
  { name: 'task.run', group: 'task', write: true, p0: true, summary: '下达任务并等它跑完，直接回 out', positional: ['prompt'], params: ['cwd', 'provider', 'model', 'sessionId', 'timeoutMs'] },
  { name: 'task.run_async', group: 'task', write: true, p0: true, summary: '下达任务立即返回 taskId（长任务用）', positional: ['prompt'], params: ['cwd', 'provider', 'model', 'sessionId'] },
  { name: 'task.get', group: 'task', p0: true, summary: '查任务状态 / 进度 / 结果', positional: ['taskId'], params: ['tail'] },
  { name: 'task.out', group: 'task', p0: true, summary: '只取任务的终结产出 out', positional: ['taskId'] },
  { name: 'task.wait', group: 'task', p0: true, summary: '阻塞等任务完成（可设超时）', positional: ['taskId'], params: ['timeoutMs'] },
  { name: 'task.list', group: 'task', p0: true, summary: '列任务（按状态 / 时间过滤）', params: ['status', 'limit', 'cwd'] },
  { name: 'task.cancel', group: 'task', write: true, summary: '取消任务（= 终止运行）', positional: ['taskId'], params: ['confirm'] },
  { name: 'task.log', group: 'task', summary: '取任务原始事件记录', positional: ['taskId'], params: ['cursor', 'limit'] },
  { name: 'task.retry', group: 'task', write: true, summary: '同参数重跑一次', positional: ['taskId'], params: ['cwd', 'provider', 'model'] },
  { name: 'task.follow', group: 'task', summary: '持续跟随任务事件（流式）', positional: ['taskId'], params: ['cursor', 'timeoutMs'] },
  { name: 'task.plan', group: 'task', summary: '只让 dsh 出计划不执行（评审用）', positional: ['prompt'], params: ['cwd', 'provider', 'model'] },

  // B. 会话（11）
  { name: 'session.new', group: 'session', write: true, p0: true, summary: '新建会话（指定 provider / model / workplace）→ owner=cli', params: ['cwd', 'provider', 'model', 'preset', 'title'] },
  { name: 'session.list', group: 'session', p0: true, summary: '列会话（含归属、是否在跑）', params: ['cwd', 'limit'] },
  { name: 'session.get', group: 'session', p0: true, summary: '会话详情（配置 / 统计 / 状态 / 归属）', positional: ['sessionId'], params: ['tail'] },
  { name: 'session.resume', group: 'session', write: true, p0: true, summary: '往指定会话继续下任务', positional: ['prompt'], params: ['sessionId', 'cwd', 'provider', 'model', 'timeoutMs'] },
  { name: 'session.history', group: 'session', p0: true, summary: '分段记录（一步一条）', positional: ['sessionId'], params: ['cursor', 'limit', 'since'] },
  { name: 'session.adopt', group: 'session', write: true, summary: '认领外来会话，登记为 CLI 所有', positional: ['sessionId'] },
  { name: 'session.rename', group: 'session', write: true, summary: '重命名会话', positional: ['sessionId', 'title'] },
  { name: 'session.interrupt', group: 'session', write: true, summary: '打断当前回合（= 终止本次运行）', positional: ['sessionId'], params: ['confirm'] },
  { name: 'session.fork', group: 'session', write: true, summary: '从某会话分叉出新会话', positional: ['sessionId'], params: ['prompt', 'cwd'] },
  { name: 'session.export', group: 'session', summary: '导出会话归档', positional: ['sessionId'], params: ['to'] },
  { name: 'session.delete', group: 'session', write: true, summary: '删除会话', positional: ['sessionId'], params: ['confirm'] },

  // C. 工作情况 / 汇报（10）
  { name: 'status.overview', group: 'status', p0: true, summary: '整体状态：在跑吗 / 几个会话 / 最近干了什么', params: ['cwd'] },
  { name: 'status.health', group: 'status', p0: true, summary: '健康检查（进程 / 端口 / 插件 / 凭证）' },
  { name: 'status.compat', group: 'status', p0: true, summary: '兼容状态：哪些工具可用 / 降级 / 不可用', params: ['sessionId'] },
  { name: 'report.facts', group: 'report', p0: true, summary: '汇报素材（机器可读）：在跑 / 完成 / 失败 / 待人处理 / 产出 / 用量', params: ['since', 'cwd'] },
  { name: 'report.digest', group: 'report', p0: true, summary: '汇报成文（模板）：把素材套成人能读的一段话', params: ['since', 'cwd'] },
  { name: 'report.narrate', group: 'report', summary: '汇报成文（模型）：让 dsh 跑一次总结任务（花一次模型调用，默认不启用）', params: ['since', 'cwd', 'provider', 'model'] },
  { name: 'report.daily', group: 'report', summary: '日报（按天汇总；report.facts/digest 带 since 已能顶）', params: ['since'] },
  { name: 'stats.usage', group: 'stats', summary: 'token 用量聚合（按会话 / 窗口）', params: ['since', 'cwd', 'limit'] },
  { name: 'stats.tools', group: 'stats', summary: '工具调用统计（用得最多 / 失败清单）', params: ['since', 'cwd', 'limit'] },
  { name: 'stats.activity', group: 'stats', summary: '活跃度：多少会话 / 多少轮 / 多少步', params: ['since', 'cwd', 'limit'] },

  // D. 产出物（5）
  { name: 'artifact.list', group: 'artifact', p0: true, summary: '某会话 / 任务的产出文件清单', params: ['sessionId', 'taskId', 'cwd'] },
  { name: 'artifact.diff', group: 'artifact', p0: true, summary: '工作目录的 git diff（stat + 全量 diff + 未跟踪清单）', params: ['sessionId', 'cwd'] },
  { name: 'artifact.get', group: 'artifact', summary: '取产出物内容 / 路径', positional: ['path'] },
  { name: 'artifact.open', group: 'artifact', summary: '在本机打开产出物', positional: ['path'] },
  { name: 'artifact.publish', group: 'artifact', summary: '把产出物导出到指定目录', positional: ['path'], params: ['to'] },

  // E. 配置 / 元信息（12，查 + 改成对）
  { name: 'provider.list', group: 'provider', p0: true, summary: '有哪些 provider 可用' },
  { name: 'provider.get', group: 'provider', summary: 'provider 详情（能力 / 默认 model）', positional: ['name'] },
  { name: 'model.list', group: 'model', p0: true, summary: '有哪些 model 可用（可按 provider 过滤）', params: ['provider'] },
  { name: 'model.get', group: 'model', summary: 'model 详情（上下文长度 / 价格）', positional: ['name'] },
  { name: 'model.set_default', group: 'model', write: true, summary: '设默认 model', positional: ['name'] },
  { name: 'workspace.list', group: 'workspace', p0: true, summary: '有哪些 workplace 可用' },
  { name: 'workspace.get', group: 'workspace', summary: 'workplace 详情（存在性 / 是否 git / 大小）', positional: ['path'] },
  { name: 'workspace.set_default', group: 'workspace', write: true, summary: '设默认 workplace', positional: ['path'] },
  { name: 'preset.list', group: 'preset', summary: '有哪些 agent preset' },
  { name: 'preset.get', group: 'preset', summary: 'preset 详情', positional: ['name'] },
  { name: 'config.get', group: 'config', p0: true, summary: '读当前默认配置', params: ['key'] },
  { name: 'config.set', group: 'config', write: true, summary: '改默认配置', positional: ['key', 'value'] },

  // F. 插件 / 技能 / 生态（9）
  { name: 'plugin.list', group: 'plugin', summary: '已装插件 + 状态' },
  { name: 'plugin.install', group: 'plugin', write: true, summary: '装插件（走生态清单）', positional: ['id'], params: ['source'] },
  { name: 'plugin.remove', group: 'plugin', write: true, summary: '卸载插件', positional: ['id'], params: ['confirm'] },
  { name: 'plugin.reload', group: 'plugin', write: true, summary: '重载插件（上游结论：改动后建议重启）', positional: ['id'] },
  { name: 'skill.list', group: 'skill', summary: '已装技能' },
  { name: 'skill.install', group: 'skill', write: true, summary: '装技能', positional: ['name'], params: ['source'] },
  { name: 'skill.remove', group: 'skill', write: true, summary: '删技能', positional: ['name'], params: ['confirm'] },
  { name: 'ecosystem.pull', group: 'ecosystem', write: true, summary: '按清单拉齐（生态全家桶）', params: ['core', 'plugins', 'skills', 'dryRun'] },
  { name: 'ecosystem.status', group: 'ecosystem', summary: '清单与版本漂移检查' },

  // G. 凭证（5，只回名字与状态，永不回值）
  { name: 'cred.list', group: 'cred', summary: '有哪些凭证（只有名字）' },
  { name: 'cred.set', group: 'cred', write: true, summary: '写入凭证（值只写不回显）', positional: ['name', 'value'] },
  { name: 'cred.verify', group: 'cred', summary: '验证凭证可用', positional: ['name'] },
  { name: 'cred.unset', group: 'cred', write: true, summary: '删除凭证', positional: ['name'], params: ['confirm'] },
  { name: 'cred.where', group: 'cred', summary: '这个凭证被哪些插件在用', positional: ['name'] },

  // H. 运行时 / 运维（8）
  { name: 'runtime.status', group: 'runtime', p0: true, summary: '运行时在不在跑（进程 / 端口 / 版本）' },
  { name: 'runtime.version', group: 'runtime', p0: true, summary: '版本信息（dsh / dshcli / 契约表）' },
  { name: 'runtime.start', group: 'runtime', write: true, summary: '启动运行时' },
  { name: 'runtime.stop', group: 'runtime', write: true, summary: '停止运行时', params: ['confirm'] },
  { name: 'runtime.restart', group: 'runtime', write: true, summary: '重启（复用 launcher 的重启 seam）', params: ['confirm'] },
  { name: 'runtime.logs', group: 'runtime', summary: '运行时日志', params: ['limit', 'tail'] },
  { name: 'runtime.upgrade', group: 'runtime', write: true, summary: '升级 dsh 本体 / CLI', params: ['version'] },
  { name: 'compat.check', group: 'runtime', summary: '手动跑一次兼容检测（doctor 的机器版）', params: ['sessionId'] },

  // I. 事件 / 回调 / 消息（7）
  { name: 'event.poll', group: 'event', p0: true, summary: '按游标拉增量分段记录（不怕断线）', positional: ['sessionId'], params: ['cursor', 'limit'] },
  { name: 'event.subscribe', group: 'event', summary: '订阅事件（流式，第二步）', positional: ['sessionId'], params: ['cursor', 'events'] },
  { name: 'hook.set', group: 'hook', write: true, summary: '注册回调地址（HTTP 回调）', positional: ['url'], params: ['events', 'sessionId'] },
  { name: 'hook.list', group: 'hook', summary: '列回调' },
  { name: 'hook.delete', group: 'hook', write: true, summary: '删回调', positional: ['id'], params: ['confirm'] },
  { name: 'message.post', group: 'message', write: true, summary: '往会话里投一条消息（插入指令）', positional: ['text'], params: ['sessionId'] },
  { name: 'message.outbox', group: 'message', summary: '取「待汇报给人的消息」', params: ['sessionId'] },
]

/** 本阶段已实现的工具（其余返回 not_implemented，明确报出，不静默）。 */
export const IMPLEMENTED = [
  'task.run', 'task.run_async', 'task.get', 'task.out', 'task.wait', 'task.list', 'task.cancel',
  'session.new', 'session.list', 'session.get', 'session.resume', 'session.history', 'session.adopt',
  'status.overview', 'status.health', 'status.compat',
  'report.facts', 'report.digest', 'report.narrate',
  'artifact.list', 'artifact.diff',
  'stats.usage', 'stats.tools', 'stats.activity',
  'event.poll',
  'runtime.status', 'runtime.version',
  'compat.check',
]

/** 工具清单里还缺的条目（由 TOOLS 与 IMPLEMENTED 推导 —— 单一事实来源，不再手抄）。 */
export const TOOLS_PENDING = TOOLS.map((tool) => tool.name).filter((name) => !IMPLEMENTED.includes(name))

/** 清单里有、但本阶段还没实现的，调用时明确报 not_implemented。 */
const NOT_IMPLEMENTED = new Set(TOOLS_PENDING)

/** 把工具条目的 params 键展开成完整声明（供 CLI 生成 / `--help` / `/tools` 自描述）。 */
function expandParams(tool) {
  return (tool.params ?? []).map((key) => {
    const spec = PARAMS[key]
    if (spec === undefined) throw new Error(`工具 ${tool.name} 引用了未声明的参数：${key}`)
    return { name: key, ...spec }
  })
}

/**
 * 清单导出（给 serve 的 `/tools`、`dshcli tools` 与层 2 子命令生成用）。
 * **78 个全量**带 `positional` / `params` 声明；未实现的一律 `pending: true`。
 */
export function toolCatalog() {
  return TOOLS.map((tool) => {
    const done = !NOT_IMPLEMENTED.has(tool.name)
    return {
      name: tool.name,
      group: tool.group,
      summary: tool.summary,
      implemented: done,
      ...(done ? {} : { pending: true }),
      ...(tool.write === true ? { write: true } : {}),
      ...(tool.p0 === true ? { p0: true } : {}),
      positional: tool.positional ?? [],
      params: expandParams(tool),
    }
  })
}

/** 按组聚拢（CLI 帮助与 `--group` 过滤用）。 */
export function toolGroups() {
  const groups = new Map()
  for (const tool of toolCatalog()) {
    if (!groups.has(tool.group)) groups.set(tool.group, [])
    groups.get(tool.group).push(tool)
  }
  return groups
}

/** 会话行 + 归属 + 运行态的公共解析。 */
export function resolveSession(sessionId, cwd) {
  const row = sessionId === undefined ? undefined : findSession(sessionId, cwd)
  if (row === undefined) {
    const error = new Error(`找不到会话 ${sessionId ?? '(未指定)'}${cwd === undefined ? '' : `（cwd=${cwd}）`}`)
    error.code = 'not_found'
    throw error
  }
  const running = runState({ liveRuns: hasLiveRun(sessionId), tailEvents: readTailEvents(row.dir, 40) })
  const owner = ownershipOf(sessionId)
  return { ...row, owner, running: running.running, runningWhy: running.why }
}

/** 读一个会话的分段记录。 */
export function recordsOf(dir) {
  const { events, frameCount } = readEvents(dir)
  const { records, stats } = buildRecords(events)
  return { records, stats, frameCount, eventCount: events.length }
}

/** 把 provider/model 落成一次性的 `--patch` 覆盖（默认模型是 cordis 条目 default-model）。 */
function writeModelPatch({ provider, model, reasoningEffort }) {
  if (provider === undefined && model === undefined && reasoningEffort === undefined) return undefined
  const dir = join(stateDir(), 'patch')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `model-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yml`)
  const lines = ['# dshcli 生成的临时覆盖层：只改默认模型，任务结束即删。', '- id: default-model', "  name: 'cordis:model'", '  config:']
  if (provider !== undefined) lines.push(`    provider: ${JSON.stringify(provider)}`)
  if (model !== undefined) lines.push(`    model: ${JSON.stringify(model)}`)
  if (reasoningEffort !== undefined) lines.push(`    reasoningEffort: ${JSON.stringify(reasoningEffort)}`)
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

/** 执行一次任务的完整流程（sync/async 共用）。 */
async function performRun(args) {
  const cwd = args.cwd ?? args.workplace ?? process.cwd()
  const taskId = args.taskId ?? newTaskId()
  let target = undefined
  if (args.sessionId !== undefined) {
    target = resolveSession(args.sessionId, args.cwd)
    assertWritable(args.sessionId, target.running)
  }
  const patchFile = writeModelPatch(args)
  upsertRun(taskId, {
    taskId,
    sessionId: args.sessionId,
    cwd,
    provider: args.provider,
    model: args.model,
    prompt: args.prompt,
    status: 'running',
    startedAt: new Date().toISOString(),
  })
  const startedAt = Date.now()
  let result
  try {
    result = await runHeadless({
      prompt: args.prompt,
      cwd,
      sessionId: args.sessionId,
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      extraArgs: patchFile === undefined ? [] : ['--patch', patchFile],
      onChild: (child) => liveChildren.set(taskId, child),
    })
  } finally {
    liveChildren.delete(taskId)
    if (patchFile !== undefined) rmSync(patchFile, { force: true })
  }

  const sessionId = args.sessionId ?? newestSessionId(cwd, startedAt)
  const out = await collectOut({ taskId, sessionId, cwd, result, provider: args.provider, model: args.model })
  upsertRun(taskId, {
    sessionId,
    status: out.status,
    endedAt: new Date().toISOString(),
    exitCode: result.code,
    timedOut: result.timedOut,
    out,
  })
  if (sessionId !== undefined) claim(sessionId, { cwd, provider: args.provider, model: args.model, purpose: args.purpose })
  return out
}

/** 我们刚跑完的任务对应哪个会话：取该 cwd 下 createdAt 不早于开始时刻的最新会话。 */
function newestSessionId(cwd, startedAt) {
  const rows = listSessions({ cwd }).filter((row) => (row.createdAt ?? 0) >= startedAt - 5000)
  return rows.length > 0 ? rows[0].sessionId : undefined
}

/** 汇总 out：退出码 + 会话事件（文本取 stdout；细节走分段记录）。 */
async function collectOut({ taskId, sessionId, cwd, result, provider, model }) {
  let stats
  let degraded = []
  if (sessionId !== undefined) {
    const row = listSessions({ cwd }).find((item) => item.sessionId === sessionId)
    if (row !== undefined) {
      const { stats: summary } = recordsOf(row.dir)
      stats = summary
      const check = checkContract({ sampleEvents: readTailEvents(row.dir, 60) })
      degraded = check.degraded
    }
  }
  const status = result.timedOut ? 'timeout' : result.code === 0 ? 'ok' : 'failed'
  return makeOut({
    status,
    text: result.stdout.trim(),
    sessionId,
    taskId,
    turn: stats === undefined ? undefined : stats.turns,
    usage: stats?.usage,
    seqRange: stats?.seqRange,
    startedAt: stats?.startedAt,
    endedAt: stats?.endedAt,
    degraded,
    error: status === 'ok'
      ? undefined
      : {
          code: result.timedOut ? 'timeout' : 'exit_nonzero',
          message: (result.stderr.trim() || `dsh 退出码 ${result.code}`).slice(0, 2000),
          provider,
          model,
        },
  })
}

/**
 * 跨会话聚合（stats.* 用）：把若干会话的分段记录加总。
 * @param options.limit 最多读几个会话的日志（默认 10，按日志 mtime 倒序；大日志很贵）
 */
export function aggregateSessions({ cwd, limit = 10, since } = {}) {
  const from = since === undefined ? 0 : Date.parse(since)
  const rows = listSessions({ cwd })
    .filter((row) => row.logBytes > 0 && (from === 0 || logMtime(row) >= from))
    .slice(0, limit)
  const toolHistogram = {}
  const usage = {}
  const failures = []
  let steps = 0
  let toolCalls = 0
  let turns = 0
  for (const row of rows) {
    const { records, stats } = recordsOf(row.dir)
    turns += stats.turns
    steps += stats.steps
    toolCalls += stats.toolCalls
    for (const [name, count] of Object.entries(stats.toolHistogram)) toolHistogram[name] = (toolHistogram[name] ?? 0) + count
    for (const [key, value] of Object.entries(stats.usage)) usage[key] = (usage[key] ?? 0) + value
    for (const failure of stats.toolFailures) failures.push({ sessionId: row.sessionId, ...failure })
    void records
  }
  return { sessions: rows.length, turns, steps, toolCalls, toolHistogram, usage, failures, window: { since: since ?? null }, scanned: rows.map((row) => row.sessionId) }
}

/** 日志最后修改时间（统计窗口用）。 */
function logMtime(row) {
  if (row.logFile === undefined) return 0
  try {
    return statSync(row.logFile).mtimeMs
  } catch {
    return 0
  }
}

/** 汇报素材（report.facts）：把某时间窗内的任务与记录聚合成「事实」，不做摘要。 */
export function facts({ since, cwd } = {}) {
  const from = since === undefined ? 0 : Date.parse(since)
  const runs = listRuns().filter((run) => (from === 0 || Date.parse(run.startedAt ?? 0) >= from) && (cwd === undefined || run.cwd === cwd))
  const finished = []
  const failed = []
  const needAttention = []
  const artifacts = []
  const usage = {}
  for (const run of runs) {
    if (run.status === 'ok') finished.push({ taskId: run.taskId, sessionId: run.sessionId, cwd: run.cwd, startedAt: run.startedAt, endedAt: run.endedAt, text: run.out?.text })
    else if (run.status === 'running') needAttention.push({ kind: 'running', taskId: run.taskId, sessionId: run.sessionId, startedAt: run.startedAt })
    else if (run.status !== undefined) failed.push({ taskId: run.taskId, status: run.status, error: run.out?.error })
    for (const artifact of run.out?.artifacts ?? []) artifacts.push(artifact)
    for (const [key, value] of Object.entries(run.out?.usage ?? {})) usage[key] = (usage[key] ?? 0) + value
    for (const item of run.out?.degraded ?? []) needAttention.push({ kind: 'degraded', ...item })
  }
  return {
    window: { since: since ?? null, until: new Date().toISOString() },
    running: listRuns().filter((run) => run.status === 'running').length,
    finished,
    failed,
    needAttention,
    artifacts,
    usage,
    sessions: listSessions({ cwd }).length,
    // 「这段时间里 dsh 自己动过哪些会话」—— 不只我们跑的任务（web/vscode 里跑的也算）
    sessionsActive: listSessions({ cwd })
      .filter((row) => row.logBytes > 0 && (from === 0 || logMtime(row) >= from))
      .map((row) => ({ sessionId: row.sessionId, cwd: row.cwd, logBytes: row.logBytes, owner: ownershipOf(row.sessionId) })),
  }
}

/** 汇报成文（report.digest）：模板化的人读文本，零模型成本。 */
export function digest(factsValue) {
  const lines = []
  lines.push(`【dsh 工作汇报 ${factsValue.window.since ?? '起始'} → ${factsValue.window.until}】`)
  lines.push(`在跑：${factsValue.running} 个任务`)
  lines.push(`完成：${factsValue.finished.length} 个`)
  for (const item of factsValue.finished.slice(0, 10)) {
    const text = String(item.text ?? '').replace(/\s+/g, ' ').slice(0, 80)
    lines.push(`  - ${item.startedAt ?? '?'} ${item.sessionId ?? item.taskId}${text === '' ? '' : ` → ${text}`}`)
  }
  lines.push(`失败：${factsValue.failed.length} 个`)
  for (const item of factsValue.failed.slice(0, 5)) lines.push(`  - ${item.taskId}：${item.error?.message ?? item.status}`)
  lines.push(`要你处理：${factsValue.needAttention.length} 项`)
  for (const item of factsValue.needAttention.slice(0, 5)) lines.push(`  - ${item.kind}${item.message === undefined ? '' : `：${item.message}`}`)
  lines.push(`产出：${factsValue.artifacts.length} 个`)
  const usageKeys = Object.keys(factsValue.usage ?? {})
  if (usageKeys.length > 0) lines.push(`用量：${usageKeys.map((key) => `${key}=${factsValue.usage[key]}`).join(' / ')}`)
  lines.push(`会话总数：${factsValue.sessions}`)
  return lines.join('\n')
}

/** 从分段记录里抽出出现过的绝对路径当产出物（保守启发式：只认存在且有扩展名的路径）。 */
export function artifactsFromRecords(records) {
  const seen = new Map()
  const visit = (value) => {
    if (typeof value === 'string') {
      if (!isAbsolute(value)) return
      if (!/[\\/][^\\/]+\.[A-Za-z0-9]{1,8}$/.test(value)) return
      if (seen.has(value)) return
      const exists = existsSync(value)
      seen.set(value, { path: value, exists, bytes: exists ? statSync(value).size : undefined })
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const item of Object.values(value)) visit(item)
  }
  for (const record of records) visit(record)
  return [...seen.values()]
}

/** 调用一个工具。 */
export async function callTool(name, args = {}, deps = {}) {
  if (NOT_IMPLEMENTED.has(name)) {
    const error = new Error(`工具 ${name} 本阶段未实现（见 dshcli tools 的 implemented 标记）`)
    error.code = 'not_implemented'
    throw error
  }
  switch (name) {
    case 'runtime.version': {
      const bin = findDshBin()
      return {
        dshcli: deps.version ?? '0.1.0',
        dshHome: dshHome(),
        stateDir: stateDir(),
        dshBin: bin === undefined ? null : { source: bin.source, command: bin.command },
        contractVersion: CONTRACT.version,
      }
    }
    case 'runtime.status':
    case 'status.health': {
      const instance = await instanceState()
      return { ...instance, stateDir: stateDir(), liveRuns: liveChildren.size }
    }
    case 'status.compat': {
      const sample = args.sessionId === undefined ? [] : readTailEvents(resolveSession(args.sessionId, args.cwd).dir, 60)
      const check = checkContract({ sampleEvents: sample })
      const pending = toolCatalog().filter((tool) => !tool.implemented).map((tool) => tool.name)
      return {
        ok: check.ok,
        degraded: check.degraded.map((item) => ({ ...item, consequence: '依赖该能力工具会降级或不可用' })),
        tools: { total: toolCatalog().length, implemented: toolCatalog().length - pending.length, pending },
      }
    }
    case 'status.overview': {
      const instance = await instanceState()
      const runs = listRuns()
      const sessions = listSessions({ cwd: args.cwd })
      return {
        runtime: { running: instance.running, port: instance.port, listening: instance.listening, launcher: instance.launcher },
        tasks: { total: runs.length, running: runs.filter((run) => run.status === 'running').length },
        sessions: { total: sessions.length, recent: sessions.slice(0, 5).map((row) => ({ sessionId: row.sessionId, cwd: row.cwd, createdAt: row.createdAt })) },
        recentTasks: runs.slice(0, 5).map((run) => ({ taskId: run.taskId, status: run.status, startedAt: run.startedAt, cwd: run.cwd })),
      }
    }
    case 'compat.check': {
      const check = checkContract({})
      return { ok: check.ok, degraded: check.degraded }
    }
    case 'session.list': {
      return {
        sessions: listSessions({ cwd: args.cwd, limit: args.limit }).map((row) => ({
          sessionId: row.sessionId,
          cwd: row.cwd,
          createdAt: row.createdAt,
          agentPreset: row.agentPreset,
          owner: ownershipOf(row.sessionId),
          logBytes: row.logBytes,
        })),
      }
    }
    case 'session.get': {
      const row = resolveSession(args.sessionId, args.cwd)
      const { stats, frameCount } = recordsOf(row.dir)
      return {
        sessionId: row.sessionId,
        cwd: row.cwd,
        createdAt: row.createdAt,
        agentPreset: row.agentPreset,
        owner: row.owner,
        running: row.running,
        runningWhy: row.runningWhy,
        logBytes: row.logBytes,
        frames: frameCount,
        stats,
        registry: loadRegistry().sessions[row.sessionId] ?? null,
      }
    }
    case 'session.new': {
      const cwd = args.cwd ?? args.workplace ?? process.cwd()
      const taskId = args.prompt === undefined ? undefined : newTaskId()
      if (args.prompt === undefined) {
        const sessionRef = `cli-pending-${Date.now().toString(36)}`
        const entry = { sessionRef, cwd, provider: args.provider, model: args.model, purpose: args.purpose, bound: false }
        const dir = join(stateDir(), 'pending')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${sessionRef}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
        return entry
      }
      const out = await performRun({ ...args, cwd, taskId })
      return { sessionId: out.sessionId, cwd, provider: args.provider, model: args.model, bound: true, out }
    }
    case 'session.adopt': {
      const row = resolveSession(args.sessionId, args.cwd)
      const entry = claim(args.sessionId, { cwd: row.cwd, purpose: args.purpose, adopted: true })
      return { sessionId: args.sessionId, owner: 'cli', adopted: true, entry }
    }
    case 'session.history': {
      const row = resolveSession(args.sessionId, args.cwd)
      const { records, stats, frameCount } = recordsOf(row.dir)
      const selected = args.since === undefined ? records : recordsSince(records, args.since)
      const limited = args.limit === undefined ? selected : selected.slice(0, args.limit)
      return { sessionId: row.sessionId, frames: frameCount, stats, records: limited, returned: limited.length, total: records.length }
    }
    case 'session.resume': {
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        const error = new Error('session.resume 需要 prompt（继续下任务）')
        error.code = 'invalid_args'
        throw error
      }
      const row = resolveSession(args.sessionId, args.cwd)
      assertWritable(args.sessionId, row.running)
      return performRun({ ...args, cwd: row.cwd ?? args.cwd, sessionId: args.sessionId })
    }
    case 'task.run': {
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        const error = new Error('task.run 需要 prompt')
        error.code = 'invalid_args'
        throw error
      }
      return performRun(args)
    }
    case 'task.run_async': {
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        const error = new Error('task.run_async 需要 prompt')
        error.code = 'invalid_args'
        throw error
      }
      const taskId = args.taskId ?? newTaskId()
      performRun({ ...args, taskId }).catch((error) => {
        upsertRun(taskId, { status: 'failed', endedAt: new Date().toISOString(), error: String(error?.message ?? error) })
      })
      return { taskId, status: 'running', acceptedAt: new Date().toISOString() }
    }
    case 'task.get': {
      const run = getRun(args.taskId)
      if (run === undefined) {
        const error = new Error(`没有这个任务：${args.taskId}`)
        error.code = 'not_found'
        throw error
      }
      return run
    }
    case 'task.out': {
      const run = getRun(args.taskId)
      if (run === undefined) {
        const error = new Error(`没有这个任务：${args.taskId}`)
        error.code = 'not_found'
        throw error
      }
      return run.out ?? { status: 'running', taskId: args.taskId }
    }
    case 'task.wait': {
      const deadline = Date.now() + (args.timeoutMs ?? 60000)
      for (;;) {
        const run = getRun(args.taskId)
        if (run === undefined) {
          const error = new Error(`没有这个任务：${args.taskId}`)
          error.code = 'not_found'
          throw error
        }
        if (run.status !== 'running') return run.out ?? run
        if (Date.now() > deadline) return { status: 'running', taskId: args.taskId, waitedMs: args.timeoutMs ?? 60000 }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    case 'task.list': {
      const rows = listRuns({ limit: args.limit }).filter((run) => args.status === undefined || run.status === args.status)
      return { tasks: rows.map((run) => ({ taskId: run.taskId, status: run.status, sessionId: run.sessionId, cwd: run.cwd, startedAt: run.startedAt, endedAt: run.endedAt })) }
    }
    case 'task.cancel': {
      const child = liveChildren.get(args.taskId)
      if (child === undefined) {
        const error = new Error(`任务 ${args.taskId} 没有活着的进程（未在跑或已结束）`)
        error.code = 'not_running'
        throw error
      }
      child.kill()
      upsertRun(args.taskId, { status: 'cancelled', endedAt: new Date().toISOString() })
      return { taskId: args.taskId, status: 'cancelled', note: '上游没有中途取消：这里等于终止本次运行' }
    }
    case 'report.facts':
      return facts({ since: args.since, cwd: args.cwd })
    case 'report.digest':
      return { text: digest(facts({ since: args.since, cwd: args.cwd })) }
    case 'report.narrate': {
      // 方案 (c)：让 dsh 自己跑一次「总结任务」把素材写成叙述式汇报 —— 要花一次模型调用，默认不启用。
      const material = facts({ since: args.since, cwd: args.cwd })
      const prompt = [
        '你是 dsh 的工作汇报助手。下面是 dsh-cli 采集的原始素材（结构化事实，未做摘要）。',
        '请用中文写一段给主人看的工作汇报：先说正在跑的，再说完成了什么、失败了什么、需要主人处理什么；',
        '只写素材里有的内容，不要编造；不要输出 JSON，不要复述字段名。',
        '',
        JSON.stringify(material, null, 2),
      ].join('\n')
      const out = await callTool('task.run', { prompt, cwd: args.cwd, provider: args.provider, model: args.model, timeoutMs: args.timeoutMs })
      return { text: out.text, status: out.status, sessionId: out.sessionId, taskId: out.taskId, usage: out.usage, degraded: out.degraded }
    }
    case 'artifact.list': {
      const row = resolveSession(args.sessionId, args.cwd)
      const { records } = recordsOf(row.dir)
      return { sessionId: row.sessionId, artifacts: args.all === true ? artifactsFromRecords(records) : artifactsFromRecords(records).filter((item) => item.exists) }
    }
    case 'artifact.diff': {
      const cwd = args.cwd ?? (args.sessionId === undefined ? undefined : resolveSession(args.sessionId, undefined).cwd)
      if (cwd === undefined || !existsSync(cwd)) {
        const error = new Error('artifact.diff 需要 cwd 或 sessionId 来定位工作目录')
        error.code = 'invalid_args'
        throw error
      }
      if (!existsSync(join(cwd, '.git'))) return { cwd, available: false, reason: 'workplace 不是 git 仓库（没有 .git）' }
      const git = (gitArgs) => spawnSync('git', ['-C', cwd, ...gitArgs], { encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024 })
      const stat = git(['diff', '--stat'])
      const diff = git(['diff', '--no-color'])
      const untracked = git(['ls-files', '--others', '--exclude-standard'])
      // 不裁：diff 原样返回（调用方自己决定怎么看）
      return {
        cwd,
        available: true,
        stat: stat.stdout ?? '',
        diff: diff.stdout ?? '',
        untracked: (untracked.stdout ?? '').split(/\r?\n/).filter((line) => line !== ''),
        truncated: false,
      }
    }
    case 'stats.usage': {
      const agg = aggregateSessions({ cwd: args.cwd, since: args.since, limit: args.limit === undefined ? undefined : Number(args.limit) })
      return { sessions: agg.sessions, usage: agg.usage, scanned: agg.scanned }
    }
    case 'stats.tools': {
      const agg = aggregateSessions({ cwd: args.cwd, since: args.since, limit: args.limit === undefined ? undefined : Number(args.limit) })
      return { sessions: agg.sessions, toolCalls: agg.toolCalls, toolHistogram: agg.toolHistogram, failureCount: agg.failures.length, failures: agg.failures.slice(0, Number(args.failureLimit ?? 20)), scanned: agg.scanned }
    }
    case 'stats.activity': {
      const agg = aggregateSessions({ cwd: args.cwd, since: args.since, limit: args.limit === undefined ? undefined : Number(args.limit) })
      return { sessions: agg.sessions, turns: agg.turns, steps: agg.steps, toolCalls: agg.toolCalls, scanned: agg.scanned, window: agg.window }
    }
    case 'event.poll': {
      const row = resolveSession(args.sessionId, args.cwd)
      const { records, frameCount } = recordsOf(row.dir)
      const selected = recordsSince(records, args.cursor)
      const limited = args.limit === undefined ? selected : selected.slice(0, args.limit)
      const cursor = limited.length === 0 ? Number(args.cursor ?? 0) : limited[limited.length - 1].seqRange[1]
      return { sessionId: row.sessionId, cursor, frames: frameCount, records: limited, returned: limited.length }
    }
    default: {
      const error = new Error(`未知工具：${name}`)
      error.code = 'unknown_tool'
      throw error
    }
  }
}
