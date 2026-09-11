import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmbedProxy } from './embedProxy.ts'

interface Upstream {
  server: Server
  base: string
  requests: { headers: Record<string, string | string[] | undefined>; url: string; method: string }[]
}

async function startUpstream(handler: (cookie: string | undefined, req: { url: string; method: string }) => {
  status: number
  headers?: Record<string, string>
  body?: string
}): Promise<Upstream> {
  const requests: Upstream['requests'] = []
  const server = createServer((req, res) => {
    requests.push({ headers: req.headers, url: req.url ?? '/', method: req.method ?? 'GET' })
    const raw = req.headers.cookie
    const cookie = Array.isArray(raw) ? raw[0] : raw
    const out = handler(cookie, { url: req.url ?? '/', method: req.method ?? 'GET' })
    res.writeHead(out.status, out.headers ?? { 'content-type': 'text/plain' })
    res.end(out.body ?? '')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { server, base: `http://127.0.0.1:${String(port)}`, requests }
}

let proxy: EmbedProxy | undefined
let upstream: Upstream | undefined

afterEach(async () => {
  proxy?.stop()
  proxy = undefined
  if (upstream !== undefined) await new Promise<void>((resolve) => upstream!.server.close(() => resolve()))
  upstream = undefined
})

describe('EmbedProxy', () => {
  it('injects the exchanged cookie, forwards upstream Host and drops browser identity headers', async () => {
    upstream = await startUpstream((cookie) =>
      cookie === 'dsh-auth-x=secret' ? { status: 200, body: 'ok' } : { status: 401, body: 'unauthorized' })
    proxy = new EmbedProxy({
      baseUrl: upstream.base,
      token: 'tok',
      exchange: async () => 'dsh-auth-x=secret',
    })
    const handle = await proxy.start()

    const res = await fetch(`${handle.origin}/api/ping`, { headers: { origin: 'http://127.0.0.1:9999', referer: 'http://127.0.0.1:9999/' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')

    const seen = upstream.requests.at(-1)!
    expect(seen.headers.host).toBe(new URL(upstream.base).host)
    expect(seen.headers.cookie).toBe('dsh-auth-x=secret')
    expect(seen.headers.origin).toBeUndefined()
    expect(seen.headers.referer).toBeUndefined()
  })

  it('refreshes the token exchange once on 401 (covers restarts that rotate the token)', async () => {
    let exchangeCount = 0
    upstream = await startUpstream((cookie) =>
      cookie === 'dsh-auth-x=second' ? { status: 200, body: 'recovered' } : { status: 401, body: 'unauthorized' })
    proxy = new EmbedProxy({
      baseUrl: upstream.base,
      token: 'tok',
      exchange: async () => {
        exchangeCount += 1
        return exchangeCount === 1 ? 'dsh-auth-x=first' : 'dsh-auth-x=second'
      },
    })
    const handle = await proxy.start()
    const res = await fetch(`${handle.origin}/api/refresh-me`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('recovered')
    expect(exchangeCount).toBe(2)
    expect(upstream.requests.length).toBe(2)
  })

  it('rewrites absolute upstream redirects to the proxy origin and strips upstream set-cookie', async () => {
    upstream = await startUpstream((_cookie, req) =>
      req.url === '/old'
        ? { status: 302, headers: { location: `${upstream!.base}/new`, 'set-cookie': 'dsh-auth-x=leak' }, body: '' }
        : { status: 200, body: 'new' })
    proxy = new EmbedProxy({ baseUrl: upstream.base, token: 'tok', exchange: async () => 'c=1' })
    const handle = await proxy.start()

    const redirected = await fetch(`${handle.origin}/old`, { redirect: 'manual' })
    expect(redirected.status).toBe(302)
    expect(redirected.headers.get('location')).toBe(`${handle.origin}/new`)
    expect(redirected.headers.get('set-cookie')).toBeNull()

    const relative = await fetch(`${handle.origin}/new`)
    expect(await relative.text()).toBe('new')
  })

  it('keeps relative redirects untouched', async () => {
    upstream = await startUpstream(() => ({ status: 302, headers: { location: '/login' }, body: '' }))
    proxy = new EmbedProxy({ baseUrl: upstream.base, token: 'tok', exchange: async () => 'c=1' })
    const handle = await proxy.start()
    const res = await fetch(`${handle.origin}/old`, { redirect: 'manual' })
    expect(res.headers.get('location')).toBe('/login')
  })

  it('forwards POST bodies literally', async () => {
    const seen: string[] = []
    upstream = await startUpstream((_cookie, req) => ({ status: 200, body: req.url }))
    upstream.server.removeAllListeners('request')
    upstream.server.on('request', (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen.push(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      })
    })
    proxy = new EmbedProxy({ baseUrl: upstream.base, token: 'tok', exchange: async () => 'c=1' })
    const handle = await proxy.start()
    const res = await fetch(`${handle.origin}/api/echo`, { method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(res.status).toBe(200)
    expect(seen).toEqual(['{"a":1}'])
  })
  it('forwards without a token (open server) and never exchanges', async () => {
    let exchanged = 0
    upstream = await startUpstream(() => ({ status: 200, body: 'open' }))
    proxy = new EmbedProxy({
      baseUrl: upstream.base,
      token: '',
      exchange: async () => { exchanged += 1; return 'unexpected' },
    })
    const handle = await proxy.start()
    const res = await fetch(`${handle.origin}/api/open`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('open')
    expect(exchanged).toBe(0)
    expect(upstream.requests.at(-1)!.headers.cookie).toBeUndefined()
  })

  it('uses the seeded connection cookie when no token is available', async () => {
    upstream = await startUpstream((cookie) =>
      cookie === 'dsh-auth-seeded=1' ? { status: 200, body: 'seeded' } : { status: 401, body: 'unauthorized' })
    proxy = new EmbedProxy({ baseUrl: upstream.base, token: '', cookie: 'dsh-auth-seeded=1' })
    const handle = await proxy.start()
    const res = await fetch(`${handle.origin}/api/ping`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('seeded')
    expect(upstream.requests.at(-1)!.headers.cookie).toBe('dsh-auth-seeded=1')
  })
  it('streams oversized request bodies instead of truncating them', async () => {
    const seen: number[] = []
    upstream = await startUpstream(() => ({ status: 200, body: 'ok' }))
    upstream.server.removeAllListeners('request')
    upstream.server.on('request', (req, res) => {
      let size = 0
      req.on('data', (c: Buffer) => { size += c.length })
      req.on('end', () => { seen.push(size); res.writeHead(200); res.end('ok') })
    })
    proxy = new EmbedProxy({ baseUrl: upstream.base, token: '', maxRetryBodyBytes: 64 })
    const handle = await proxy.start()
    const payload = 'x'.repeat(512)
    const res = await fetch(`${handle.origin}/api/upload`, { method: 'POST', body: payload })
    expect(res.status).toBe(200)
    expect(seen).toEqual([512])
  })
})
