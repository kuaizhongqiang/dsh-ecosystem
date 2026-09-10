/**
 * embed —— 把 dsh web「内嵌进 VS Code」的能力层（milestone #2，#21/#22/#23）。
 *
 * 设计依据：docs/modules/dsh-vscode-embed-design.md。
 * - dsh 浏览器会话 cookie 为 HttpOnly; SameSite=Strict 且按 Host authority 命名，
 *   webview 顶级 vscode-webview:// 跨站 → iframe 里 cookie 自动登录不可用。
 * - 因此内嵌的前提是 dsh server 提供 embed 认证 seam（§9 S1：one-time embed token +
 *   `/api/embed/open` 302），本层做：能力探测 → seam 可用则内嵌，不可用则「浏览器打开」降级。
 *
 * 本模块为纯逻辑（可注入 fetch），单测见 embedModel.test.ts。
 */

/** 服务器是否声明支持 embed seam（探测路径，§9.1 S1/S2 共用）。 */
export const EMBED_CAPABILITY_PATH = '/api/embed/capability'

export interface EmbedTargetInput {
  /** dsh server 根地址（http://host:port，不含尾斜杠）。 */
  base: string
  /** launch-token（浏览器根路径登录用；扩展与 launcher 共享）。 */
  token?: string
  /** 可选：会话深链（seam 可用时内嵌到该会话页）。 */
  sessionId?: string
}

export type EmbedDecision =
  | { kind: 'embed'; url: string; reason: 'seam' }
  | { kind: 'fallback'; url: string; browserUrl: string; reason: 'no-token' | 'no-seam' | 'unreachable' }

export interface ProbeOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 进程内缓存探测结果（默认 true）。 */
  cache?: boolean
}

export interface SeamInfo {
  seam: boolean
  /** Embed-seam protocol version advertised by the server (absent if unknown). */
  version?: number
}

const capabilityCache = new Map<string, Promise<SeamInfo>>()

function baseOf(url: string): string {
  return url.replace(/\/+$/, '')
}

/** seam 打开 URL（§9 S1）：服务器校验 one-time token 后 302 到 path。 */
export function buildSeamOpenUrl(base: string, token: string, sessionId?: string): string {
  const b = baseOf(base)
  const path = sessionId ? `/session/${sessionId}` : '/'
  return `${b}/api/embed/open?t=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`
}

/** 无 seam 时的浏览器直开 URL（与现有 openInBrowser 语义一致）。 */
export function buildBrowserUrl(base: string, token?: string): string {
  const b = baseOf(base)
  return token && token.length > 0 ? `${b}/?token=${encodeURIComponent(token)}` : `${b}/`
}

async function probeOnce(base: string, opts: ProbeOptions): Promise<SeamInfo> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 2500
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${baseOf(base)}${EMBED_CAPABILITY_PATH}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return { seam: false }
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return { seam: false }
    const body = (await res.json()) as { seam?: boolean | string; enabled?: boolean | string; version?: unknown }
    const seam = body?.seam === true || body?.seam === 'true' || body?.enabled === true || body?.enabled === 'true'
    const version = typeof body?.version === 'number' && Number.isFinite(body.version) ? body.version : undefined
    return version === undefined ? { seam } : { seam, version }
  } catch {
    return { seam: false }
  } finally {
    clearTimeout(timer)
  }
}

/** 探测服务器 embed seam 能力与协议版本（404/超时/非 JSON 一律 seam=false；默认进程内缓存）。 */
export async function probeSeamInfo(base: string, opts: ProbeOptions = {}): Promise<SeamInfo> {
  const key = baseOf(base)
  if (opts.cache === false) return probeOnce(key, opts)
  const cached = capabilityCache.get(key)
  if (cached) return cached
  const p = probeOnce(key, opts)
  capabilityCache.set(key, p)
  return p
}

/** 便捷布尔形态（保留原 API；语义 = probeSeamInfo(base).seam）。 */
export async function probeSeamCapability(base: string, opts: ProbeOptions = {}): Promise<boolean> {
  return (await probeSeamInfo(base, opts)).seam
}

/** 清除能力缓存（测试与连接切换后用）。 */
export function resetSeamCapabilityCache(): void {
  capabilityCache.clear()
}

/**
 * 决策：seam 可用且有 token → 内嵌 seam URL；
 * 否则 → 浏览器直开 URL 的降级（no-token / no-seam / unreachable）。
 */
export async function decideEmbed(input: EmbedTargetInput, opts: ProbeOptions = {}): Promise<EmbedDecision> {
  const base = baseOf(input.base || '')
  if (!base) return { kind: 'fallback', url: '', browserUrl: '', reason: 'unreachable' }
  if (!input.token) {
    return { kind: 'fallback', url: base + '/', browserUrl: base + '/', reason: 'no-token' }
  }
  const info = await probeSeamInfo(base, opts)
  if (info.seam) {
    return {
      kind: 'embed',
      url: buildSeamOpenUrl(base, input.token, input.sessionId),
      reason: 'seam',
    }
  }
  return {
    kind: 'fallback',
    url: buildBrowserUrl(base, input.token),
    browserUrl: buildBrowserUrl(base, input.token),
    reason: 'no-seam',
  }
}
