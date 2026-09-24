/**
 * 对外调用面：本机回环 HTTP + 本机 token（docs/dsh-cli-design.md §4.2 / Q5）。
 *
 * 约定：
 *   · 只监听 127.0.0.1（单机前提，非本机地址一律拒绝）；
 *   · 鉴权：`Authorization: Bearer <token>` / `x-dshcli-token` / `?token=`；
 *   · 路由：GET /health（免鉴权）、GET /tools、任意方法 /call/<工具名>、GET|POST /api/<工具名>；
 *   · 返回：`{ ok:true, result }` 或 `{ ok:false, error:{ code, message } }`（**无损 JSON**）。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { jsonSafe } from './out.js'
import { stateDir } from './paths.js'
import { callTool, toolCatalog } from './tools.js'

/** 本机端点文件（含 token；只落本机、不进仓库/日志，Q5 已拍板）。 */
export function endpointPath() {
  return join(stateDir(), 'endpoint.json')
}

/** 读/建本机 token。 */
export function loadEndpoint(options = {}) {
  const file = endpointPath()
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed?.token === 'string' && parsed.token !== '') return parsed
    } catch {
      // 损坏则重建
    }
  }
  if (options.create !== true) return undefined
  const payload = { version: 1, token: randomBytes(24).toString('base64url'), createdAt: new Date().toISOString() }
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return payload
}

/** 解析请求参数：POST/JSON body 优先，其次 query string（值按 JSON 解析，失败当字符串）。 */
function readArgs(request, url) {
  return new Promise((resolve) => {
    const fromQuery = {}
    for (const [key, value] of url.searchParams) {
      if (key === 'token') continue
      try {
        fromQuery[key] = JSON.parse(value)
      } catch {
        fromQuery[key] = value
      }
    }
    if (request.method !== 'POST' && request.method !== 'PUT') {
      resolve(fromQuery)
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (body.trim() === '') {
        resolve(fromQuery)
        return
      }
      try {
        const parsed = JSON.parse(body)
        resolve(parsed !== null && typeof parsed === 'object' ? { ...fromQuery, ...parsed } : fromQuery)
      } catch {
        resolve({ ...fromQuery, __parseError: 'body 不是合法 JSON' })
      }
    })
  })
}

/** 工具错误 → HTTP 状态码。 */
function statusFor(code) {
  switch (code) {
    case 'readonly': return 403
    case 'not_found': return 404
    case 'invalid_args': return 400
    case 'unknown_tool': return 404
    case 'not_implemented': return 501
    case 'unavailable': return 503
    default: return 500
  }
}

/**
 * 起服务。
 * @param options.port 0 = 随机端口
 * @returns `{ port, host, token, url, close() }`
 */
export function startServer(options = {}) {
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('dsh-cli 只允许监听本机回环地址（单机前提，见设计 §2）')
  }
  const endpoint = options.token === undefined ? loadEndpoint({ create: true }) : { token: options.token }
  const token = endpoint.token
  const log = options.log ?? (() => {})

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`)
    const send = (status, payload) => {
      const body = `${JSON.stringify(jsonSafe(payload))}\n`
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      response.end(body)
    }
    if (url.pathname === '/health') {
      send(200, { ok: true, service: 'dsh-cli', version: options.version })
      return
    }
    const authorized = request.headers.authorization === `Bearer ${token}` ||
      request.headers['x-dshcli-token'] === token ||
      url.searchParams.get('token') === token
    if (!authorized) {
      send(401, { ok: false, error: { code: 'unauthorized', message: '缺少或错误的 dshcli token（见 %DSH_HOME%/dsh-cli/endpoint.json）' } })
      return
    }
    if (url.pathname === '/tools') {
      send(200, { ok: true, result: { tools: toolCatalog() } })
      return
    }
    const match = /^\/(?:call|api)\/(.+)$/.exec(url.pathname)
    if (match === null) {
      send(404, { ok: false, error: { code: 'unknown_route', message: `未知路由 ${url.pathname}` } })
      return
    }
    const name = match[1]
    const args = await readArgs(request, url)
    if (args.__parseError !== undefined) {
      send(400, { ok: false, error: { code: 'invalid_args', message: args.__parseError } })
      return
    }
    try {
      const result = await callTool(name, args, options.deps ?? {})
      send(200, { ok: true, result })
    } catch (error) {
      send(statusFor(error?.code), { ok: false, error: { code: error?.code ?? 'internal', message: String(error?.message ?? error) } })
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : options.port
      log(`dshcli serve 监听 http://${host}:${port}（token 见 ${endpointPath()}）`)
      resolve({
        port,
        host,
        token,
        url: `http://${host}:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}
