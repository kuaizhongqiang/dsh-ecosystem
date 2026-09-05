/**
 * Render types + webview op protocol shared by the host-side chat model and
 * the chat webview. Ops flow host → webview; requests flow webview → host.
 */

import type { QuestionItem, SessionModels } from '../client/types.ts'

export interface RenderToolCall {
  callId: string
  name: string
  arguments: string
  result?: string
  isError?: boolean
  status: 'pending' | 'running' | 'done' | 'error'
}

export interface RenderMessage {
  /** Stable id: message id when the event carries one, else `m-{turn}-{step}`. */
  id: string
  role: 'user' | 'assistant' | 'system'
  /** Extra label for non-human user sources (agent.inject, goal rounds…). */
  label?: string
  text: string
  reasoning?: string
  toolCalls: RenderToolCall[]
  streaming?: boolean
  interrupted?: boolean
  time: number
}

/** 用量统计（来自 sessionStats / tokenUsage / contextPressure 投影）。 */
export interface SessionStatsView {
  turns?: number
  steps?: number
  llmMs?: number
  toolMs?: number
  decodeTokens?: number
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
  /** 按当前会话模型官方价估算的累计费用（¥，来自 tokenUsage 投影）。 */
  costCny?: number
}

/** todo/write 事件携带的单个任务。 */
export interface TodoEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** goal/change 事件投影后的目标视图。 */
export interface GoalView {
  id: string
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  maxGoalRounds: number
  roundsStarted: number
  blockedReason?: { code: string; message: string }
}

/** @ 提及候选：会话 cwd / 当前工作区下的一个文件或文件夹。 */
export interface FileCandidate {
  name: string
  /** 相对 cwd 的展示路径（目录以 / 结尾）。 */
  path: string
  isDir: boolean
}

/** 发送给 DSH 的图片附件（base64，DSH 提升为持久附件）。 */
export interface PromptImage {
  /** 展示名（可选）。 */
  name?: string
  /** image/png | image/jpeg | image/webp | image/gif。 */
  mediaType: string
  /** canonical base64 编码的图片字节。 */
  data: string
}

export type HostToWebviewOp =
  | { type: 'init'; sessionId: string; title?: string; cwd?: string; running: boolean; messages: RenderMessage[]; showReasoning: boolean; todos?: TodoEntry[]; goal?: GoalView | null }
  | { type: 'connection'; connected: boolean }
  | { type: 'running'; running: boolean }
  | { type: 'models'; current: { provider: string; model: string; reasoningEffort?: string } | null; routable: boolean; groups: SessionModels['groups']; failures: SessionModels['failures'] }
  | { type: 'stats'; stats: SessionStatsView }
  | { type: 'append-message'; message: RenderMessage }
  | { type: 'stream-text'; id: string; text: string }
  | { type: 'stream-reasoning'; id: string; text: string }
  | { type: 'finalize-message'; id: string; message: RenderMessage }
  | { type: 'tool-call'; messageId?: string; tool: RenderToolCall }
  | { type: 'tool-result'; callId: string; result: string; isError?: boolean }
  | { type: 'todos'; todos: TodoEntry[] }
  | { type: 'goal'; goal: GoalView | null }
  | { type: 'approval'; rpcId: string; approvalId: string; toolName: string; reason?: string }
  | { type: 'approval-resolved'; approvalId: string; outcome: string }
  | { type: 'question'; rpcId: string; questions: QuestionItem[] }
  | { type: 'question-resolved'; questionRpcId: string; outcome: string }
  | { type: 'turn-end'; turn: number; reasonKind: string }
  | { type: 'title'; title: string }
  | { type: 'status'; text: string }
  | { type: 'error'; text: string }
  | { type: 'file-candidates'; candidates: FileCandidate[] }
  | { type: 'file-read-result'; path: string; name: string; mediaType: string; data: string; error?: string }
  | { type: 'audio-saved'; name: string; path: string; error?: string }

export type WebviewToHostRequest =
  | { type: 'ready' }
  | { type: 'prompt'; text: string; images?: PromptImage[] }
  | { type: 'cancel' }
  | { type: 'approve'; rpcId: string; approvalId: string }
  | { type: 'reject'; rpcId: string; approvalId: string }
  | { type: 'answer'; rpcId: string; answers: { id: string; selected: string[]; custom?: string }[] }
  | { type: 'model-change'; provider: string; model: string }
  | { type: 'open-in-browser' }
  | { type: 'file-pick'; query: string }
  | { type: 'file-read'; path: string }
  | { type: 'audio-paste'; name: string; mediaType: string; data: string }

/** Default truncation cap for tool results before shipping to the webview. */
export const MAX_TOOL_RESULT_CHARS = 4000
