/**
 * 用量费用的纯计算层：单价结构、官方峰谷时段判定、按生效期取价、费用折算。
 *
 * 刻意不 import `vscode`：整层可在 node 环境直接单测（见 pricing.test.ts），
 * 配置读取（`config.ts`）与计费调用点（`chatPanel.ts`）只做数据与接线。
 */

/** 一档单价（每百万 tokens，人民币 ¥）。 */
export interface PriceTier {
  /** 输入（缓存未命中）¥/1M tokens。 */
  input: number
  /** 输入（缓存命中）¥/1M tokens。 */
  cacheHit: number
  /** 输出 ¥/1M tokens。 */
  output: number
}

/**
 * 一个生效期内的价目：`effectiveFrom`（北京时间，'YYYY-MM-DD HH:mm'，含）起生效。
 *
 * 三种写法都合法：
 *   - 只有 `peak`/`offPeak`（DeepSeek 官方价，顶层三项省略）；
 *   - 只有顶层扁平三项（无峰谷的固定价，如小米 MiMo）；
 *   - 两者都给（顶层三项兼作无峰谷时的兜底，见 `readPricing` 的旧写法兼容）。
 */
export interface PricePeriod extends Partial<PriceTier> {
  /**
   * 生效时点（北京时间，'YYYY-MM-DD HH:mm'）。缺省 = 该模型最早一段，永远兜底。
   * 同一模型的多段按此串比较（ISO 形态，字典序即时序）。
   */
  effectiveFrom?: string
  /** 高峰时段价。缺省 = 无峰谷，全时段按顶层 input/cacheHit/output 计。 */
  peak?: PriceTier
  /** 空闲时段价。给出即启用峰谷定价（闲时 = 峰价的一半，官方口径）。 */
  offPeak?: PriceTier
}

/** 一个模型的价目历史：按生效期排列的分段；空数组 = 无价不估算。 */
export type ModelPricing = PricePeriod[]

export type PricingTable = Record<string, ModelPricing>

/**
 * 官方价格表默认值（每百万 tokens，人民币 ¥）。DeepSeek 自 2026-08-17 00:00 起采用峰谷定价：
 * 高峰时段为北京时间**周一至周五** 9:00-12:00、14:00-18:00，其余（含周末全天）为空闲时段，
 * 闲时价格为高峰时段价格的一半。2026-09-10 12:00 起 V4.1 Flash 上线（模型名 `deepseek-flash`），
 * V4-Flash / V4-Flash-Vision-Exp 下线，但旧名仍路由到 V4.1 Flash 并按 Flash 价计费。
 * 小米 MiMo 为固定价（无峰谷）。用户可用 `dsh.pricing` 整段覆盖某个模型（见 config.ts readPricing）。
 *
 * 2026-09-14 12:00 起官方计划把 `deepseek-v4-pro` 全部路由到 V4.1 Flash 并按 Flash 价计费；
 * 该时点尚未到达，到点后在此表 `deepseek-v4-pro` 追加一段（与 `deepseek-flash` 同价）即可，
 * 取价逻辑无需改动。
 */
export const DEFAULT_PRICING: PricingTable = {
  // V4.1 Flash（`deepseek-flash`）：2026-09-10 12:00 起 2 / 0.04 / 8。
  'deepseek-flash': [
    { effectiveFrom: '2026-09-10 12:00', peak: { input: 2, cacheHit: 0.04, output: 8 }, offPeak: { input: 1, cacheHit: 0.02, output: 4 } },
  ],
  // 旧模型名：V4-Flash 与 V4-Flash-Vision-Exp 已下线，请求按公告路由到 V4.1 Flash 并按 Flash 价计费。
  'deepseek-v4-flash': [
    { effectiveFrom: '2026-08-17 00:00', peak: { input: 3, cacheHit: 0.1, output: 9 }, offPeak: { input: 1.5, cacheHit: 0.05, output: 4.5 } },
    { effectiveFrom: '2026-09-10 12:00', peak: { input: 2, cacheHit: 0.04, output: 8 }, offPeak: { input: 1, cacheHit: 0.02, output: 4 } },
  ],
  'deepseek-v4-flash-vision-exp': [
    { effectiveFrom: '2026-08-21 00:00', peak: { input: 3, cacheHit: 0.1, output: 9 }, offPeak: { input: 1.5, cacheHit: 0.05, output: 4.5 } },
    { effectiveFrom: '2026-09-10 12:00', peak: { input: 2, cacheHit: 0.04, output: 8 }, offPeak: { input: 1, cacheHit: 0.02, output: 4 } },
  ],
  // V4-Pro：2026-08-17 起 9 / 0.3 / 27，至今未变（9/14 12:00 的路由变更到点再补一段）。
  'deepseek-v4-pro': [
    { effectiveFrom: '2026-08-17 00:00', peak: { input: 9, cacheHit: 0.3, output: 27 }, offPeak: { input: 4.5, cacheHit: 0.15, output: 13.5 } },
  ],
  'mimo-v2.5': [{ input: 1.0, cacheHit: 0.02, output: 2.0 }],
  'mimo-v2.5-pro': [{ input: 3.0, cacheHit: 0.025, output: 6.0 }],
}

