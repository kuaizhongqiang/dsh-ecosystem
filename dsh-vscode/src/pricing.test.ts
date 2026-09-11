/**
 * 费用估算纯计算层的单测：峰谷时段（含工作日约束）、按生效期取价（2026-08-17 峰谷定价、
 * 2026-09-10 12:00 V4.1 Flash 降价）、模型别名回落、费用折算与官方默认价格表口径。
 *
 * 时段断言都用「北京墙上时间」构造：`bj(y, m, d, h)` 从北京时间反推 UTC，避免依赖 CI 时区。
 */

import { describe, expect, it } from 'vitest'
import {
  beijingStamp,
  computeCostCny,
  DEFAULT_PRICING,
  DEEPSEEK_PEAK_WINDOWS,
  isDeepSeekPeakHour,
  pricingAt,
  pricingPeriodAt,
  type PricingTable,
} from './pricing.ts'

/** 北京时间某一时刻对应的 Date（北京 = UTC+8，无夏令时）。 */
function bj(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute))
}

describe('isDeepSeekPeakHour', () => {
  it('treats weekday 9-12 and 14-18 Beijing as peak', () => {
    // 2026-09-11 是周五。
    expect(isDeepSeekPeakHour(bj(2026, 9, 11, 8, 59))).toBe(false)
    expect(isDeepSeekPeakHour(bj(2026, 9, 11, 9, 0))).toBe(true)
    expect(isDeepSeekPeakHour(bj(2026, 9, 11, 11, 59))).toBe(true)
    expect(isDeepSeekPeakHour(bj(2026, 9, 11, 12, 0))).toBe(false)
    expect(isDeepSeekPeakHour(bj(2026, 9, 11, 13, 59))).toBe(false)
    expect(isDeepSeekPeakHour(bj(2026, 9, 11, 14, 0))).toBe(true)
    expect(isDeepSeekPeakHour(bj(2026, 9, 11, 17, 59))).toBe(true)
    expect(isDeepSeekPeakHour(bj(2026, 9, 11, 18, 0))).toBe(false)
    expect(isDeepSeekPeakHour(bj(2026, 9, 11, 23, 30))).toBe(false)
  })

  it('treats all weekend hours as off-peak (official: everything outside weekday windows)', () => {
    // 2026-09-12 周六 / 2026-09-13 周日 的 10:00 与 15:00 均在高峰窗口内，但周末应为空闲。
    for (const day of [12, 13]) {
      expect(isDeepSeekPeakHour(bj(2026, 9, day, 10))).toBe(false)
      expect(isDeepSeekPeakHour(bj(2026, 9, day, 15))).toBe(false)
      expect(isDeepSeekPeakHour(bj(2026, 9, day, 9))).toBe(false)
    }
  })

  it('exposes the two weekday peak windows', () => {
    expect(DEEPSEEK_PEAK_WINDOWS).toEqual([[9, 12], [14, 18]])
  })
})

describe('beijingStamp', () => {
  it('renders the Beijing wall clock', () => {
    expect(beijingStamp(bj(2026, 9, 10, 12, 30))).toBe('2026-09-10 12:30')
    // UTC 2026-09-10 04:07 → 北京时间 12:07（同日，不跨日）。
    expect(beijingStamp(new Date(Date.UTC(2026, 8, 10, 4, 7)))).toBe('2026-09-10 12:07')
    // UTC 2026-09-09 17:30 → 北京时间 2026-09-10 01:30（跨日）。
    expect(beijingStamp(new Date(Date.UTC(2026, 8, 9, 17, 30)))).toBe('2026-09-10 01:30')
  })
})

