import { describe, expect, it, vi } from 'vitest'
import { NestedSessions, type NestedModelLike } from './nestedSessions.ts'
import type { HostToWebviewOp } from './types.ts'

function harness(overrides: { createSession?: () => Promise<string>; prompt?: (id: string, text: string) => Promise<void> } = {}) {
  const ops: HostToWebviewOp[] = []
  const models: { sessionId: string; loaded: number; disposed: boolean }[] = []
  const nested = new NestedSessions({
    createSession: overrides.createSession ?? (async () => 's-nested-1'),
    createModel: (sessionId): NestedModelLike => {
      const record = { sessionId, loaded: 0, disposed: false }
      models.push(record)
      return {
        load: async (n) => { record.loaded = n },
        dispose: () => { record.disposed = true },
      }
    },
    emit: (op) => ops.push(op),
    prompt: overrides.prompt ?? (async () => {}),
    historyLimit: 0,
  })
  return { nested, ops, models }
}

describe('NestedSessions', () => {
  it('creates a session, emits nested-init and loads the model', async () => {
    const { nested, ops, models } = harness()
    const id = await nested.create()
    expect(id).toBe('nest-1')
    expect(models[0]?.sessionId).toBe('s-nested-1')
    expect(ops[0]).toEqual({ type: 'nested-init', nestedId: 'nest-1', collapsed: false })
    await Promise.resolve()
    expect(models[0]?.loaded).toBe(0)
    expect(nested.list).toEqual([{ id: 'nest-1', sessionId: 's-nested-1', collapsed: false, running: false }])
  })

  it('tags model ops with the nest id', async () => {
    const ops: HostToWebviewOp[] = []
    let forward: ((op: HostToWebviewOp) => void) | undefined
    const nested = new NestedSessions({
      createSession: async () => 's1',
      createModel: (_sessionId, onOp) => {
        forward = onOp
        return { load: async () => {}, dispose: () => {} }
      },
      emit: (op) => ops.push(op),
      prompt: async () => {},
    })
    await nested.create()
    forward?.({ type: 'stream-text', id: 'm1', text: 'hi' })
    expect(ops.at(-1)).toEqual({ type: 'stream-text', id: 'm1', text: 'hi', nestedId: 'nest-1' })
  })

  it('routes prompts to the nested session and toggles running state', async () => {
    const calls: [string, string][] = []
    const { nested, ops } = harness({ prompt: async (id, text) => { calls.push([id, text]) } })
    await nested.create()
    await nested.prompt('nest-1', '  ping  ')
    expect(calls).toEqual([['s-nested-1', '  ping  ']])
    expect(ops.filter((op) => op.type === 'running')).toEqual([
      { type: 'running', running: true, nestedId: 'nest-1' },
      { type: 'running', running: false, nestedId: 'nest-1' },
    ])
  })

  it('ignores prompts for unknown nests and empty text', async () => {
    const calls: string[] = []
    const { nested } = harness({ prompt: async (id) => { calls.push(id) } })
    await nested.prompt('nope', 'x')
    await nested.create()
    await nested.prompt('nest-1', '   ')
    expect(calls).toEqual([])
  })

  it('reports create failures explicitly instead of throwing', async () => {
    const { nested, ops } = harness({ createSession: async () => { throw new Error('boom') } })
    await expect(nested.create()).resolves.toBeUndefined()
    expect(ops).toEqual([{ type: 'error', text: '子会话创建失败：boom' }])
  })

  it('toggles collapse, closes (disposing the model) and removes the card', async () => {
    const { nested, ops, models } = harness()
    await nested.create()
    nested.toggle('nest-1', true)
    expect(ops.at(-1)).toEqual({ type: 'nested-collapsed', nestedId: 'nest-1', collapsed: true })
    expect(nested.list[0]?.collapsed).toBe(true)
    nested.close('nest-1')
    expect(models[0]?.disposed).toBe(true)
    expect(ops.at(-1)).toEqual({ type: 'nested-remove', nestedId: 'nest-1' })
    expect(nested.list).toEqual([])
  })

  it('disposes every model on disposeAll', async () => {
    const { nested, models } = harness()
    await nested.create()
    await nested.create()
    nested.disposeAll()
    expect(models.every((m) => m.disposed)).toBe(true)
    expect(nested.list).toEqual([])
  })
})
