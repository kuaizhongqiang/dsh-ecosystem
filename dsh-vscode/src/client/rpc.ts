/**
 * Unary RPC client for the current DSH /api channel (Typert Remote protocol).
 *
 * Wire protocol (mirrors @deepseek-ai/dsh-client-connection + api gateway):
 *   POST {base}/api/{namespace}/{method}
 *   body: { "type": "client-request", "rpcId": "<uuid>", "method": "<namespace>/<method>",
 *           "payload": { "args": { ... } } }
 *   response JSON: { "type": "server-response", "rpcId": "<same>",
 *                    "result": { ok:true, value } | { ok:false, error } }
 *
 * Every Remote payload is wrapped in a single `args` object (including the
 * `$events/result` endpoint). Authentication rides on the `Cookie` header that
 * the auth layer attaches to every request and WebSocket handshake.
 */

import { randomUUID } from 'node:crypto'
import type { AuthExchangeResult } from './auth.ts'
import type {
  ClientRequest,
  ClientResponse,
  RemoteEventResultPayload,
  RpcResult,
  ServerResponse,
} from './types.ts'

export interface RpcTarget {
  /** Base URL of the DSH web server, e.g. http://127.0.0.1:3080 (no trailing slash). */
  baseUrl: string
  /** Auth cookie value to attach as `Cookie:` on every request. Empty = none. */
  authCookie?: string
  /** Extra headers on every /api request. */
  extraHeaders?: Record<string, string>
}

export class RpcErrorResult extends Error {
  readonly code: string
  readonly details: unknown
  constructor(code: string, message: string, details: unknown) {
    super(message)
    this.name = 'RpcErrorResult'
    this.code = code
    this.details = details
  }
}

export class DshTransportError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'DshTransportError'
    this.status = status
  }
}

/** Normalize a server base URL: strip trailing slashes. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

export class DshRpcClient {
  private readonly baseUrl: string
  private readonly extraHeaders: Record<string, string>
  /** Latest auth cookie; updated by the auth exchange before first use. */
  private authCookie: string

  constructor(baseUrl: string, options: { authCookie?: string; extraHeaders?: Record<string, string> } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.authCookie = options.authCookie ?? ''
    this.extraHeaders = { ...(options.extraHeaders ?? {}) }
  }

  get url(): string {
    return this.baseUrl
  }

  /** Merge the authentication result (cookie) into this client. */
  applyAuth(auth: AuthExchangeResult): void {
    if (auth.cookie.length > 0) this.authCookie = auth.cookie
  }

  get cookie(): string {
    return this.authCookie
  }

  /** Headers shared by every /api request and WebSocket handshake. */
  requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...this.extraHeaders, ...extra }
    // dsh-auth cookie 必须总是带上：与手动配置的 Cookie（如残留的 Cloudflare
    // CF_Authorization）**合并**而非跳过——否则认证 cookie 被挤掉导致 401。
    if (this.authCookie.length > 0) {
      const existing = headers['Cookie']
      headers['Cookie'] = existing === undefined || existing.trim().length === 0
        ? this.authCookie
        : `${existing}; ${this.authCookie}`
    }
    return headers
  }

  /**
   * Call one unary RPC method. `method` is `<namespace>/<method>` (e.g.
   * `session/list`). The named `args` are wrapped in `{ args }` for transport.
   * Throws DshTransportError on HTTP/network failure, or RpcErrorResult when
   * the server answered with ok:false.
   */
  async call<T>(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const rpcId = randomUUID()
    const message: ClientRequest = {
      type: 'client-request',
      rpcId,
      method,
      payload: { args },
    }
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.requestHeaders() },
        body: JSON.stringify(message),
        signal,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new DshTransportError(`无法连接 DSH 服务 ${this.baseUrl}：${reason}`)
    }
    if (!response.ok) {
      throw new DshTransportError(
        `DSH RPC ${method} 传输失败：HTTP ${response.status}${response.redirected ? '（发生了重定向，可能被访问控制/反代拦截）' : ''}`,
        response.status,
      )
    }
    let envelope: ServerResponse
    try {
      envelope = (await response.json()) as ServerResponse
    } catch {
      const contentType = response.headers.get('content-type') ?? ''
      const hint = contentType.includes('html')
        ? '返回了 HTML（很可能被反向代理 / 访问控制拦截，未放行 /api）'
        : '响应不是合法 JSON'
      throw new DshTransportError(`DSH RPC ${method} ${hint}`)
    }
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
      throw new DshTransportError(`DSH RPC ${method} 响应 rpcId 不匹配或格式错误`)
    }
    return unwrapResult<T>(method, envelope.result)
  }

  /**
   * Answer one forwarded Remote event (approval / question waterfall) via the
   * `$events/result` unary endpoint. `value` is the domain response payload.
   */
  async respondEvent(result: RemoteEventResultPayload): Promise<void> {
    await this.call<unknown>(`$events/result`, result as unknown as Record<string, unknown>)
  }

  /**
   * Legacy alias kept for compatibility with the old approval/question flow.
   * The current DSH answers forwarded events through `respondEvent`; this
   * throws a clear error if still reached.
   */
  async respond(rpcId: string, _value: unknown): Promise<void> {
    throw new RpcErrorResult(
      'RESPONSE_REJECTED',
      `旧版应答通道已废弃（rpcId=${rpcId}）。请通过 $events/result 应答审批/提问。`,
      { rpcId },
    )
  }
}

export function unwrapResult<T>(method: string, result: RpcResult<unknown>): T {
  if (result.ok) return result.value as T
  throw new RpcErrorResult(result.error.code, result.error.message, result.error.details)
}

export type { ClientResponse }
