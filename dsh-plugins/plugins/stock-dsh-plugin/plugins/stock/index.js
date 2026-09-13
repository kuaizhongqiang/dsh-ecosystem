/**
 * A-share stock tools for the native dsh web profile:
 * - market data: `stock_quote`, `stock_kline`, `stock_indicators`,
 *   `stock_market_overview`, `watchlist_add|remove|list`,
 *   `stock_daily_collect`, `stock_report`
 * - sentiment & forecast layer: `sentiment_sources` (whitelist),
 *   `sentiment_pick` (≤5 picks/day), `sentiment_record` / `sentiment_list`
 * - advice & order layer: `advice_calc` (trigger/target/stop/position),
 *   `position_record` / `position_list` / `position_update`
 * - paper trading (建议即挂单): `paper_init` / `paper_account` /
 *   `paper_execute_advice` / `paper_trade` / `paper_settle`
 *
 * == 时间模型（时间周期为日，非小时）==
 * 每条建议/挂单都以「日」为单位标注其产生时段 phase 与数据基准日 dataDate：
 * - T0 盘后（交易日 15:00 后；含晚间/周末/节假日）：预测基于 T0 及以前
 *   所有已收盘数据（dataDate = T0 最近交易日）；挂单最早只能在 T+1
 *   （下一交易日）成交，paper_settle 以建议日期之后第一个交易日的
 *   最高/最低价区间核算。
 * - T0 盘中（交易日 9:30–15:00 未收盘）：预测**忽略 T0 当日数据**（当日
 *   K 线未走完），按 T-1 及以前已收盘数据（dataDate = T-1）分析与挂单；
 *   挂单同样顺延到 T+1 核算，绝不用 T0 当天区间（避免马后炮）。
 * - 因此 paper_settle 统一取「建议日期之后第一个交易日」的区间判定成交，
 *   与记录时刻的 phase 无关；phase/dataDate 仅用于审计与展示。
 *
 * Data comes exclusively from Tencent's public quote endpoints (no API key):
 * - real-time quotes:  `https://qt.gtimg.cn/q=<symbol>`  (GBK-encoded)
 * - daily K-line (前复权): `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get`
 *
 * The main conversation model stays text-only: these tools fetch and compute
 * numbers, the model reads them and does the interpretation (trends, signals,
 * sentiment contradiction analysis, advice prose). All technical indicators
 * (MA/volume-MA/MACD/RSI/KDJ/ATR) are computed in-process with zero dependencies.
 *
 * User data lives under `%DSH_HOME%\stock\`:
 *   watchlist.json · kline-cache.json · daily/YYYY-MM-DD.json · reports/*.md
 *   sentiment.json · positions.json
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

/**
 * 权威信息源白名单（舆情分析只采信这些"大而靠谱"的网站）。
 * 分层：官方（政府/部委/官媒/交易所公告）+ 主流财经媒体。
 */
const SENTIMENT_SOURCES = {
  官方: [
    { name: '中国政府网', domain: 'gov.cn' },
    { name: '新华社', domain: 'xinhuanet.com' },
    { name: '人民日报', domain: 'people.com.cn' },
    { name: '央视新闻', domain: 'cctv.com' },
    { name: '发改委', domain: 'ndrc.gov.cn' },
    { name: '工信部', domain: 'miit.gov.cn' },
    { name: '国家能源局', domain: 'nea.gov.cn' },
    { name: '国务院国资委', domain: 'sasac.gov.cn' },
    { name: '证监会', domain: 'csrc.gov.cn' },
    { name: '上交所', domain: 'sse.com.cn' },
    { name: '深交所', domain: 'szse.cn' },
    { name: '巨潮资讯(交易所公告)', domain: 'cninfo.com.cn' },
  ],
  财经: [
    { name: '财联社', domain: 'cls.cn' },
    { name: '证券时报', domain: 'stcn.com' },
    { name: '上海证券报', domain: 'cnstock.com' },
    { name: '中国证券报', domain: 'cs.com.cn' },
    { name: '证券日报', domain: 'zqrb.cn' },
    { name: '第一财经', domain: 'yicai.com' },
    { name: '新华财经', domain: 'cnfin.com' },
  ],
}

/** 舆情记录文件名（%DSH_HOME%\stock\sentiment.json）。 */
const SENTIMENT_FILE = 'sentiment.json'
/** 仓位建议记录文件名（%DSH_HOME%\stock\positions.json）。 */
const POSITIONS_FILE = 'positions.json'
/** 模拟盘账户文件名（%DSH_HOME%\stock\paper.json）。 */
const PAPER_FILE = 'paper.json'
/** 模拟盘默认初始本金（元）。 */
const DEFAULT_PAPER_CASH = 100000
/** 每日舆情调查上限（默认不超过 5 只）。 */
const DEFAULT_MAX_PICKS = 5
/** 用户风险偏好参考值：0 最保守，10 最激进（默认 6.5）。 */
const DEFAULT_RISK_PROFILE = 6.5
/** A股一手股数（买卖按 100 股整数倍）。 */
const LOT_SIZE = 100

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

/** Round to 2 decimals (A-share minimum tick). */
function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * Build a filesystem-safe report file name for a symbol list.
 * Joining 60+ symbols produces names far beyond the OS path limit, so when the
 * plain name would be too long we truncate it and append a stable short hash.
 */
function reportFileName(date, symbols) {
  const base = `${date}-${symbols.join('_')}`
  const MAX = 120
  if (base.length <= MAX) return `${base}.md`
  // djb2 hash -> short stable suffix (no crypto dependency needed).
  let hash = 5381
  for (let i = 0; i < base.length; i += 1) {
    hash = ((hash << 5) + hash + base.charCodeAt(i)) | 0
  }
  const suffix = (hash >>> 0).toString(36).padStart(6, '0').slice(0, 6)
  const head = symbols.slice(0, 3).join('_')
  return `${date}-${head}_etc${symbols.length}_${suffix}.md`
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
// 时间模型（日周期）：phase / 数据基准日 / 下一交易日
// 规则（见文件头注释）：
//   - after_hours（交易日 15:00 后，或非交易日）：数据基准 = 最近已收盘交易日
//   - intraday / pre_market（交易日未收盘，含盘中与盘前）：忽略 T0 当日数据，
//     数据基准 = 最近已收盘交易日（通常为 T-1）
//   - 挂单统一以「建议日期之后第一个交易日」核算（T+1），与 phase 无关
// ---------------------------------------------------------------------------

/** A股交易时段：开盘 9:30 / 午休 11:30-13:00 / 收盘 15:00（本地时区）。 */
const MARKET_CLOSE_HHMM = 15 * 60 + 0

/** Local minutes-of-day for a date. */
function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}

/** True when `d` is a Saturday or Sunday. */
function isWeekend(d) {
  const wd = d.getDay()
  return wd === 0 || wd === 6
}

/**
 * Classify the current local moment into a trading phase (日周期, 不细到小时撮合):
 * - 'pre_market'  交易日未开盘（9:30 前，含集合竞价窗口）
 * - 'intraday'    交易时段内（9:30–11:30 / 13:00–15:00），当日数据未走完
 * - 'after_hours' 已收盘（交易日 15:00 后）或非交易日（周末/节假日）
 * 周末/节假日一律视作 after_hours（数据只能取到最近已收盘交易日）。
 */
function currentPhase(now = new Date()) {
  if (isWeekend(now)) return 'after_hours'
  const m = minutesOfDay(now)
  if (m < 9 * 60 + 30) return 'pre_market'
  if (m >= MARKET_CLOSE_HHMM) return 'after_hours'
  return 'intraday'
}

/**
 * Pick the bars that a forecast may legitimately use at this moment.
 * 盘中/盘前（T0 未收盘）时，若 K 线最后一根恰是 T0 当日（腾讯日 K 会实时
 * 追加当日 bar），必须剔除它——预测只许用 T-1 及以前已收盘数据。
 * 盘后/非交易日则原样返回（最后一根即最近已收盘交易日）。
 * @returns `{ bars, dataDate, note }`
 */
function barsForForecast(bars, now = new Date()) {
  const phase = currentPhase(now)
  const last = bars.at(-1)
  if (last === undefined) return { bars: [], dataDate: null, note: `无K线 ${phase}` }
  const lastDateIsToday = last.date === today()
  const dropToday = (phase === 'intraday' || phase === 'pre_market') && lastDateIsToday && bars.length > 1
  const usable = dropToday ? bars.slice(0, -1) : bars
  const dataDate = usable.at(-1)?.date ?? null
  const note = dropToday
    ? `T0 盘中/盘前：忽略当日 ${last.date} 未收盘数据，数据基准 ${dataDate}`
    : phase === 'after_hours'
      ? `T0 已收盘：数据基准 ${dataDate}`
      : `数据基准 ${dataDate}`
  return { bars: usable, dataDate, note }
}

/**
 * The first bar strictly AFTER `date` (its T+1 settlement day). Returns
 * undefined when the K-line window does not reach a later trading day yet —
 * callers must then keep the order pending.
 */
