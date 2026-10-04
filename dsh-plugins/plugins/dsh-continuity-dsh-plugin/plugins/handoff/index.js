/**
 * dsh-continuity / handoff —— 任务连续性域的第一个服务（native dsh）。
 *
 * 解决的问题：一个会话上下文不再够用时，沿用「让模型总结一段文字 → 手工复制到
 * 新会话」的做法要额外一轮对话且全靠人手。本服务把它变成一次命令/工具调用：
 *
 *   /handoff [备注]            → 写交接文档 → 同 workspace 新开会话
 *                                → 克隆 goal（轮次归零）→ 播种首条消息并自动开跑
 *   handoff_start({ brief? })  → 同上，但允许模型自己写 brief（质量更好）
 *
 * 语义决定（2026-10-04 与用户确认）：
 * - 源会话处于 plan mode（计划未批准）→ 拒绝执行，避免新会话执行未批准的计划。
 * - goal 克隆后轮次归零，且不保持 paused。
 * - 上下文与 KV 缓存可以丢；交接文档默认确定性生成（命令面零 token）。
 *
 * 只读投影读取：使用 ctx.sessionProjections.stateOf()，不碰已 deprecated 的
 * eventAt / snapshotEvents / ownEvents。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { runHandoff } from './core.js'

export const name = 'tool-handoff'
/** commands 缺失（headless/ACP）也要能装：命令面用 ctx.inject 可选挂载。 */
export const inject = ['tools']

/** package.json 是版本的唯一事实源（伞仓约定）。 */
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
export const version = PKG.version

const PLUGIN_ID = 'dsh-continuity'

/** 原子写：先写临时文件再 rename，避免半截文档被新会话读到。 */
async function writeFileAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/**
 * 构造一条 plugin 来源的 user 消息。
 * `@deepseek-ai/dsh-llm` 用**动态** import：它是宿主自带包，正常一定解析得到；
 * 但万一 profile 的解析路径里没有它，插件也不该整体加载失败——退回手搓同形状消息。
 */
let createUserMessageImpl
async function makeUserMessage(text) {
  if (createUserMessageImpl === undefined) {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      createUserMessageImpl = typeof mod.createUserMessage === 'function' ? mod.createUserMessage : null
    } catch {
      createUserMessageImpl = null
    }
  }
  const input = {
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_ID },
  }
  if (createUserMessageImpl) return createUserMessageImpl(input)
  return { id: randomUUID(), role: 'user', content: input.content, source: input.source }
}

/** 把 cordis ctx 适配成 core 需要的能力集合（缺服务时报可读错误，而不是 undefined 崩）。 */
function buildDeps(ctx) {
  const requireService = (key) => {
    const svc = ctx.get(key)
    if (svc === undefined) {
      throw new Error(`handoff 需要 ${key} 服务，但当前 profile 没有挂载它（profile 组合问题，不是用法问题）。`)
    }
    return svc
  }
  return {
    stateOf: (session, key) => requireService('sessionProjections').stateOf(session, key),
    planMode: { get: (agent) => ctx.get('planMode')?.get(agent) },
    goals: { create: (agent, request) => requireService('goals').create(agent, request) },
    agents: {
      resolveAgent: (sessionId) => requireService('agents').resolveAgent(sessionId),
      presetForSession: (session) => ctx.get('agents')?.presetForSession?.(session),
    },
    workspaces: () => ctx.get('workspaceRegistry')?.list() ?? [],
    createSession: async ({ workspaceId, cwd, preset }) => {
      const controller = ctx.get('sessionController')
      if (typeof controller?.create === 'function') {
        // 与浏览器「新建会话」走同一条链：preset 组合、持久化、workspace 挂载都由它负责。
        const request = workspaceId !== undefined ? { workspaceId } : { cwd }
        if (preset !== undefined) request.agentPreset = preset
        return await controller.create(request)
      }
      const agents = requireService('agents')
      if (typeof agents.ensureSession !== 'function') {
        throw new Error('handoff 既没有 sessionController.create，也没有 agents.ensureSession；无法新建会话。')
      }
      const sessionId = `session-${randomUUID()}`
      const agent = await agents.ensureSession(sessionId, cwd, false, preset)
      return { sessionId: agent?.session?.id ?? sessionId }
    },
    home: () => process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    now: () => new Date(),
    mkdir: async (dir) => { await mkdir(dir, { recursive: true }) },
    writeFile: writeFileAtomic,
    seed: async (agent, text) => {
      agent.followup(await makeUserMessage(text))
    },
  }
}

