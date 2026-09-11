import * as vscode from 'vscode'
import {
  DEFAULT_PRICING,
  type ModelPricing,
  type PricePeriod,
  type PriceTier,
  type PricingTable,
} from './pricing.ts'

// 纯计算层（默认价格表/时段判定/取价/费用折算）在 pricing.ts；这里连同默认价格表一起转出，
// 保持既有 import 路径（`./config.ts`）不变。
export {
  beijingClock,
  beijingStamp,
  computeCostCny,
  DEFAULT_PRICING,
  DEEPSEEK_PEAK_WINDOWS,
  isDeepSeekPeakHour,
  pricingAt,
  pricingPeriodAt,
} from './pricing.ts'
export type { ModelPricing, PricePeriod, PriceTier, PricingTable } from './pricing.ts'

const SERVER_URL = 'dsh.serverUrl'
const AUTO_CONNECT = 'dsh.autoConnect'
const AUTO_ATTACH_WORKSPACE = 'dsh.autoAttachWorkspace'
const DEFAULT_AGENT_PRESET = 'dsh.defaultAgentPreset'
const HISTORY_PAGE_SIZE = 'dsh.historyPageSize'
const RECONNECT_INTERVAL = 'dsh.reconnectIntervalMs'
const AUTO_OPEN_CHAT = 'dsh.autoOpenChat'
const SHOW_REASONING = 'dsh.showReasoning'
const MAX_TOOL_RESULT_CHARS = 'dsh.maxToolResultChars'
const EXTRA_HEADERS = 'dsh.extraHeaders'
const REMOTE = 'dsh.remote'
const TOKEN = 'dsh.token'
const LOCAL_SERVER_PATH = 'dsh.localServerPath'
const PROMPT_MODE = 'dsh.promptMode'
const PRICING = 'dsh.pricing'
const LAUNCH_TOKEN_FOLLOW = 'dsh.launchTokenFollow'

export type PromptMode = 'steer' | 'queue'

export interface DshConfig {
  serverUrl: string
  autoConnect: boolean
  autoAttachWorkspace: boolean
  defaultAgentPreset: string
  historyPageSize: number
  reconnectIntervalMs: number
  autoOpenChat: boolean
  showReasoning: boolean
  maxToolResultChars: number
  /** 附加到每个 /api 请求与 remote.mux WebSocket 握手头的自定义请求头。 */
  extraHeaders: Record<string, string>
  /** Remote 模式开关：true = 直连远程 DSH（配 token 认证），false = 本地模式（可拉起本地 dsh web）。 */
  remote: boolean
  /** DSH 进程启动 token（`dsh web` 打印的 `?token=` 值）。扩展用它换取浏览器会话 cookie，
   * 认证所有 /api 与 remote.mux 请求。 */
  token: string
  /** Local 模式下 dsh 安装/启动目录；配置后扩展可自动拉起 `dsh web`（cwd=该路径）并连接。 */
  localServerPath: string
  /** Local 模式 + dsh.token 为空时，跟随共享 launch-token.json 认证（默认开，可关）。 */
  launchTokenFollow: boolean
  /** 发送消息的模式：'steer' = 插话（立即处理，默认，与 DSH Web 一致），'queue' = 排队（等当前回合结束）。 */
  promptMode: PromptMode
  /** 按模型 id 的每百万 token 单价历史（¥，用于用量栏费用估算）。 */
  pricing: PricingTable
}

function key(full: string): string {
  return full.replace('dsh.', '')
}

export function readConfig(): DshConfig {
  const config = vscode.workspace.getConfiguration('dsh')
  const token = config.get<string>(key(TOKEN), '')
  return {
    serverUrl: config.get<string>(key(SERVER_URL), 'http://127.0.0.1:3080'),
    autoConnect: config.get<boolean>(key(AUTO_CONNECT), true),
    autoAttachWorkspace: config.get<boolean>(key(AUTO_ATTACH_WORKSPACE), true),
    defaultAgentPreset: config.get<string>(key(DEFAULT_AGENT_PRESET), 'standard'),
    historyPageSize: config.get<number>(key(HISTORY_PAGE_SIZE), 40),
    reconnectIntervalMs: config.get<number>(key(RECONNECT_INTERVAL), 3000),
    autoOpenChat: config.get<boolean>(key(AUTO_OPEN_CHAT), true),
    showReasoning: config.get<boolean>(key(SHOW_REASONING), true),
    maxToolResultChars: config.get<number>(key(MAX_TOOL_RESULT_CHARS), 4000),
    extraHeaders: readExtraHeaders(config),
    remote: config.get<boolean>(key(REMOTE), false),
    token,
    localServerPath: config.get<string>(key(LOCAL_SERVER_PATH), ''),
    launchTokenFollow: config.get<boolean>(key(LAUNCH_TOKEN_FOLLOW), true),
    promptMode: readPromptMode(config),
    pricing: readPricing(config),
  }
}