function nextTradingBarAfter(bars, date) {
  return bars
    .filter((b) => b.date > date)
    .sort((a, b) => a.date.localeCompare(b.date))[0]
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

/**
 * Fetch quotes for many symbols in ONE request (Tencent accepts `q=a,b,c`).
 * Reuses the same GBK parsing as fetchQuote.
 * @returns array of parsed quote objects (same shape as fetchQuote).
 */
async function fetchQuotes(symbols, timeoutMs) {
  const url = QUOTE_URL + symbols.join(',')
  const response = await throttledFetch(url, timeoutMs)
  if (!response.ok) throw new Error(`stock tools: quote endpoint answered ${response.status} for batch`)
  const text = decodeGbk(new Uint8Array(await response.arrayBuffer()))
  const parsed = []
  for (const line of text.split('\n')) {
    const match = /v_(\w+)="([^"]*)"/.exec(line)
    if (match === null) continue
    const symbol = match[1]
    const f = match[2].split('~')
    if (f.length < 40) continue
    const field = (i) => (f[i] === undefined || f[i] === '' ? null : f[i])
    parsed.push({
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
      amount: num(field(37)),
      turnover: num(field(38)),
      peTtm: num(field(39)),
      amplitude: num(field(43)),
      floatMv: num(field(44)),
      totalMv: num(field(45)),
      pb: num(field(46)),
      limitUp: num(field(47)),
      limitDown: num(field(48)),
      volumeRatio: num(field(49)),
    })
  }
  return parsed
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
// 舆情挑选打分（异动 + 技术信号）
// ---------------------------------------------------------------------------

/**
 * Score one stock for "deserves sentiment research today".
 * Dimensions: price action (moves/limit/volume/amplitude) + technical signals
 * (RSI extremes, KDJ J extremes, MA breakdown/breakout, MACD).
 * @returns `{ score, reasons }` with human-readable Chinese reason tags.
 */
function scoreForSentiment(quote, indicators) {
  let score = 0
  const reasons = []
  const pct = quote.changePct ?? 0
  const price = quote.price
  const ma = indicators.ma
  const kdj = indicators.kdj
  const rsi6 = indicators.rsi?.rsi6

  // --- 异动维度 -----------------------------------------------------------
  const absPct = Math.abs(pct)
  if (absPct >= 9.8) { score += 4; reasons.push('涨跌停') }
  else if (absPct >= 5) { score += 3; reasons.push(`异动 ${pct > 0 ? '+' : ''}${pct}%`) }
  else if (absPct >= 3) { score += 1.5; reasons.push(`明显波动 ${pct > 0 ? '+' : ''}${pct}%`) }
  if (quote.limitUp !== null && price !== null && price >= quote.limitUp - 0.01) { score += 1; reasons.push('封涨停') }
  if (quote.limitDown !== null && price !== null && price <= quote.limitDown + 0.01) { score += 1; reasons.push('封跌停') }
  const vr = quote.volumeRatio ?? 0
  if (vr >= 3) { score += 2; reasons.push(`放量 量比${vr}`) }
  else if (vr >= 1.5) { score += 1; reasons.push(`量比${vr}`) }
  const amp = quote.amplitude ?? 0
  if (amp >= 8) { score += 1.5; reasons.push(`巨震 振幅${amp}%`) }
  else if (amp >= 5) { score += 0.5; reasons.push(`振幅${amp}%`) }

  // --- 技术信号维度 -------------------------------------------------------
  if (rsi6 !== null && rsi6 !== undefined) {
    if (rsi6 <= 15) { score += 2.5; reasons.push('深度超卖 RSI6=' + rsi6) }
    else if (rsi6 <= 25) { score += 1.5; reasons.push('超卖 RSI6=' + rsi6) }
    else if (rsi6 >= 85) { score += 2.5; reasons.push('深度超买 RSI6=' + rsi6) }
    else if (rsi6 >= 75) { score += 1.5; reasons.push('超买 RSI6=' + rsi6) }
  }
  if (kdj && kdj.j !== null && kdj.j !== undefined) {
    if (kdj.j <= 0) { score += 2; reasons.push('KDJ J=' + kdj.j + ' 极端超卖') }
    else if (kdj.j >= 100) { score += 2; reasons.push('KDJ J=' + kdj.j + ' 极端超买') }
  }
  const ma5 = ma?.ma5, ma10 = ma?.ma10, ma20 = ma?.ma20, ma60 = ma?.ma60
  if (price !== null && ma20 !== null && ma60 !== null) {
    if (price < ma60 && ma5 < ma20 && ma10 < ma20) { score += 2; reasons.push('均线空头破位') }
    if (price > ma60 && ma5 > ma20 && ma10 > ma20) { score += 1.5; reasons.push('均线多头突破') }
  }
  const macd = indicators.macd
  if (macd && macd.dif !== null && macd.dea !== null && macd.hist !== null) {
    if (macd.hist < 0 && macd.dif < macd.dea) { score += 0.5; reasons.push('MACD死叉') }
    if (macd.hist > 0 && macd.dif > macd.dea) { score += 0.5; reasons.push('MACD金叉') }
  }
  return { score: round(score), reasons: reasons.slice(0, 6) }
}

/**
 * Pick the watchlist stocks that deserve sentiment research today.
 * @returns ranked candidates (max `limit`).
 */
