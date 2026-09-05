/**
 * Sidebar: entry-style home navigation (issue #5) with sub-views
 * (sessions / local service / settings / plugins / presets) and a shared
 * "enter + back" mechanism (issue #3). One tree data provider switches its
 * root content per view; the title bar buttons stay in `package.json`.
 */

import * as vscode from 'vscode'
import type { SessionStore, StoredSession } from './sessionStore.ts'
import type { DshConnection } from './client/connection.ts'
import type { AgentPresetEntry, SessionId, WorkspaceId } from './client/types.ts'
import type { LocalServiceState } from './localServer.ts'
import type { PluginEntry } from './plugins.ts'

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

type TreeNode =
  | { kind: 'back' }
  | { kind: 'nav'; view: SidebarView; title: string; icon: string; description?: string; badge?: string }
  | { kind: 'path'; path: string; hint?: string }
  | { kind: 'status'; text: string; icon: string; description?: string; error?: boolean }
  | { kind: 'action'; id: string; title: string; icon: string; description?: string; contextValue: string }
  | { kind: 'toggle-all' }
  | { kind: 'workspace'; workspaceId: string; title: string; path: string; sessions: StoredSession[] }
  | { kind: 'ungrouped'; sessions: StoredSession[] }
  | { kind: 'session'; session: StoredSession }
  | { kind: 'log'; text: string }
  | { kind: 'log-group'; logs: string[] }
  | { kind: 'setting'; key: string; label: string; value: string; valueKind: 'bool' | 'text' | 'path'; description?: string }
  | { kind: 'settings-group'; title: string }
  | { kind: 'plugin'; entry: PluginEntry }
  | { kind: 'plugin-group'; title: string; count: number }
  | { kind: 'preset'; preset: AgentPresetEntry; isConfigDefault: boolean }
  | { kind: 'preset-note'; text: string }

