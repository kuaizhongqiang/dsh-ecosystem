/**
 * A-share stock analysis tools for the native dsh web profile:
 * `stock_quote`, `stock_kline`, `stock_indicators`, `stock_market_overview`,
 * `watchlist_add`, `watchlist_remove`, `watchlist_list`,
 * `stock_daily_collect`, and `stock_report`.
 *
 * Data comes exclusively from Tencent's public quote endpoints (no API key):
 * - real-time quotes:  `https://qt.gtimg.cn/q=<symbol>`  (GBK-encoded)
 * - daily K-line (前复权): `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get`
 *
 * The main conversation model stays text-only: these tools fetch and compute
 * numbers, the model reads them and does the interpretation (trends, signals,
 * report prose). All technical indicators (MA/volume-MA/MACD/RSI/KDJ/ATR) are
 * computed in-process with zero dependencies.
 *
 * User data lives under `%DSH_HOME%\stock\`:
 *   watchlist.json · kline-cache.json · daily/YYYY-MM-DD.json · reports/*.md
 *
 * This plugin is self-contained for the npm dsh install: it depends only on
 * packages the installed CLI already provides (dsh-tools, schemastery).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-stock'
export const inject = ['tools']

/** package.json is the single source of truth for the version. */
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
export const version = PKG.version

/** Tencent quote endpoint (GBK-encoded response). */
const QUOTE_URL = 'https://qt.gtimg.cn/q='
/** Tencent daily K-line endpoint (qfq = 前复权). */
const KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='
/** Per-request endpoint timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000
/** Minimum gap between Tencent requests (public endpoint politeness). */
const REQUEST_GAP_MS = 250
/** Default number of trading days cached per symbol. */
const DEFAULT_KLINE_DAYS = 150
/** The four indices shown by the market-overview tool. */
const INDICES = [
  { symbol: 'sh000001', name: '上证指数' },
  { symbol: 'sz399001', name: '深证成指' },
  { symbol: 'sz399006', name: '创业板指' },
  { symbol: 'sh000300', name: '沪深300' },
]

/** Configuration for the plugin. All optional — see apply(). */
export const Config = z.object({
  /** Trading days of K-line cached per symbol. */
  klineDays: z.natural(),
  /** Root directory for user data; defaults to %DSH_HOME%\stock. */
  dataRoot: z.string(),
  /** Per-request endpoint timeout in milliseconds. */
  timeoutMs: z.natural(),
})

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

