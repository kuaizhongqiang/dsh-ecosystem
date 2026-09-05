/**
 * DSH browser-session authentication.
 *
 * The current DSH requires a browser-session cookie on every /api request and
 * on the /api/remote.mux WebSocket handshake. That cookie can only be minted by
 * exchanging the Host's process launch token against the index route:
 *
 *   GET {base}/?token=<launchToken>   →  303 with Set-Cookie: dsh-auth-<hash>=v1...
 *
 * This module performs the exchange once, then exposes the cookie value so it
 * can be attached to every /api fetch and the WebSocket handshake. Clients that
 * don't need authentication (e.g. an already-unlocked local server) may skip
 * the exchange.
 */

import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface AuthExchangeResult {
  /** Raw cookie header value, e.g. `dsh-auth-<hash>=v1...`. Empty when unauthenticated. */
  readonly cookie: string
  /** Final base URL after any redirect (typically unchanged). */
  readonly baseUrl: string
}

/** Parse `Set-Cookie` header(s) into name=value pairs (first wins). */
function parseSetCookies(value: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (value == null) return out
  for (const part of value.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const valuePart = part.slice(eq + 1).split(';')[0]!.trim()
    if (name.length > 0 && !out.has(name)) out.set(name, valuePart)
  }
  return out
}

/**
 * 通过 Node `http`/`https` 模块完成 token → cookie 交换。
 *
 * 部分宿主环境（Electron/Chromium 网络栈）的全局 `fetch` 对
 * `redirect: 'manual'` 返回 `opaqueredirect`（status 0），读不到 `set-cookie`，
 * 无法完成交换。此回退路径绕开 fetch 的重定向语义，行为与 curl/undici 一致。
 */
function exchangeViaHttp(
  baseUrl: string,
  token: string,
  extraHeaders: Record<string, string>,
): Promise<AuthExchangeResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/?token=${encodeURIComponent(token)}`)
    const options: RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { ...extraHeaders },
    }
    const onResponse = (res: IncomingMessage): void => {
      res.resume() // 释放连接
      const setCookies = res.headers['set-cookie']
      const raw = Array.isArray(setCookies) ? setCookies[0] : setCookies
      if (res.statusCode === 303 || res.statusCode === 302) {
        if (raw === undefined || !raw.includes('dsh-auth-')) {
          reject(new Error(`DSH 认证成功但未返回会话 cookie（HTTP ${res.statusCode}）`))
          return
        }
        resolve({ cookie: raw.split(';')[0]!.trim(), baseUrl })
        return
      }
      if (res.statusCode === 200) {
        resolve({ cookie: '', baseUrl })
        return
      }
      reject(new Error(`DSH 认证 cookie 换取失败：HTTP ${res.statusCode}`))
    }
    const req = url.protocol === 'https:'
      ? httpsRequest(options, onResponse)
      : httpRequest(options, onResponse)
    req.on('error', (error: Error) => {
      reject(new Error(`无法连接 DSH 服务 ${baseUrl} 以换取认证 cookie：${error.message}`))
    })
    req.end()
  })
}

/**
 * Exchange a process launch token for the browser-session cookie.
 *
 * @param baseUrl - DSH web origin (no trailing slash).
 * @param token   - the process launch token printed by `dsh web`.
 * @param extraHeaders - extra headers to carry on the request.
 * @throws Error when the exchange cannot be completed.
 */
export async function authenticateWithToken(
  baseUrl: string,
  token: string,
  extraHeaders: Record<string, string> = {},
): Promise<AuthExchangeResult> {
  const trimmed = token.trim()
  if (trimmed.length === 0) {
    return { cookie: '', baseUrl }
  }
  const url = `${baseUrl}/?token=${encodeURIComponent(trimmed)}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { ...extraHeaders },
      redirect: 'manual',
    })
  } catch (error) {
    // fetch 不可用：回退 Node http(s) 模块。
    return exchangeViaHttp(baseUrl, trimmed, extraHeaders)
  }
  // Electron/Chromium net fetch 的 manual 重定向返回 opaqueredirect（status 0），
  // 读不到 set-cookie：回退 Node http(s) 模块重做交换。
  if (response.status === 0) {
    return exchangeViaHttp(baseUrl, trimmed, extraHeaders)
  }
  if (response.status !== 303 && response.status !== 302) {
    // A direct 200 means the route didn't require auth (no token gate active).
    if (response.status === 200) return { cookie: '', baseUrl }
    throw new Error(`DSH 认证 cookie 换取失败：HTTP ${response.status}`)
  }
  const cookies = parseSetCookies(response.headers.get('set-cookie'))
  const authCookie = [...cookies.entries()].find(([name]) => name.startsWith('dsh-auth-'))
  if (authCookie === undefined) {
    // Some deployments reject the token on the root route; surface the status.
    throw new Error(`DSH 认证成功但未返回会话 cookie（HTTP ${response.status}）`)
  }
  return { cookie: `${authCookie[0]}=${authCookie[1]}`, baseUrl }
}
