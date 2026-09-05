import { describe, expect, it } from 'vitest'
import { ChatModel, extractText } from './chatModel.ts'
import type { DshConnection, DshEvent } from '../client/connection.ts'
import type { SessionEvent } from '../client/types.ts'

function event(seq: number, type: string, data: Record<string, unknown>, time = seq): SessionEvent {
  return { seq, type, time, data } as SessionEvent
}

interface FakeConnection {
  followSession: (sessionId: string, onEvent: (event: SessionEvent) => void) => { close: () => void }
  history: (sessionId: string, maxMessages: number) => Promise<{ records: { type: 'event'; event: SessionEvent }[]; hasMore: boolean }>
}

function makeModel(historyEvents: SessionEvent[]): { model: ChatModel; ops: unknown[]; pushLive: (e: SessionEvent) => void } {
  const ops: unknown[] = []
  let listener: ((event: SessionEvent) => void) | undefined
  const conn: FakeConnection = {
    followSession: (_sessionId, onEvent) => {
      listener = onEvent
      return { close: () => { listener = undefined } }
    },
    history: async () => ({
      records: historyEvents.map((e) => ({ type: 'event' as const, event: e })),
      hasMore: false,
    }),
  }
  const model = new ChatModel({
    connection: conn as unknown as DshConnection,
    sessionId: 's1',
    onOp: (op) => ops.push(op),
  })
  return {
    model,
    ops,
    pushLive: (e) => listener?.(e),
  }
}

describe('extractText', () => {
  it('joins text and reasoning, recurses into tool-result', () => {
    expect(extractText([
      { type: 'text', text: 'a' },
      { type: 'reasoning', text: 'b' },
      { type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'd' }] },
    ])).toBe('abd')
  })
})

describe('ChatModel', () => {
  it('loads history and dedupes overlapping live events by seq', async () => {
    const historyEvents = [
      event(1, 'user/message', { content: [{ type: 'text', text: 'hi' }], role: 'user', id: 'u1' }),
      event(2, 'assistant/message', {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], id: 'a1' },
      }),
    ]
    const { model, ops, pushLive } = makeModel(historyEvents)
    await model.load(40)
    // Live events with seq <= 2 must be dropped.
    pushLive(event(2, 'assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], id: 'a1' },
    }))
    pushLive(event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const appended = ops.filter((op) => (op as { type: string }).type === 'append-message')
    const finalized = ops.filter((op) => (op as { type: string }).type === 'finalize-message')
    // user/message → append-message; assistant/message (history) → finalize-message.
    expect(appended).toHaveLength(1)
    expect(finalized).toHaveLength(1)
    const messages = model.snapshot()
    expect(messages).toHaveLength(2)
    expect(messages[0]?.text).toBe('hi')
    expect(messages[1]?.text).toBe('hello')
    expect(ops.some((op) => (op as { type: string }).type === 'turn-end')).toBe(true)
    model.dispose()
  })

  it('streams assistant chunks then finalizes with the assembled message', async () => {
    const { model, ops, pushLive } = makeModel([])
    await model.load(40)
    pushLive(event(10, 'assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' },
    }))
    pushLive(event(11, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你' } }))
    pushLive(event(12, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '好' } }))
    pushLive(event(13, 'assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '你好' }], id: 'a1' },
    }))

    const streamOps = ops.filter((op) => (op as { type: string }).type === 'stream-text')
    expect(streamOps.map((op) => (op as { text: string }).text).join('')).toBe('你好')
    const final = ops.find((op) => (op as { type: string }).type === 'finalize-message')
    expect((final as { message: { text: string } }).message.text).toBe('你好')
    const messages = model.snapshot()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe('你好')
    expect(messages[0]?.streaming).toBeUndefined()
    model.dispose()
  })

  it('collects tool calls and attaches results by callId', async () => {
    const { model, ops, pushLive } = makeModel([])
    await model.load(40)
    pushLive(event(20, 'tool/call', {
      turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}',
    }))
    pushLive(event(21, 'tool/result', {
      turn: 1, step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'call_1' },
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }] }],
      },
    }))
    const toolOps = ops.filter((op) => (op as { type: string }).type === 'tool-call')
    expect(toolOps).toHaveLength(1)
    const resultOp = ops.find((op) => (op as { type: string }).type === 'tool-result') as
      { callId: string; result: string; isError?: boolean }
    expect(resultOp.callId).toBe('call_1')
    expect(resultOp.result).toBe('file.txt')
    model.dispose()
  })

  it('skips chunk events during history load (compaction)', async () => {
    const historyEvents = [
      event(1, 'user/message', { content: [{ type: 'text', text: 'q' }], role: 'user', id: 'u1' }),
      event(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'zzz' } }),
      event(3, 'assistant/message', {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], id: 'a1' },
      }),
    ]
    const { model, ops } = makeModel(historyEvents)
    await model.load(40)
    // Chunk events from history must not produce stream-text ops.
    expect(ops.some((op) => (op as { type: string }).type === 'stream-text')).toBe(false)
    const messages = model.snapshot()
    expect(messages[1]?.text).toBe('answer')
    model.dispose()
  })

  it('tracks the todo list from todo/write events (issue #16)', async () => {
    const { model, ops, pushLive } = makeModel([])
    await model.load(40)
    pushLive(event(30, 'todo/write', { todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'completed' },
      { content: '', status: 'pending' }, // invalid entries are dropped
      { content: 'weird', status: 'unknown-status' }, // normalized to pending
    ] }))
    const todosOp = ops.find((op) => (op as { type: string }).type === 'todos') as { todos: { content: string; status: string }[] }
    expect(todosOp.todos).toEqual([
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'completed' },
      { content: 'weird', status: 'pending' },
    ])
    expect(model.todosSnapshot()).toHaveLength(4)
    model.dispose()
  })

  it('projects goal/change events and clears on goal/change clear (issue #16)', async () => {
    const { model, ops, pushLive } = makeModel([])
    await model.load(40)
    pushLive(event(40, 'goal/change', {
      kind: 'goal/change', version: 1, operation: 'create',
      goal: { id: 'g1', revision: 1, objective: '完成任务', phase: 'active', maxGoalRounds: 5 },
      roundsStarted: 1, createdAt: 100, updatedAt: 100,
    }))
    const goalOp = ops.find((op) => (op as { type: string }).type === 'goal') as { goal: { objective: string; phase: string; roundsStarted: number } }
    expect(goalOp.goal).toMatchObject({ objective: '完成任务', phase: 'active', roundsStarted: 1 })
    expect(model.goalSnapshot()?.maxGoalRounds).toBe(5)

    pushLive(event(41, 'goal/change', {
      kind: 'goal/change', version: 1, operation: 'block',
      goal: { id: 'g1', revision: 2, objective: '完成任务', phase: 'blocked', maxGoalRounds: 5,
        blockedReason: { code: 'hard-blocker', message: '外部依赖缺失' } },
      roundsStarted: 2, createdAt: 100, updatedAt: 200,
    }))
    expect(model.goalSnapshot()?.phase).toBe('blocked')
    expect(model.goalSnapshot()?.blockedReason?.message).toBe('外部依赖缺失')

    pushLive(event(42, 'goal/change', { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'g1', revision: 3 }, clearedAt: 300 }))
    expect(model.goalSnapshot()).toBeNull()
    const lastGoalOp = ops.filter((op) => (op as { type: string }).type === 'goal').pop() as { goal: unknown }
    expect(lastGoalOp.goal).toBeNull()
    model.dispose()
  })
})
