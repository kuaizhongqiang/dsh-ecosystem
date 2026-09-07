/**
 * Sidebar (issue #3): 卡片式 WebviewView 侧边栏。
 *
 * 取代旧的原生 TreeView（缩进式层级）：所有子视图（首页 / 会话 / 服务 /
 * 配置 / 插件 / 模式）都在一张自绘 WebviewView 里渲染，层级靠**分组标题、
 * 色块、图标与卡片**区分，不再依赖缩进。宿主侧只负责：
 *   - 维护当前视图（view）与"全部/当前工作区"开关（showAll）；
 *   - 每次数据变化把视图模型快照 postMessage 给 Webview；
 *   - 接收 Webview 的动作消息 → 执行对应 vscode 命令。
 */

import * as vscode from 'vscode'
import type { SessionStore, StoredSession } from './sessionStore.ts'
import type { DshConnection } from './client/connection.ts'
import type { AgentPresetEntry, SessionId, WorkspaceId } from './client/types.ts'
import type { LocalServiceState } from './localServer.ts'
import type { PluginEntry } from './plugins.ts'
import { sidebarViewHtml } from './sidebarViewHtml.ts'

export type SidebarView = 'home' | 'sessions' | 'service' | 'settings' | 'plugins' | 'presets'

export interface SidebarContext {
  getStore: () => SessionStore | undefined
  getConnection: () => DshConnection | undefined
  getConnected: () => boolean
  /** 当前关联的工作区（id + 规范化路径）。 */
  getWorkspace: () => { workspaceId?: WorkspaceId; path?: string } | undefined
  getService: () => LocalServiceState | undefined
  getPlugins: () => PluginEntry[]
  getPresets: () => AgentPresetEntry[]
  /** 读取一个 dsh.* 配置项的字符串值（如 'remote' / 'localServerPath'）。 */
  getConfigValue: (key: string) => string | undefined
}

// ---------------------------------------------------------------- 视图模型

export interface SessionCardView {
  sessionId: SessionId
  title: string
  cwd: string
  preset: string
  running: boolean
  turns?: number
  updatedText: string
}

export interface SidebarSnapshot {
  view: SidebarView
  connected: boolean
  /** 首页卡片 */
  home?: {
    workspacePath?: string
    workspaceHint?: string
    connText: string
    connDetail?: string
    connError: boolean
    entries: { view: SidebarView; title: string; desc: string; badge?: string }[]
  }
  /** 会话列表卡片 */
  sessions?: {
    showAll: boolean
    groups: { key: string; title: string; subtitle?: string; sessions: SessionCardView[] }[]
    emptyMsg?: string
  }
  /** 本地服务卡片 */
  service?: {
    statusText: string
    running: boolean
    starting: boolean
    failed: boolean
    url?: string
    details?: string[]
    error?: string
    canStart: boolean
    canStop: boolean
    logs: string[]
    missingPath?: boolean
  }
  /** 配置卡片 */
  settings?: {
    note?: string
    groups: { title: string; rows: { key: string; label: string; value: string; valueKind: 'bool' | 'text' | 'path'; desc?: string }[] }[]
  }
  /** 插件卡片 */
  plugins?: {
    installed: PluginCardView[]
    available: PluginCardView[]
  }
  /** 模式卡片 */
  presets?: {
    list: { id: string; isDefault: boolean; configDefault: boolean; trust: string }[]
    note?: string
    none?: boolean
  }
}

export interface PluginCardView {
  name: string
  kind: string
  path: string
  description: string
}

interface SettingRow {
  key: string
  label: string
  value: string
  valueKind: 'bool' | 'text' | 'path'
  desc?: string
}

interface SettingsGroup {
  title: string
  rows: SettingRow[]
}

// ---------------------------------------------------------------- 视图模型构建

function connView(ctx: SidebarContext): { text: string; detail?: string; error: boolean } {
  if (!ctx.getConnected()) {
    return { text: '未连接 DSH', detail: '点击连接，或检查 dsh.serverUrl', error: false }
  }
  const service = ctx.getService()
  const detail = service?.status === 'running' ? `本地服务 ${service.url ?? ''}` : '已连接'
  return { text: '已连接', detail, error: false }
}

function sessionCardView(session: StoredSession): SessionCardView {
  const stats: string[] = []
  if (session.running) stats.push('● 运行中')
  if (session.turns !== undefined) stats.push(`${session.turns} 轮`)
  stats.push(relativeTime(session.updatedAt))
  void stats
  return {
    sessionId: session.sessionId,
    title: session.title ?? '新会话',
    cwd: session.cwd,
    preset: session.agentPreset,
    running: session.running,
    turns: session.turns,
    updatedText: relativeTime(session.updatedAt),
  }
}

