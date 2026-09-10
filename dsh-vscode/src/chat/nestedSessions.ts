/**
 * Nested sub-sessions ("聊天中聊天", milestone #2 issue #22).
 *
 * A Nest is an independent dsh session created from inside a conversation and
 * rendered as an in-message card: it has its own prompt/stream lifecycle while
 * the main session keeps its own. This module owns the bookkeeping (create,
 * route ops with a `nestedId`, toggle, close) and stays free of VS Code types
 * so it can be unit-tested; the panel supplies session creation, the per-session
 * model and the op sink.
 */

import type { HostToWebviewOp } from './types.ts'

/** Minimal per-session model surface the nest drives (satisfied by ChatModel). */
export interface NestedModelLike {
  load(maxMessages: number): Promise<void>
  dispose(): void
}

export interface NestedSessionsDeps {
  /** Create a real dsh session (same workspace as the parent when possible). */
  createSession: () => Promise<string>
  /**
   * Build a model for the nested session. `onOp` receives the session's raw ops;
   * the nest adds `nestedId` before forwarding them to the webview.
   */
  createModel: (sessionId: string, onOp: (op: HostToWebviewOp) => void) => NestedModelLike
  /** Ship one op to the webview. */
  emit: (op: HostToWebviewOp) => void
  /** Send a prompt to the nested session. */
  prompt: (sessionId: string, text: string) => Promise<void>
  /** History rows to load for a fresh nest (default 0 — a new conversation). */
  historyLimit?: number
}

export interface NestedSessionInfo {
  id: string
  sessionId: string
  collapsed: boolean
  running: boolean
}

interface Entry {
  info: NestedSessionInfo
  model: NestedModelLike
}

export class NestedSessions {
  private readonly entries = new Map<string, Entry>()
  private seq = 0

  constructor(private readonly deps: NestedSessionsDeps) {}

  get list(): NestedSessionInfo[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.info }))
  }

  /** Create a nested session and emit its init op. Returns the nest id. */
  async create(): Promise<string | undefined> {
    let sessionId: string
    try {
      sessionId = await this.deps.createSession()
    } catch (error) {
      this.deps.emit({ type: 'error', text: `子会话创建失败：${messageOf(error)}` })
      return undefined
    }
    const id = `nest-${String(++this.seq)}`
    const info: NestedSessionInfo = { id, sessionId, collapsed: false, running: false }
    const model = this.deps.createModel(sessionId, (op) => {
      // The forwarded op keeps its message-level shape and gains the nest id;
      // the webview routes on `nestedId` when present.
      this.deps.emit({ ...op, nestedId: id } as HostToWebviewOp)
    })
    this.entries.set(id, { info, model })
    this.deps.emit({ type: 'nested-init', nestedId: id, collapsed: info.collapsed })
    void Promise.resolve(model.load(this.deps.historyLimit ?? 0)).catch((error: unknown) => {
      this.deps.emit({ type: 'error', nestedId: id, text: `子会话历史加载失败：${messageOf(error)}` })
    })
    return id
  }

  async prompt(id: string, text: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry === undefined || text.trim().length === 0) return
    entry.info.running = true
    this.deps.emit({ type: 'running', running: true, nestedId: id })
    try {
      await this.deps.prompt(entry.info.sessionId, text)
    } catch (error) {
      this.deps.emit({ type: 'error', nestedId: id, text: `子会话发送失败：${messageOf(error)}` })
    } finally {
      entry.info.running = false
      this.deps.emit({ type: 'running', running: false, nestedId: id })
    }
  }

  toggle(id: string, collapsed: boolean): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    entry.info.collapsed = collapsed
    this.deps.emit({ type: 'nested-collapsed', nestedId: id, collapsed })
  }

  close(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    entry.model.dispose()
    this.entries.delete(id)
    this.deps.emit({ type: 'nested-remove', nestedId: id })
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) entry.model.dispose()
    this.entries.clear()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