/** Parse a possibly-missing/empty field as a number, else null. */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Round to 3 decimals for display. */
function round(value) {
  return Math.round(value * 1000) / 1000
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Minimal request throttle so bursts stay polite to the public endpoint. */
let lastRequestAt = 0
async function throttledFetch(url, timeoutMs) {
  const gap = REQUEST_GAP_MS - (Date.now() - lastRequestAt)
  if (gap > 0) await sleep(gap)
  lastRequestAt = Date.now()
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
}

/** Normalize a user-supplied code to a Tencent symbol (sh600519 / sz000001). */
function normalizeCode(raw) {
  let code = String(raw).trim().toLowerCase()
  code = code.replace(/\.(sh|sz)$/i, '')
  if (/^\d{6}$/.test(code)) {
    if (/^(60|68|9)/.test(code)) return `sh${code}`
    if (/^(00|30|20)/.test(code)) return `sz${code}`
    throw new Error(`stock tools: cannot infer the exchange for code ${raw} (supported: 60/68/9x -> sh, 00/30/20 -> sz)`)
  }
  if (/^(sh|sz)\d{6}$/.test(code)) return code
  throw new Error(`stock tools: invalid code ${JSON.stringify(raw)} (expected e.g. 600519, sh600519, or 600519.SH)`)
}

/** Decode a Tencent response (GBK) to text. */
function decodeGbk(buffer) {
  return new TextDecoder('gbk').decode(buffer)
}

/** Today as YYYY-MM-DD in the local timezone. */
function today() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---------------------------------------------------------------------------
// Tencent clients
// ---------------------------------------------------------------------------

/**
 * Fetch and parse one Tencent quote line. The response is
 * `v_sh600519="1~贵州茅台~600519~...";` — a `~`-separated field list whose
 * layout varies slightly between stocks and indices, so every field beyond
 * the core ones is parsed defensively.
 * @returns the parsed quote object.
 */
async function fetchQuote(symbol, timeoutMs) {
  const response = await throttledFetch(QUOTE_URL + symbol, timeoutMs)
  if (!response.ok) throw new Error(`stock tools: quote endpoint answered ${response.status} for ${symbol}`)
  const text = decodeGbk(new Uint8Array(await response.arrayBuffer()))
  const match = /"([^"]*)"/.exec(text)
  if (match === null || match[1].length === 0) throw new Error(`stock tools: empty quote response for ${symbol}`)
  const f = match[1].split('~')
  const field = (i) => (f[i] === undefined || f[i] === '' ? null : f[i])
  return {
    symbol,
    code: field(2),
    name: field(1),
    price: num(field(3)),
    prevClose: num(field(4)),
    open: num(field(5)),
    volume: num(field(6)),
    time: field(30),
    change: num(field(31)),
    changePct: num(field(32)),
    high: num(field(33)),
    low: num(field(34)),
    amount: num(field(37)),      // 成交额（万元）
    turnover: num(field(38)),    // 换手率 %
    peTtm: num(field(39)),       // 市盈率（TTM）
    amplitude: num(field(43)),   // 振幅 %
    floatMv: num(field(44)),     // 流通市值（亿元）
    totalMv: num(field(45)),     // 总市值（亿元）
    pb: num(field(46)),          // 市净率
    limitUp: num(field(47)),     // 涨停价
    limitDown: num(field(48)),   // 跌停价
    volumeRatio: num(field(49)), // 量比
    bid: [
      { price: num(field(9)), volume: num(field(10)) },
      { price: num(field(11)), volume: num(field(12)) },
      { price: num(field(13)), volume: num(field(14)) },
      { price: num(field(15)), volume: num(field(16)) },
      { price: num(field(17)), volume: num(field(18)) },
    ],
    ask: [
      { price: num(field(19)), volume: num(field(20)) },
      { price: num(field(21)), volume: num(field(22)) },
      { price: num(field(23)), volume: num(field(24)) },
      { price: num(field(25)), volume: num(field(26)) },
      { price: num(field(27)), volume: num(field(28)) },
    ],
  }
}

/**
 * Fetch daily K-line bars (前复权). Bar shape: [date, open, close, high, low, volume].
 * @returns `{ symbol, name, bars }` with the most recent `days` bars.
 */
async function fetchKline(symbol, days, timeoutMs) {
  const url = `${KLINE_URL}${symbol},day,,,${days},qfq`
  const response = await throttledFetch(url, timeoutMs)
  if (!response.ok) throw new Error(`stock tools: kline endpoint answered ${response.status} for ${symbol}`)
  const parsed = await response.json()
  const data = parsed?.data?.[symbol]
  if (data === undefined) throw new Error(`stock tools: kline endpoint returned no data for ${symbol}`)
  const bars = (data.qfqday ?? data.day ?? []).map((row) => ({
    date: row[0],
    open: Number(row[1]),
    close: Number(row[2]),
    high: Number(row[3]),
    low: Number(row[4]),
    volume: Number(row[5]),
  }))
  if (bars.length === 0) throw new Error(`stock tools: no K-line bars for ${symbol}`)
  return { symbol, name: data.qt?.[symbol]?.[1] ?? symbol, bars }
}

// ---------------------------------------------------------------------------
// technical indicators (zero-dependency, standard formulas)
// ---------------------------------------------------------------------------

/** EMA series (seed = first value). */
function emaSeries(values, period) {
  const k = 2 / (period + 1)
  const out = []
  let prev = undefined
  for (const value of values) {
    prev = prev === undefined ? value : value * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

/** Simple moving average series; leading window positions are null. */
function smaSeries(values, period) {
  const out = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    out.push(i >= period - 1 ? sum / period : null)
  }
  return out
}

/** Latest value of a possibly-null-prefixed series. */
function lastOf(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return round(series[i])
  }
  return null
}

/** MACD(12,26,9) — latest DIF/DEA/hist. */
function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return { dif: null, dea: null, hist: null }
  const emaFast = emaSeries(closes, fast)
  const emaSlow = emaSeries(closes, slow)
  const dif = closes.map((_, i) => emaFast[i] - emaSlow[i])
  const dea = emaSeries(dif, signal)
  const i = closes.length - 1
  return { dif: round(dif[i]), dea: round(dea[i]), hist: round((dif[i] - dea[i]) * 2) }
}

