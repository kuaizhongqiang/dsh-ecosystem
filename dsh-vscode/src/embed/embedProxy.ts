/**
 * EmbedProxy — extension-side loopback reverse proxy (milestone #2 #21 fallback).
 *
 * Stock dsh servers do not expose the embed seam, so an iframe pointed at them
 * cannot authenticate (browser cookies are SameSite=Strict and cross-site in a
 * webview). This proxy removes that dependency: the extension exchanges its
 * launch token for the upstream browser-session cookie once, then forwards
 * HTTP and WebSocket traffic with that cookie attached. The webview iframes
 * `http://127.0.0.1:<port>/`, which is same-origin within the webview, so the
 * dsh web app boots and streams exactly as in a browser.
 *
 * Design notes:
 * - Loopback-only listener, one instance per upstream base, lazily started.
 * - Upstream `Host` is the upstream authority (cookies are authority-bound).
 * - Hop-by-hop and browser-identity headers (`origin`, `referer`, `cookie`)
 *   are dropped; responses lose upstream `set-cookie` (the proxy owns auth).
 * - On a 401 the proxy refreshes the token→cookie exchange once and retries,
 *   which also covers dsh restarts that rotate the token.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { authenticateWithToken } from '../client/auth.ts'

export interface EmbedProxyOptions {
  /** Upstream dsh base URL, e.g. `http://127.0.0.1:3080`. */
  baseUrl: string
  /** Launch token used for the cookie exchange (empty = server needs none). */
  token?: string
  /** Extra headers for the exchange and upstream requests. */
  extraHeaders?: Record<string, string>
  /** Bind port (default 0 = OS-assigned). */
  port?: number
  /** Injectable token→cookie exchange (tests). */
  exchange?: (baseUrl: string, token: string, extraHeaders: Record<string, string>) => Promise<string>
  /** Seed cookie (e.g. the connection's own browser-session cookie). */
  cookie?: string
  /** Bodies larger than this are streamed through instead of buffered (no 401 retry). */
  maxRetryBodyBytes?: number
}

export interface EmbedProxyHandle {
  /** Origin to iframe: `http://127.0.0.1:<port>`. */
  origin: string
  port: number
  stop(): void
}

/** Request bodies are buffered up to this size so a 401 can be retried safely. */
const MAX_RETRY_BODY_BYTES = 8 * 1024 * 1024

const STRIPPED_REQUEST_HEADERS = new Set([
  'host', 'cookie', 'origin', 'referer', 'connection', 'upgrade', 'keep-alive',
  'proxy-connection', 'transfer-encoding', 'expect', 'content-length', 'te-length',
])

const STRIPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding'])

export class EmbedProxy {
  private readonly baseUrl: string
  private readonly token: string
  private readonly extraHeaders: Record<string, string>
  private readonly exchange: (baseUrl: string, token: string, extraHeaders: Record<string, string>) => Promise<string>
  private readonly seedCookie: string
  private readonly maxRetryBodyBytes: number
  private readonly desiredPort: number
  private server: Server | undefined
  private cookie = ''
  private handle: EmbedProxyHandle | undefined

  constructor(options: EmbedProxyOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token ?? ''
    this.extraHeaders = options.extraHeaders ?? {}
    this.seedCookie = options.cookie ?? ''
    this.maxRetryBodyBytes = options.maxRetryBodyBytes ?? MAX_RETRY_BODY_BYTES
    this.desiredPort = options.port ?? 0
    this.exchange = options.exchange ?? (async (base, token, headers) => (await authenticateWithToken(base, token, headers)).cookie)
  }

