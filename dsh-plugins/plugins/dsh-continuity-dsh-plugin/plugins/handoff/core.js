/**
 * dsh-continuity / handoff —— 任务连续性域的纯逻辑核心。
 *
 * 设计约束：
 * 1. 本文件不 import 任何 cordis / dsh 包，只依赖 node 内置与注入的 deps，
 *    因此可以用桩对象直接单测（scripts/verify-continuity.mjs）。
 * 2. 所有会话状态都从**只读投影**读取（sessionProjections.stateOf），
 *    不直接读会话日志（eventAt/snapshotEvents/ownEvents 已被标记 deprecated）。
 * 3. 交接文档是唯一事实源：新会话首条消息只给指针 + 关键字段，不复述全文。
 *
 * 语义决定（2026-10-04 与用户确认）：
 * - 源会话处于 plan mode（计划未批准）时，handoff **拒绝**执行。
 * - goal 克隆后 round 归零（goals.create 强制 roundsStarted=0），且**不**保持 paused。
 * - 上下文与缓存可以丢，交接文档要"简单"：默认确定性生成，不调用模型。
 */

/** 单条消息抽取的文本上限（字符）。 */
const DEFAULT_RECENT_MESSAGES = 8
const DEFAULT_RECENT_CHARS = 1200
/** goal objective 在首条消息里内联的一行上限。 */
const INLINE_OBJECTIVE_CHARS = 200

/** 把工作目录压成安全的目录名（不试图与 dsh 自身 sessions 目录命名保持一致）。 */
export function slugifyCwd(cwd) {
  const raw = typeof cwd === 'string' && cwd.trim() ? cwd : 'unknown-workspace'
  const slug = raw.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'unknown-workspace'
}

/** 时间戳串 YYYYMMDD-HHmmss（本地时间）。 */
export function stamp(now) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now())
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 会话 id 的短形式（首 8 位，去掉 session- 前缀）。 */
export function shortId(sessionId) {
  const s = String(sessionId ?? '').replace(/^session-/, '')
  return s.slice(0, 8) || 'unknown'
}

/** 取单条消息里可见的纯文本（content 既可能是块数组，也可能是裸字符串）。 */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    // 必须按 type === 'text' 过滤：assistant 消息里还有 {type:'reasoning', text}
    // （实测本会话 191 条 reasoning vs 39 条 text），不过滤会把思维链写进交接文档。
    if (!block || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 从 exit_plan_mode 的工具调用参数里取 plan 文本。 */
function planFromArguments(args) {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      return typeof parsed?.plan === 'string' ? parsed.plan : undefined
    } catch {
      return undefined
    }
  }
  if (args && typeof args === 'object' && typeof args.plan === 'string') return args.plan
  return undefined
}

/** 容错深度扫描：不同版本里 tool call 的字段名不完全一致，这里不押注具体形状。 */
function deepFindPlan(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return undefined
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      const hit = deepFindPlan(value[i], depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  if (typeof value !== 'object') return undefined
  const name = value.name ?? value.toolName ?? value.tool
  if (name === 'exit_plan_mode') {
    const plan = planFromArguments(value.arguments ?? value.input ?? value.args ?? value.parameters)
    if (plan && plan.trim()) return plan
  }
  for (const key of Object.keys(value)) {
    const hit = deepFindPlan(value[key], depth + 1)
    if (hit) return hit
  }
  return undefined
}

/** 从消息数组（倒序）里找最近一次已提交的计划文本。 */
export function findPlanText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const hit = deepFindPlan(list[i])
    if (hit) return hit
  }
  return undefined
}

/** 收集最近若干条 user/assistant 文本（截断，倒序取最近的）。 */
export function recentProgress(messages, maxMessages, maxChars) {
  const list = Array.isArray(messages) ? messages : []
  const picked = []
  for (let i = list.length - 1; i >= 0 && picked.length < maxMessages; i -= 1) {
    const role = list[i]?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = messageText(list[i])
    if (!text) continue
    picked.push({ role, text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text })
  }
  return picked.reverse()
}

/**
 * 收集一个会话的交接状态（只读）。
 * @param deps - { stateOf, planMode }；stateOf(session,key) 为投影读取。
 * @param agent - 源会话所属的 live agent。
 */
export function collectHandoffState(deps, agent) {
  const session = agent?.session
  const goalState = safe(() => deps.stateOf(session, 'goal'))
  const todos = safe(() => deps.stateOf(session, 'todos'))
  const plan = safe(() => deps.planMode?.get(agent))
  const messages = safe(() => session.deriveMessages()) ?? []
  return {
    sessionId: session?.id,
    cwd: session?.header?.cwd,
    goal: goalState?.current ?? null,
    goalFailure: goalState?.failure ?? null,
    todos: Array.isArray(todos) ? todos : [],
    planActive: plan?.active === true,
    planPending: plan?.pending,
    planText: findPlanText(messages),
    recent: recentProgress(messages, DEFAULT_RECENT_MESSAGES, DEFAULT_RECENT_CHARS),
    messageCount: messages.length,
  }
}