/** RSI with Wilder smoothing — latest value. */
function rsi(closes, period) {
  if (closes.length <= period) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gain += diff
    else loss -= diff
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period
  }
  if (avgLoss === 0) return round(100)
  return round(100 - 100 / (1 + avgGain / avgLoss))
}

/** KDJ(9,3,3) — latest K/D/J. */
function kdj(highs, lows, closes, n = 9) {
  let k = 50
  let d = 50
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - n + 1)
    let hh = -Infinity
    let ll = Infinity
    for (let j = start; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j]
      if (lows[j] < ll) ll = lows[j]
    }
    const rsv = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100
    k = (2 / 3) * k + (1 / 3) * rsv
    d = (2 / 3) * d + (1 / 3) * k
  }
  return { k: round(k), d: round(d), j: round(3 * k - 2 * d) }
}

/** ATR(14) with Wilder smoothing — latest value. */
function atr(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null
  const trs = []
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ))
  }
  let value = trs.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < trs.length; i++) {
    value = (value * (period - 1) + trs[i]) / period
  }
  return round(value)
}

/**
 * Compute the full indicator set over K-line bars.
 * @returns latest indicator values plus a short price tail for context.
 */
function computeIndicators(bars) {
  const closes = bars.map((b) => b.close)
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const volumes = bars.map((b) => b.volume)
  const last = bars.length - 1
  return {
    date: bars[last].date,
    barCount: bars.length,
    closesTail: bars.slice(-5).map((b) => ({ date: b.date, close: b.close })),
    ma: {
      ma5: lastOf(smaSeries(closes, 5)),
      ma10: lastOf(smaSeries(closes, 10)),
      ma20: lastOf(smaSeries(closes, 20)),
      ma60: lastOf(smaSeries(closes, 60)),
    },
    volumeMa: {
      vma5: lastOf(smaSeries(volumes, 5)),
      vma10: lastOf(smaSeries(volumes, 10)),
    },
    macd: macd(closes),
    rsi: { rsi6: rsi(closes, 6), rsi12: rsi(closes, 12), rsi24: rsi(closes, 24) },
    kdj: kdj(highs, lows, closes),
    atr14: atr(highs, lows, closes),
  }
}

// ---------------------------------------------------------------------------
// storage helpers (under %DSH_HOME%\stock)
// ---------------------------------------------------------------------------

/** Resolve the user-data root directory. */
function dataRootOf(config) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return config.dataRoot ?? join(dshHome, 'stock')
}