export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private tree: TreeNode[] = []
  private view: SidebarView = 'home'
  private showAllSessions = false
  private readonly ctx: SidebarContext

  constructor(ctx: SidebarContext) {
    this.ctx = ctx
    this.refresh()
  }

  getCurrentView(): SidebarView {
    return this.view
  }

  /** Switch to another view (home for back). Rebuilds the tree. */
  navigate(view: SidebarView): void {
    this.view = view
    this.rebuild()
  }

  /** Toggle between "current workspace only" and "all sessions" in the sessions view. */
  toggleAllSessions(): void {
    this.showAllSessions = !this.showAllSessions
    this.rebuild()
  }

  getSessionNode(sessionId: SessionId): TreeNode | undefined {
    for (const node of this.tree) {
      if (node.kind === 'session' && node.session.sessionId === sessionId) return node
    }
    return undefined
  }

  refresh(): void {
    this.rebuild()
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element === undefined) return this.tree
    switch (element.kind) {
      case 'workspace':
        return element.sessions.map(sessionNode)
      case 'ungrouped':
        return element.sessions.map(sessionNode)
      case 'log-group':
        return element.logs.map((text) => ({ kind: 'log' as const, text }))
      case 'plugin-group':
        // Children are resolved from the context at rebuild time; keep a
        // static placeholder so the group can still expand.
        return this.groupChildren(element)
      case 'settings-group':
        return this.groupChildren(element)
      default:
        return []
    }
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'back':
        return backItem()
      case 'nav':
        return navItem(element)
      case 'path':
        return pathItem(element)
      case 'status':
        return statusItem(element)
      case 'action':
        return actionItem(element)
      case 'toggle-all':
        return toggleAllItem(this.showAllSessions)
      case 'workspace':
        return workspaceItem(element)
      case 'ungrouped':
        return ungroupedItem(element)
      case 'session':
        return sessionTreeItem(element.session)
      case 'log':
        return logItem(element)
      case 'log-group':
        return logGroupItem(element)
      case 'setting':
        return settingItem(element)
      case 'settings-group':
        return settingsGroupItem(element)
      case 'plugin':
        return pluginItem(element)
      case 'plugin-group':
        return pluginGroupItem(element)
      case 'preset':
        return presetItem(element)
      case 'preset-note':
        return noteItem(element)
    }
  }

  // ---- rebuild ----

  private rebuild(): void {
    switch (this.view) {
      case 'home':
        this.tree = this.buildHome()
        break
      case 'sessions':
        this.tree = this.buildSessions()
        break
      case 'service':
        this.tree = this.buildService()
        break
      case 'settings':
        this.tree = this.buildSettings()
        break
      case 'plugins':
        this.tree = this.buildPlugins()
        break
      case 'presets':
        this.tree = this.buildPresets()
        break
    }
    this._onDidChangeTreeData.fire(undefined)
  }

  // ---- home ----

  private buildHome(): TreeNode[] {
    const nodes: TreeNode[] = []
    const workspace = this.ctx.getWorkspace()
    if (workspace?.path !== undefined && workspace.path.length > 0) {
      nodes.push({ kind: 'path', path: workspace.path, hint: '当前工作区 · 新会话将在此目录工作' })
    }
    nodes.push(this.connectionStatusNode())

    const sessions = this.ctx.getStore()?.allSessions ?? []
    const workspaceIdForCount = workspace?.workspaceId
    const workspaceSessions = workspaceIdForCount !== undefined
      ? sessions.filter((s) => this.sessionInWorkspace(s, workspaceIdForCount)).length
      : 0
    nodes.push({ kind: 'nav', view: 'sessions', title: '会话列表', icon: 'comment-discussion', description: '当前工作区的会话', badge: String(workspaceSessions) })

    const service = this.ctx.getService()
    nodes.push({
      kind: 'nav',
      view: 'service',
      title: '拉起服务',
      icon: 'server',
      description: '本地 dsh web 启动 / 停止',
      badge: serviceStatusText(service),
    })
    nodes.push({ kind: 'nav', view: 'settings', title: '进入配置', icon: 'settings-gear', description: '连接模式 · 服务地址 · 认证' })
    const installedPlugins = this.ctx.getPlugins().filter((p) => p.installed).length
    nodes.push({
      kind: 'nav',
      view: 'plugins',
      title: '插件库',
      icon: 'extensions',
      description: 'skills / tools / presets 插件',
      badge: installedPlugins > 0 ? String(installedPlugins) : undefined,
    })
    const presets = this.ctx.getPresets()
    const configDefault = presets.find((p) => p.isDefault)?.id
    nodes.push({
      kind: 'nav',
      view: 'presets',
      title: '模式列表',
      icon: 'sparkle',
      description: 'agent preset（模式）',
      badge: configDefault,
    })

    nodes.push({ kind: 'action', id: 'dsh.newSession', title: '新建会话', icon: 'add', contextValue: 'dsh-action' })
    nodes.push({ kind: 'action', id: 'dsh.refreshSessions', title: '刷新', icon: 'refresh', contextValue: 'dsh-action' })
    return nodes
  }

  private connectionStatusNode(): TreeNode {
    if (!this.ctx.getConnected()) {
      return { kind: 'status', text: '未连接 DSH', icon: 'plug', description: '点击连接或检查 dsh.serverUrl', error: false }
    }
    const service = this.ctx.getService()
    const detail = service?.status === 'running' ? `本地服务 ${service.url ?? ''}` : '已连接'
    return { kind: 'status', text: '已连接', icon: 'check', description: detail }
  }

  // ---- sessions ----

  private buildSessions(): TreeNode[] {
    const nodes: TreeNode[] = [{ kind: 'back' }]
    const workspace = this.ctx.getWorkspace()
    if (workspace?.path !== undefined && workspace.path.length > 0) {
      nodes.push({ kind: 'path', path: workspace.path, hint: '当前工作区' })
    }
    nodes.push({ kind: 'toggle-all' })

    const store = this.ctx.getStore()
    const sessions = store?.allSessions ?? []
    const workspaces = store?.allWorkspaces ?? []
    const workspaceSessions = new Map<string, StoredSession[]>()
    for (const workspaceEntry of workspaces) {
      workspaceSessions.set(workspaceEntry.workspaceId, [])
    }
    const ungrouped: StoredSession[] = []
    for (const session of sessions) {
      let placed = false
      for (const workspaceEntry of workspaces) {
        if (this.sessionInWorkspace(session, workspaceEntry.workspaceId)) {
          workspaceSessions.get(workspaceEntry.workspaceId)?.push(session)
          placed = true
          break
        }
      }
      if (!placed) ungrouped.push(session)
    }

    if (this.showAllSessions) {
      for (const workspaceEntry of workspaces) {
        nodes.push({
          kind: 'workspace',
          workspaceId: workspaceEntry.workspaceId,
          title: workspaceEntry.title,
          path: workspaceEntry.path,
          sessions: (workspaceSessions.get(workspaceEntry.workspaceId) ?? []).sort(byUpdatedAt),
        })
      }
      if (ungrouped.length > 0) nodes.push({ kind: 'ungrouped', sessions: ungrouped.sort(byUpdatedAt) })
      if (workspaces.length === 0 && ungrouped.length === 0) {
        nodes.push({ kind: 'status', text: '没有会话', icon: 'info', description: '点击下方按钮新建', error: false })
      }
    } else {
      let addedWorkspace = false
      const primaryId = workspace?.workspaceId
      if (primaryId !== undefined) {
        const entry = workspaces.find((w) => w.workspaceId === primaryId)
        const own = (workspaceSessions.get(primaryId) ?? []).sort(byUpdatedAt)
        if (entry !== undefined) {
          nodes.push({ kind: 'workspace', workspaceId: entry.workspaceId, title: entry.title, path: entry.path, sessions: own })
          addedWorkspace = true
        } else if (own.length > 0) {
          nodes.push({ kind: 'workspace', workspaceId: primaryId, title: workspace?.path?.split(/[\\/]/).pop() ?? '当前工作区', path: workspace?.path ?? '', sessions: own })
          addedWorkspace = true
        }
      }
      if (!addedWorkspace) {
        // 没有当前工作区（或数据未就绪）：退化为展示全部。
        for (const workspaceEntry of workspaces) {
          nodes.push({
            kind: 'workspace',
            workspaceId: workspaceEntry.workspaceId,
            title: workspaceEntry.title,
            path: workspaceEntry.path,
            sessions: (workspaceSessions.get(workspaceEntry.workspaceId) ?? []).sort(byUpdatedAt),
          })
        }
        if (ungrouped.length > 0) nodes.push({ kind: 'ungrouped', sessions: ungrouped.sort(byUpdatedAt) })
      }
    }
    nodes.push({ kind: 'action', id: 'dsh.newSession', title: '新建会话', icon: 'add', contextValue: 'dsh-action' })
    return nodes
  }

  /** Workspace membership: sessionIds first, then normalized-cwd fallback. */
  private sessionInWorkspace(session: StoredSession, workspaceId: string): boolean {
    const workspaces = this.ctx.getStore()?.allWorkspaces ?? []
    const entry = workspaces.find((w) => w.workspaceId === workspaceId)
    if (entry === undefined) return false
    if (entry.sessionIds.includes(session.sessionId)) return true
    return normalizePath(entry.path) === normalizePath(session.cwd)
  }

  // ---- service ----

  private buildService(): TreeNode[] {
    const nodes: TreeNode[] = [{ kind: 'back' }]
    const service = this.ctx.getService()
    const state = service ?? { status: 'stopped' as const, logs: [] as string[] }

    nodes.push({
      kind: 'status',
      text: `服务状态：${serviceStatusText(state)}`,
      icon: state.status === 'running' ? 'check' : state.status === 'starting' ? 'sync~spin' : state.status === 'failed' ? 'error' : 'circle-outline',
      description: state.url ?? (state.status === 'running' ? undefined : undefined),
      error: state.status === 'failed',
    })
    if (state.status === 'running' && state.url !== undefined) {
      const details: string[] = []
      if (state.reused) details.push('复用已有实例')
      if (state.pid !== undefined) details.push(`PID ${state.pid}`)
      nodes.push({ kind: 'status', text: state.url, icon: 'globe', description: details.join(' · ') || undefined })
    }
    if (state.error !== undefined) {
      nodes.push({ kind: 'status', text: state.error, icon: 'warning', error: true })
    }
    if (this.ctx.getConfigValue('localServerPath') === '') {
      nodes.push({ kind: 'status', text: '未配置本地服务目录', icon: 'info', description: '在「进入配置」中填写 dsh.localServerPath（应包含 dsh 启动器的目录，如 D:\\dsh 或 ~/dsh）', error: false })
    }
    if (state.status === 'running' || state.status === 'starting') {
      nodes.push({ kind: 'action', id: 'dsh.stopLocalService', title: '停止服务', icon: 'debug-stop', contextValue: 'dsh-action' })
    } else {
      nodes.push({ kind: 'action', id: 'dsh.startLocalService', title: '启动服务（dsh web）', icon: 'play', contextValue: 'dsh-action' })
    }
    nodes.push({ kind: 'action', id: 'dsh.sidebarNavigateSettings', title: '配置服务目录', icon: 'settings-gear', contextValue: 'dsh-action' })
    if (state.logs.length > 0) {
      nodes.push({ kind: 'log-group', logs: state.logs.slice(-30) })
    }
    return nodes
  }

  private hasLocalServerPath(): boolean {
    return (this.ctx.getConfigValue('localServerPath') ?? '') !== ''
  }

  // ---- settings ----

  private buildSettings(): TreeNode[] {
    const nodes: TreeNode[] = [{ kind: 'back' }]
    nodes.push({ kind: 'preset-note', text: '改动即时保存并生效（serverUrl / cookie 变更会自动重连）' })

    const remote = this.boolValue('remote')
    nodes.push({
      kind: 'setting',
      key: 'remote',
      label: '远程模式（Remote）',
      value: remote ? '开启' : '关闭',
      valueKind: 'bool',
      description: '开 = 直连远程 DSH（配 token 认证）；关 = 本地模式（可拉起 dsh web）',
    })
    nodes.push({
      kind: 'setting',
      key: 'token',
      label: 'DSH 启动 Token（dsh.token）',
      value: this.textValue('token') ? '（已设置）' : '（未设置）',
      valueKind: 'text',
      description: 'dsh web 打印的 ?token= 值；扩展自动换取会话 cookie 认证 /api 与事件流',
    })
    if (!remote) {
      nodes.push({
        kind: 'setting',
        key: 'localServerPath',
        label: '本地服务目录（dsh.localServerPath）',
        value: this.textValue('localServerPath') || '（未设置）',
        valueKind: 'path',
        description: '配置后启动即可自动拉起 dsh web（cwd=该目录）并连接',
      })
    }
    nodes.push({
      kind: 'setting',
      key: 'serverUrl',
      label: '服务地址（dsh.serverUrl）',
      value: this.textValue('serverUrl'),
      valueKind: 'text',
      description: 'Remote 必填；Local 可留空（默认 http://127.0.0.1:3080）',
    })

    nodes.push({ kind: 'settings-group', title: '行为' })
    for (const key of ['autoConnect', 'autoAttachWorkspace', 'autoOpenChat', 'showReasoning'] as const) {
      nodes.push({
        kind: 'setting',
        key,
        label: settingLabel(key),
        value: this.boolValue(key) ? '开启' : '关闭',
        valueKind: 'bool',
      })
    }
    nodes.push({
      kind: 'setting',
      key: 'promptMode',
      label: '发送消息模式（dsh.promptMode）',
      value: this.textValue('promptMode') === 'queue' ? '排队（queue）' : '插话（steer）',
      valueKind: 'text',
      description: '插话 = 立即处理（与 DSH Web 一致）；排队 = 等当前回合结束',
    })
    nodes.push({ kind: 'settings-group', title: '数值' })
    for (const key of ['defaultAgentPreset', 'historyPageSize', 'reconnectIntervalMs', 'maxToolResultChars'] as const) {
      nodes.push({
        kind: 'setting',
        key,
        label: settingLabel(key),
        value: this.textValue(key),
        valueKind: 'text',
      })
    }
    nodes.push({ kind: 'action', id: 'dsh.openSettingsJson', title: '打开设置 JSON（全部 dsh.* 项）', icon: 'json', contextValue: 'dsh-action' })
    return nodes
  }

  // ---- plugins ----

  private buildPlugins(): TreeNode[] {
    const nodes: TreeNode[] = [{ kind: 'back' }]
    const entries = this.ctx.getPlugins()
    const installed = entries.filter((p) => p.installed)
    const available = entries.filter((p) => !p.installed)
    if (installed.length === 0 && available.length === 0) {
      nodes.push({ kind: 'status', text: '暂无插件', icon: 'info', description: '已扫描 DSH_HOME 与 dsh-plugins 仓库目录', error: false })
    }
    nodes.push({ kind: 'plugin-group', title: `已安装（${installed.length}）`, count: installed.length })
    nodes.push({ kind: 'plugin-group', title: `可用（${available.length}）`, count: available.length })
    nodes.push({ kind: 'action', id: 'dsh.openDshHome', title: '打开 DSH_HOME 目录', icon: 'folder-opened', contextValue: 'dsh-action' })
    return nodes
  }

  private groupChildren(element: TreeNode): TreeNode[] {
    if (element.kind === 'plugin-group') {
      const entries = this.ctx.getPlugins()
      const list = entries.filter((p) => p.installed === (element.title.startsWith('已安装')))
      return list.map((entry) => ({ kind: 'plugin' as const, entry }))
    }
    if (element.kind === 'settings-group') {
      const nodes: TreeNode[] = []
      const keys: string[] = element.title === '行为'
        ? ['autoConnect', 'autoAttachWorkspace', 'autoOpenChat', 'showReasoning']
        : ['defaultAgentPreset', 'historyPageSize', 'reconnectIntervalMs', 'maxToolResultChars']
      for (const key of keys) {
        const isBool = element.title === '行为'
        nodes.push({
          kind: 'setting',
          key,
          label: settingLabel(key),
          value: isBool ? (this.boolValue(key) ? '开启' : '关闭') : this.textValue(key),
          valueKind: isBool ? 'bool' : 'text',
        })
      }
      return nodes
    }
    return []
  }

  // ---- presets ----

  private buildPresets(): TreeNode[] {
    const nodes: TreeNode[] = [{ kind: 'back' }]
    const presets = this.ctx.getPresets()
    const configDefault = this.textValue('defaultAgentPreset')
    if (presets.length === 0) {
      nodes.push({ kind: 'status', text: '暂无 preset 数据', icon: 'info', description: '连接 DSH 后可见；当前默认 preset 见配置', error: false })
    }
    for (const preset of presets) {
      nodes.push({ kind: 'preset', preset, isConfigDefault: preset.id === configDefault })
    }
    nodes.push({
      kind: 'preset-note',
      text: `新建会话默认 preset：${configDefault || '（未配置，用服务端默认）'}`,
    })
    nodes.push({ kind: 'action', id: 'dsh.newSession', title: '新建会话（默认 preset）', icon: 'add', contextValue: 'dsh-action' })
    return nodes
  }

  // ---- config value accessors ----

  private boolValue(key: string): boolean {
    return this.ctx.getConfigValue(key) === 'true'
  }

  private textValue(key: string): string {
    return this.ctx.getConfigValue(key) ?? ''
  }
}