/** 命令面：/handoff [--dry-run] [备注] */
function parseCommandLine(rawInput) {
  let rest = String(rawInput ?? '').trim()
  let dryRun = false
  if (/^--dry-run\b/.test(rest) || /^--dryrun\b/.test(rest)) {
    dryRun = true
    rest = rest.replace(/^--dry-?run\b/, '').trim()
  }
  return { dryRun, note: rest || undefined }
}

export function apply(ctx) {
  ctx.logger?.info?.(`${PLUGIN_ID}: handoff v${version} loaded (native dsh)`)

  ctx.tools.register(defineTool({
    name: 'handoff_start',
    description:
      '把当前会话的任务状态（goal / 计划 / todo / 最近进展）落成一份交接文档，并在同一工作区新开一个会话、'
      + '把首条消息播种进去让它自动继续跑。默认交接文档是确定性生成的（不调用模型）；'
      + '你也可以用 brief 参数自己写一份更好的交接文档。dryRun=true 只写文档、不建会话。'
      + '当前会话处于计划模式（计划未批准）时会被拒绝。'
      + `交接文档写入 %DSH_HOME%\\handoff\\<workspace>\\。`,
    parameters: {
      brief: { type: 'string', description: '（可选）由你写好的交接文档全文，替换确定性生成的那份。建议包含：目标/已完成/在途/下一步/关键决策/文件清单/未决问题。' },
      nextStep: { type: 'string', description: '（可选）「下一步」一行的内容，写进确定性生成的文档里。' },
      note: { type: 'string', description: '（可选）给接手会话的交接备注（会写进文档并内联在首条消息里）。' },
      dryRun: { type: 'boolean', description: '（可选）true = 只写交接文档、不创建会话。用于先看一眼交接内容。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          briefPath: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          sessionId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          goalCloned: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined) {
        throw new Error('handoff_start: 当前工具调用没有绑定会话（exec.agent 缺失）')
      }
      const deps = buildDeps(ctx)
      const result = await runHandoff(deps, {
        agent,
        brief: typeof args.brief === 'string' ? args.brief : undefined,
        nextStep: typeof args.nextStep === 'string' ? args.nextStep : undefined,
        note: typeof args.note === 'string' ? args.note : undefined,
        dryRun: args.dryRun === true,
      })
      return {
        ok: result.kind === 'success',
        dryRun: result.dryRun === true,
        briefPath: result.briefPath ?? null,
        sessionId: result.sessionId ?? null,
        goalCloned: result.goalCloned === true,
        summary: result.text,
      }
    },
  }))

  // 命令面可选挂载：headless / ACP 没有命令平面，但工具仍然可用。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'handoff',
      description: '把当前任务交接给一个新会话并让它自动继续（上下文重置，交接文档落盘）',
      input: { hint: '[--dry-run] [备注]' },
      handler: async ({ agent, rawInput }) => {
        if (!agent?.session) return { kind: 'error', text: 'handoff：没有收到当前会话。' }
        const { dryRun, note } = parseCommandLine(rawInput)
        try {
          const result = await runHandoff(buildDeps(ctx), { agent, note, dryRun })
          return { kind: result.kind, text: result.text }
        } catch (error) {
          return { kind: 'error', text: `handoff 失败：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    })
  })
}