describe('pricingPeriodAt', () => {
  const periods = DEFAULT_PRICING['deepseek-v4-flash']!

  it('picks the newest period whose effectiveFrom has passed', () => {
    expect(pricingPeriodAt(periods, bj(2026, 8, 16, 23, 59))).toBeUndefined()
    expect(pricingPeriodAt(periods, bj(2026, 8, 17, 0, 0))?.peak?.input).toBe(3)
    expect(pricingPeriodAt(periods, bj(2026, 9, 10, 11, 59))?.peak?.input).toBe(3)
    expect(pricingPeriodAt(periods, bj(2026, 9, 10, 12, 0))?.peak?.input).toBe(2)
    expect(pricingPeriodAt(periods, bj(2026, 9, 11, 15, 0))?.peak?.output).toBe(8)
  })

  it('falls back to the period without effectiveFrom when nothing has passed', () => {
    const table: PricingTable = { 'x': [{ input: 1, cacheHit: 0.1, output: 2 }] }
    expect(pricingPeriodAt(table['x']!, bj(2020, 1, 1, 10))?.input).toBe(1)
  })
})

describe('pricingAt', () => {
  it('selects peak vs off-peak by the given instant, not by now', () => {
    // 周五高峰（9:00-12:00）→ 峰价。
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-flash', bj(2026, 9, 11, 10))?.input).toBe(2)
    // 周五午休（12:00-14:00）→ 闲价。
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-flash', bj(2026, 9, 11, 13))?.input).toBe(1)
    // 周六 10:00 → 闲价（修复点：旧实现按峰价算）。
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-flash', bj(2026, 9, 12, 10))?.input).toBe(1)
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-flash', bj(2026, 9, 12, 10))?.cacheHit).toBe(0.02)
  })

  it('keeps the pre-2026-09-10 V4-Flash prices for sessions billed then', () => {
    // 2026-09-10 是周四。11:59 在高峰窗口内（9-12）：旧价 3 / 0.1 / 9。
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-v4-flash', bj(2026, 9, 10, 11, 59))).toEqual({ input: 3, cacheHit: 0.1, output: 9 })
    // 9/10 12:00 整点调价生效，同时落进午休空闲时段：新闲价 1 / 0.02 / 4。
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-v4-flash', bj(2026, 9, 10, 12, 0))).toEqual({ input: 1, cacheHit: 0.02, output: 4 })
    // 当天下午高峰（14:00-18:00）：新峰价 2 / 0.04 / 8。
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-v4-flash', bj(2026, 9, 10, 15, 0))).toEqual({ input: 2, cacheHit: 0.04, output: 8 })
  })

  it('prices the retired V4-Flash / vision-exp names at V4.1 Flash rates after 2026-09-10 12:00', () => {
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-v4-flash-vision-exp', bj(2026, 9, 11, 10))?.input).toBe(2)
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-v4-flash-vision-exp', bj(2026, 9, 11, 13))?.input).toBe(1)
  })

  it('keeps deepseek-v4-pro at its own rates (2026-09-14 routing change not encoded yet)', () => {
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-v4-pro', bj(2026, 9, 11, 10))).toEqual({ input: 9, cacheHit: 0.3, output: 27 })
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-v4-pro', bj(2026, 9, 11, 13))).toEqual({ input: 4.5, cacheHit: 0.15, output: 13.5 })
  })

  it('falls back to the longest matching prefix for unknown aliases', () => {
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-flash-preview', bj(2026, 9, 11, 10))?.input).toBe(2)
    expect(pricingAt(DEFAULT_PRICING, 'deepseek-v4-flash-latest', bj(2026, 9, 11, 10))?.input).toBe(2)
  })

  it('returns undefined for unknown models, empty tables and empty ids', () => {
    expect(pricingAt(DEFAULT_PRICING, 'gpt-5')).toBeUndefined()
    expect(pricingAt({}, 'deepseek-flash')).toBeUndefined()
    expect(pricingAt(undefined, 'deepseek-flash')).toBeUndefined()
    expect(pricingAt(DEFAULT_PRICING, '')).toBeUndefined()
  })

  it('uses a flat (no offPeak) model price at every hour', () => {
    const at = bj(2026, 9, 11, 10)
    expect(pricingAt(DEFAULT_PRICING, 'mimo-v2.5', at)).toEqual({ input: 1, cacheHit: 0.02, output: 2 })
    expect(pricingAt(DEFAULT_PRICING, 'mimo-v2.5', bj(2026, 9, 12, 10))).toEqual({ input: 1, cacheHit: 0.02, output: 2 })
  })
})