/** 官方峰谷时段（北京时间，整点闭开区间，仅周一至周五）。 */
export const DEEPSEEK_PEAK_WINDOWS: readonly (readonly [number, number])[] = [[9, 12], [14, 18]]

/** 挂钟北京时间：UTC 加 8 小时，用 getUTC* 读取即为北京时间的年月日与星期。 */
export function beijingClock(now: Date = new Date()): Date {
  return new Date(now.getTime() + 8 * 3600 * 1000)
}

/** 北京时间 'YYYY-MM-DD HH:mm'；用于价目生效期比较（ISO 形态可直接字典序比）。 */
export function beijingStamp(now: Date = new Date()): string {
  const bj = beijingClock(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`
}

/**
 * 是否处于 DeepSeek 高峰时段：北京时间**周一至周五** 9:00-12:00、14:00-18:00。
 * 周末（周六、周日）全天为空闲时段——官方口径“其余为空闲时段”。
 */
export function isDeepSeekPeakHour(now: Date = new Date()): boolean {
  const bj = beijingClock(now)
  const day = bj.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = bj.getUTCHours()
  return DEEPSEEK_PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to)
}

/**
 * 取某模型在 `at`（默认现在）时点生效的价目段：
 * 多段时取 `effectiveFrom <= at` 中最晚的一段；无生效期或缺省的那段作为最早兜底。
 */
export function pricingPeriodAt(periods: ModelPricing, at: Date = new Date()): PricePeriod | undefined {
  if (periods.length === 0) return undefined
  const want = beijingStamp(at)
  let best: PricePeriod | undefined
  let fallback: PricePeriod | undefined
  for (const period of periods) {
    if (period.effectiveFrom === undefined) {
      if (fallback === undefined) fallback = period
      continue
    }
    if (period.effectiveFrom <= want && (best === undefined || period.effectiveFrom > (best.effectiveFrom ?? ''))) {
      best = period
    }
  }
  return best ?? fallback
}

/**
 * 某模型 id 在 `at` 时点生效的单价档（含峰/闲选档）。
 * 先精确匹配，再按前缀匹配别名（如 `deepseek-flash-preview` → `deepseek-flash`，取最长匹配键）。
 */
export function pricingAt(
  table: PricingTable | undefined,
  modelId: string,
  at: Date = new Date(),
): PriceTier | undefined {
  if (table === undefined || modelId.length === 0) return undefined
  let periods = table[modelId]
  if (periods === undefined) {
    let bestKey = ''
    for (const [key, value] of Object.entries(table)) {
      if (key.length > bestKey.length && modelId.startsWith(key)) {
        bestKey = key
        periods = value
      }
    }
  }
  if (periods === undefined) return undefined
  const period = pricingPeriodAt(periods, at)
  if (period === undefined) return undefined
  if (period.offPeak !== undefined && !isDeepSeekPeakHour(at)) return period.offPeak
  return period.peak ?? flatTier(period)
}

/** 分段的顶层扁平三项齐备时作为兜底档；缺项（只给了 peak/offPeak）返回 undefined。 */
function flatTier(period: PricePeriod): PriceTier | undefined {
  if (period.input === undefined || period.cacheHit === undefined || period.output === undefined) return undefined
  return { input: period.input, cacheHit: period.cacheHit, output: period.output }
}

/**
 * 按某单价档估算费用（¥）。`tokens` 为累计 token 数。
 * 缓存写入按“缓存未命中输入价”计（官方只区分命中/未命中两档输入价）。
 */
export function computeCostCny(
  tokens: { uncachedInput: number; cacheRead: number; cacheWrite: number; output: number },
  price: PriceTier,
): number {
  return (
    (tokens.uncachedInput / 1e6) * price.input +
    (tokens.cacheWrite / 1e6) * price.input +
    (tokens.cacheRead / 1e6) * price.cacheHit +
    (tokens.output / 1e6) * price.output
  )
}