function normalizePath(p: string): string {
  if (!p) return ''
  let out = p.replace(/[\\/]+$/, '')
  if (process.platform === 'win32') out = out.toLowerCase()
  return out
}

function sessionInWorkspace(session: StoredSession, workspaceId: string, store: SessionStore | undefined): boolean {
  const workspaces = store?.allWorkspaces ?? []
  const entry = workspaces.find((w) => w.workspaceId === workspaceId)
  if (entry === undefined) return false
  if (entry.sessionIds.includes(session.sessionId)) return true
  return normalizePath(entry.path) === normalizePath(session.cwd)
}

function buildHome(ctx: SidebarContext): SidebarSnapshot['home'] {
  const workspace = ctx.getWorkspace()
  const conn = connView(ctx)
  const entries: NonNullable<SidebarSnapshot['home']>['entries'] = []

  const sessions = ctx.getStore()?.allSessions ?? []
  const workspaceId = workspace?.workspaceId
  const workspaceCount = workspaceId !== undefined
    ? sessions.filter((s) => sessionInWorkspace(s, workspaceId, ctx.getStore())).length
    : 0
  entries.push({ view: 'sessions', title: '会话列表', desc: '当前工作区的会话', badge: String(workspaceCount) })

  const service = ctx.getService()
  entries.push({
    view: 'service',
    title: '拉起服务',
    desc: '本地 dsh web 启动 / 停止',
    badge: serviceStatusText(service),
  })
  entries.push({ view: 'settings', title: '进入配置', desc: '连接模式 · 服务地址 · 认证' })
  const installedPlugins = ctx.getPlugins().filter((p) => p.installed).length
  entries.push({
    view: 'plugins',
    title: '插件库',
    desc: 'skills / tools / presets 插件',
    badge: installedPlugins > 0 ? String(installedPlugins) : undefined,
  })
  const configDefault = ctx.getPresets().find((p) => p.isDefault)?.id
  entries.push({
    view: 'presets',
    title: '模式列表',
    desc: 'agent preset（模式）',
    badge: configDefault,
  })

  return {
    workspacePath: workspace?.path,
    workspaceHint: '当前工作区 · 新会话将在此目录工作',
    connText: conn.text,
    connDetail: conn.detail,
    connError: conn.error,
    entries,
  }
}

function buildSessions(ctx: SidebarContext, showAll: boolean): SidebarSnapshot['sessions'] {
  const store = ctx.getStore()
  const sessions = store?.allSessions ?? []
  const workspaces = store?.allWorkspaces ?? []
  const workspace = ctx.getWorkspace()
  const workspaceSessions = new Map<string, StoredSession[]>()
  for (const ws of workspaces) workspaceSessions.set(ws.workspaceId, [])
  const ungrouped: StoredSession[] = []
  for (const session of sessions) {
    let placed = false
    for (const ws of workspaces) {
      if (sessionInWorkspace(session, ws.workspaceId, store)) {
        workspaceSessions.get(ws.workspaceId)?.push(session)
        placed = true
        break
      }
    }
    if (!placed) ungrouped.push(session)
  }
  const byUpdated = (a: StoredSession, b: StoredSession): number => b.updatedAt - a.updatedAt
  const groups: NonNullable<SidebarSnapshot['sessions']>['groups'] = []

  const pushWorkspace = (workspaceId: string, title: string, subtitle: string | undefined, list: StoredSession[]): void => {
    if (list.length === 0) return
    groups.push({
      key: workspaceId,
      title,
      subtitle: subtitle ?? `${list.length} 个会话`,
      sessions: [...list].sort(byUpdated).map(sessionCardView),
    })
  }

  if (showAll) {
    for (const ws of workspaces) {
      pushWorkspace(ws.workspaceId, ws.title, ws.path, workspaceSessions.get(ws.workspaceId) ?? [])
    }
    if (ungrouped.length > 0) {
      pushWorkspace('__ungrouped__', '未分组会话', '不在任何已关联工作区', ungrouped)
    }
  } else {
    const primaryId = workspace?.workspaceId
    let added = false
    if (primaryId !== undefined) {
      const entry = workspaces.find((w) => w.workspaceId === primaryId)
      const own = workspaceSessions.get(primaryId) ?? []
      if (entry !== undefined) {
        pushWorkspace(entry.workspaceId, entry.title, entry.path, own)
        added = true
      } else if (own.length > 0) {
        pushWorkspace(primaryId, workspace?.path?.split(/[\\/]/).pop() ?? '当前工作区', workspace?.path, own)
        added = true
      }
    }
    if (!added) {
      for (const ws of workspaces) {
        pushWorkspace(ws.workspaceId, ws.title, ws.path, workspaceSessions.get(ws.workspaceId) ?? [])
      }
      if (ungrouped.length > 0) pushWorkspace('__ungrouped__', '未分组会话', '不在任何已关联工作区', ungrouped)
    }
  }
  const emptyMsg = groups.length === 0 ? (sessions.length === 0 ? '还没有会话，点击下方按钮新建' : '当前工作区没有会话，可切换查看全部') : undefined
  return { showAll, groups, emptyMsg }
}