function safe(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

const TODO_MARK = { completed: '[x]', in_progress: '[~]', pending: '[ ]' }

/**
 * 「薄交接」警告文本（正文与返回值共用同一份，保证接手会话读到的与调用方看到的一致）。
 *
 * 真机事故：源会话没有 goal、没有已批准计划、没有 todo，调用方也没传 brief，
 * 于是交接文档里「目标/计划/待办」全是"无"，接手会话拿到一份空任务书后
 * 只能自行满世界探测环境（实测它去用 Unity 的 execute_code 扫 PATH 找 node）。
 * 这种交接必须被显式警告，而不是静默生成。
 */
export const THIN_HANDOFF_WARNING = [
  '> ⚠️ 薄交接警告：本次交接没有实质任务内容。',
  '>',
  '> - 源会话没有 goal、没有已批准的计划文本、也没有 todo 快照，且调用方未提供 `brief`。',
  '> - 接手会话会拿到一份「目标 / 计划 / 待办」全为空的空任务书，只能自行探测环境'
    + '（真机曾出现接手会话跑去扫 PATH 找 node 的情况）。',
  '> - 建议调用方重跑 handoff 并显式传 `brief`，写明：目标 / 已完成 / 在途 / 下一步 / 关键决策 / 文件清单 / 未决问题。',
].join('\n')

/**
 * 薄交接判定：**同时**满足下列全部条件才算 ——
 * 调用方没写 brief；源会话没有 goal；没有已批准的计划文本；没有 todo 条目。
 * @param state - collectHandoffState 的结果
 * @param options - runHandoff 的 options（只看 brief）
 */
export function isThinHandoff(state, options = {}) {
  const hasOwnBrief = typeof options.brief === 'string' && options.brief.trim() !== ''
  if (hasOwnBrief) return false
  if (state?.goal?.goal) return false
  if (typeof state?.planText === 'string' && state.planText.trim() !== '') return false
  if (Array.isArray(state?.todos) && state.todos.length > 0) return false
  return true
}

/** 渲染交接文档（Markdown，确定性、无模型调用）。 */
export function renderBrief(state, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now())
  const lines = []
  lines.push(`# 交接文档 · ${shortId(state.sessionId)}`)
  lines.push('')
  lines.push(`- 生成时间：${now.toISOString()}（本地 ${stamp(now)}）`)
  lines.push(`- 源会话：\`${state.sessionId ?? '未知'}\``)
  lines.push(`- 工作目录：\`${state.cwd ?? '未知'}\``)
  lines.push(`- 源会话消息数：${state.messageCount ?? 0}`)
  if (options.note) lines.push(`- 交接备注：${options.note}`)
  lines.push('')

  // 薄交接：警告必须落在文档正文里（接手会话读文档时看得到），不能只写在返回值里。
  if (options.thinHandoff) {
    lines.push(THIN_HANDOFF_WARNING)
    lines.push('')
  }

  lines.push('## 目标（goal）')
  if (state.goal?.goal) {
    const g = state.goal.goal
    lines.push(`- objective：${g.objective}`)
    lines.push(`- 阶段：${g.phase}；已跑轮次：${state.goal.roundsStarted ?? 0} / 上限 ${g.maxGoalRounds}`)
    if (g.blockedReason) lines.push(`- 阻塞原因：${g.blockedReason.code} ${g.blockedReason.message}`)
    lines.push('- 克隆语义：新会话重新 create 同一 objective，**轮次计数归零**，且不继承 paused。')
  } else {
    lines.push('- 无（源会话没有 goal）')
  }
  lines.push('')

  lines.push('## 计划（plan）')
  lines.push(state.planText ? state.planText.trim() : '- 无已批准的计划文本（源会话日志里没有 exit_plan_mode 提交记录）')
  lines.push('')

  lines.push('## 待办（todo）')
  if (state.todos.length) {
    for (const item of state.todos) {
      const mark = TODO_MARK[item?.status] ?? '[ ]'
      lines.push(`- ${mark} ${item?.content ?? ''}`)
    }
    lines.push('')
    lines.push('> 注意：todo 是会话内状态，新会话不会自动继承；请在第一条回复里用 `todo_write` 重建上面这张表。')
  } else {
    lines.push('- 无（源会话没有 todo 快照）')
  }
  lines.push('')

  lines.push('## 最近进展')
  if (state.recent.length) {
    for (const entry of state.recent) lines.push(`### ${entry.role}\n${entry.text}\n`)
  } else {
    lines.push('- 无')
  }
  lines.push('')

  lines.push('## 下一步')
  lines.push(options.nextStep ? options.nextStep.trim() : '- 由接手会话按「计划」与「待办」自行推断；不确定时先向用户确认。')
  lines.push('')

  lines.push('## 未决问题')
  if (options.openQuestions?.length) for (const q of options.openQuestions) lines.push(`- ${q}`)
  else lines.push('- 无')
  lines.push('')
  return lines.join('\n')
}