// ---- tree item builders ----

function backItem(): vscode.TreeItem {
  const item = new vscode.TreeItem('← 返回首页', vscode.TreeItemCollapsibleState.None)
  item.id = 'nav:back'
  item.iconPath = new vscode.ThemeIcon('arrow-left')
  item.command = { command: 'dsh.sidebarBack', title: '返回首页' }
  item.contextValue = 'dsh-back'
  return item
}

function navItem(element: Extract<TreeNode, { kind: 'nav' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(
    `${element.title}${element.badge !== undefined ? `  ·  ${element.badge}` : ''}`,
    vscode.TreeItemCollapsibleState.None,
  )
  item.id = `nav:${element.view}`
  item.iconPath = new vscode.ThemeIcon(element.icon)
  if (element.description !== undefined) item.description = element.description
  item.tooltip = element.description
  item.command = { command: 'dsh.sidebarNavigate', title: element.title, arguments: [element.view] }
  item.contextValue = 'dsh-nav'
  return item
}

function pathItem(element: Extract<TreeNode, { kind: 'path' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(element.path, vscode.TreeItemCollapsibleState.None)
  item.id = 'path:current'
  item.iconPath = new vscode.ThemeIcon('folder-opened')
  if (element.hint !== undefined) item.description = element.hint
  item.tooltip = `${element.hint ?? '当前工作区'}\n\n${element.path}`
  item.contextValue = 'dsh-path'
  return item
}

function statusItem(element: Extract<TreeNode, { kind: 'status' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None)
  item.id = `status:${element.text}`
  item.iconPath = new vscode.ThemeIcon(element.icon, element.error ? new vscode.ThemeColor('errorForeground') : undefined)
  if (element.description !== undefined) item.description = element.description
  item.contextValue = 'dsh-status'
  return item
}

function actionItem(element: Extract<TreeNode, { kind: 'action' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None)
  item.id = `action:${element.id}`
  item.iconPath = new vscode.ThemeIcon(element.icon)
  if (element.description !== undefined) item.description = element.description
  item.command = { command: element.id, title: element.title }
  item.contextValue = element.contextValue
  return item
}

function toggleAllItem(showAll: boolean): vscode.TreeItem {
  const item = new vscode.TreeItem(showAll ? '只看当前工作区' : '查看全部会话', vscode.TreeItemCollapsibleState.None)
  item.id = 'toggle-all'
  item.iconPath = new vscode.ThemeIcon(showAll ? 'list-tree' : 'list-flat')
  item.description = showAll ? '折叠回当前工作区' : '展开所有工作区 / 未分组'
  item.command = { command: 'dsh.toggleAllSessions', title: '切换会话范围' }
  item.contextValue = 'dsh-toggle-all'
  return item
}

function workspaceItem(element: Extract<TreeNode, { kind: 'workspace' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(
    element.title || element.path.split(/[\\/]/).pop() || '工作区',
    vscode.TreeItemCollapsibleState.Expanded,
  )
  item.id = `ws:${element.workspaceId}`
  item.iconPath = new vscode.ThemeIcon('folder')
  item.description = `${element.sessions.length} 个会话`
  item.tooltip = new vscode.MarkdownString(`**${element.title}**\n\n${element.path}`)
  item.contextValue = 'dsh-workspace'
  return item
}

function ungroupedItem(element: Extract<TreeNode, { kind: 'ungrouped' }>): vscode.TreeItem {
  const item = new vscode.TreeItem('未分组会话', vscode.TreeItemCollapsibleState.Expanded)
  item.id = 'ws:__ungrouped__'
  item.iconPath = new vscode.ThemeIcon('inbox')
  item.description = `${element.sessions.length} 个会话`
  item.contextValue = 'dsh-workspace'
  return item
}

function sessionTreeItem(session: StoredSession): vscode.TreeItem {
  const title = session.title ?? '新会话'
  const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None)
  item.id = `sess:${session.sessionId}`
  item.iconPath = new vscode.ThemeIcon(
    session.running ? 'loading~spin' : 'comment-discussion',
    session.running ? new vscode.ThemeColor('charts.blue') : undefined,
  )
  const stats: string[] = []
  if (session.running) stats.push('● 运行中')
  if (session.turns !== undefined) stats.push(`${session.turns} 轮`)
  stats.push(relativeTime(session.updatedAt))
  item.description = stats.join(' · ')
  item.tooltip = new vscode.MarkdownString(
    [
      `**${title}**`,
      '',
      `- 会话: \`${session.sessionId}\``,
      `- 目录: \`${session.cwd}\``,
      `- preset: \`${session.agentPreset}\``,
      session.running ? '- 状态: 🔄 运行中' : '- 状态: 空闲',
      `- 更新: ${new Date(session.updatedAt).toLocaleString()}`,
    ].join('\n'),
  )
  item.contextValue = 'dsh-session'
  // 单击会话条目直接打开聊天面板（issue #15），无需再走一步选择。
  item.command = { command: 'dsh.openChat', title: '打开会话', arguments: [session.sessionId] }
  return item
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

function logItem(element: Extract<TreeNode, { kind: 'log' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None)
  item.id = `log:${element.text}`
  item.iconPath = new vscode.ThemeIcon('console')
  item.description = ''
  item.contextValue = 'dsh-log'
  return item
}

function logGroupItem(element: Extract<TreeNode, { kind: 'log-group' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(`日志摘要（${element.logs.length} 行）`, vscode.TreeItemCollapsibleState.Collapsed)
  item.id = 'log-group'
  item.iconPath = new vscode.ThemeIcon('list-ordered')
  item.contextValue = 'dsh-log-group'
  return item
}

function settingItem(element: Extract<TreeNode, { kind: 'setting' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None)
  item.id = `setting:${element.key}`
  item.iconPath = new vscode.ThemeIcon(
    element.valueKind === 'bool' ? (element.value === '开启' ? 'check' : 'circle-outline') : element.valueKind === 'path' ? 'folder' : 'edit',
  )
  item.description = element.value
  if (element.description !== undefined) item.tooltip = element.description
  item.command = { command: 'dsh.toggleSetting', title: element.label, arguments: [element.key] }
  item.contextValue = element.valueKind === 'bool' ? 'dsh-setting-bool' : 'dsh-setting-text'
  return item
}

function settingsGroupItem(element: Extract<TreeNode, { kind: 'settings-group' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.Expanded)
  item.id = `settings-group:${element.title}`
  item.iconPath = new vscode.ThemeIcon('gear')
  item.contextValue = 'dsh-settings-group'
  return item
}

function pluginItem(element: Extract<TreeNode, { kind: 'plugin' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(element.entry.name, vscode.TreeItemCollapsibleState.None)
  item.id = `plugin:${element.entry.kind}:${element.entry.path}`
  item.iconPath = new vscode.ThemeIcon(
    element.entry.kind === 'skill' ? 'lightbulb' : element.entry.kind === 'tool' ? 'wrench' : element.entry.kind === 'preset' ? 'file-code' : 'package',
  )
  item.description = element.entry.kind
  if (element.entry.description.length > 0) item.tooltip = element.entry.description
  item.command = { command: 'dsh.openPluginPath', title: '打开', arguments: [element.entry.path] }
  item.contextValue = 'dsh-plugin'
  return item
}

function pluginGroupItem(element: Extract<TreeNode, { kind: 'plugin-group' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.Collapsed)
  item.id = `plugin-group:${element.title}`
  item.iconPath = new vscode.ThemeIcon(element.title.startsWith('已安装') ? 'extensions' : 'cloud-download')
  item.contextValue = 'dsh-plugin-group'
  return item
}

function presetItem(element: Extract<TreeNode, { kind: 'preset' }>): vscode.TreeItem {
  const preset = element.preset
  const item = new vscode.TreeItem(preset.id, vscode.TreeItemCollapsibleState.None)
  item.id = `preset:${preset.id}`
  item.iconPath = new vscode.ThemeIcon('sparkle')
  const tags: string[] = []
  if (preset.isDefault) tags.push('服务端默认')
  if (element.isConfigDefault) tags.push('当前默认')
  tags.push(preset.trust === 'user' ? '本地' : '系统')
  item.description = tags.join(' · ')
  item.tooltip = `agent preset：${preset.id}\n\n单击设为新建会话默认`
  item.command = { command: 'dsh.usePreset', title: '设为默认', arguments: [preset.id] }
  item.contextValue = 'dsh-preset'
  return item
}

function noteItem(element: Extract<TreeNode, { kind: 'preset-note' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None)
  item.id = `note:${element.text}`
  item.iconPath = new vscode.ThemeIcon('info')
  item.description = ''
  item.contextValue = 'dsh-note'
  return item
}

// ---- misc ----

function byUpdatedAt(a: StoredSession, b: StoredSession): number {
  return b.updatedAt - a.updatedAt
}

function sessionNode(session: StoredSession): TreeNode {
  return { kind: 'session', session }
}

function normalizePath(p: string): string {
  if (!p) return ''
  let out = p.replace(/[\\/]+$/, '')
  if (process.platform === 'win32') out = out.toLowerCase()
  return out
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