function buildService(ctx: SidebarContext): SidebarSnapshot['service'] {
  const service = ctx.getService()
  const state = service ?? { status: 'stopped' as const, logs: [] as string[] }
  const running = state.status === 'running'
  const starting = state.status === 'starting'
  const failed = state.status === 'failed'
  const details: string[] = []
  if (running) {
    if (state.reused) details.push('复用已有实例')
    if (state.pid !== undefined) details.push(`PID ${state.pid}`)
  }
  const missingPath = (ctx.getConfigValue('localServerPath') ?? '') === ''
  return {
    statusText: `服务状态：${serviceStatusText(state)}`,
    running,
    starting,
    failed,
    url: state.url,
    details,
    error: state.error,
    canStart: !running && !starting,
    canStop: running || starting,
    logs: (state.logs ?? []).slice(-12),
    missingPath,
  }
}

function boolValue(ctx: SidebarContext, key: string): boolean {
  return ctx.getConfigValue(key) === 'true'
}

function textValue(ctx: SidebarContext, key: string): string {
  return ctx.getConfigValue(key) ?? ''
}

function buildSettings(ctx: SidebarContext): SidebarSnapshot['settings'] {
  const groups: SettingsGroup[] = []
  const remote = boolValue(ctx, 'remote')
  const connRows: SettingRow[] = [
    {
      key: 'remote',
      label: '远程模式（Remote）',
      value: remote ? '开启' : '关闭',
      valueKind: 'bool',
      desc: '开 = 直连远程 DSH（配 token 认证）；关 = 本地模式（可拉起 dsh web）',
    },
    {
      key: 'token',
      label: 'DSH 启动 Token（dsh.token）',
      value: textValue(ctx, 'token') ? '（已设置）' : '（未设置）',
      valueKind: 'text',
      desc: 'dsh web 打印的 ?token= 值；扩展自动换取会话 cookie 认证 /api 与事件流',
    },
  ]
  if (!remote) {
    connRows.push({
      key: 'localServerPath',
      label: '本地服务目录（dsh.localServerPath）',
      value: textValue(ctx, 'localServerPath') || '（未设置）',
      valueKind: 'path',
      desc: '配置后启动即可自动拉起 dsh web（cwd=该目录）并连接',
    })
  }
  connRows.push({
    key: 'serverUrl',
    label: '服务地址（dsh.serverUrl）',
    value: textValue(ctx, 'serverUrl'),
    valueKind: 'text',
    desc: 'Remote 必填；Local 可留空（默认 http://127.0.0.1:3080）',
  })
  groups.push({ title: '连接', rows: connRows })

  const behaviorRows: SettingRow[] = (['autoConnect', 'autoAttachWorkspace', 'autoOpenChat', 'showReasoning'] as const).map((key) => ({
    key,
    label: settingLabel(key),
    value: boolValue(ctx, key) ? '开启' : '关闭',
    valueKind: 'bool',
  }))
  behaviorRows.push({
    key: 'promptMode',
    label: '发送消息模式（dsh.promptMode）',
    value: textValue(ctx, 'promptMode') === 'queue' ? '排队（queue）' : '插话（steer）',
    valueKind: 'text',
    desc: '插话 = 立即处理（与 DSH Web 一致）；排队 = 等当前回合结束',
  })
  groups.push({ title: '行为', rows: behaviorRows })

  groups.push({
    title: '数值',
    rows: (['defaultAgentPreset', 'historyPageSize', 'reconnectIntervalMs', 'maxToolResultChars'] as const).map((key) => ({
      key,
      label: settingLabel(key),
      value: textValue(ctx, key),
      valueKind: 'text',
    })),
  })
  return { note: '改动即时保存并生效（serverUrl / cookie 变更会自动重连）', groups }
}