/** 组装新会话首条消息：指针 + 关键字段内联（brief 读不到时不至于空转）。 */
export function renderSeed({ briefPath, state, note }) {
  const objective = state.goal?.goal?.objective
  const lines = []
  lines.push(`这是一个由 /handoff 生成的续跑会话。交接文档：`)
  lines.push('')
  lines.push(briefPath)
  lines.push('')
  lines.push('请先读这份文档，然后按其中的「下一步」继续任务。上一个会话的上下文已被有意丢弃；文档里没有的信息，先向用户确认，不要臆测。')
  if (objective) {
    const inline = objective.length > INLINE_OBJECTIVE_CHARS ? `${objective.slice(0, INLINE_OBJECTIVE_CHARS)}…` : objective
    lines.push('')
    lines.push(`目标：${inline}`)
  }
  const openTodos = state.todos.filter((t) => t?.status !== 'completed')
  if (openTodos.length) lines.push(`待办：${openTodos.length} 项未完成（见文档，需你用 todo_write 重建）`)
  if (state.planText) lines.push('计划：已在源会话批准，见文档「计划」段。')
  if (note) {
    lines.push('')
    lines.push(`用户交接备注：${note}`)
  }
  return lines.join('\n')
}

/**
 * 执行一次 handoff。
 * @param deps - 注入的只读/写能力：
 *   stateOf(session,key) · planMode.get(agent) · goals.create(agent,req) ·
 *   agents.resolveAgent(id) · createSession({workspaceId,cwd,preset}) ·
 *   workspaces() → [{id, sessionIds, path}] · home() → DSH_HOME ·
 *   writeFile(path,text) · mkdir(path) · now()
 * @param options - { agent, note, brief, dryRun, nextStep, preset }
 *   preset 指定接手会话的模式；省略或空串时继承源会话的当前模式。
 * @returns { kind:'success'|'error', text, briefPath?, sessionId?, goalCloned?, seed?, dryRun? }
 */
