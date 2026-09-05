import { describe, expect, it, vi, afterEach } from 'vitest'
import { DshRpcClient, DshTransportError, RpcErrorResult, normalizeBaseUrl } from './rpc.ts'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and whitespace', () => {
    expect(normalizeBaseUrl(' http://127.0.0.1:3080/// ')).toBe('http://127.0.0.1:3080')
  })
})

describe('DshRpcClient.call', () => {
  it('posts a client-request envelope with { args } and unwraps ok results', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.type).toBe('client-request')
      expect(body.method).toBe('session/list')
      expect(body.payload).toEqual({ args: {} })
      expect(String(input)).toMatch(/\/api\/session\/list$/)
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items: [] } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DshRpcClient('http://127.0.0.1:3080')
    const value = await client.call<{ items: unknown[] }>('session/list', {})
    expect(value.items).toEqual([])
  })

  it('sends extra headers on every request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      expect(headers['X-Custom']).toBe('custom-value')
      expect(headers['content-type']).toBe('application/json')
      const body = JSON.parse(String(init?.body))
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: null } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DshRpcClient('http://127.0.0.1:3080', {
      extraHeaders: { 'X-Custom': 'custom-value' },
    })
    await client.call('session/list', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('attaches the auth cookie as a Cookie header when present', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      expect(headers['Cookie']).toMatch(/^dsh-auth-[a-f0-9]+=v1/)
      const body = JSON.parse(String(init?.body))
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: null } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DshRpcClient('http://127.0.0.1:3080', {
      authCookie: 'dsh-auth-abc=v1.sig',
    })
    await client.call('session/list', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws a clear error when a redirect lands on an HTML page', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('<html><head><title>302 Found</title></head><body>cloudflare</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DshRpcClient('http://127.0.0.1:3080')
    await expect(client.call('session/list', {})).rejects.toThrow(/HTML/)
  })

  it('throws RpcErrorResult on ok:false', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return jsonResponse({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: false, error: { code: 'session-not-found', message: 'no such session', details: {} } },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DshRpcClient('http://127.0.0.1:3080')
    await expect(client.call('session/page', { address: { kind: 'session', sessionId: 'x' }, maxMessages: 40 })).rejects.toMatchObject({
      code: 'session-not-found',
      message: 'no such session',
    })
  })

  it('rejects on rpcId mismatch', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ type: 'server-response', rpcId: 'other', result: { ok: true, value: null } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DshRpcClient('http://127.0.0.1:3080')
    await expect(client.call('session/list', {})).rejects.toThrow(/rpcId/)
  })

  it('throws DshTransportError on HTTP error and network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })))
    const client = new DshRpcClient('http://127.0.0.1:3080')
    await expect(client.call('session/list', {})).rejects.toBeInstanceOf(DshTransportError)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(client.call('session/list', {})).rejects.toBeInstanceOf(DshTransportError)
  })
})

describe('DshRpcClient.respondEvent', () => {
  it('posts the $events/result envelope wrapped in { args }', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.type).toBe('client-request')
      expect(body.method).toBe('$events/result')
      expect(body.payload).toEqual({
        args: {
          clientId: 'client-1',
          eventId: 'evt-1',
          outcome: { kind: 'result', value: { sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' } },
        },
      })
      expect(String(input)).toMatch(/\/api\/\$events\/result$/)
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DshRpcClient('http://127.0.0.1:3080')
    await client.respondEvent({
      clientId: 'client-1',
      eventId: 'evt-1',
      outcome: { kind: 'result', value: { sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' } },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('RpcErrorResult', () => {
  it('carries code and details', () => {
    const error = new RpcErrorResult('agent-busy', 'busy', { reason: 'running' })
    expect(error.code).toBe('agent-busy')
    expect(error.details).toEqual({ reason: 'running' })
  })
})