/** Read a JSON file, or null when absent. */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** Write a JSON file (creating parent directories). */
async function writeJson(file, value) {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

/** Load the watchlist document. */
async function loadWatchlist(root) {
  const doc = await readJson(join(root, 'watchlist.json'))
  if (doc === null || !Array.isArray(doc.codes)) return { codes: [], updatedAt: null }
  return doc
}

/** Load the K-line cache document. */
async function loadKlineCache(root) {
  const doc = await readJson(join(root, 'kline-cache.json'))
  return doc === null || typeof doc !== 'object' ? {} : doc
}

/** K-line for a symbol with per-day caching (refreshed once per local day). */
async function klineWithCache(root, symbol, days, timeoutMs) {
  const cache = await loadKlineCache(root)
  const entry = cache[symbol]
  if (entry !== undefined && entry.date === today() && entry.bars.length >= days) {
    return { symbol, name: entry.name, bars: entry.bars.slice(-days) }
  }
  const fetched = await fetchKline(symbol, days, timeoutMs)
  cache[symbol] = { date: today(), name: fetched.name, bars: fetched.bars }
  await writeJson(join(root, 'kline-cache.json'), cache)
  return fetched
}

/** Quote for a symbol with a tiny staleness shield (quotes are cheap; no cache). */
async function quoteOf(symbol, timeoutMs) {
  return fetchQuote(symbol, timeoutMs)
}

// ---------------------------------------------------------------------------
// plugin registration
// ---------------------------------------------------------------------------

/**
 * Register the nine stock tools.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - plugin config.
 */
export function apply(ctx, config) {
  console.info(`[tool-stock] v${version} registered`)
  const klineDays = config.klineDays ?? DEFAULT_KLINE_DAYS
  const dataRoot = dataRootOf(config)
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // --- stock_quote ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'stock_quote',
    description: 'Get a real-time quote for one A-share stock or index from Tencent. Pass code (e.g. 600519, sh600519, or '
      + '600519.SH; indices like sh000001). Returns price, change, volume/amount, turnover, PE/PB, market caps, and the '
      + 'bid/ask ladder. Use it when the user asks about the current price or today\'s movement of a stock.',
    parameters: {
      code: { type: 'string', required: true, description: 'Stock code, e.g. 600519 or sh600519 (or an index symbol like sh000001).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          quote: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              symbol: { type: 'string', required: true },
              code: { type: 'string', required: true },
              name: { type: 'string', required: true },
              price: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              prevClose: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              open: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              high: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              low: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              change: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              changePct: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              volume: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              amount: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              turnover: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              peTtm: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              pb: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              totalMv: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              floatMv: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              volumeRatio: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              amplitude: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              limitUp: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              limitDown: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              time: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              bid: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    price: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                    volume: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                  },
                },
              },
              ask: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    price: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                    volume: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderQuote(value.quote) }],
    },
    async execute(args) {
      const symbol = normalizeCode(args.code)
      return { quote: await quoteOf(symbol, timeoutMs) }
    },
    presentCall: args => ({ card: 'generic', title: 'Stock quote', kind: 'read', rawInput: args }),
  }))

  // --- stock_kline ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'stock_kline',
    description: 'Get daily K-line bars (前复权) for one A-share stock from Tencent, cached per day. Pass code and optional '
      + 'days (default 60, max 150). Returns [date, open, close, high, low, volume] bars. Use it to see the price history '
      + 'or feed technical analysis.',
    parameters: {
      code: { type: 'string', required: true, description: 'Stock code, e.g. 600519 or sh600519.' },
      days: { type: 'integer', description: 'Number of trading days to return (default 60, capped at the cache depth).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          name: { type: 'string', required: true },
          bars: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                open: { type: 'number', required: true },
                close: { type: 'number', required: true },
                high: { type: 'number', required: true },
                low: { type: 'number', required: true },
                volume: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.name}(${value.symbol}) ${value.bars.length} bars, last: ${value.bars.at(-1).date} close=${value.bars.at(-1).close}`,
      }],
    },
    async execute(args) {
      const symbol = normalizeCode(args.code)
      const days = args.days === undefined ? 60 : Math.min(Math.max(1, args.days), klineDays)
      const result = await klineWithCache(dataRoot, symbol, klineDays, timeoutMs)
      return { symbol, name: result.name, bars: result.bars.slice(-days) }
    },
    presentCall: args => ({ card: 'generic', title: 'Stock K-line', kind: 'read', rawInput: args }),
  }))

  // --- stock_indicators ----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'stock_indicators',
    description: 'Compute technical indicators for one A-share stock from cached Tencent K-line data: MA(5/10/20/60), '
      + 'volume MA(5/10), MACD(12,26,9), RSI(6/12/24), KDJ(9,3,3), ATR(14). Returns the latest values; interpret them '
      + '(golden/death cross, overbought/oversold, trend) for the user.',
    parameters: {
      code: { type: 'string', required: true, description: 'Stock code, e.g. 600519 or sh600519.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          name: { type: 'string', required: true },
          date: { type: 'string', required: true },
          barCount: { type: 'integer', required: true },
          closesTail: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                close: { type: 'number', required: true },
              },
            },
          },
          ma: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              ma5: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              ma10: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              ma20: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              ma60: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
          volumeMa: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              vma5: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              vma10: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
          macd: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              dif: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              dea: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              hist: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
          rsi: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              rsi6: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              rsi12: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              rsi24: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
          kdj: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              k: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              d: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              j: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
          atr14: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderIndicators(value) }],
    },
    async execute(args) {
      const symbol = normalizeCode(args.code)
      const kline = await klineWithCache(dataRoot, symbol, klineDays, timeoutMs)
      const indicators = computeIndicators(kline.bars)
      return { symbol, name: kline.name, ...indicators }
    },
    presentCall: args => ({ card: 'generic', title: 'Stock indicators', kind: 'read', rawInput: args }),
  }))

  // --- stock_market_overview ----------------------------------------------
  ctx.tools.register(defineTool({
    name: 'stock_market_overview',
    description: 'Get a snapshot of the four main A-share indices (上证指数/深证成指/创业板指/沪深300): current value, '
      + 'change, change %, volume and amount. Use it for a quick market overview or when the user asks how the market '
      + 'is doing today.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          indices: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                symbol: { type: 'string', required: true },
                name: { type: 'string', required: true },
                price: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                change: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                changePct: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                volume: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                amount: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.indices.map((i) => `${i.name} ${i.price} (${i.changePct ?? '-'}%)`).join('\n'),
      }],
    },
    async execute() {
      const indices = []
      for (const index of INDICES) {
        const quote = await quoteOf(index.symbol, timeoutMs)
        indices.push({
          symbol: index.symbol,
          name: index.name,
          price: quote.price,
          change: quote.change,
          changePct: quote.changePct,
          volume: quote.volume,
          amount: quote.amount,
        })
      }
      return { indices }
    },
    presentCall: () => ({ card: 'generic', title: 'Market overview', kind: 'read' }),
  }))

  // --- watchlist_add / watchlist_remove / watchlist_list -------------------
  ctx.tools.register(defineTool({
    name: 'watchlist_add',
    description: 'Add one stock code to the local watchlist (persisted under %DSH_HOME%\\stock\\watchlist.json). '
      + 'Idempotent: adding an existing code is a no-op. Use it to build the list that stock_daily_collect snapshots.',
    parameters: {
      code: { type: 'string', required: true, description: 'Stock code, e.g. 600519 or sh600519.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          codes: { type: 'array', required: true, items: { type: 'string' } },
          added: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.added ? 'Added' : 'Already in watchlist:'} ${value.codes.join(', ')}` }],
    },
    async execute(args) {
      const symbol = normalizeCode(args.code)
      const doc = await loadWatchlist(dataRoot)
      const added = !doc.codes.includes(symbol)
      if (added) doc.codes.push(symbol)
      doc.updatedAt = new Date().toISOString()
      await writeJson(join(dataRoot, 'watchlist.json'), doc)
      return { codes: doc.codes, added }
    },
    presentCall: args => ({ card: 'generic', title: 'Add to watchlist', kind: 'edit', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'watchlist_remove',
    description: 'Remove one stock code from the local watchlist. A no-op when the code is not in the list.',
    parameters: {
      code: { type: 'string', required: true, description: 'Stock code, e.g. 600519 or sh600519.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          codes: { type: 'array', required: true, items: { type: 'string' } },
          removed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.removed ? 'Removed' : 'Not in watchlist:'} ${value.codes.join(', ')}` }],
    },
    async execute(args) {
      const symbol = normalizeCode(args.code)
      const doc = await loadWatchlist(dataRoot)
      const index = doc.codes.indexOf(symbol)
      const removed = index >= 0
      if (removed) doc.codes.splice(index, 1)
      doc.updatedAt = new Date().toISOString()
      await writeJson(join(dataRoot, 'watchlist.json'), doc)
      return { codes: doc.codes, removed }
    },
    presentCall: args => ({ card: 'generic', title: 'Remove from watchlist', kind: 'edit', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'watchlist_list',
    description: 'List the local watchlist codes (persisted under %DSH_HOME%\\stock\\watchlist.json).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          codes: { type: 'array', required: true, items: { type: 'string' } },
          updatedAt: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.codes.length === 0 ? '(empty watchlist)' : value.codes.join('\n') }],
    },
    async execute() {
      const doc = await loadWatchlist(dataRoot)
      return { codes: doc.codes, updatedAt: doc.updatedAt }
    },
    presentCall: () => ({ card: 'generic', title: 'List watchlist', kind: 'read' }),
  }))

  // --- stock_daily_collect ------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'stock_daily_collect',
    description: 'Collect a daily snapshot for the whole watchlist: close/change/volume/amount per stock plus the four '
      + 'main index quotes, and append indicators (MA/MACD/RSI/KDJ/ATR). Writes %DSH_HOME%\\stock\\daily\\YYYY-MM-DD.json '
      + 'and is idempotent per day (a snapshot already collected today is not overwritten). Returns a text summary.',
    parameters: {
      force: { type: 'boolean', description: 'Set true to overwrite today\'s snapshot if it already exists (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', required: true },
          path: { type: 'string', required: true },
          collected: { type: 'boolean', required: true },
          stockCount: { type: 'integer', required: true },
          indices: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                symbol: { type: 'string', required: true },
                name: { type: 'string', required: true },
                price: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                changePct: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const doc = await loadWatchlist(dataRoot)
      if (doc.codes.length === 0) {
        throw new Error('stock_daily_collect: the watchlist is empty; add codes with watchlist_add first')
      }
      const date = today()
      const file = join(dataRoot, 'daily', `${date}.json`)
      if (existsSync(file) && args.force !== true) {
        const existing = await readJson(file)
        return {
          date,
          path: file,
          collected: false,
          stockCount: existing?.watchlist?.length ?? 0,
          indices: existing?.indices ?? [],
          summary: `今日快照已存在（${file}），未覆盖；如需重采加 force=true。`,
        }
      }
      const stocks = []
      for (const symbol of doc.codes) {
        const quote = await quoteOf(symbol, timeoutMs)
        const kline = await klineWithCache(dataRoot, symbol, klineDays, timeoutMs)
        stocks.push({
          symbol,
          name: quote.name ?? kline.name,
          quote: {
            price: quote.price,
            changePct: quote.changePct,
            change: quote.change,
            volume: quote.volume,
            amount: quote.amount,
            turnover: quote.turnover,
          },
          indicators: computeIndicators(kline.bars),
        })
      }
      const indices = []
      for (const index of INDICES) {
        const quote = await quoteOf(index.symbol, timeoutMs)
        indices.push({ symbol: index.symbol, name: index.name, price: quote.price, changePct: quote.changePct })
      }
      const snapshot = { date, collectedAt: new Date().toISOString(), watchlist: stocks, indices }
      await writeJson(file, snapshot)
      const summary = [
        `已收集 ${date} 快照（${stocks.length} 只自选股 + ${indices.length} 个指数）-> ${file}`,
        ...stocks.map((s) => `${s.name} ${s.quote.price ?? '-'} (${s.quote.changePct ?? '-'}%)`),
        ...indices.map((i) => `${i.name} ${i.price ?? '-'} (${i.changePct ?? '-'}%)`),
      ].join('\n')
      return { date, path: file, collected: true, stockCount: stocks.length, indices, summary }
    },
    presentCall: () => ({ card: 'generic', title: 'Collect daily snapshot', kind: 'other' }),
  }))

  // --- stock_report --------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'stock_report',
    description: 'Assemble a Markdown report skeleton (quote + K-line summary + indicators tables) for one or more '
      + 'stocks and write it under %DSH_HOME%\\stock\\reports\\ (or an explicit output_path). Returns the file path and '
      + 'the key numbers so the model can enrich the 分析 section and summarize for the user.',
    parameters: {
      codes: { type: 'array', required: true, description: 'Stock codes to include, e.g. ["600519", "000001"].', items: { type: 'string' } },
      output_path: { type: 'string', description: 'Optional output file path (default: %DSH_HOME%\\stock\\reports\\<name>_<date>.md).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          date: { type: 'string', required: true },
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                symbol: { type: 'string', required: true },
                price: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                changePct: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `报告已生成：${value.path}` }],
    },
    async execute(args) {
      const symbols = args.codes.map(normalizeCode)
      const date = today()
      const sections = []
      const rows = []
      for (const symbol of symbols) {
        const quote = await quoteOf(symbol, timeoutMs)
        const kline = await klineWithCache(dataRoot, symbol, klineDays, timeoutMs)
        const indicators = computeIndicators(kline.bars)
        const name = quote.name ?? kline.name
        rows.push({ name, symbol, price: quote.price, changePct: quote.changePct })
        const last = kline.bars.at(-1)
        sections.push(
          `## ${name}（${symbol}）\n\n`
          + `> 数据日期：${last.date} ｜ 来源：腾讯公开行情（非投资建议）\n\n`
          + `### 行情快照\n\n`
          + `| 现价 | 涨跌 | 涨跌幅 | 今开 | 最高 | 最低 | 昨收 | 成交量(手) | 成交额(万) | 换手率% |\n`
          + `|---|---|---|---|---|---|---|---|---|---|\n`
          + `| ${quote.price ?? '-'} | ${quote.change ?? '-'} | ${quote.changePct ?? '-'}% | ${quote.open ?? '-'} | ${quote.high ?? '-'} | ${quote.low ?? '-'} | ${quote.prevClose ?? '-'} | ${quote.volume ?? '-'} | ${quote.amount ?? '-'} | ${quote.turnover ?? '-'} |\n\n`
          + `### 技术指标（${indicators.date}）\n\n`
          + `| 指标 | 值 |\n|---|---|\n`
          + `| MA5 / MA10 / MA20 / MA60 | ${indicators.ma.ma5 ?? '-'} / ${indicators.ma.ma10 ?? '-'} / ${indicators.ma.ma20 ?? '-'} / ${indicators.ma.ma60 ?? '-'} |\n`
          + `| MACD DIF / DEA / 柱 | ${indicators.macd.dif ?? '-'} / ${indicators.macd.dea ?? '-'} / ${indicators.macd.hist ?? '-'} |\n`
          + `| RSI(6/12/24) | ${indicators.rsi.rsi6 ?? '-'} / ${indicators.rsi.rsi12 ?? '-'} / ${indicators.rsi.rsi24 ?? '-'} |\n`
          + `| KDJ K / D / J | ${indicators.kdj.k ?? '-'} / ${indicators.kdj.d ?? '-'} / ${indicators.kdj.j ?? '-'} |\n`
          + `| ATR(14) | ${indicators.atr14 ?? '-'} |\n\n`
          + `### 分析\n\n<!-- 由模型补充：趋势、信号、风险、结论 -->\n`,
        )
      }
      const outputPath = args.output_path ?? join(dataRoot, 'reports', `${date}-${symbols.join('_')}.md`)
      await mkdir(join(outputPath, '..'), { recursive: true })
      const markdown = `# 个股分析报告（${date}）\n\n> 数据来源：腾讯公开行情；仅供学习参考，不构成投资建议。\n\n${sections.join('\n')}`
      await writeFile(outputPath, markdown, 'utf8')
      return { path: outputPath, date, rows }
    },
    presentCall: args => ({ card: 'generic', title: 'Stock report', kind: 'other', rawInput: args }),
  }))
}

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

