/**
 * Render tests for media/webview.html: load the real webview script into jsdom,
 * mock acquireVsCodeApi(), and replay the host op protocol (init / append-message /
 * finalize-message / tool-call / tool-result) exactly as src/chat/chatPanel.ts +
 * src/chat/chatModel.ts would emit them. Guards issue #12 (tool cards not shown).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, type DOMWindow } from 'jsdom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(__dirname, '..', '..', 'media', 'webview.html'), 'utf8')

interface WebviewHarness {
  window: DOMWindow
  /** Everything the webview posted to the host (vscode.postMessage). */
  sent: unknown[]
  /** Dispatch an op from the host into the webview. */
  send: (op: unknown) => void
  count: (selector: string) => number
}

function setup(): WebviewHarness {
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
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!match) throw new Error('no <script> block in webview.html')
  window.eval(match[1])
  return {
    window,
    sent,
    send: (op) => window.dispatchEvent(new window.MessageEvent('message', { data: op })),
    count: (selector) => window.document.querySelectorAll(selector).length,
  }
}

describe('webview tool cards (issue #12)', () => {
  it('renders tool cards from init snapshot messages with toolCalls', () => {
    const h = setup()
    h.send({ type: 'connection', connected: true })
    h.send({
      type: 'init',
      sessionId: 's1',
      title: 'T',
      running: false,
      showReasoning: true,
      messages: [
        { id: 'u1', role: 'user', text: 'hi', toolCalls: [], time: 1 },
        {
          id: 'a1',
          role: 'assistant',
          text: 'let me look',
          toolCalls: [
            { callId: 'call_1', name: 'read', arguments: '{"path":"a.ts"}', status: 'done', result: 'file content' },
          ],
          time: 2,
        },
      ],
    })
    expect(h.count('.msg')).toBe(2)
    expect(h.count('.tool-card')).toBe(1)
    const nameEl = h.window.document.querySelector('.tool-card .tool-name')
    expect(nameEl?.textContent).toBe('read')
    // Card must sit AFTER its owning message, not before it.
    const msgs = h.window.document.querySelectorAll('.msg')
    const cards = h.window.document.querySelectorAll('.tool-card')
    const a1 = Array.from(msgs).find((el) => el.id === 'a1' || el.textContent?.includes('let me look'))
    const card = cards[0]
    const a1Index = Array.from(h.window.document.querySelectorAll('.msg, .tool-card')).indexOf(a1!)
    const cardIndex = Array.from(h.window.document.querySelectorAll('.msg, .tool-card')).indexOf(card)
    expect(cardIndex).toBeGreaterThan(a1Index)
  })

  it('shows the tool result after a tool-result op (no TypeError)', () => {
    const h = setup()
    h.send({ type: 'connection', connected: true })
    h.send({
      type: 'init',
      sessionId: 's1',
      running: false,
      showReasoning: true,
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          text: 'running',
          toolCalls: [{ callId: 'call_1', name: 'grep', arguments: '{}', status: 'running' }],
          time: 2,
        },
      ],
    })
    expect(h.count('.tool-card')).toBe(1)
    // Result arrives afterwards.
    expect(() => h.send({ type: 'tool-result', callId: 'call_1', result: 'a.ts:1: match', isError: false })).not.toThrow()
    const body = h.window.document.querySelector('.tool-card .tool-body')
    expect(body?.textContent).toContain('a.ts:1: match')
  })

  it('renders tool cards during live streaming (tool-call-delta path)', () => {
    const h = setup()
    h.send({ type: 'connection', connected: true })
    h.send({ type: 'init', sessionId: 's1', running: false, showReasoning: true, messages: [] })
    // Host mirrors chatModel.handleChunk: append placeholder, then tool-call op,
    // then finalize-message, then tool-result.
    h.send({
      type: 'append-message',
      message: { id: 'm-1-1', role: 'assistant', text: '', toolCalls: [], streaming: true, time: 10 },
    })
    h.send({ type: 'tool-call', messageId: 'm-1-1', tool: { callId: 'call_x', name: 'edit', arguments: '{"path":"b.ts"}', status: 'pending' } })
    expect(h.count('.tool-card')).toBe(1)
    h.send({ type: 'stream-text', id: 'm-1-1', text: 'editing' })
    h.send({
      type: 'finalize-message',
      id: 'm-1-1',
      message: {
        id: 'm-1-1',
        role: 'assistant',
        text: 'editing',
        toolCalls: [{ callId: 'call_x', name: 'edit', arguments: '{"path":"b.ts"}', status: 'running' }],
        time: 10,
      },
    })
    h.send({ type: 'tool-result', callId: 'call_x', result: 'ok', isError: false })
    expect(h.count('.tool-card')).toBe(1)
    expect(h.window.document.querySelector('.tool-card .tool-name')?.textContent).toBe('edit')
    expect(h.window.document.querySelector('.tool-card .tool-body')?.textContent).toContain('ok')
  })

  it('replays buffered history ops after init without losing cards', () => {
    const h = setup()
    h.send({ type: 'connection', connected: true })
    // init carries the full snapshot (messages + toolCalls)…
    h.send({
      type: 'init',
      sessionId: 's1',
      running: false,
      showReasoning: true,
      messages: [
        { id: 'u1', role: 'user', text: 'hi', toolCalls: [], time: 1 },
        {
          id: 'a1',
          role: 'assistant',
          text: 'done',
          toolCalls: [{ callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}', status: 'done', result: 'x' }],
          time: 2,
        },
      ],
    })
    // …then the buffered ops that produced it replay (chatPanel.flushPending).
    h.send({ type: 'append-message', message: { id: 'u1', role: 'user', text: 'hi', toolCalls: [], time: 1 } })
    h.send({
      type: 'finalize-message',
      id: 'a1',
      message: {
        id: 'a1',
        role: 'assistant',
        text: 'done',
        toolCalls: [{ callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}', status: 'done' }],
        time: 2,
      },
    })
    h.send({ type: 'tool-call', tool: { callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}', status: 'running' } })
    h.send({ type: 'tool-result', callId: 'c1', result: 'x', isError: false })
    expect(h.count('.tool-card')).toBe(1)
    expect(h.count('.msg')).toBe(2)
  })

  it('removes the bubble border line (issue #13)', () => {
    const h = setup()
    h.send({
      type: 'init',
      sessionId: 's1',
      running: false,
      showReasoning: true,
      messages: [
        { id: 'a1', role: 'assistant', text: 'hi', toolCalls: [], time: 1 },
        { id: 'u1', role: 'user', text: 'yo', toolCalls: [], time: 2 },
      ],
    })
    // jsdom 的 getComputedStyle 不解析 <style> 规则，直接断言样式表内容：
    // .msg .body / .msg.user .body 两条规则不得再声明任何 border。
    const styleText = h.window.document.querySelector('style')?.textContent ?? ''
    const msgBodyRule = styleText.match(/\.msg \.body \{(?:(?!\})[\s\S])*\}/)?.[0] ?? ''
    const userBodyRule = styleText.match(/\.msg\.user \.body \{(?:(?!\})[\s\S])*\}/)?.[0] ?? ''
    expect(msgBodyRule).not.toMatch(/border(?!-)/)
    expect(userBodyRule).not.toMatch(/border(?!-)/)
  })

  it('shows the 费用 chip in the stats bar (issue #14)', () => {
    const h = setup()
    h.send({ type: 'stats', stats: { turns: 3, costCny: 1.234567 } })
    expect(h.window.document.querySelector('#stats-bar')?.textContent).toContain('费用')
    expect(h.window.document.querySelector('#stats-bar')?.textContent).toContain('¥1.23')
  })

  it('renders the todo list and goal panel (issue #16)', () => {
    const h = setup()
    h.send({
      type: 'init',
      sessionId: 's1',
      running: false,
      showReasoning: true,
      messages: [],
      todos: [
        { content: '第一步', status: 'in_progress' },
        { content: '第二步', status: 'completed' },
      ],
      goal: { id: 'g1', objective: '完成插件', phase: 'active', maxGoalRounds: 5, roundsStarted: 2 },
    })
    expect(h.window.document.getElementById('ov-todos')?.textContent).toContain('第一步')
    expect(h.window.document.getElementById('ov-todos')?.textContent).toContain('1/2 完成')
    expect(h.window.document.getElementById('ov-goal')?.textContent).toContain('完成插件')
    expect(h.window.document.getElementById('ov-goal')?.textContent).toContain('2/5 轮')

    // Live updates replace the panels.
    h.send({ type: 'todos', todos: [{ content: '新任务', status: 'pending' }] })
    expect(h.window.document.getElementById('ov-todos')?.textContent).toContain('新任务')
    expect(h.window.document.getElementById('ov-todos')?.textContent).not.toContain('第一步')
    h.send({ type: 'goal', goal: null })
    expect(h.window.document.getElementById('ov-goal')).toBeNull()
  })

  it('creates a fallback card when tool-result arrives without a prior tool-call op (issue #12 hardening)', () => {
    const h = setup()
    h.send({ type: 'connection', connected: true })
    h.send({ type: 'init', sessionId: 's1', running: false, showReasoning: true, messages: [] })
    expect(() => h.send({ type: 'tool-result', callId: 'orphan_1', result: 'some result', isError: false })).not.toThrow()
    expect(h.count('.tool-card')).toBe(1)
    expect(h.window.document.querySelector('.tool-card .tool-body')?.textContent).toContain('some result')
  })

  it('forbids flex shrinking of messages-area children (issue #12: cards were squashed to 0 height)', () => {
    const h = setup()
    const styleText = h.window.document.querySelector('style')?.textContent ?? ''
    // 卡片自身禁收缩。
    expect(styleText).toMatch(/\.tool-card \{[^}]*flex-shrink: 0/s)
    // 消息区所有子项禁收缩。
    expect(styleText).toMatch(/#messages > \* \{ flex-shrink: 0; \}/)
  })

  it('skips the empty bubble for pure-tool turns (text-less assistant message renders cards only)', () => {
    const h = setup()
    h.send({ type: 'connection', connected: true })
    h.send({
      type: 'init',
      sessionId: 's1',
      running: false,
      showReasoning: true,
      messages: [
        // 纯工具回合：无文字、无思考
        {
          id: 'a1',
          role: 'assistant',
          text: '',
          toolCalls: [{ callId: 'c9', name: 'pwsh', arguments: '{}', status: 'done', result: 'ok' }],
          time: 2,
        },
      ],
    })
    expect(h.count('.tool-card')).toBe(1)
    // 不应渲染空的 .msg 气泡（没有空气泡/奇怪条）
    expect(h.count('.msg')).toBe(0)
    expect(h.window.document.querySelector('.tool-card .tool-name')?.textContent).toBe('pwsh')
  })

  it('renders tool cards collapsed by default with inline SVG tool icons (no emoji, no left status glyph)', () => {
    const h = setup()
    h.send({ type: 'connection', connected: true })
    h.send({
      type: 'init',
      sessionId: 's1',
      running: false,
      showReasoning: true,
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          text: 'x',
          toolCalls: [{ callId: 'c1', name: 'read', arguments: '{}', status: 'done', result: 'ok' }],
          time: 2,
        },
      ],
    })
    const card = h.window.document.querySelector('.tool-card')
    expect(card).toBeTruthy()
    // 默认折叠：不携带 open 类（点击头部展开）。
    expect(card?.classList.contains('open')).toBe(false)
    // 左侧只有状态圆点，没有大的状态图标/emoji。
    expect(card?.querySelector('.dot.done')).toBeTruthy()
    expect(card?.querySelector('.tool-icon')).toBeNull()
    // 工具类型是内联 SVG，不再是 emoji。
    expect(card?.querySelector('.tool-name-icon svg')).toBeTruthy()
    expect(card?.textContent).not.toMatch(/[📖✏️🔍💻✅❌⏳🔄]/)
    // 点击头部后展开。
    ;(card?.querySelector('.tool-head') as HTMLElement | undefined)?.click()
    expect(card?.classList.contains('open')).toBe(true)
  })
})
