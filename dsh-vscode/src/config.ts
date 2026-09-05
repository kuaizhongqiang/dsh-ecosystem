import * as vscode from 'vscode'

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

/**
 * 每百万 tokens 单价（人民币 ¥）。DeepSeek 官方 2026-08-17 起采用峰谷定价：
 * 高峰时段为北京时间 9:00-12:00、14:00-18:00，其余为空闲时段（offPeak 为峰价一半）。
 * 小米 MiMo 为固定价。价格随官方调整，用户可在 dsh.pricing 设置里覆盖。
 */
export interface ModelPrice {
  /** 输入（缓存未命中）¥/1M tokens。 */
  input: number
  /** 输入（缓存命中）¥/1M tokens。 */
  cacheHit: number
  /** 输出 ¥/1M tokens。 */
  output: number
  /** 空闲时段价格（DeepSeek 峰谷定价；缺省表示无峰谷）。 */
  offPeak?: { input: number; cacheHit: number; output: number }
}

export type PricingTable = Record<string, ModelPrice>

export const DEFAULT_PRICING: PricingTable = {
  'deepseek-v4-flash': {
    input: 3.0, cacheHit: 0.1, output: 9.0,
    offPeak: { input: 1.5, cacheHit: 0.05, output: 4.5 },
  },
  'deepseek-v4-pro': {
    input: 9.0, cacheHit: 0.3, output: 27.0,
    offPeak: { input: 4.5, cacheHit: 0.15, output: 13.5 },
  },
  'mimo-v2.5': { input: 1.0, cacheHit: 0.02, output: 2.0 },
  'mimo-v2.5-pro': { input: 3.0, cacheHit: 0.025, output: 6.0 },
}

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
  /** 按模型 id 的每百万 token 单价表（¥，用于用量栏费用估算）。 */
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

/** 读取价格表：与默认表浅合并（用户覆盖某个模型或某档价格时保留其余默认值）。 */
function readPricing(config: vscode.WorkspaceConfiguration): PricingTable {
  const raw = config.get<Record<string, unknown>>(key(PRICING), {})
  const out: PricingTable = { ...DEFAULT_PRICING }
  for (const [modelId, entry] of Object.entries(raw)) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const input = num(e.input)
    const cacheHit = num(e.cacheHit)
    const output = num(e.output)
    if (input === undefined || cacheHit === undefined || output === undefined) continue
    const price: ModelPrice = { input, cacheHit, output }
    const off = e.offPeak
    if (typeof off === 'object' && off !== null) {
      const oi = num((off as Record<string, unknown>).input)
      const oh = num((off as Record<string, unknown>).cacheHit)
      const oo = num((off as Record<string, unknown>).output)
      if (oi !== undefined && oh !== undefined && oo !== undefined) price.offPeak = { input: oi, cacheHit: oh, output: oo }
    }
    out[modelId] = price
  }
  return out
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
  const base = serverUrl.replace(/\/+$/, '')
  return `${base}/session/${encodeURIComponent(sessionId)}`
}

/** 是否处于 DeepSeek 高峰时段（北京时间 9:00-12:00、14:00-18:00）。 */
export function isDeepSeekPeakHour(now: Date = new Date()): boolean {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000)
  const h = bj.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/** 按某模型单价估算费用（¥）。tokens 为累计 token 数；DeepSeek 峰谷价按当前北京时间取档。 */
export function computeCostCny(
  tokens: { uncachedInput: number; cacheRead: number; cacheWrite: number; output: number },
  price: ModelPrice,
): number {
  const p = price.offPeak !== undefined && !isDeepSeekPeakHour() ? price.offPeak : price
  return (
    (tokens.uncachedInput / 1e6) * p.input +
    (tokens.cacheWrite / 1e6) * p.input +
    (tokens.cacheRead / 1e6) * p.cacheHit +
    (tokens.output / 1e6) * p.output
  )
}
