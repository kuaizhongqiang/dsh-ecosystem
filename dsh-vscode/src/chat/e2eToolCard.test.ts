/**
 * End-to-end repro for issue #12 using REAL session history from the local dsh
 * server (fixture: last 40 messages ≈ 26k events, mostly assistant/chunk).
 *
 * Mirrors the exact chatPanel flow:
 *   1. ChatModel.load() emits ops while the webview is not ready → pendingOps buffer.
 *   2. Webview 'ready' → host posts init(model.snapshot()) then flushPending().
 *   3. Webview renders. Assert tool cards are present.
 *
 * Run: pnpm vitest run src/chat/e2eToolCard.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, type DOMWindow } from 'jsdom'
import { ChatModel } from './chatModel.ts'
import type { DshConnection, DshEvent } from '../client/connection.ts'
import type { SessionEvent, SessionPage } from '../client/types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '__fixtures__', 'real-history-40.json')
// Fixture 是本机真实会话数据（不入库）；缺失时跳过端到端用例。
const fixture: SessionEvent[] = (() => {
  try {
    return JSON.parse(readFileSync(fixturePath, 'utf8')) as SessionEvent[]
  } catch {
    return []
  }
})()

interface FakeConnection {
  followSession: (sessionId: string, onEvent: (event: SessionEvent) => void) => { close: () => void }
  history: () => Promise<SessionPage>
}

function makeModel(): { model: ChatModel; ops: unknown[]; error: Error | undefined } {
  const ops: unknown[] = []
  const conn: FakeConnection = {
    followSession: () => ({ close: () => {} }),
    history: async () => ({
      records: fixture.map((event) => ({ type: 'event' as const, event })),
      hasMore: false,
    }),
  }
  const model = new ChatModel({
    connection: conn as unknown as DshConnection,
    sessionId: 'real-session',
    onOp: (op) => ops.push(op),
  })
  return { model, ops, error: undefined }
}

function setupWebview(): {
  window: DOMWindow
  sent: unknown[]
  send: (op: unknown) => void
  count: (selector: string) => number
  errors: string[]
} {
  const html = readFileSync(join(__dirname, '..', '..', 'media', 'webview.html'), 'utf8')
  const sent: unknown[] = []
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true })
  const { window } = dom
  ;(window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => {
      sent.push(msg)
    },
    getState: () => undefined,
    setState: () => undefined,
  })
  // 捕获 webview 运行时的 console.error 与未捕获异常，用于断言渲染零报错。
  const errors: string[] = []
  const origError = window.console.error.bind(window.console)
  window.console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
    origError(...args)
  }
  window.addEventListener('error', (e: ErrorEvent) => {
    errors.push(`uncaught: ${e.message} @${e.filename}:${e.lineno}`)
  })
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!match) throw new Error('no <script> block')
  window.eval(match[1])
  return {
    window,
    sent,
    send: (op) => window.dispatchEvent(new window.MessageEvent('message', { data: op })),
    count: (selector) => window.document.querySelectorAll(selector).length,
    errors,
  }
}

describe('issue #12 e2e: real history → ChatModel → webview', () => {
  const skip = fixture.length === 0
  it.skipIf(skip)('does not throw on real history and renders tool cards', async () => {
    const { model, ops } = makeModel()
    // Feed real history exactly like ChatPanel does.
    await model.load(40)

    const messages = model.snapshot()
    const msgWithTools = messages.filter((m) => m.toolCalls.length > 0)
    const toolCallOps = ops.filter((op) => (op as { type: string }).type === 'tool-call')
    const toolResultOps = ops.filter((op) => (op as { type: string }).type === 'tool-result')
    // eslint-disable-next-line no-console
    console.log(`[e2e] messages=${messages.length} withTools=${msgWithTools.length} toolCallOps=${toolCallOps.length} toolResultOps=${toolResultOps.length}`)

    // Now the webview side: it is NOT ready during load, so ops were buffered.
    const h = setupWebview()
    // The webview sent 'ready' (last message in `sent`).
    // Host replies: connection + init(snapshot) + flushPending(buffered ops).
    h.send({ type: 'connection', connected: true })
    h.send({
      type: 'init',
      sessionId: 'real-session',
      running: false,
      showReasoning: true,
      messages,
    })
    for (const op of ops) h.send(op)

    expect(h.count('.tool-card')).toBeGreaterThan(0)
    // 纯工具回合（无文字/思考）不渲染空消息气泡，其余消息都应渲染。
    const bubbleMsgs = messages.filter((m) =>
      (m.text !== undefined && m.text.length > 0) ||
      (m.reasoning !== undefined && m.reasoning.length > 0) ||
      m.streaming === true)
    expect(h.count('.msg')).toBe(bubbleMsgs.length)
    // 渲染必须零报错（捕获 console.error / uncaught error）。
    expect(h.errors).toEqual([])
    // Every snapshot message with toolCalls must have its card rendered.
    for (const m of msgWithTools) {
      const cardCount = Array.from(h.window.document.querySelectorAll('.tool-card')).filter((el) =>
        (el as HTMLElement).textContent?.includes(m.toolCalls[0]?.name ?? ''),
      ).length
      expect(cardCount).toBeGreaterThan(0)
    }
    model.dispose()
  })

  it.skipIf(skip)('handles the REAL live chunk stream (assistant/chunk with tool-call-delta) without losing cards', async () => {
    // Take the tail of the real fixture (the most recent turn, which contains
    // chunk streaming + assistant/message + tool/call + tool/result) and feed it
    // as LIVE events — this exercises handleChunk's tool-call-delta path with
    // real payloads, then the finalize path.
    const live = fixture.slice(Math.max(0, fixture.length - 9000))
    const { model, ops, pushLive } = (() => {
      const ops: unknown[] = []
      let listener: ((event: SessionEvent) => void) | undefined
      const conn: FakeConnection = {
        followSession: (_sessionId, onEvent) => {
          listener = onEvent
          return { close: () => { listener = undefined } }
        },
        history: async () => ({ records: [], hasMore: false }),
      }
      const m = new ChatModel({
        connection: conn as unknown as DshConnection,
        sessionId: 'real-session',
        onOp: (op) => ops.push(op),
      })
      return { model: m, ops, pushLive: (e: SessionEvent) => listener?.(e) }
    })()
    await model.load(40)
    // Feed the tail as a live event stream.
    for (const e of live) {
      expect(() => pushLive(e)).not.toThrow()
    }

    const h = setupWebview()
    h.send({ type: 'connection', connected: true })
    h.send({ type: 'init', sessionId: 'real-session', running: false, showReasoning: true, messages: [] })
    for (const op of ops) {
      expect(() => h.send(op)).not.toThrow()
    }

    const cards = h.count('.tool-card')
    const finalMsgs = ops.filter((op) => (op as { type: string }).type === 'finalize-message')
    const toolCallOps = ops.filter((op) => (op as { type: string }).type === 'tool-call')
    const distinctCallIds = new Set((toolCallOps as { tool: { callId: string } }[]).map((op) => op.tool.callId))
    // eslint-disable-next-line no-console
    console.log(`[e2e-live] finalize=${finalMsgs.length} toolCallOps=${toolCallOps.length} distinctCallIds=${distinctCallIds.size} cards=${cards}`)
    expect(cards).toBeGreaterThan(0)
    // One card per distinct callId (renderToolCard dedupes by callId).
    expect(cards).toBe(distinctCallIds.size)
    model.dispose()
  })
})