function buildPlugins(ctx: SidebarContext): SidebarSnapshot['plugins'] {
  const entries = ctx.getPlugins()
  const card = (p: PluginEntry): PluginCardView => ({ name: p.name, kind: p.kind, path: p.path, description: p.description })
  return {
    installed: entries.filter((p) => p.installed).map(card),
    available: entries.filter((p) => !p.installed).map(card),
  }
}

function buildPresets(ctx: SidebarContext): SidebarSnapshot['presets'] {
  const presets = ctx.getPresets()
  const configDefault = textValue(ctx, 'defaultAgentPreset')
  return {
    list: presets.map((preset) => ({
      id: preset.id,
      isDefault: preset.isDefault,
      configDefault: preset.id === configDefault,
      trust: preset.trust === 'user' ? '本地' : '系统',
    })),
    note: `新建会话默认 preset：${configDefault || '（未配置，用服务端默认）'}`,
    none: presets.length === 0,
  }
}

/** 按当前视图组装完整快照。 */
export function buildSnapshot(ctx: SidebarContext, view: SidebarView, showAll: boolean): SidebarSnapshot {
  const snapshot: SidebarSnapshot = { view, connected: ctx.getConnected() }
  switch (view) {
    case 'home':
      snapshot.home = buildHome(ctx)
      break
    case 'sessions':
      snapshot.sessions = buildSessions(ctx, showAll)
      break
    case 'service':
      snapshot.service = buildService(ctx)
      break
    case 'settings':
      snapshot.settings = buildSettings(ctx)
      break
    case 'plugins':
      snapshot.plugins = buildPlugins(ctx)
      break
    case 'presets':
      snapshot.presets = buildPresets(ctx)
      break
  }
  return snapshot
}

// ---------------------------------------------------------------- Provider

export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'dsh.sessions'
  private readonly ctx: SidebarContext
  private view: SidebarView = 'home'
  private showAllSessions = false
  private webviewView: vscode.WebviewView | undefined

  constructor(ctx: SidebarContext) {
    this.ctx = ctx
  }

  getCurrentView(): SidebarView {
    return this.view
  }

  navigate(view: SidebarView): void {
    this.view = view
    if (view !== 'sessions') this.showAllSessions = false
    this.post()
  }

  toggleAllSessions(): void {
    this.showAllSessions = !this.showAllSessions
    this.post()
  }

  refresh(): void {
    this.post()
  }

  private post(): void {
    if (this.webviewView === undefined) return
    void this.webviewView.webview.postMessage({ type: 'snapshot', snapshot: buildSnapshot(this.ctx, this.view, this.showAllSessions) })
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.html = sidebarViewHtml()
    webviewView.onDidDispose(() => {
      if (this.webviewView === webviewView) this.webviewView = undefined
    })
    webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message)
    })
    // 视图就绪后立即推送当前快照。
    webviewView.webview.postMessage({ type: 'snapshot', snapshot: buildSnapshot(this.ctx, this.view, this.showAllSessions) })
  }

  /** Webview 动作 → vscode 命令（白名单，全部经扩展已有命令执行）。 */
  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as { type?: string; command?: string; arg?: unknown }
    if (msg?.type !== 'exec' || typeof msg.command !== 'string') return
    const command = msg.command
    const arg = msg.arg
    try {
      switch (command) {
        case 'dsh.openChat':
        case 'dsh.openInBrowser':
        case 'dsh.cancel':
        case 'dsh.renameSession':
        case 'dsh.openPluginPath':
        case 'dsh.usePreset':
        case 'dsh.toggleSetting':
        case 'dsh.sidebarNavigate':
          await vscode.commands.executeCommand(command, arg)
          break
        default:
          await vscode.commands.executeCommand(command)
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      void vscode.window.showErrorMessage(`操作失败（${command}）：${text}`)
    }
  }
}

// ---------------------------------------------------------------- 工具

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

function serviceStatusText(state: LocalServiceState | undefined): string {
  if (state === undefined) return '未启动'
  switch (state.status) {
    case 'running':
      return '运行中'
    case 'starting':
      return '启动中…'
    case 'failed':
      return '启动失败'
    default:
      return '未启动'
  }
}

function settingLabel(key: string): string {
  const labels: Record<string, string> = {
    autoConnect: '启动自动连接',
    autoAttachWorkspace: '工作区自动关联',
    autoOpenChat: '新建会话自动打开聊天',
    showReasoning: '显示思考过程',
    defaultAgentPreset: '默认 agent preset',
    historyPageSize: '历史消息条数',
    reconnectIntervalMs: '重连间隔（毫秒）',
    maxToolResultChars: '工具结果最大字符数',
  }
  return labels[key] ?? key
}