describe('会话基准时点口径（chatPanel 约定：整段按会话最早事件的价档计）', () => {
  // 真实会话示例：开始于 2026-09-09 20:55（北京，空闲时段，早于 9/10 12:00 调价）。
  const sessionStart = bj(2026, 9, 9, 20, 55)
  const totals = { uncachedInput: 40_587, cacheRead: 737_024, cacheWrite: 0, output: 28_403 }

  it('bills a session that started before the 2026-09-10 12:00 change at the old off-peak rates', () => {
    const price = pricingAt(DEFAULT_PRICING, 'deepseek-v4-flash', sessionStart)
    expect(price).toEqual({ input: 1.5, cacheHit: 0.05, output: 4.5 })
    // 40.587k×1.5 + 737.024k×0.05 + 28.403k×4.5（每百万单价）≈ 0.2255
    expect(computeCostCny(totals, price!)).toBeCloseTo(0.2255, 3)
  })

  it('no longer re-prices the same session by the moment the panel is opened', () => {
    const baseline = pricingAt(DEFAULT_PRICING, 'deepseek-v4-flash', sessionStart)!
    expect(computeCostCny(totals, baseline)).toBeCloseTo(0.2255, 3)
    // 旧实现 = “当刻取档 + 该模型的单档旧价”，在次日高峰打开面板会把整段按 3 / 0.1 / 9 重算（约翻倍）。
    const oldEntry = { input: 3, cacheHit: 0.1, output: 9 }
    expect(computeCostCny(totals, oldEntry)).toBeCloseTo(0.4511, 3)
  })
})

describe('computeCostCny', () => {
  it('sums uncached input + cache writes at input price, cache reads at cacheHit price, output at output price', () => {
    const cost = computeCostCny(
      { uncachedInput: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 },
      { input: 2, cacheHit: 0.04, output: 8 },
    )
    expect(cost).toBeCloseTo(2 + 0.04 + 2 + 8, 10)
  })

  it('prices a realistic agent turn', () => {
    // 30k 未命中输入 + 200k 缓存读 + 0 缓存写 + 5k 输出，峰价 2 / 0.04 / 8。
    const cost = computeCostCny(
      { uncachedInput: 30_000, cacheRead: 200_000, cacheWrite: 0, output: 5_000 },
      { input: 2, cacheHit: 0.04, output: 8 },
    )
    // 0.06 + 0.008 + 0.04 = 0.108
    expect(cost).toBeCloseTo(0.108, 10)
  })

  it('is zero for zero tokens', () => {
    expect(computeCostCny({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, { input: 9, cacheHit: 0.3, output: 27 })).toBe(0)
  })
})

describe('DEFAULT_PRICING', () => {
  it('covers the model ids the bundled DSH selects by default', () => {
    // ~/.dsh/settings.yaml 与本仓库 base bundle 的默认模型：deepseek-flash（旧名 deepseek-v4-flash）。
    expect(DEFAULT_PRICING['deepseek-flash']).toBeDefined()
    expect(DEFAULT_PRICING['deepseek-v4-flash']).toBeDefined()
    expect(DEFAULT_PRICING['deepseek-v4-pro']).toBeDefined()
    expect(DEFAULT_PRICING['mimo-v2.5']).toBeDefined()
    expect(DEFAULT_PRICING['mimo-v2.5-pro']).toBeDefined()
  })

  it('keeps off-peak exactly half of peak for every DeepSeek period', () => {
    for (const [modelId, periods] of Object.entries(DEFAULT_PRICING)) {
      if (!modelId.startsWith('deepseek')) continue
      for (const period of periods) {
        expect(period.peak, `${modelId}@${period.effectiveFrom} 缺 peak`).toBeDefined()
        expect(period.offPeak, `${modelId}@${period.effectiveFrom} 缺 offPeak`).toBeDefined()
        expect(period.offPeak!.input).toBeCloseTo(period.peak!.input / 2, 10)
        expect(period.offPeak!.cacheHit).toBeCloseTo(period.peak!.cacheHit / 2, 10)
        expect(period.offPeak!.output).toBeCloseTo(period.peak!.output / 2, 10)
      }
    }
  })
})