  /** Start listening; resolves with the iframe origin. */
  async start(): Promise<EmbedProxyHandle> {
    if (this.handle !== undefined) return this.handle
    // No token: the server either needs no auth or the caller seeded the
    // connection's own browser-session cookie; forward as-is.
    this.cookie = this.token === ''
      ? this.seedCookie
      : await this.exchange(this.baseUrl, this.token, this.extraHeaders)
    const server = createServer((req, res) => { void this.forward(req, res) })
    server.on('upgrade', (req, socket, head) => { void this.forwardUpgrade(req, socket as Socket, head) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.desiredPort, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : this.desiredPort
    this.handle = {
      origin: `http://127.0.0.1:${String(port)}`,
      port,
      stop: () => { this.stop() },
    }
    return this.handle
  }

  stop(): void {
    this.server?.closeAllConnections()
    this.server?.close()
    this.server = undefined
    this.handle = undefined
  }

  get running(): boolean {
    return this.server !== undefined
  }

  private upstream(): { protocol: string; hostname: string; port: number; host: string; base: string } {
    const url = new URL(this.baseUrl)
    const secure = url.protocol === 'https:'
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port !== '' ? Number(url.port) : secure ? 443 : 80,
      host: url.host,
      base: this.baseUrl,
    }
  }

  private requestHeaders(req: IncomingMessage): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue
      headers[key] = value
    }
    const up = this.upstream()
    headers.host = up.host
    if (this.cookie !== '') headers.cookie = this.cookie
    for (const [key, value] of Object.entries(this.extraHeaders)) headers[key.toLowerCase()] = value
    return headers
  }

  private rewriteLocation(value: string): string {
    if (this.handle === undefined) return value
    const up = this.upstream()
    if (value.startsWith(up.base)) return this.handle.origin + value.slice(up.base.length)
    return value
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const retryable = req.method === 'GET' || req.method === 'HEAD'
    const read = retryable ? { body: Buffer.alloc(0), truncated: false } : await readBody(req, this.maxRetryBodyBytes)
    if (read.truncated) {
      // Too large to buffer for a retry: stream the (already partially read)
      // body through unchanged so uploads are never truncated.
      this.streamThrough(req, res, read.body)
      return
    }
    const body = read.body
    const attempt = async (): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> =>
      sendUpstream(this.upstream(), req.method ?? 'GET', req.url ?? '/', this.requestHeaders(req), body)
    try {
      let out = await attempt()
      if (out.status === 401 && this.token !== '') {
        this.cookie = await this.exchange(this.baseUrl, this.token, this.extraHeaders)
        out = await attempt()
      }
      const headers: Record<string, string | string[]> = {}
      for (const [key, value] of Object.entries(out.headers)) {
        if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue
        headers[key] = key.toLowerCase() === 'location' && typeof value === 'string' ? this.rewriteLocation(value) : value
      }
      res.writeHead(out.status, headers)
      res.end(out.body)
    } catch (error) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`embed proxy upstream error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Pass a large request straight through (no retry, no truncation). */
  private streamThrough(req: IncomingMessage, res: ServerResponse, prefix: Buffer): void {
    const up = this.upstream()
    const send = up.protocol === 'https:' ? httpsRequest : httpRequest
    const upstreamReq = send(
      { hostname: up.hostname, port: up.port, method: req.method ?? 'POST', path: req.url ?? '/', headers: this.requestHeaders(req), setHost: false },
      (upstreamRes) => {
        const headers: Record<string, string | string[]> = {}
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined || STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue
          headers[key] = key.toLowerCase() === 'location' && typeof value === 'string' ? this.rewriteLocation(value) : value
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers)
        upstreamRes.pipe(res)
      },
    )
    upstreamReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('embed proxy upstream error')
    })
    if (prefix.length > 0) upstreamReq.write(prefix)
    req.pipe(upstreamReq)
  }

  private async forwardUpgrade(req: IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
    const up = this.upstream()
    const secure = up.protocol === 'https:'
    const onConnected = (upstreamSocket: Socket): void => {
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
      const headers = this.requestHeaders(req)
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
        else lines.push(`${key}: ${value}`)
      }
      lines.push('', '')
      upstreamSocket.write(lines.join('\r\n'))
      if (head.length > 0) upstreamSocket.write(head)
      clientSocket.pipe(upstreamSocket)
      upstreamSocket.pipe(clientSocket)
    }
    const upstreamSocket = secure
      ? tlsConnect({ host: up.hostname, port: up.port }, () => { onConnected(upstreamSocket) })
      : netConnect({ host: up.hostname, port: up.port }, () => { onConnected(upstreamSocket) })
    const fail = (): void => {
      clientSocket.destroy()
      upstreamSocket.destroy()
    }
    upstreamSocket.on('error', fail)
    clientSocket.on('error', fail)
    clientSocket.on('close', () => { upstreamSocket.destroy() })
    upstreamSocket.on('close', () => { clientSocket.destroy() })
  }
}

function sendUpstream(
  up: { protocol: string; hostname: string; port: number; host: string },
  method: string,
  path: string,
  headers: Record<string, string | string[]>,
  body: Buffer,
): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const send = up.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send({ hostname: up.hostname, port: up.port, method, path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const out: Record<string, string | string[]> = {}
        for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) out[key] = value
        resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) })
      })
    })
    req.on('error', reject)
    if (body.length > 0) req.write(body)
    req.end()
  })
}

/**
 * Buffer a request body up to `cap`. On overflow the collected prefix is
 * returned with `truncated: true` and — crucially — the stream is left
 * un-destroyed so the caller can pipe the remainder through unchanged
 * (`for await` would destroy it on early return).
 */
function readBody(req: IncomingMessage, cap: number): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (truncated: boolean): void => {
      if (settled) return
      settled = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      resolve({ body: Buffer.concat(chunks), truncated })
    }
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      chunks.push(chunk)
      if (size > cap) finish(true)
    }
    const onEnd = (): void => { finish(false) }
    const onError = (): void => { finish(false) }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}