async function pickSentimentCandidates(root, codes, limit, timeoutMs) {
  if (codes.length === 0) return []
  const quotes = await fetchQuotes(codes, timeoutMs)
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]))
  const scored = []
  for (const symbol of codes) {
    const quote = bySymbol.get(symbol)
    if (quote === undefined) continue
    let indicators = null
    try {
      const kline = await klineWithCache(root, symbol, DEFAULT_KLINE_DAYS, timeoutMs)
      indicators = computeIndicators(kline.bars)
    } catch {
      indicators = { ma: {}, macd: {}, kdj: {}, rsi: {} }
    }
    const { score, reasons } = scoreForSentiment(quote, indicators)
    scored.push({
      symbol, name: quote.name, price: quote.price, changePct: quote.changePct,
      amount: quote.amount, volumeRatio: quote.volumeRatio, score, reasons,
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

// ---------------------------------------------------------------------------
// 建议价格计算（触发价 / 目标价 / 止损价 / 仓位比例）
// ---------------------------------------------------------------------------

/**
 * 仓位档位（按 ATR 波动率 + 风险偏好定档）。
 * @returns suggested position percentage for a fresh buy.
 */
function positionPctFor(atrPct, riskProfile) {
  let pct
  if (atrPct < 1.5) pct = 40
  else if (atrPct < 2.5) pct = 30
  else if (atrPct < 4) pct = 20
  else if (atrPct < 6) pct = 15
  else pct = 10
  // 风险偏好 6.5 为基准；每偏离 1 分 ±8%
  const factor = 1 + (riskProfile - DEFAULT_RISK_PROFILE) * 0.08
  pct = Math.round(pct * factor / 5) * 5
  return Math.max(5, Math.min(50, pct))
}

/**
 * 多因子信号评分：趋势 + 动量 + 量能。
 * 供 advice_calc 的 auto 判断与置信度输出使用；分数范围约 -7..+7。
 * @returns `{ score, level, factors }`（level: 强/中/弱 ｜ factors: 中文因子说明）
 */
function signalScoreFor(quote, indicators) {
  const price = quote.price
  const ma = indicators.ma ?? {}
  const macd = indicators.macd ?? {}
  const rsi6 = indicators.rsi?.rsi6
  const ma5 = ma.ma5, ma20 = ma.ma20, ma60 = ma.ma60
  let score = 0
  const factors = []

  // --- 趋势因子（±3）------------------------------------------------------
  if (price !== null && ma20 !== null) {
    if (price > ma20) { score += 1; factors.push('价>MA20') } else { score -= 1; factors.push('价<MA20') }
  }
  if (price !== null && ma60 !== null) {
    if (price > ma60) { score += 1; factors.push('价>MA60') } else { score -= 1; factors.push('价<MA60') }
  }
  if (ma5 !== null && ma20 !== null) {
    if (ma5 > ma20) { score += 1; factors.push('MA5>MA20') } else { score -= 1; factors.push('MA5<MA20') }
  }

  // --- 动量因子（±2）------------------------------------------------------
  if (macd.dif !== null && macd.dea !== null && macd.hist !== null) {
    if (macd.hist > 0 && macd.dif > macd.dea) { score += 1; factors.push('MACD金叉') }
    else if (macd.hist < 0 && macd.dif < macd.dea) { score -= 1; factors.push('MACD死叉') }
  }
  if (rsi6 !== null && rsi6 !== undefined) {
    if (rsi6 <= 25) { score += 1; factors.push(`RSI6=${rsi6}超卖`) }
    else if (rsi6 >= 75) { score -= 1; factors.push(`RSI6=${rsi6}超买`) }
  }

  // --- 量能因子（±2）------------------------------------------------------
  const vr = quote.volumeRatio ?? 1
  const up = (quote.changePct ?? 0) >= 0
  if (vr >= 1.5) {
    if (up) { score += 1; factors.push(`放量上涨 量比${vr}`) }
    else { score -= 1; factors.push(`放量下跌 量比${vr}`) }
  } else if (vr <= 0.7) {
    score -= 0.5; factors.push(`缩量 量比${vr}`)
  }

  const level = Math.abs(score) >= 4 ? '强' : Math.abs(score) >= 2 ? '中' : '弱'
  return { score: round(score), level, factors: factors.slice(0, 6) }
}

/**
 * 计算一条交易建议的价格/仓位。
 * @param quote - parsed quote
 * @param indicators - computed indicators
 * @param kline - { bars }
 * @param action - 'buy' | 'sell' | 'auto'
 * @param riskProfile - 0..10
 */
function calcAdvice(quote, indicators, kline, action, riskProfile) {
  const price = quote.price
  const bars = kline.bars
  const closes = bars.map((b) => b.close)
  const last = bars.at(-1)
  const atrV = indicators.atr14 ?? price * 0.02
  const atrPct = price > 0 ? (atrV / price) * 100 : 3
  const ma20 = indicators.ma?.ma20
  const ma60 = indicators.ma?.ma60
  const rsi6 = indicators.rsi?.rsi6
  const rsi12 = indicators.rsi?.rsi12

  // 支撑/压力：近期 20 根 K 线的低点/高点，结合 MA20/MA60
  const recent = bars.slice(-20)
  const low20 = Math.min(...recent.map((b) => b.low))
  const high20 = Math.max(...recent.map((b) => b.high))
  const supports = [low20, ma20, ma60].filter((v) => v !== null && v !== undefined && v < price)
  const resistances = [high20, ma20, ma60].filter((v) => v !== null && v !== undefined && v > price)
  const support = supports.length > 0 ? Math.max(...supports) : price * 0.95
  const resistance = resistances.length > 0 ? Math.min(...resistances) : price * 1.05

  // 多因子信号评分（趋势/动量/量能），供 auto 判断与置信度输出
  const sig = signalScoreFor(quote, indicators)

  // 自动判断动作：优先信号分；极端 RSI 仅在中性信号分时微调方向
  let act = action
  if (act === 'auto' || act === undefined) {
    if (sig.score >= 2) act = 'buy'
    else if (sig.score <= -2) act = 'sell'
    else if (rsi6 !== null && rsi6 !== undefined && rsi6 <= 20 && sig.score >= -1) act = 'buy'
    else if (rsi6 !== null && rsi6 !== undefined && rsi6 >= 80 && sig.score <= 1) act = 'sell'
    else act = price < ma60 ? 'sell' : 'buy'
  }
  if (act !== 'buy' && act !== 'sell') act = 'buy'

  let trigger, target, stop, positionPct, direction
  if (act === 'buy') {
    direction = '买入'
    // 触发价：回调至支撑/MA 附近（取现价与支撑之间较近的可成交价位）
    const pullback = price - 0.6 * atrV
    trigger = round2(Math.max(pullback, Math.min(support, price)))
    // 目标价：按风险偏好定 R 倍数（6.5 → 约 2.2R）
    const rr = 1.4 + riskProfile * 0.12
    target = round2(trigger + rr * (price - trigger) + 0.5 * atrV)
    stop = round2(trigger - 1.5 * atrV)
    positionPct = positionPctFor(atrPct, riskProfile)
  } else {
    direction = '卖出'
    // 触发价：反弹至压力/MA 附近
    const bounce = price + 0.6 * atrV
    trigger = round2(Math.min(bounce, Math.max(resistance, price)))
    target = round2(Math.max(support, trigger - 1.5 * atrV))
    stop = round2(trigger + 1.2 * atrV) // 卖出建议的"止损"= 卖飞回补位
    positionPct = Math.min(50, Math.max(10, Math.round(atrPct * 8 / 5) * 5))
  }

  return {
    symbol: quote.symbol,
    name: quote.name,
    date: last?.date,
    action: act,
    actionLabel: direction,
    price,
    trigger,
    target,
    stop,
    positionPct,
    atr: atrV,
    atrPct: round(atrPct),
    support: round2(support),
    resistance: round2(resistance),
    rsi6,
    signalScore: sig.score,
    confidence: sig.level,
    factors: sig.factors,
    basis: `ATR=${round(atrV)}(${round(atrPct)}%) 支撑=${round2(support)} 压力=${round2(resistance)} 信号分=${sig.score}(${sig.level}) ${sig.factors.join(' ')}`,
  }
}

// ---------------------------------------------------------------------------
// 仓位建议存储（positions.json）
// ---------------------------------------------------------------------------

/** Load the positions document. */
async function loadPositions(root) {
  const doc = await readJson(join(root, POSITIONS_FILE))
  if (doc === null || !Array.isArray(doc.positions)) return { version: 1, positions: [], updatedAt: null }
  return doc
}

/** Save the positions document. */
async function savePositions(root, doc) {
  doc.updatedAt = new Date().toISOString()
  await writeJson(join(root, POSITIONS_FILE), doc)
}

/** Load the sentiment records document. */
async function loadSentiment(root) {
  const doc = await readJson(join(root, SENTIMENT_FILE))
  if (doc === null || !Array.isArray(doc.records)) return { version: 1, records: [], updatedAt: null }
  return doc
}

/** Save the sentiment records document. */
async function saveSentiment(root, doc) {
  doc.updatedAt = new Date().toISOString()
  await writeJson(join(root, SENTIMENT_FILE), doc)
}

// ---------------------------------------------------------------------------
// 模拟盘账户存储（paper.json）
// ---------------------------------------------------------------------------

/**
 * 模拟盘账户文档结构：
 * {
 *   version: 1,
 *   initialCash: 100000,        // 初始本金
 *   cash: 100000,               // 可用现金
 *   positions: {                // 持仓：symbol -> 记录
 *     sz300124: { name, shares, avgCost, updatedAt }
 *   },
 *   trades: [ { id, date, symbol, name, action, price, shares, amount, positionId?, createdAt } ],
 *   updatedAt
 * }
 */

/** Load the paper account document (null when not initialized). */
async function loadPaper(root) {
  const doc = await readJson(join(root, PAPER_FILE))
  if (doc === null || typeof doc !== 'object' || typeof doc.initialCash !== 'number') return null
  return doc
}

/** Save the paper account document. */
async function savePaper(root, doc) {
  doc.updatedAt = new Date().toISOString()
  await writeJson(join(root, PAPER_FILE), doc)
}

/** Create a fresh paper account with the given initial cash. */
function newPaperAccount(initialCash) {
  return {
    version: 1,
    initialCash,
    cash: initialCash,
    positions: {},
    trades: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/** Round a trade amount to cents. */
function roundMoney(value) {
  return Math.round(value * 100) / 100
}

/** Parse a shares count to a valid 100-lot multiple (A股一手 = 100 股). */
function normalizeShares(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error('paper tools: shares must be a positive number')
  return Math.floor(n / LOT_SIZE) * LOT_SIZE
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
      const outputPath = args.output_path ?? join(dataRoot, 'reports', reportFileName(date, symbols))
      await mkdir(join(outputPath, '..'), { recursive: true })
      const markdown = `# 个股分析报告（${date}）\n\n> 数据来源：腾讯公开行情；仅供学习参考，不构成投资建议。\n\n${sections.join('\n')}`
      await writeFile(outputPath, markdown, 'utf8')
      return { path: outputPath, date, rows }
    },
    presentCall: args => ({ card: 'generic', title: 'Stock report', kind: 'other', rawInput: args }),
  }))

  // --- sentiment_sources ---------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'sentiment_sources',
    description: '权威信息源白名单（舆情分析只采信这些网站）：官方（政府网/部委/新华社/人民日报/央视/交易所公告）'
      + '与主流财经媒体（财联社/证券时报/上证报/中证报等）。舆情搜索时必须只采用本清单中的来源。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sources: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              官方: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    domain: { type: 'string', required: true },
                  },
                },
              },
              财经: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    domain: { type: 'string', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: Object.entries(value.sources)
          .map(([tier, list]) => `【${tier}】\n` + list.map((s) => `- ${s.name} (${s.domain})`).join('\n'))
          .join('\n'),
      }],
    },
    async execute() {
      return { sources: SENTIMENT_SOURCES }
    },
    presentCall: () => ({ card: 'generic', title: 'Sentiment whitelist', kind: 'read' }),
  }))

  // --- sentiment_pick ------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'sentiment_pick',
    description: '从自选股客观数据中挑选当日最需要做舆情调查的股票（默认最多 5 只，原则每日不超过 5 只）。'
      + '打分维度：当日异动（涨跌停/大幅波动/量比/振幅）+ 技术信号（RSI 超买超卖/KDJ 极端/均线破位突破/MACD）。'
      + '返回按分数排序的候选清单及挑选理由，供模型对候选逐一做权威网站舆情搜索。',
    parameters: {
      limit: { type: 'integer', description: '最多返回几只（默认 5，不超过 5）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', required: true },
          candidates: {
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
                amount: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                volumeRatio: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                score: { type: 'number', required: true },
                reasons: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `【${value.date} 舆情调查候选】\n` + value.candidates.map((c, i) =>
          `${i + 1}. ${c.name}(${c.symbol}) 分=${c.score} 现价=${c.price ?? '-'} (${c.changePct ?? '-'}%)\n`
          + `   理由：${c.reasons.join('、') || '无突出信号'}`).join('\n'),
      }],
    },
    async execute(args) {
      const doc = await loadWatchlist(dataRoot)
      if (doc.codes.length === 0) {
        throw new Error('sentiment_pick: the watchlist is empty; add codes with watchlist_add first')
      }
      const limit = args.limit === undefined ? DEFAULT_MAX_PICKS : Math.max(1, Math.min(DEFAULT_MAX_PICKS, args.limit))
      const candidates = await pickSentimentCandidates(dataRoot, doc.codes, limit, timeoutMs)
      return { date: today(), candidates }
    },
    presentCall: () => ({ card: 'generic', title: 'Pick sentiment candidates', kind: 'other' }),
  }))

  // --- sentiment_record ----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'sentiment_record',
    description: '记录一只股票的舆情分析结论（模型完成权威网站搜索与矛盾分析后调用本工具持久化，防遗忘）。'
      + '字段含消息摘要、来源、受众定位（老百姓/机构/外资/产业界）、解读方向、矛盾检验命中项、反身性定性、'
      + '结论倾向（偏多/偏空/中性）与一句话结论。',
    parameters: {
      code: { type: 'string', required: true, description: '股票代码，如 600519 或 sh600519。' },
      date: { type: 'string', description: '分析日期，默认今天 (YYYY-MM-DD)。' },
      sources: { type: 'array', required: true, description: '采信的权威来源列表（网站名，须来自 sentiment_sources 白名单）。', items: { type: 'string' } },
      messages: { type: 'array', required: true, description: '消息内容摘要（每条一句）。', items: { type: 'string' } },
      audience: { type: 'string', description: '受众定位：老百姓 / 机构 / 外资 / 产业界。' },
      audience_read: { type: 'string', description: '解读方向：反着看 / 警告或通知 / 兑现验证 / 看订单成本。' },
      conflict_checks: { type: 'array', description: '矛盾检验命中项（动机/反说/利益/措辞/兑现，每条一句）。', items: { type: 'string' } },
      reflexivity: { type: 'string', description: '反身性定性：政府行为→传导路径→对实际价值的影响（一句话）。' },
      bias: { type: 'string', description: '结论倾向：偏多 / 偏空 / 中性。' },
      conclusion: { type: 'string', required: true, description: '一句话结论（含对股价的真实含义）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          name: { type: 'string', required: true },
          date: { type: 'string', required: true },
          recordCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已记录 ${value.name}(${value.symbol}) ${value.date} 舆情结论 (id=${value.id})` }],
    },
    async execute(args) {
      const symbol = normalizeCode(args.code)
      const quote = await quoteOf(symbol, timeoutMs)
      const doc = await loadSentiment(dataRoot)
      const id = `s${Date.now()}${Math.floor(Math.random() * 1000)}`
      const record = {
        id,
        date: args.date ?? today(),
        symbol,
        name: quote.name ?? symbol,
        sources: args.sources,
        messages: args.messages,
        audience: args.audience ?? null,
        audience_read: args.audience_read ?? null,
        conflict_checks: args.conflict_checks ?? [],
        reflexivity: args.reflexivity ?? null,
        bias: args.bias ?? '中性',
        conclusion: args.conclusion,
        createdAt: new Date().toISOString(),
      }
      doc.records.push(record)
      await saveSentiment(dataRoot, doc)
      return { id, symbol, name: record.name, date: record.date, recordCount: doc.records.length }
    },
    presentCall: args => ({ card: 'generic', title: 'Record sentiment analysis', kind: 'edit', rawInput: args }),
  }))

  // --- sentiment_list ------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'sentiment_list',
    description: '列出已记录的舆情分析结论，可按日期过滤（默认全部）。供每日分析前回顾历史舆情，避免重复调查。',
    parameters: {
      date: { type: 'string', description: '只列出某天 (YYYY-MM-DD) 的记录；缺省列出全部。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                date: { type: 'string', required: true },
                symbol: { type: 'string', required: true },
                name: { type: 'string', required: true },
                sources: { type: 'array', required: true, items: { type: 'string' } },
                messages: { type: 'array', required: true, items: { type: 'string' } },
                audience: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                audience_read: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                conflict_checks: { type: 'array', required: true, items: { type: 'string' } },
                reflexivity: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                bias: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                conclusion: { type: 'string', required: true },
                createdAt: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.records.length === 0 ? '(无舆情记录)'
          : value.records.map((r) => `[${r.date}] ${r.name}(${r.symbol}) 倾向=${r.bias}\n  结论：${r.conclusion}`).join('\n'),
      }],
    },
    async execute(args) {
      const doc = await loadSentiment(dataRoot)
      const records = args.date ? doc.records.filter((r) => r.date === args.date) : doc.records
      return { records: records.slice().reverse() }
    },
    presentCall: () => ({ card: 'generic', title: 'List sentiment records', kind: 'read' }),
  }))

  // --- advice_calc ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'advice_calc',
    description: '按技术位计算一条交易建议的价格与数量：触发价/目标价/止损价/建议股数。'
      + '基于 ATR 波动率、均线、近期支撑压力与风险偏好（0 最保守~10 最激进，默认 6.5）自动定档；'
      + '建议股数按模拟盘总资产×仓位档位÷触发价折算为 100 股整数倍（A股一手），供 position_record 直接登记。'
      + 'action 可指定 buy/sell，或 auto 由技术面自动判断。返回数值供模型整合进最终建议（模型可酌情微调）。',
    parameters: {
      code: { type: 'string', required: true, description: '股票代码，如 600519 或 sh600519。' },
      action: { type: 'string', description: 'buy=买入 / sell=卖出 / auto=按技术面自动（默认 auto）。' },
      risk_profile: { type: 'number', description: '风险偏好 0~10（默认 6.5）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          name: { type: 'string', required: true },
          date: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          action: { type: 'string', required: true },
          actionLabel: { type: 'string', required: true },
          price: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
          trigger: { type: 'number', required: true },
          target: { type: 'number', required: true },
          stop: { type: 'number', required: true },
          positionPct: { type: 'integer', required: true },
          shares: { type: 'integer', required: true },
          amount: { type: 'number', required: true },
          sizingBasis: { type: 'string', required: true },
          atr: { type: 'number', required: true },
          atrPct: { type: 'number', required: true },
          support: { type: 'number', required: true },
          resistance: { type: 'number', required: true },
          rsi6: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
          signalScore: { type: 'number', required: true },
          confidence: { type: 'string', required: true },
          factors: { type: 'array', required: true, items: { type: 'string' } },
          basis: { type: 'string', required: true },
          dataDate: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          phase: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.name}(${value.symbol}) ${value.actionLabel}建议\n`
          + `数据基准日 ${value.dataDate ?? '-'}（${value.phase ?? '-'}）\n`
          + `建议${value.actionLabel}价 ${value.trigger} ｜ 目标价 ${value.target} ｜ 止损价 ${value.stop}\n`
          + `建议数量 ${value.shares} 股（约 ${value.amount} 元，参考仓位 ${value.positionPct}%）\n`
          + `定量依据：${value.sizingBasis}\n`
          + `信号分 ${value.signalScore}（${value.confidence}）${value.factors.join(' ')}\n`
          + `依据：${value.basis}`,
      }],
    },
    async execute(args) {
      const symbol = normalizeCode(args.code)
      const kline = await klineWithCache(dataRoot, symbol, klineDays, timeoutMs)
      // 预测数据基准（时间模型）：盘中/盘前忽略 T0 当日未收盘数据，只用 T-1 收盘
      const f = barsForForecast(kline.bars)
      const bars = f.bars
      const last = bars.at(-1)
      // 以数据基准日收盘价构造静态 quote（不引入 T0 盘中实时价），供价位定档
      const prev = bars.at(-2)
      const price = last?.close ?? null
      const quote = {
        symbol,
        name: kline.name ?? symbol,
        price,
        prevClose: prev?.close ?? null,
        changePct: price !== null && prev?.close ? round2((price - prev.close) / prev.close * 100) : null,
        volumeRatio: null,
        change: null,
      }
      const indicators = computeIndicators(bars)
      const risk = args.risk_profile ?? DEFAULT_RISK_PROFILE
      const advice = calcAdvice(quote, indicators, { bars }, args.action ?? 'auto', risk)
      advice.dataDate = f.dataDate
      advice.phase = currentPhase()
      advice.basis = `数据基准 ${f.dataDate ?? '-'}（${advice.phase}）｜ ${f.note}｜ ${advice.basis}`
      // 数量定档：把「仓位档位」折算成可登记的股数（100 股整数倍）。
      // 买入按模拟盘总资产×档位÷触发价；卖出直接对齐当前持仓股数。
      const account = await loadPaper(dataRoot)
      let totalAssets = DEFAULT_PAPER_CASH
      let holdingShares = 0
      if (account !== null) {
        try {
          const summary = await summarizePaperWithQuotes(account, timeoutMs)
          totalAssets = summary.totalAssets
        } catch { /* 行情失败时退回默认本金口径 */ }
        holdingShares = account.positions?.[symbol]?.shares ?? 0
      }
      if (advice.action === 'sell') {
        advice.shares = holdingShares
        advice.amount = roundMoney(holdingShares * advice.trigger)
        advice.sizingBasis = holdingShares > 0
          ? `模拟盘 ${symbol} 全部持仓 ${holdingShares} 股，按建议价 ${advice.trigger} 卖出`
          : `模拟盘无 ${symbol} 持仓，shares=0（仅预测观察）`
      } else {
        const budget = totalAssets * (advice.positionPct ?? 0) / 100
        const lots = advice.trigger > 0 ? Math.floor(budget / advice.trigger / LOT_SIZE) * LOT_SIZE : 0
        advice.shares = lots
        advice.amount = roundMoney(lots * advice.trigger)
        advice.sizingBasis = `总资产 ${totalAssets} 元 × 档位 ${advice.positionPct}% = 预算 ${round2(budget)} 元 `
          + `÷ ${advice.trigger} → ${lots} 股（100股整数倍）`
      }
      return advice
    },
    presentCall: args => ({ card: 'generic', title: 'Calc advice', kind: 'other', rawInput: args }),
  }))

  // --- position_record -----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'position_record',
    description: '记录一条交易建议（挂单）到本地 positions.json，状态默认"未执行"（pending），防遗忘。'
      + '挂单以【股数 shares】为准（A股一手=100股，自动取整到整数倍）：buy 必须给出 shares；'
      + 'sell 缺省 shares 表示卖出该股全部持仓。position_pct 仅作备注，不再用于计算成交数量。'
      + '自动标注产生时段 phase（pre_market 盘前 / intraday 盘中 / after_hours 盘后）：盘中记录按 T-1 数据、'
      + '盘后记录按 T0 数据；挂单（kind=order，默认）统一在建议日期之后第一个交易日（T+1）由 paper_settle 验单，'
      + 'kind=prediction 为纯预测观察不参与验单。'
      + '若同一股票已有未执行的同类建议会提示（防止重复下单）。用户反馈执行情况后再用 position_update 更新状态。',
    parameters: {
      code: { type: 'string', required: true, description: '股票代码，如 600519 或 sh600519。' },
      action: { type: 'string', required: true, description: 'buy=买入 / sell=卖出 / hold=持有。' },
      price: { type: 'number', required: true, description: '记录时现价。' },
      advice_price: { type: 'number', required: true, description: '建议成交价（触发价/挂单价）。' },
      shares: { type: 'integer', description: '建议股数（A股一手=100股，自动取整到100股整数倍）。buy 必填；sell 缺省=卖出全部持仓。' },
      target_price: { type: 'number', description: '目标价（卖出建议可缺省）。' },
      stop_loss: { type: 'number', description: '止损价（卖出建议可缺省，此时为卖飞回补位）。' },
      position_pct: { type: 'integer', description: '（可选备注）参考仓位比例%；成交数量以 shares 为准。' },
      kind: { type: 'string', description: 'order=挂单（默认，T+1 验单成交） / prediction=预测观察（不验单）。' },
      reason: { type: 'string', description: '一句话逻辑（技术面+舆情面）。' },
      sentiment_id: { type: 'string', description: '关联的舆情记录 id（如有）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          name: { type: 'string', required: true },
          status: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          phase: { type: 'string', required: true },
          dataDate: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          shares: { type: 'integer', required: true },
          advicePrice: { type: 'number', required: true },
          amount: { type: 'number', required: true },
          duplicateWarning: { type: 'string', required: true },
          positionCount: { type: 'integer', required: true },
          pendingBuyShares: { type: 'integer', required: true },
          pendingBuyAmount: { type: 'number', required: true },
          pendingSellShares: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已记录挂单 ${value.name}(${value.symbol}) (id=${value.id}) 状态=${value.status}`
          + ` 时段=${value.phase} 数据基准=${value.dataDate ?? '-'} 类型=${value.kind}\n`
          + `${value.action === 'buy' ? '买入' : '卖出'} ${value.shares}股 @ ${value.advicePrice} = ${value.amount}元\n`
          + (value.duplicateWarning ? `⚠ ${value.duplicateWarning}\n` : '')
          + `当前未执行挂单：买入 ${value.pendingBuyShares}股 / ${value.pendingBuyAmount}元`
          + `，卖出 ${value.pendingSellShares}股`,
      }],
    },
    async execute(args) {
      const symbol = normalizeCode(args.code)
      const quote = await quoteOf(symbol, timeoutMs)
      const doc = await loadPositions(dataRoot)
      const id = `p${Date.now()}${Math.floor(Math.random() * 1000)}`
      const phase = currentPhase()
      const kind = args.kind === 'prediction' ? 'prediction' : 'order'
      // 数据基准：盘中/盘前忽略 T0（当日未收盘），用 T-1；盘后用最近交易日。
      // 这里尽力从行情/缓存取最近已收盘交易日，失败则回退到记录日。
      let dataDate = null
      try {
        const kline = await klineWithCache(dataRoot, symbol, klineDays, timeoutMs)
        const f = barsForForecast(kline.bars)
        dataDate = f.dataDate
      } catch {
        dataDate = phase === 'after_hours' ? today() : null
      }
      const duplicate = doc.positions.find((p) => p.symbol === symbol && p.action === args.action && (p.kind ?? 'order') === kind && p.status === 'pending')
      // 数量定档：挂单以股数为准。buy 必填 shares；sell 缺省则对齐当前持仓（全部卖出）。
      let shares = args.shares === undefined || args.shares === null ? null : normalizeShares(args.shares)
      let sharesNote = ''
      if (shares === null && args.action === 'sell') {
        const account = await loadPaper(dataRoot)
        shares = account?.positions?.[symbol]?.shares ?? 0
        sharesNote = '（缺省=全部持仓）'
      }
      if ((args.action === 'buy' || args.action === 'sell') && kind === 'order' && !(shares > 0)) {
        throw new Error('position_record: 挂单必须给出 shares（A股100股整数倍）；buy 必填，sell 缺省时才按全部持仓')
      }
      const advicePrice = args.advice_price
      const amount = roundMoney((shares ?? 0) * advicePrice)
      const duplicateWarning = duplicate
        ? `注意：${quote.name ?? symbol} 已有未执行的${args.action === 'buy' ? '买入' : '卖出'}挂单（id=${duplicate.id}，`
          + `${duplicate.shares ?? '-'}股 @ ${duplicate.advicePrice}），请确认是否追加或更新`
        : ''
      doc.positions.push({
        id,
        date: today(),
        symbol,
        name: quote.name ?? symbol,
        action: args.action,
        kind,
        phase,
        dataDate,
        price: args.price,
        advicePrice,
        shares,
        amount,
        targetPrice: args.target_price ?? null,
        stopLoss: args.stop_loss ?? null,
        positionPct: args.position_pct ?? null,
        reason: (args.reason ?? null) === null ? null : `${args.reason}${sharesNote}`,
        sentimentId: args.sentiment_id ?? null,
        status: 'pending',
        createdAt: new Date().toISOString(),
      })
      await savePositions(dataRoot, doc)
      const pendingOf = (action) => doc.positions.filter((p) => p.status === 'pending' && p.action === action)
      const sumShares = (list) => list.reduce((s, p) => s + (p.shares ?? 0), 0)
      const sumAmount = (list) => roundMoney(list.reduce((s, p) => s + ((p.shares ?? 0) * (p.advicePrice ?? 0)), 0))
      const pendingBuys = pendingOf('buy')
      const pendingSells = pendingOf('sell')
      return {
        id, symbol, name: quote.name ?? symbol, status: 'pending',
        kind, phase, dataDate,
        shares: shares ?? 0, advicePrice, amount,
        duplicateWarning, positionCount: doc.positions.length,
        pendingBuyShares: sumShares(pendingBuys), pendingBuyAmount: sumAmount(pendingBuys),
        pendingSellShares: sumShares(pendingSells),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Record position advice', kind: 'edit', rawInput: args }),
  }))

  // --- position_list -------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'position_list',
    description: '列出本地记录的交易建议（挂单），可按状态过滤：pending=未执行（默认重点展示）、executed=已执行、'
      + 'cancelled=已取消、all=全部。返回未执行挂单的买入股数/金额与卖出股数合计，供防遗忘核对。'
      + '每条含时段 phase、数据基准 dataDate 与类型 kind（order 挂单 / prediction 预测观察）。',
    parameters: {
      status: { type: 'string', description: 'pending / executed / cancelled / all（默认 pending）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          positions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                date: { type: 'string', required: true },
                symbol: { type: 'string', required: true },
                name: { type: 'string', required: true },
                action: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                phase: { type: 'string', required: true },
                dataDate: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                price: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                advicePrice: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                shares: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
                amount: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                targetPrice: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                stopLoss: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                positionPct: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
                reason: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                sentimentId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                status: { type: 'string', required: true },
                createdAt: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                updatedAt: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                settledAt: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                cancelledAt: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                settle: {
                  required: true,
                  oneOf: [
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        date: { type: 'string', required: true },
                        low: { type: 'number', required: true },
                        high: { type: 'number', required: true },
                        result: { type: 'string', required: true },
                        reason: { type: 'string', required: true },
                      },
                    },
                    { type: 'null' },
                  ],
                },
              },
            },
          },
          pendingBuyShares: { type: 'integer', required: true },
          pendingBuyAmount: { type: 'number', required: true },
          pendingSellShares: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.positions.length === 0 ? '(无匹配建议)'
          : value.positions.map((p) =>
            `[${p.status}] ${p.date} ${p.name}(${p.symbol}) ${p.action}(${p.kind ?? 'order'}/${p.phase ?? '-'}) `
            + `挂单 ${p.shares ?? '-'}股 @ ${p.advicePrice ?? '-'}${p.amount ? ` = ${p.amount}元` : ''} `
            + `目标=${p.targetPrice ?? '-'} 止损=${p.stopLoss ?? '-'} `
            + `${p.reason ? `｜${p.reason}` : ''} (id=${p.id})`).join('\n')
          + `\n--- 未执行挂单：买入 ${value.pendingBuyShares}股 / ${value.pendingBuyAmount}元`
          + `，卖出 ${value.pendingSellShares}股 ---`,
      }],
    },
    async execute(args) {
      const doc = await loadPositions(dataRoot)
      const status = args.status ?? 'pending'
      const positions = status === 'all' ? doc.positions : doc.positions.filter((p) => p.status === status)
      const pendingAll = doc.positions.filter((p) => p.status === 'pending')
      const sumShares = (action) => pendingAll
        .filter((p) => p.action === action)
        .reduce((s, p) => s + (p.shares ?? 0), 0)
      const sumAmount = (action) => roundMoney(pendingAll
        .filter((p) => p.action === action)
        .reduce((s, p) => s + ((p.shares ?? 0) * (p.advicePrice ?? 0)), 0))
      const pendingBuyShares = sumShares('buy')
      const pendingBuyAmount = sumAmount('buy')
      const pendingSellShares = sumShares('sell')
      const normalize = (p) => ({
        id: p.id, date: p.date, symbol: p.symbol, name: p.name,
        action: p.action, kind: p.kind ?? 'order', phase: p.phase ?? 'after_hours', dataDate: p.dataDate ?? null,
        price: p.price ?? null, advicePrice: p.advicePrice ?? null,
        shares: p.shares ?? null,
        amount: p.amount ?? ((p.shares ?? 0) * (p.advicePrice ?? 0) || null),
        targetPrice: p.targetPrice ?? null, stopLoss: p.stopLoss ?? null,
        positionPct: p.positionPct ?? null, reason: p.reason ?? null, sentimentId: p.sentimentId ?? null,
        status: p.status, createdAt: p.createdAt ?? null, updatedAt: p.updatedAt ?? null,
        settledAt: p.settledAt ?? null, cancelledAt: p.cancelledAt ?? null,
        settle: p.settle ?? null,
      })
      return {
        positions: positions.slice().reverse().map(normalize),
        pendingBuyShares, pendingBuyAmount, pendingSellShares,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List position advice', kind: 'read' }),
  }))

  // --- position_update -----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'position_update',
    description: '更新一条交易建议的执行状态：用户反馈"已执行"→ executed，"放弃/取消"→ cancelled。'
      + '未反馈默认保持 pending（未执行）。找不到 id 会报错。',
    parameters: {
      id: { type: 'string', required: true, description: '建议 id（position_record / position_list 返回）。' },
      status: { type: 'string', required: true, description: 'executed=已执行 / cancelled=已取消。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          updated: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          pendingBuyShares: { type: 'integer', required: true },
          pendingBuyAmount: { type: 'number', required: true },
          pendingSellShares: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.updated
          ? `建议 ${value.id} 已标记为 ${value.status}；未执行挂单：买入 ${value.pendingBuyShares}股 / ${value.pendingBuyAmount}元，卖出 ${value.pendingSellShares}股`
          : `未找到建议 ${value.id}`,
      }],
    },
    async execute(args) {
      const doc = await loadPositions(dataRoot)
      const target = doc.positions.find((p) => p.id === args.id)
      if (target === undefined) {
        return { updated: false, id: args.id, status: args.status, pendingBuyShares: 0, pendingBuyAmount: 0, pendingSellShares: 0 }
      }
      if (args.status !== 'executed' && args.status !== 'cancelled') {
        throw new Error(`position_update: status must be "executed" or "cancelled", got ${JSON.stringify(args.status)}`)
      }
      target.status = args.status
      target.updatedAt = new Date().toISOString()
      await savePositions(dataRoot, doc)
      const pendingAll = doc.positions.filter((p) => p.status === 'pending')
      const sumShares = (action) => pendingAll
        .filter((p) => p.action === action)
        .reduce((s, p) => s + (p.shares ?? 0), 0)
      const pendingBuyShares = sumShares('buy')
      const pendingSellShares = sumShares('sell')
      const pendingBuyAmount = roundMoney(pendingAll
        .filter((p) => p.action === 'buy')
        .reduce((s, p) => s + ((p.shares ?? 0) * (p.advicePrice ?? 0)), 0))
      return { updated: true, id: args.id, status: args.status, pendingBuyShares, pendingBuyAmount, pendingSellShares }
    },
    presentCall: args => ({ card: 'generic', title: 'Update position status', kind: 'edit', rawInput: args }),
  }))

  // --- paper_init ----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'paper_init',
    description: '初始化模拟盘账户（默认本金 100000 元），持久化到 %DSH_HOME%\\stock\\paper.json。'
      + '模拟盘是"建议即操作"的自有账户：每条 buy/sell 建议被记录后，用 paper_execute_advice 将建议执行成模拟盘成交。'
      + '重复调用不重置；传 force=true 才清空重建。返回账户快照。',
    parameters: {
      initial_cash: { type: 'number', description: '初始本金（元），默认 100000。' },
      force: { type: 'boolean', description: 'true 时重置账户（清空持仓与流水），默认 false。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          initialized: { type: 'boolean', required: true },
          account: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              initialCash: { type: 'number', required: true },
              cash: { type: 'number', required: true },
              positionCount: { type: 'integer', required: true },
              tradeCount: { type: 'integer', required: true },
              totalCost: { type: 'number', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPaperAccount(value.account) }],
    },
    async execute(args) {
      const existing = await loadPaper(dataRoot)
      if (existing !== null && args.force !== true) {
        return { initialized: false, account: summarizePaper(existing) }
      }
      const account = newPaperAccount(args.initial_cash ?? DEFAULT_PAPER_CASH)
      await savePaper(dataRoot, account)
      return { initialized: true, account: summarizePaper(account) }
    },
    presentCall: args => ({ card: 'generic', title: 'Init paper account', kind: 'edit', rawInput: args }),
  }))

  // --- paper_account -------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'paper_account',
    description: '查看模拟盘账户：现金、持仓明细（股数/成本/现价/市值/浮盈亏）、总资产、收益率与交易流水摘要。'
      + '未初始化时返回提示（用 paper_init 开户）。现价来自腾讯实时行情。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          initialized: { type: 'boolean', required: true },
          account: { required: true, oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.initialized
          ? renderPaperAccount(value.account)
          : '模拟盘未初始化：调用 paper_init 开户（默认本金 10 万）。',
      }],
    },
    async execute() {
      const account = await loadPaper(dataRoot)
      if (account === null) return { initialized: false, account: null }
      const summary = await summarizePaperWithQuotes(account, timeoutMs)
      return { initialized: true, account: summary }
    },
    presentCall: () => ({ card: 'generic', title: 'Paper account', kind: 'read' }),
  }))

  // --- paper_execute_advice ------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'paper_execute_advice',
    description: '把一条 pending 挂单执行到模拟盘（"建议即操作"）：buy 按建议价买入该挂单记录的 shares 股'
      + '（缺省时退回 position_pct 预算口径），sell 按建议价卖出该挂单记录的 shares 股（缺省=全部持仓）。'
      + '执行后自动把该建议标记为 executed。可用 overrides（价格/股数/金额）微调。返回成交明细。',
    parameters: {
      id: { type: 'string', required: true, description: '待执行的建议 id（position_list 可查）。' },
      price: { type: 'number', description: '成交价覆盖（默认用建议的 advice_price）。' },
      shares: { type: 'integer', description: '股数覆盖：给出时优先于挂单记录的 shares。' },
      amount: { type: 'number', description: '金额覆盖：buy 时若给出则按此金额买入（优先于股数）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          executed: { type: 'boolean', required: true },
          trade: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              id: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              date: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              symbol: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              name: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              action: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              price: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              shares: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              amount: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              positionId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              createdAt: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
          cash: { type: 'number', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.executed
          ? `${value.trade.action === 'buy' ? '买入' : '卖出'} ${value.trade.name}(${value.trade.symbol}) `
            + `${value.trade.shares}股 @ ${value.trade.price} = ${value.trade.amount}元；剩余现金 ${value.cash}元`
          : `未执行：${value.message}`,
      }],
    },
    async execute(args) {
      const positionsDoc = await loadPositions(dataRoot)
      const position = positionsDoc.positions.find((p) => p.id === args.id)
      if (position === undefined) {
        return { executed: false, trade: emptyTrade(), cash: 0, message: `未找到建议 ${args.id}` }
      }
      if (position.status !== 'pending') {
        return { executed: false, trade: emptyTrade(), cash: 0, message: `建议 ${args.id} 状态为 ${position.status}，仅 pending 可执行` }
      }
      const account = await loadPaper(dataRoot)
      if (account === null) {
        return { executed: false, trade: emptyTrade(), cash: 0, message: '模拟盘未初始化，请先调用 paper_init 开户' }
      }

      const symbol = position.symbol
      const quote = await quoteOf(symbol, timeoutMs)
      const price = args.price ?? position.advicePrice ?? quote.price ?? 0
      if (!(price > 0)) return { executed: false, trade: emptyTrade(), cash: 0, message: '成交价无效' }

      const summary = await summarizePaperWithQuotes(account, timeoutMs)
      const totalAssets = summary.totalAssets

      let shares
      if (args.amount !== undefined && position.action === 'buy') {
        shares = Math.floor(args.amount / price / LOT_SIZE) * LOT_SIZE
      } else if (args.shares !== undefined) {
        shares = normalizeShares(args.shares)
      } else if (position.shares !== undefined && position.shares !== null && position.shares > 0) {
        // 挂单以股数为准（position_record 登记的 shares）
        shares = position.action === 'sell'
          ? Math.min(position.shares, account.positions[symbol]?.shares ?? 0)
          : position.shares
      } else if (position.action === 'buy') {
        // 兼容旧挂单（仅有 position_pct）：按总资产比例折算
        const budget = (totalAssets * (position.positionPct ?? 10)) / 100
        shares = Math.floor(budget / price / LOT_SIZE) * LOT_SIZE
      } else {
        // sell：默认卖全部持仓
        shares = account.positions[symbol]?.shares ?? 0
      }
      if (shares <= 0) {
        return { executed: false, trade: emptyTrade(), cash: 0, message: position.action === 'buy'
          ? '预算不足以买入 100 股（一手）'
          : `模拟盘无 ${symbol} 持仓可卖` }
      }

      const amount = roundMoney(shares * price)
      if (position.action === 'buy') {
        if (amount > account.cash) {
          return { executed: false, trade: emptyTrade(), cash: 0, message: `现金不足：需 ${amount} 元，可用 ${account.cash} 元` }
        }
        account.cash = roundMoney(account.cash - amount)
        const holding = account.positions[symbol] ?? { name: quote.name ?? symbol, shares: 0, avgCost: 0, updatedAt: null }
        const totalCost = holding.avgCost * holding.shares + amount
        holding.shares += shares
        holding.avgCost = roundMoney(totalCost / holding.shares)
        holding.updatedAt = new Date().toISOString()
        account.positions[symbol] = holding
      } else {
        const holding = account.positions[symbol]
        if (holding === undefined || holding.shares < shares) {
          return { executed: false, trade: emptyTrade(), cash: 0, message: `持仓不足：${symbol} 持有 ${holding?.shares ?? 0} 股，需卖 ${shares} 股` }
        }
        account.cash = roundMoney(account.cash + amount)
        holding.shares -= shares
        if (holding.shares === 0) delete account.positions[symbol]
      }

      const trade = {
        id: `t${Date.now()}${Math.floor(Math.random() * 1000)}`,
        date: today(),
        symbol,
        name: quote.name ?? symbol,
        action: position.action,
        price,
        shares,
        amount,
        positionId: position.id,
        createdAt: new Date().toISOString(),
      }
      account.trades.push(trade)
      await savePaper(dataRoot, account)

      position.status = 'executed'
      position.updatedAt = new Date().toISOString()
      await savePositions(dataRoot, positionsDoc)

      return { executed: true, trade, cash: account.cash, message: 'ok' }
    },
    presentCall: args => ({ card: 'generic', title: 'Execute advice on paper', kind: 'edit', rawInput: args }),
  }))

  // --- paper_trade ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'paper_trade',
    description: '在模拟盘手工成交一笔（不依赖建议记录）：buy 买入 / sell 卖出指定股数，按给定价格（默认实时价）成交，'
      + '更新现金与持仓。用于模拟盘日常调仓、止损/止盈操作。返回成交明细与最新现金。',
    parameters: {
      code: { type: 'string', required: true, description: '股票代码，如 600519 或 sh600519。' },
      action: { type: 'string', required: true, description: 'buy=买入 / sell=卖出。' },
      shares: { type: 'integer', required: true, description: '股数（自动取整到 100 股）。' },
      price: { type: 'number', description: '成交价（默认腾讯实时价）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          executed: { type: 'boolean', required: true },
          trade: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              id: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              date: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              symbol: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              name: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              action: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              price: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              shares: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              amount: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              positionId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              createdAt: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
          cash: { type: 'number', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.executed
          ? `${value.trade.action === 'buy' ? '买入' : '卖出'} ${value.trade.name}(${value.trade.symbol}) `
            + `${value.trade.shares}股 @ ${value.trade.price} = ${value.trade.amount}元；剩余现金 ${value.cash}元`
          : `未执行：${value.message}`,
      }],
    },
    async execute(args) {
      const account = await loadPaper(dataRoot)
      if (account === null) {
        return { executed: false, trade: emptyTrade(), cash: 0, message: '模拟盘未初始化，请先调用 paper_init 开户' }
      }
      if (args.action !== 'buy' && args.action !== 'sell') {
        return { executed: false, trade: emptyTrade(), cash: 0, message: `action 必须为 buy 或 sell，got ${JSON.stringify(args.action)}` }
      }
      const symbol = normalizeCode(args.code)
      const quote = await quoteOf(symbol, timeoutMs)
      const price = args.price ?? quote.price ?? 0
      if (!(price > 0)) return { executed: false, trade: emptyTrade(), cash: 0, message: '成交价无效' }
      const shares = normalizeShares(args.shares)
      const amount = roundMoney(shares * price)

      if (args.action === 'buy') {
        if (amount > account.cash) {
          return { executed: false, trade: emptyTrade(), cash: 0, message: `现金不足：需 ${amount} 元，可用 ${account.cash} 元` }
        }
        account.cash = roundMoney(account.cash - amount)
        const holding = account.positions[symbol] ?? { name: quote.name ?? symbol, shares: 0, avgCost: 0, updatedAt: null }
        const totalCost = holding.avgCost * holding.shares + amount
        holding.shares += shares
        holding.avgCost = roundMoney(totalCost / holding.shares)
        holding.updatedAt = new Date().toISOString()
        account.positions[symbol] = holding
      } else {
        const holding = account.positions[symbol]
        if (holding === undefined || holding.shares < shares) {
          return { executed: false, trade: emptyTrade(), cash: 0, message: `持仓不足：${symbol} 持有 ${holding?.shares ?? 0} 股，需卖 ${shares} 股` }
        }
        account.cash = roundMoney(account.cash + amount)
        holding.shares -= shares
        if (holding.shares === 0) delete account.positions[symbol]
      }

      const trade = {
        id: `t${Date.now()}${Math.floor(Math.random() * 1000)}`,
        date: today(),
        symbol,
        name: quote.name ?? symbol,
        action: args.action,
        price,
        shares,
        amount,
        positionId: null,
        createdAt: new Date().toISOString(),
      }
      account.trades.push(trade)
      await savePaper(dataRoot, account)
      return { executed: true, trade, cash: account.cash, message: 'ok' }
    },
    presentCall: args => ({ card: 'generic', title: 'Paper trade', kind: 'edit', rawInput: args }),
  }))

  // --- paper_settle --------------------------------------------------------
  // 「建议即挂单」规则：每天一早给出建议 = 挂出买/卖单（建议价）。验单时
  // 统一取建议日期之后第一个交易日（T+1）的最高/最低价，挂单价落在
  // [low, high] 区间内视为已成交（按挂单价记账）；落在区间外则挂单作废。
  // kind=prediction（预测观察）不参与验单，保持 pending 供人工跟进。
  ctx.tools.register(defineTool({
    name: 'paper_settle',
    description: 'T+1 验单结算（建议即挂单）：对每条 pending 的 order 挂单建议（kind=order），'
      + '取建议日期之后第一个交易日的最高/最低价，挂单价落在区间内 → 视为已成交并按挂单价记账到模拟盘'
      + '（buy 按挂单登记的 shares 股数买入，sell 按登记 shares 卖出、缺省卖全部持仓），建议置 executed；'
      + '落在区间外 → 挂单作废（cancelled）并记录偏离原因。kind=prediction（预测观察）不参与验单。'
      + 'preview=true 只试算不落库。已结算（settledAt）的建议不会重复处理。返回每条建议的判定明细。',
    parameters: {
      preview: { type: 'boolean', description: 'true 时只试算、不改动任何数据，默认 false。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          settled: { type: 'integer', required: true },
          filled: { type: 'integer', required: true },
          expired: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                symbol: { type: 'string', required: true },
                name: { type: 'string', required: true },
                action: { type: 'string', required: true },
                advicePrice: { type: 'number', required: true },
                settleDate: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                low: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                high: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                result: { type: 'string', required: true },
                shares: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
                price: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                amount: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPaperSettle(value) }],
    },
    async execute(args) {
      const preview = args.preview === true
      const positionsDoc = await loadPositions(dataRoot)
      const account = await loadPaper(dataRoot)
      if (account === null) {
        return { settled: 0, filled: 0, expired: 0, skipped: 0, results: [] }
      }

      const pending = positionsDoc.positions
        .filter((p) => p.status === 'pending')
        .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))

      const results = []
      let filled = 0
      let expired = 0
      let skipped = 0

      for (const position of pending) {
        const symbol = position.symbol
        const advicePrice = position.advicePrice ?? 0
        const base = {
          id: position.id, symbol, name: position.name ?? symbol,
          action: position.action, advicePrice, settleDate: null,
          low: null, high: null, result: 'skipped', shares: null, price: null, amount: null, reason: '',
        }
        // 预测观察（kind=prediction）不参与验单成交，保持 pending 供人工跟进
        if ((position.kind ?? 'order') === 'prediction') {
          skipped += 1
          results.push({ ...base, reason: 'kind=prediction 预测观察不参与验单，保持挂起' })
          continue
        }
        let kline
        try {
          kline = await klineWithCache(dataRoot, symbol, 60, timeoutMs)
        } catch (e) {
          skipped += 1
          results.push({ ...base, reason: `K线获取失败：${e.message}` })
          continue
        }
        const bars = kline.bars ?? []
        // 验单判定 bar：统一取「建议日期之后第一个交易日」（T+1 核算，时间周期为日）。
        // 盘中/盘后挂出的单最早只能在下一交易日成交：用建议日当天区间判定会
        // 产生马后炮（盘后挂单时当天已收盘；盘中挂单时当天数据未走完）。
        // 历史挂单（旧数据无 phase）同样按此规则顺延，避免用当日已发生价格回溯。
        const later = bars
          .filter((b) => b.date > position.date)
          .sort((a, b) => a.date.localeCompare(b.date))
        let bar = later[0]
        if (bar === undefined) {
          skipped += 1
          results.push({ ...base, reason: `无 ${position.date} 之后交易日K线，保持挂单` })
          continue
        }
        const low = bar.low
        const high = bar.high
        const inRange = advicePrice >= low && advicePrice <= high
        base.settleDate = bar.date
        base.low = low
        base.high = high

        if (!inRange) {
          // 挂单作废 + 记录偏离
          expired += 1
          base.result = 'expired'
          base.reason = `挂单价 ${advicePrice} 不在 ${bar.date} 区间 [${low}, ${high}] 内，未成交作废`
          if (!preview) {
            position.status = 'cancelled'
            position.cancelledAt = new Date().toISOString()
            position.settledAt = today()
            position.settle = { date: bar.date, low, high, result: 'expired', reason: base.reason }
          }
          results.push(base)
          continue
        }

        // 成交记账（按挂单价）
        const price = advicePrice
        let shares = null
        let amount = null
        if (position.action === 'buy') {
          // 挂单以股数为准：优先用 position_record 登记的 shares，旧挂单才退回仓位预算口径
          if (position.shares !== undefined && position.shares !== null && position.shares > 0) {
            shares = position.shares
          } else {
            const summary = await summarizePaperWithQuotes(account, timeoutMs)
            const budget = summary.totalAssets * (position.positionPct ?? 10) / 100
            shares = Math.floor(budget / price / LOT_SIZE) * LOT_SIZE
          }
          if (shares <= 0) {
            skipped += 1
            base.reason = `股数为 0（挂单未登记 shares），保持挂单`
            results.push(base)
            continue
          }
          amount = roundMoney(shares * price)
          if (amount > account.cash) {
            skipped += 1
            base.reason = `现金不足：需 ${amount} 元，可用 ${account.cash} 元，保持挂单`
            results.push(base)
            continue
          }
          if (!preview) {
            account.cash = roundMoney(account.cash - amount)
            const holding = account.positions[symbol] ?? { name: kline.name ?? symbol, shares: 0, avgCost: 0, updatedAt: null }
            const totalCost = holding.avgCost * holding.shares + amount
            holding.shares += shares
            holding.avgCost = roundMoney(totalCost / holding.shares)
            holding.updatedAt = new Date().toISOString()
            account.positions[symbol] = holding
          }
        } else {
          const holding = account.positions?.[symbol]
          // 卖出：挂单登记 shares 则卖该数量，缺省卖全部持仓
          const want = position.shares !== undefined && position.shares !== null && position.shares > 0
            ? position.shares
            : (holding?.shares ?? 0)
          shares = Math.min(want, holding?.shares ?? 0)
          if (shares <= 0) {
            skipped += 1
            base.reason = `模拟盘无 ${symbol} 持仓可卖（或可卖股数为 0），保持挂单`
            results.push(base)
            continue
          }
          amount = roundMoney(shares * price)
          if (!preview) {
            account.cash = roundMoney(account.cash + amount)
            holding.shares -= shares
            if (holding.shares === 0) delete account.positions[symbol]
          }
        }

        filled += 1
        base.result = 'filled'
        base.shares = shares
        base.price = price
        base.amount = amount
        base.reason = `挂单价 ${price} 落入 ${bar.date} 区间 [${low}, ${high}]，按挂单价${position.action === 'buy' ? '买入' : '卖出'}`
        if (!preview) {
          const trade = {
            id: `t${Date.now()}${Math.floor(Math.random() * 1000)}`,
            date: bar.date,
            symbol,
            name: kline.name ?? symbol,
            action: position.action,
            price,
            shares,
            amount,
            positionId: position.id,
            createdAt: new Date().toISOString(),
          }
          account.trades.push(trade)
          position.status = 'executed'
          position.updatedAt = new Date().toISOString()
          position.settledAt = today()
          position.settle = { date: bar.date, low, high, result: 'filled', reason: base.reason }
        }
        results.push(base)
      }

      if (!preview && (filled > 0 || expired > 0)) {
        await savePaper(dataRoot, account)
        await savePositions(dataRoot, positionsDoc)
      }
      return { settled: results.length, filled, expired, skipped, results }
    },
    presentCall: args => ({ card: 'generic', title: 'Settle paper orders', kind: 'edit', rawInput: args }),
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

// ---------------------------------------------------------------------------
// paper (模拟盘) renderers & helpers
// ---------------------------------------------------------------------------

/** Empty trade placeholder for failed executions. */
function emptyTrade() {
  return { id: null, date: null, symbol: null, name: null, action: null, price: null, shares: null, amount: null, positionId: null, createdAt: null }
}

/** Summarize an account without live quotes (cheap snapshot). */
function summarizePaper(account) {
  const positionCount = Object.keys(account.positions ?? {}).length
  const totalCost = Object.values(account.positions ?? {})
    .reduce((s, h) => s + h.avgCost * h.shares, 0)
  return {
    initialCash: account.initialCash,
    cash: account.cash,
    positionCount,
    tradeCount: (account.trades ?? []).length,
    totalCost: roundMoney(totalCost),
  }
}

/**
 * Summarize an account with live quotes: mark-to-market per holding,
 * total assets and total P&L.
 */
async function summarizePaperWithQuotes(account, timeoutMs) {
  const positions = []
  let marketValue = 0
  let totalCost = 0
  for (const [symbol, holding] of Object.entries(account.positions ?? {})) {
    let price = holding.avgCost
    let name = holding.name ?? symbol
    try {
      const quote = await quoteOf(symbol, timeoutMs)
      price = quote.price ?? price
      name = quote.name ?? name
    } catch { /* keep cost price when quote fails */ }
    const value = roundMoney(price * holding.shares)
    const cost = roundMoney(holding.avgCost * holding.shares)
    marketValue += value
    totalCost += cost
    positions.push({
      symbol,
      name,
      shares: holding.shares,
      avgCost: holding.avgCost,
      price,
      marketValue: value,
      cost,
      pnl: roundMoney(value - cost),
      pnlPct: cost > 0 ? round((value - cost) / cost * 100) : 0,
    })
  }
  positions.sort((a, b) => b.marketValue - a.marketValue)
  return {
    initialCash: account.initialCash,
    cash: account.cash,
    positionCount: positions.length,
    tradeCount: (account.trades ?? []).length,
    totalCost: roundMoney(totalCost),
    marketValue: roundMoney(marketValue),
    totalAssets: roundMoney(account.cash + marketValue),
    totalPnl: roundMoney(account.cash + marketValue - account.initialCash),
    totalPnlPct: round((account.cash + marketValue - account.initialCash) / account.initialCash * 100),
    positions,
  }
}

/** Render a paper account summary for the model-facing text block. */
function renderPaperAccount(account) {
  const lines = [
    `模拟盘 初始本金 ${account.initialCash}元 ｜ 现金 ${account.cash}元 ｜ 持仓 ${account.positionCount}只 ｜ 成交 ${account.tradeCount}笔`,
  ]
  if (account.totalAssets !== undefined) {
    lines.push(`总资产 ${account.totalAssets}元 ｜ 总盈亏 ${account.totalPnl}元 (${account.totalPnlPct}%) ｜ 市值 ${account.marketValue}元`)
  }
  for (const p of account.positions ?? []) {
    lines.push(`  ${p.name}(${p.symbol}) ${p.shares}股 成本${p.avgCost} 现价${p.price} 市值${p.marketValue} 浮盈亏${p.pnl} (${p.pnlPct}%)`)
  }
  return lines.join('\n')
}

/** Render a paper settlement (次日验单) result for the model-facing text block. */
function renderPaperSettle(value) {
  const tag = (r) => (r === 'filled' ? '✅成交' : r === 'expired' ? '❌作废' : '⏭跳过')
  const lines = [
    `挂单结算：共处理 ${value.settled} 条 ｜ 成交 ${value.filled} ｜ 作废 ${value.expired} ｜ 跳过 ${value.skipped}`,
  ]
  for (const r of value.results ?? []) {
    const range = r.low !== null && r.high !== null ? `区间[${r.low},${r.high}]` : '区间未知'
    if (r.result === 'filled') {
      lines.push(`  ${tag(r.result)} ${r.name}(${r.symbol}) ${r.action === 'buy' ? '买入' : '卖出'} `
        + `${r.shares}股 @ ${r.price} = ${r.amount}元（${r.settleDate} ${range}）`)
    } else {
      lines.push(`  ${tag(r.result)} ${r.name}(${r.symbol}) 挂单 ${r.advicePrice}（${r.settleDate} ${range}）${r.reason}`)
    }
  }
  return lines.join('\n')
}