function readPromptMode(config: vscode.WorkspaceConfiguration): PromptMode {
  const value = config.get<string>(key(PROMPT_MODE), 'steer')
  return value === 'queue' ? 'queue' : 'steer'
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 读一档单价；三项缺一不可，否则整档丢弃。 */
function readTier(raw: unknown): PriceTier | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const e = raw as Record<string, unknown>
  const input = finiteNumber(e.input)
  const cacheHit = finiteNumber(e.cacheHit)
  const output = finiteNumber(e.output)
  if (input === undefined || cacheHit === undefined || output === undefined) return undefined
  return { input, cacheHit, output }
}

/**
 * 读取价格表：与默认表合并（用户覆盖某个模型时整段替换该模型的价目历史）。
 * 支持两种写法：
 *   1) 分段写法（推荐）：`{ "<model>": [{ effectiveFrom, peak, offPeak }] }`，可表达官方调价历史与峰谷时段
 *      （高峰 = 北京时间周一至周五 9-12、14-18，其余含周末为空闲）；
 *   2) 扁平写法（旧版兼容）：`{ "<model>": { input, cacheHit, output, offPeak? } }`，
 *      视为一段无生效期的价目，峰档取顶层三项、闲档取 offPeak。
 */
function readPricing(config: vscode.WorkspaceConfiguration): PricingTable {
  const raw = config.get<Record<string, unknown>>(key(PRICING), {})
  const out: PricingTable = { ...DEFAULT_PRICING }
  for (const [modelId, entry] of Object.entries(raw)) {
    const periods = Array.isArray(entry) ? readPeriods(entry) : readLegacyPeriod(entry)
    if (periods === undefined || periods.length === 0) continue
    out[modelId] = periods
  }
  return out
}

function readPeriods(entries: unknown[]): ModelPricing | undefined {
  const periods: ModelPricing = []
  for (const entry of entries) {
    const peak = readTier(entry)
    if (peak === undefined) continue
    const e = entry as Record<string, unknown>
    const offPeak = e.offPeak === undefined ? undefined : readTier(e.offPeak)
    if (e.offPeak !== undefined && offPeak === undefined) continue
    const effectiveFrom = typeof e.effectiveFrom === 'string' && e.effectiveFrom.length > 0 ? e.effectiveFrom : undefined
    const period: PricePeriod = { input: peak.input, cacheHit: peak.cacheHit, output: peak.output }
    if (effectiveFrom !== undefined) period.effectiveFrom = effectiveFrom
    period.peak = peak
    if (offPeak !== undefined) period.offPeak = offPeak
    periods.push(period)
  }
  return periods.length > 0 ? periods : undefined
}

function readLegacyPeriod(entry: unknown): ModelPricing | undefined {
  const peak = readTier(entry)
  if (peak === undefined) return undefined
  const offPeak = readTier((entry as Record<string, unknown>).offPeak)
  const period: PricePeriod = { input: peak.input, cacheHit: peak.cacheHit, output: peak.output, peak }
  if (offPeak !== undefined) period.offPeak = offPeak
  return [period]
}

function readExtraHeaders(config: vscode.WorkspaceConfiguration): Record<string, string> {
  const raw = config.get<Record<string, string>>(key(EXTRA_HEADERS), {})
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0 && name.trim().length > 0) {
      out[name.trim()] = value
    }
  }
  return out
}

export function onConfigChanged(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('dsh')) listener()
  })
}

/** The DSH web GUI URL for a session (the same origin as the API). */
export function sessionWebUrl(serverUrl: string, sessionId: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/session/${encodeURIComponent(sessionId)}`
}