/** One-line-ish quote rendering for the model-facing text block. */
function renderQuote(q) {
  const parts = [
    `${q.name}(${q.symbol})`,
    `现价 ${q.price ?? '-'}`,
    `涨跌 ${q.change ?? '-'} (${q.changePct ?? '-'}%)`,
    `今开 ${q.open ?? '-'} 高 ${q.high ?? '-'} 低 ${q.low ?? '-'}`,
    `量 ${q.volume ?? '-'}手 额 ${q.amount ?? '-'}万 换手 ${q.turnover ?? '-'}%`,
  ]
  if (q.peTtm !== null) parts.push(`PE(TTM) ${q.peTtm}`)
  if (q.pb !== null) parts.push(`PB ${q.pb}`)
  if (q.totalMv !== null) parts.push(`总市值 ${q.totalMv}亿`)
  return parts.join('\n')
}

/** Compact indicator rendering for the model-facing text block. */
function renderIndicators(v) {
  return [
    `${v.name}(${v.symbol}) 指标（${v.date}，${v.barCount}根K线）`,
    `MA ${v.ma.ma5 ?? '-'}/${v.ma.ma10 ?? '-'}/${v.ma.ma20 ?? '-'}/${v.ma.ma60 ?? '-'}`,
    `MACD ${v.macd.dif ?? '-'}/${v.macd.dea ?? '-'}/${v.macd.hist ?? '-'}`,
    `RSI ${v.rsi.rsi6 ?? '-'}/${v.rsi.rsi12 ?? '-'}/${v.rsi.rsi24 ?? '-'}`,
    `KDJ ${v.kdj.k ?? '-'}/${v.kdj.d ?? '-'}/${v.kdj.j ?? '-'}`,
    `ATR ${v.atr14 ?? '-'}`,
  ].join('\n')
}