export async function runHandoff(deps, options = {}) {
  const agent = options.agent
  if (!agent?.session) {
    return { kind: 'error', text: 'handoff：拿不到当前会话（命令/工具必须由会话内的 agent 调用）。' }
  }
  const state = collectHandoffState(deps, agent)

  if (state.planActive) {
    return {
      kind: 'error',
      text: 'handoff 已拒绝：当前会话处于计划模式（计划尚未批准）。请先批准计划（exit_plan_mode）或退出计划模式，再执行 /handoff —— 否则新会话会去执行一份没人批准的计划。',
    }
  }

  const now = deps.now?.() instanceof Date ? deps.now() : new Date(deps.now?.() ?? Date.now())
  // 薄交接（无 goal / 无计划 / 无 todo / 无调用方 brief）：警告同时进正文与返回值。
  const thinHandoff = isThinHandoff(state, options)
  const briefBody = typeof options.brief === 'string' && options.brief.trim()
    ? options.brief.trim()
    : renderBrief(state, { now, note: options.note, nextStep: options.nextStep, thinHandoff })

  const root = deps.home()
  const dir = joinPath(root, 'handoff', slugifyCwd(state.cwd))
  const base = `${stamp(now)}-${shortId(state.sessionId)}`
  const briefPath = joinPath(dir, `${base}.md`)
  const latestPath = joinPath(dir, 'latest.md')
  await deps.mkdir(dir)
  await deps.writeFile(briefPath, briefBody)
  await deps.writeFile(latestPath, briefBody)

  const seed = renderSeed({ briefPath, state, note: options.note })

  // 接手会话的模式：显式 preset 优先，否则继承源会话当前模式（原有行为）。
  // 两者都没有就让 createSession 走部署默认——不在这里猜。
  const requestedPreset = typeof options.preset === 'string' ? options.preset.trim() : ''
  const sourcePreset = safe(() => deps.resolvePreset?.(agent.session))
  const preset = requestedPreset !== '' ? requestedPreset : sourcePreset
  const presetLabel = preset ?? '部署默认'

  if (options.dryRun) {
    return {
      kind: 'success',
      dryRun: true,
      briefPath,
      latestPath,
      seed,
      text: [
        `[dry-run] 交接文档已写入：${briefPath}`,
        `（latest.md 同步更新）`,
        `会创建的会话：workspace=${state.cwd ?? '未知'}；模式=${presetLabel}；goal 克隆=${state.goal?.goal ? '是' : '否'}`,
        '未创建任何会话。去掉 dryRun 才真正执行。',
        ...(thinHandoff ? ['', THIN_HANDOFF_WARNING] : []),
      ].join('\n'),
    }
  }

  // 1) 新会话（同一 workspace）
  const workspaceId = findWorkspaceId(deps, state.sessionId)
  let sessionId
  let newAgent
  try {
    const created = await deps.createSession({ workspaceId, cwd: state.cwd, preset })
    sessionId = created?.sessionId
    newAgent = created?.agent          // createSession 能解析出 agent 就直接用，省一次解析
    if (!sessionId) throw new Error('createSession 未返回 sessionId')
  } catch (error) {
    return {
      kind: 'error',
      briefPath,
      text: `交接文档已写入 ${briefPath}，但新会话创建失败：${errText(error)}`,
    }
  }

  // 2) 解析新 agent（真机教训：profile 层的 ctx.agents 只有 create/get/list，
  //    resolveAgent 是 sessionController 的方法 → 由 deps 分层兜底，并给注册留出重试窗口）
  let goalCloned = false
  let goalNote = ''
  if (!newAgent) {
    try {
      newAgent = await resolveAgentWithRetry(deps, sessionId)
    } catch (error) {
      goalNote = `；但新会话 agent 未能解析（${errText(error)}），goal 未克隆、首条消息未发送`
      return { kind: 'error', briefPath, sessionId, goalCloned, text: `新会话已建（${sessionId}）${goalNote}。请手动在侧栏切过去。` }
    }
  }

  if (state.goal?.goal && state.goal.goal.phase !== 'complete') {
    try {
      await deps.goals.create(newAgent, {
        objective: state.goal.goal.objective,
        maxGoalRounds: state.goal.goal.maxGoalRounds,
      })
      goalCloned = true
    } catch (error) {
      goalNote = `；goal 克隆失败（${errText(error)}），新会话会以普通会话启动`
    }
  }

  // 3) 播种首条消息 → followup 会唤醒 driver，新会话自动开跑
  try {
    await deps.seed(newAgent, seed)
  } catch (error) {
    return {
      kind: 'error',
      briefPath,
      sessionId,
      goalCloned,
      text: `新会话已建（${sessionId}）且交接文档在 ${briefPath}，但首条消息发送失败：${errText(error)}。请在侧栏切过去后手动发一句「读 ${briefPath} 继续」。`,
    }
  }

  return {
    kind: 'success',
    briefPath,
    sessionId,
    goalCloned,
    seed,
    text: [
      `已开新会话并开始执行。`,
      `- 新会话：\`${sessionId}\``,
      `- 接手模式：${presetLabel}${requestedPreset !== '' ? '（本次显式指定）' : '（继承源会话）'}`,
      `- 交接文档：${briefPath}`,
      `- goal 克隆：${goalCloned ? '是（轮次归零、active）' : '无'}`,
      `- 下一步：在左侧会话列表点开这条新会话即可看到它在跑${goalNote}`,
      ...(thinHandoff ? ['', THIN_HANDOFF_WARNING] : []),
    ].join('\n'),
  }
}

function findWorkspaceId(deps, sessionId) {
  const list = safe(() => deps.workspaces?.()) ?? []
  for (const ws of list) {
    if (Array.isArray(ws?.sessionIds) && ws.sessionIds.includes(sessionId)) return ws.id
  }
  return undefined
}

/** 解析新会话的 live agent：新建后注册可能有极短延迟，给几次重试。 */
async function resolveAgentWithRetry(deps, sessionId, attempts = 4, delayMs = 150) {
  let lastError
  for (let i = 0; i < attempts; i += 1) {
    try {
      const found = await deps.agents.resolveAgent(sessionId)
      if (found?.error) throw found.error
      const agent = found?.agent ?? found
      if (agent) return agent
      lastError = new Error('resolveAgent 未返回 agent')
    } catch (error) {
      lastError = error
    }
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw lastError ?? new Error('无法解析新会话 agent')
}

function errText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 路径拼接（不 import node:path，保持核心可移植/可单测）。 */
function joinPath(...parts) {
  const sep = process.platform === 'win32' ? '\\' : '/'
  return parts
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep)
}

/** 交接文档路径的稳定查询（供 /handoff 的 list 之类的后续能力复用）。 */
export function handoffDir(home, cwd) {
  return joinPath(home, 'handoff', slugifyCwd(cwd))
}
