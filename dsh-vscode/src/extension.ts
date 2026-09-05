/**
 * dsh-vscode extension entry: activation, connection lifecycle, commands,
 * sidebar, status bar, workspace auto-attach, local service management, and
 * settings wiring (issues #2/#3/#5).
 */

import * as vscode from 'vscode'
import { realpathSync } from 'node:fs'
import { DshConnection } from './client/connection.ts'
import type { DshEvent } from './client/connection.ts'
import { RpcErrorResult, DshTransportError } from './client/rpc.ts'
import { SessionStore } from './sessionStore.ts'
import { SessionsTreeProvider, type SidebarView } from './sidebar.ts'
import { StatusBar } from './statusBar.ts'
import { ChatPanel, errorMessage } from './chat/chatPanel.ts'
import type { SessionStatsView } from './chat/types.ts'
import { onConfigChanged, readConfig, sessionWebUrl, type DshConfig } from './config.ts'
import { LocalServerManager, validateLocalServerPath } from './localServer.ts'
import { scanInstalledPlugins, scanAvailablePlugins, dshHome } from './plugins.ts'
import { launchTokenFilePath, readLaunchToken } from './launchToken.ts'
import type { AgentPresetEntry, SessionId, WorkspaceId } from './client/types.ts'

let extension: DshExtension | undefined

export function activate(context: vscode.ExtensionContext): void {
  extension = new DshExtension(context)
  extension.activate()
  context.subscriptions.push({
    dispose: () => {
      extension?.dispose()
      extension = undefined
    },
  })
}

export function deactivate(): void {
  extension?.dispose()
  extension = undefined
}

const VIEW_TITLES: Record<SidebarView, string | undefined> = {
  home: undefined,
  sessions: '会话列表',
  service: '拉起服务',
  settings: '设置',
  plugins: '插件库',
  presets: '模式列表',
}

class DshExtension {
  readonly output: vscode.OutputChannel
  private readonly context: vscode.ExtensionContext
  private readonly statusBar: StatusBar
  private readonly disposables: vscode.Disposable[] = []

  private connection: DshConnection | undefined
  private store: SessionStore | undefined
  private treeProvider: SessionsTreeProvider | undefined
  private treeView: vscode.TreeView<unknown> | undefined
  private localServer: LocalServerManager
  private cachedPresets: AgentPresetEntry[] = []
  private currentWorkspaceId: WorkspaceId | undefined
  private currentWorkspacePath: string | undefined
  private connected = false
  private connecting = false
  private config: DshConfig

  constructor(context: vscode.ExtensionContext) {
    this.context = context
    this.config = readConfig()
    this.output = vscode.window.createOutputChannel('DSH')
    this.statusBar = new StatusBar()
    this.localServer = new LocalServerManager(() => this.config.extraHeaders)
  }

  activate(): void {
    this.output.appendLine(`[dsh-vscode] 启动，serverUrl=${this.config.serverUrl} remote=${this.config.remote}`)

    this.disposables.push(
      this.statusBar,
      this.output,
      vscode.commands.registerCommand('dsh.connect', () => this.connect()),
      vscode.commands.registerCommand('dsh.disconnect', () => this.disconnect()),
      vscode.commands.registerCommand('dsh.openChat', (sessionId?: SessionId) => this.openChat(sessionId)),
      vscode.commands.registerCommand('dsh.newSession', () => this.newSession()),
      vscode.commands.registerCommand('dsh.refreshSessions', () => this.refreshSessions()),
      vscode.commands.registerCommand('dsh.openInBrowser', () => this.openInBrowser()),
      vscode.commands.registerCommand('dsh.cancel', () => this.cancelSelected()),
      vscode.commands.registerCommand('dsh.renameSession', () => this.renameSelected()),
      vscode.commands.registerCommand('dsh.showOutput', () => this.output.show()),
      // ---- sidebar navigation / settings (#3 / #5) ----
      vscode.commands.registerCommand('dsh.openSettings', () => this.navigateSidebar('settings')),
      vscode.commands.registerCommand('dsh.sidebarBack', () => this.navigateSidebar('home')),
      vscode.commands.registerCommand('dsh.sidebarNavigate', (view: SidebarView) => this.navigateSidebar(view)),
      vscode.commands.registerCommand('dsh.sidebarNavigateSettings', () => this.navigateSidebar('settings')),
      vscode.commands.registerCommand('dsh.toggleAllSessions', () => this.toggleAllSessions()),
      vscode.commands.registerCommand('dsh.toggleSetting', (key: string) => this.toggleSetting(key)),
      vscode.commands.registerCommand('dsh.usePreset', (id: string) => this.usePreset(id)),
      vscode.commands.registerCommand('dsh.openSettingsJson', () => void vscode.commands.executeCommand('workbench.action.openSettings', 'dsh')),
      vscode.commands.registerCommand('dsh.openDshHome', () => this.openPath(dshHome())),
      vscode.commands.registerCommand('dsh.openPluginPath', (path: string) => this.openPath(path)),
      // ---- local service (#3) ----
      vscode.commands.registerCommand('dsh.startLocalService', () => this.startLocalService()),
      vscode.commands.registerCommand('dsh.stopLocalService', () => this.stopLocalService()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.handleWorkspaceChange()),
      onConfigChanged(() => this.handleConfigChanged()),
      { dispose: this.localServer.onChanged(() => this.refreshTree()) },
    )

    // Tree view with the entry-style home provider (issues #3/#5).
    this.treeProvider = new SessionsTreeProvider({
      getStore: () => this.store,
      getConnection: () => this.connection,
      getConnected: () => this.connected,
      getWorkspace: () => ({ workspaceId: this.currentWorkspaceId, path: this.currentWorkspacePath }),
      getService: () => this.localServer.getState(),
      getPlugins: () => [...scanInstalledPlugins(), ...scanAvailablePlugins()],
      getPresets: () => this.cachedPresets,
      getConfigValue: (key) => readConfigValue(key),
    })
    this.treeView = vscode.window.createTreeView('dsh.sessions', { treeDataProvider: this.treeProvider })
    this.disposables.push(this.treeView)

    void this.ensureWorkspaceAttach()
    if (this.config.autoConnect) {
      void this.connect()
    }
  }

  dispose(): void {
    ChatPanel.disposeAll()
    this.localServer.dispose()
    this.connection?.dispose()
    this.store?.dispose()
    for (const disposable of this.disposables) disposable.dispose()
  }

  // ---- connection lifecycle ----

  private async connect(): Promise<void> {
    if (this.connecting) return
    this.connecting = true
    this.statusBar.setState('connecting')
    let url = this.config.serverUrl
    try {
      if (this.shouldStartLocalServer()) {
        try {
          this.statusBar.setState('connecting', '启动本地服务')
          const result = await this.localServer.start(this.config.localServerPath)
          url = result.url
          this.output.appendLine(`[dsh-vscode] 本地服务就绪，连接 ${url}`)
        } catch (error) {
          const message = errorMessage(error)
          this.output.appendLine(`[dsh-vscode] 本地服务启动失败: ${message}`)
          const choice = await vscode.window.showErrorMessage(
            `本地 DSH 服务启动失败：${message}`,
            { modal: false },
            '重试',
            '仍直连原地址',
            '查看日志',
          )
          if (choice === '重试') {
            this.connecting = false
            void this.connect()
            return
          }
          if (choice === '查看日志') this.output.show()
          if (choice !== '仍直连原地址') {
            this.statusBar.setState('error')
            this.connecting = false
            return
          }
        }
      }
      // DSH 无论本地还是远程都默认开启浏览器认证：有 token 就用它换取会话
      // cookie（token 为空时跳过，兼容未开启认证的本地服务）。
      let resolvedToken = this.resolveLaunchToken()
      if (resolvedToken.length > 0) {
        const source = this.config.token.trim().length > 0 ? '设置 dsh.token' : `共享文件 ${launchTokenFilePath()}`
        this.output.appendLine(`[dsh-vscode] 使用启动 token 认证（来源：${source}）`)
      }
      // 连接；401 且 token 来自共享文件时，重读文件重试一次
      // （launcher 重启 dsh 会写入新 token，文件可能比本次读取更新）。
      let connection: DshConnection | undefined
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const candidate = new DshConnection(url, {
          reconnectIntervalMs: this.config.reconnectIntervalMs,
          extraHeaders: this.config.extraHeaders,
          token: resolvedToken,
        })
        const off = candidate.onEvent((event) => this.handleConnectionEvent(event))
        this.disposables.push({ dispose: off })
        try {
          await candidate.connect()
          connection = candidate
          break
        } catch (error) {
          const message = errorMessage(error)
          // 本地模式 401：无论 token 来自手动设置还是共享文件，都可能因
          // launcher 重启 dsh 而失效——重读共享文件（launcher/vscode 写入的
          // 当前权威值）并重试一次。remote 模式不重试（token 是远程服务器的）。
          const canAutoRetry = attempt < 2
            && message.includes('401')
            && !this.config.remote
            && this.config.launchTokenFollow
          if (!canAutoRetry) {
            candidate.dispose()
            throw error
          }
          const fresh = readLaunchToken()
          if (fresh === undefined || fresh.token === resolvedToken) {
            candidate.dispose()
            throw error
          }
          this.output.appendLine(`[dsh-vscode] 401：共享 token 文件已更新（launcher 重启过 dsh），用新 token 重试`)
          resolvedToken = fresh.token
          candidate.dispose()
        }
      }
      if (connection === undefined) throw new Error('连接 DSH 失败')
      this.connection = connection
      this.connected = true
      await vscode.commands.executeCommand('setContext', 'dsh.connected', true)
      this.statusBar.setState('connected', '已连接')
      this.output.appendLine(`[dsh-vscode] 已连接 ${connection.baseUrl}`)
      await this.initStore()
      await this.refreshPresets()
      await this.ensureWorkspaceAttach()
      this.refreshTree()
    } catch (error) {
      this.connection?.dispose()
      this.connection = undefined
      this.connected = false
      await vscode.commands.executeCommand('setContext', 'dsh.connected', false)
      this.statusBar.setState('error')
      const message = errorMessage(error)
      this.output.appendLine(`[dsh-vscode] 连接失败: ${message}`)
      const retry = await vscode.window.showErrorMessage(
        `无法连接 DSH 服务 ${url}：${message}`,
        { modal: false },
        '重试',
        '设置',
      )
      if (retry === '重试') void this.connect()
      if (retry === '设置') void vscode.commands.executeCommand('workbench.action.openSettings', 'dsh.serverUrl')
    } finally {
      this.connecting = false
    }
  }

  private shouldStartLocalServer(): boolean {
    // Local 模式 + 配置了本地服务目录 → 连接前先拉起服务。
    if (this.config.remote) return false
    return this.config.localServerPath.trim().length > 0
  }

  /**
   * 解析当前可用的 launch token：
   *  - 显式配置 dsh.token 优先（远程 / 手动场景）；
   *  - 本地模式且未配置时，读共享 token 文件（dsh-launcher 或本插件拉起 dsh
   *    都会写入 `$DSH_HOME/launch-token.json`，无需手动抄 token）。
   * 返回空串表示无 token（跳过认证，兼容未开启认证的服务）。
   */
  private resolveLaunchToken(): string {
    const configured = this.config.token.trim()
    if (configured.length > 0) return configured
    if (this.config.remote) return ''
    if (!this.config.launchTokenFollow) return ''
    return readLaunchToken()?.token ?? ''
  }

  private disconnect(): void {
    this.connection?.dispose()
    this.connection = undefined
    this.connected = false
    this.store?.dispose()
    this.store = undefined
    void vscode.commands.executeCommand('setContext', 'dsh.connected', false)
    this.statusBar.setState('disconnected')
    this.output.appendLine('[dsh-vscode] 已断开')
    this.refreshTree()
  }

  private async initStore(): Promise<void> {
    if (this.connection === undefined) return
    this.store?.dispose()
    this.store = new SessionStore(this.connection)
    this.store.onChanged(() => this.refreshTree())
    await this.store.refresh()
  }

  private async refreshPresets(): Promise<void> {
    if (this.connection === undefined) {
      this.cachedPresets = []
      return
    }
    try {
      this.cachedPresets = await this.connection.listPresets()
    } catch {
      // preset 目录加载失败不影响主流程
    }
    this.refreshTree()
  }

  private handleConnectionEvent(event: DshEvent): void {
    switch (event.kind) {
      case 'connected':
        this.connected = true
        this.statusBar.setState('connected', '已连接')
        void this.initStore()
        void this.refreshPresets()
        break
      case 'disconnected':
        this.connected = false
        this.statusBar.setState('error', '已断开')
        this.output.appendLine(`[dsh-vscode] 事件流断开: ${event.reason}`)
        break
      case 'stream-error':
        this.output.appendLine(`[dsh-vscode] 事件流错误: ${errorMessage(event.error)}`)
        break
      default:
        break
    }
  }

  private handleConfigChanged(): void {
    const next = readConfig()
    const serverChanged = next.serverUrl !== this.config.serverUrl
    const headersChanged = JSON.stringify(next.extraHeaders) !== JSON.stringify(this.config.extraHeaders)
    const tokenChanged = next.token !== this.config.token
    const localPathChanged = next.localServerPath !== this.config.localServerPath
    this.config = next
    if (localPathChanged) {
      // 服务目录变更后，正在跑的本地服务已不属于新路径：停止并提示。
      if (this.localServer.getState().status === 'running' || this.localServer.getState().status === 'starting') {
        this.localServer.stop()
        this.output.appendLine('[dsh-vscode] dsh.localServerPath 已变更，停止原本地服务')
      }
    }
    if (serverChanged || headersChanged || tokenChanged) {
      this.output.appendLine(
        `[dsh-vscode] 连接配置变更${serverChanged ? `（serverUrl → ${next.serverUrl}）` : '（extraHeaders / token）'}，重新连接`,
      )
      this.disconnect()
      void this.connect()
    }
    this.refreshTree()
  }

  // ---- store / tree ----

  private refreshTree(): void {
    this.treeProvider?.refresh()
    this.updateTreeViewChrome()
  }

  private updateTreeViewChrome(): void {
    if (this.treeView === undefined) return
    const view = this.treeProvider?.getCurrentView() ?? 'home'
    this.treeView.description = view === 'home' ? undefined : VIEW_TITLES[view]
  }

  private navigateSidebar(view: SidebarView): void {
    this.treeProvider?.navigate(view)
    this.updateTreeViewChrome()
  }

  private toggleAllSessions(): void {
    this.treeProvider?.toggleAllSessions()
    this.updateTreeViewChrome()
  }

  private selectedSession(): SessionId | undefined {
    const selection = this.treeView?.selection
    if (selection === undefined) return undefined
    const node = selection as { kind?: string; session?: { sessionId: SessionId } }
    if (node?.kind === 'session' && node.session) return node.session.sessionId
    return undefined
  }

  // ---- workspace auto-attach (#2) ----

  /**
   * 以当前 VSCode 打开的路径为准做"有则注入、无则新建"：
   *  - 主工作区 = 活动编辑器所在的工作区文件夹（无则取第一个文件夹）
   *  - 其余打开的文件夹也逐个关联（多根策略）
   *  - 路径比较统一走规范化（realpath + 尾分隔符归一 + Windows 大小写不敏感）
   *  - 未连接时记录意图，连接后自动补 attach；重连不重复执行
   */
  private async ensureWorkspaceAttach(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? []
    if (folders.length === 0) return
    if (!this.config.autoAttachWorkspace) return

    const primary = this.primaryWorkspaceFolder()
    const ordered = [...folders].sort((a, b) => (a.uri.fsPath === primary?.uri.fsPath ? -1 : b.uri.fsPath === primary?.uri.fsPath ? 1 : 0))

    let primaryWorkspaceId: WorkspaceId | undefined
    let primaryWorkspacePath: string | undefined
    const pending: { path: string; isPrimary: boolean }[] = []

    for (const folder of ordered) {
      const isPrimary = folder.uri.fsPath === primary?.uri.fsPath
      let path = folder.uri.fsPath
      try {
        path = realpathSync(path)
      } catch {
        // keep the original path if realpath fails
      }
      path = normalizePath(path)
      if (this.connection === undefined) {
        pending.push({ path, isPrimary })
        continue
      }
      const workspaceId = await this.attachPath(path)
      if (isPrimary) {
        primaryWorkspaceId = workspaceId
        primaryWorkspacePath = path
      }
    }

    if (this.connection === undefined) {
      // 记住意图：主工作区路径先记录，连接后再补 attach。
      const primaryPending = pending.find((p) => p.isPrimary)
      if (primaryPending !== undefined) this.currentWorkspacePath = primaryPending.path
      else if (pending[0] !== undefined) this.currentWorkspacePath = pending[0].path
      return
    }
    if (primaryWorkspaceId !== undefined) {
      this.currentWorkspaceId = primaryWorkspaceId
      this.currentWorkspacePath = primaryWorkspacePath
    }
  }

  private primaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? []
    if (folders.length === 0) return undefined
    const editorPath = vscode.window.activeTextEditor?.document.uri.fsPath
    if (editorPath !== undefined) {
      const containing = folders.find((folder) => isPathInside(editorPath, folder.uri.fsPath))
      if (containing !== undefined) return containing
    }
    return folders[0]
  }

  /** 关联单个路径：已有工作区则注入，没有则新建。返回 workspaceId。 */
  private async attachPath(path: string): Promise<WorkspaceId> {
    if (this.connection === undefined) throw new Error('尚未连接 DSH')
    try {
      const workspaces = await this.connection.listWorkspaces()
      const existing = workspaces.find((workspace) => normalizePath(workspace.path) === path)
      if (existing !== undefined) {
        this.output.appendLine(`[dsh-vscode] 关联工作区: ${existing.title} (${existing.path})`)
        return existing.workspaceId
      }
      const { workspace } = await this.connection.createWorkspace(path)
      this.output.appendLine(`[dsh-vscode] 创建并关联工作区: ${workspace.title} (${workspace.path})`)
      return workspace.workspaceId
    } catch (error) {
      this.output.appendLine(`[dsh-vscode] 工作区关联失败 (${path}): ${errorMessage(error)}`)
      throw error
    }
  }

  private handleWorkspaceChange(): void {
    this.currentWorkspaceId = undefined
    this.currentWorkspacePath = undefined
    void this.ensureWorkspaceAttach()
  }

  // ---- commands ----

  private requireConnection(): DshConnection {
    if (this.connection === undefined) {
      throw new Error('尚未连接 DSH。请先执行 "DSH: 连接"（或检查 dsh.serverUrl 设置）。')
    }
    return this.connection
  }

  /** 打开聊天面板。sidebar 会话条目单击时直接传入 sessionId（issue #15）。 */
  private async openChat(sessionIdArg?: SessionId): Promise<void> {
    try {
      const connection = this.requireConnection()
      let sessionId = sessionIdArg ?? this.selectedSession()
      if (sessionId === undefined) {
        sessionId = await this.pickSession(connection)
      }
      if (sessionId === undefined) return
      this.openChatPanel(sessionId)
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error))
    }
  }

  private openChatPanel(sessionId: SessionId): void {
    if (this.connection === undefined) return
    const session = this.store?.getSession(sessionId)
    const panel = ChatPanel.openOrFocus({
      extensionUri: this.context.extensionUri,
      connection: this.connection,
      sessionId,
      title: session?.title,
      cwd: session?.cwd,
      running: session?.running ?? false,
      historyPageSize: this.config.historyPageSize,
      showReasoning: this.config.showReasoning,
      maxToolResultChars: this.config.maxToolResultChars,
      initialStats: initialStatsOf(session),
      pricing: this.config.pricing,
      onTitleChanged: (title) => {
        const current = this.store?.getSession(sessionId)
        if (current !== undefined) {
          current.title = title
          this.refreshTree()
        }
      },
    })
    void panel
  }

  private async pickSession(connection: DshConnection): Promise<SessionId | undefined> {
    const entries = this.store?.allSessions ?? []
    if (entries.length === 0) {
      const answer = await vscode.window.showInformationMessage('还没有会话，要新建一个吗？', '新建会话', '取消')
      if (answer === '新建会话') return this.createSessionAndOpen()
      return undefined
    }
    const items = entries.slice(0, 50).map((session) => ({
      label: session.title ?? '新会话',
      description: `${session.running ? '🔄 ' : ''}${session.agentPreset}`,
      detail: session.cwd,
      sessionId: session.sessionId,
    }))
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要打开的会话',
      matchOnDescription: true,
      matchOnDetail: true,
    })
    void connection
    return picked?.sessionId
  }

  private async newSession(): Promise<void> {
    try {
      this.requireConnection()
      await this.createSessionAndOpen()
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error))
    }
  }

  private async createSessionAndOpen(): Promise<SessionId | undefined> {
    if (this.connection === undefined) return undefined
    await this.ensureWorkspaceAttach()
    try {
      const preset = await this.pickPreset()
      const workspaceId = await this.pickWorkspace()
      const { sessionId } = await this.connection.createSession({
        workspaceId,
        agentPreset: preset ?? this.config.defaultAgentPreset,
      })
      this.output.appendLine(`[dsh-vscode] 新建会话 ${sessionId}${preset !== undefined ? `（preset=${preset}）` : ''}`)
      await this.store?.refresh()
      if (this.config.autoOpenChat) this.openChatPanel(sessionId)
      return sessionId
    } catch (error) {
      if (error instanceof RpcErrorResult && error.code === 'agent-preset-not-found') {
        // Fall back to the server default preset.
        const { sessionId } = await this.connection.createSession({ workspaceId: this.currentWorkspaceId })
        this.output.appendLine(`[dsh-vscode] 新建会话 ${sessionId}（默认 preset）`)
        await this.store?.refresh()
        if (this.config.autoOpenChat) this.openChatPanel(sessionId)
        return sessionId
      }
      throw error
    }
  }

  /** Ask for an agent preset when the server offers more than one. */
  private async pickPreset(): Promise<string | undefined> {
    if (this.connection === undefined) return undefined
    try {
      const presets = await this.connection.listPresets()
      if (presets.length <= 1) return undefined
      const items = presets.map((preset) => ({
        label: preset.id,
        description: preset.isDefault ? '默认' : preset.trust === 'user' ? '本地' : '系统',
        preset: preset.id,
      }))
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '选择会话的 agent preset（跳过则用默认）',
        matchOnDescription: true,
      })
      return picked?.preset
    } catch {
      return undefined // preset 目录加载失败时静默使用配置默认值
    }
  }

  /** Ask for a workspace when more than one exists. */
  private async pickWorkspace(): Promise<string | undefined> {
    const workspaces = this.store?.allWorkspaces ?? []
    if (workspaces.length <= 1) return this.currentWorkspaceId
    const items = workspaces.map((workspace) => ({
      label: workspace.title,
      description: workspace.path,
      workspaceId: workspace.workspaceId,
    }))
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择新会话所在的工作区',
      matchOnDetail: true,
    })
    return picked?.workspaceId ?? this.currentWorkspaceId
  }

  private async refreshSessions(): Promise<void> {
    try {
      this.requireConnection()
      this.statusBar.setState('connecting', '刷新中')
      await this.store?.refresh()
      await this.refreshPresets()
      this.statusBar.setState('connected', '已连接')
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error))
    }
  }

  private async openInBrowser(): Promise<void> {
    const sessionId = this.selectedSession()
    if (sessionId === undefined) {
      void vscode.window.showInformationMessage('请先在会话列表中选中一个会话')
      return
    }
    if (this.connection === undefined) return
    const base = this.connection.baseUrl
    // 带认证的 DSH：浏览器必须先访问 /?token=... 换取会话 cookie 才能看到页面
    // （token 只在根路径生效，/session/... 直开会被 401 拦下）。
    // 有 token 时打开 token 根 URL（自动登录并落到首页），否则保持旧行为直开会话页。
    const token = this.resolveLaunchToken()
    const target = token.length > 0
      ? `${base}/?token=${encodeURIComponent(token)}`
      : sessionWebUrl(base, sessionId)
    void vscode.env.openExternal(vscode.Uri.parse(target))
  }

  private async cancelSelected(): Promise<void> {
    const sessionId = this.selectedSession()
    if (sessionId === undefined) return
    try {
      const connection = this.requireConnection()
      await connection.cancel(sessionId)
      this.output.appendLine(`[dsh-vscode] 已请求停止 ${sessionId}`)
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error))
    }
  }

  private async renameSelected(): Promise<void> {
    const sessionId = this.selectedSession()
    if (sessionId === undefined) {
      void vscode.window.showInformationMessage('请先在会话列表中选中一个会话')
      return
    }
    try {
      const connection = this.requireConnection()
      const session = this.store?.getSession(sessionId)
      const title = await vscode.window.showInputBox({
        prompt: '会话新标题',
        value: session?.title ?? '',
        placeHolder: '输入标题，留空则取消',
      })
      if (title === undefined) return
      await connection.rename(sessionId, title.trim())
      await this.store?.refresh()
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error))
    }
  }

  // ---- settings page (#3) ----

  private async toggleSetting(key: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('dsh')
    const current = config.get<unknown>(key)
    try {
      if (typeof current === 'boolean') {
        await config.update(key, !current, vscode.ConfigurationTarget.Global)
      } else if (typeof current === 'string') {
        if (key === 'localServerPath') {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: '选择本地 DSH 服务目录（应包含 dsh / dsh.cmd 启动器）',
          })
          if (picked !== undefined && picked.length > 0) {
            const chosen = picked[0].fsPath
            const validation = validateLocalServerPath(chosen)
            if (!validation.ok) {
              void vscode.window.showErrorMessage(`本地服务路径校验失败：${validation.error}`, { modal: false }, '打开目录')
              return
            }
            await config.update(key, chosen, vscode.ConfigurationTarget.Global)
          }
          return
        }
        if (key === 'promptMode') {
          const picked = await vscode.window.showQuickPick(
            [
              { label: '插话（steer）', description: '立即处理，与 DSH Web 一致（默认）', value: 'steer' },
              { label: '排队（queue）', description: '等当前回合结束后再处理', value: 'queue' },
            ],
            { placeHolder: '选择发送消息的模式' },
          )
          if (picked !== undefined) {
            await config.update(key, picked.value, vscode.ConfigurationTarget.Global)
          }
          return
        }
        const value = await vscode.window.showInputBox({
          prompt: settingPrompt(key),
          value: current,
          password: key === 'token',
          placeHolder: key === 'token' ? '粘贴 dsh web 打印的 ?token= 值' : undefined,
        })
        if (value !== undefined) {
          await config.update(key, value.trim(), vscode.ConfigurationTarget.Global)
        }
      } else if (typeof current === 'number') {
        const value = await vscode.window.showInputBox({ prompt: settingPrompt(key), value: String(current) })
        if (value !== undefined && value.trim().length > 0) {
          const parsed = Number(value.trim())
          if (Number.isFinite(parsed)) {
            await config.update(key, parsed, vscode.ConfigurationTarget.Global)
          }
        }
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`设置保存失败：${errorMessage(error)}`)
    }
  }

  private async usePreset(id: string): Promise<void> {
    try {
      await vscode.workspace.getConfiguration('dsh').update('defaultAgentPreset', id, vscode.ConfigurationTarget.Global)
      this.output.appendLine(`[dsh-vscode] 默认 agent preset → ${id}`)
    } catch (error) {
      void vscode.window.showErrorMessage(`设置默认 preset 失败：${errorMessage(error)}`)
    }
  }

  // ---- local service (#3) ----

  private async startLocalService(): Promise<void> {
    const path = this.config.localServerPath.trim()
    if (path.length === 0) {
      const answer = await vscode.window.showInformationMessage(
        '尚未配置本地服务目录（dsh.localServerPath），先去设置？',
        '去设置',
        '取消',
      )
      if (answer === '去设置') this.navigateSidebar('settings')
      return
    }
    try {
      this.statusBar.setState('connecting', '启动本地服务')
      const result = await this.localServer.start(path)
      this.statusBar.setState('connected', `本地服务 ${result.url}`)
      if (result.reused) {
        this.output.appendLine(`[dsh-vscode] 检测到已有本地实例，复用: ${result.url}`)
      } else {
        this.output.appendLine(`[dsh-vscode] 本地服务已启动: ${result.url}`)
      }
      if (!this.connected) {
        const answer = await vscode.window.showInformationMessage(
          result.reused
            ? `检测到本地 DSH 实例已就绪：${result.url}（已复用，未重复拉起）。要连接它吗？`
            : `本地 DSH 服务已就绪：${result.url}。要连接它吗？`,
          '连接',
          '稍后',
        )
        if (answer === '连接') void this.connect()
      }
    } catch (error) {
      this.statusBar.setState('error')
      void vscode.window.showErrorMessage(`本地服务启动失败：${errorMessage(error)}`)
    }
  }

  private async stopLocalService(): Promise<void> {
    this.localServer.stop()
    this.output.appendLine('[dsh-vscode] 本地服务已停止')
    this.refreshTree()
  }

  // ---- helpers ----

  private openPath(path: string): void {
    void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path)).then(
      undefined,
      () => void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path)),
    )
  }
}

export { DshTransportError }

/** 读取一个 dsh.* 配置项的字符串形式（供侧边栏显示/编辑）。 */
function readConfigValue(key: string): string | undefined {
  const value = vscode.workspace.getConfiguration('dsh').get<unknown>(key)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return undefined
}

function settingPrompt(key: string): string {
  const prompts: Record<string, string> = {
    serverUrl: 'DSH 服务地址（如 http://127.0.0.1:3080 或 https://dsh.example.com）',
    token: 'DSH 进程启动 token（dsh web 打印的 ?token= 值）',
    defaultAgentPreset: '新建会话的默认 agent preset',
    historyPageSize: '历史消息一次拉取条数（5–200）',
    reconnectIntervalMs: '事件流断开后的重连间隔（毫秒，≥1000）',
    maxToolResultChars: '工具结果最大展示字符数（200–100000）',
  }
  return prompts[key] ?? `设置 dsh.${key}`
}

function normalizePath(p: string): string {
  if (!p) return ''
  let out = p.replace(/[\\/]+$/, '')
  // Windows: 去掉 \\?\ 前缀（realpath 后可能出现）并统一大小写。
  if (process.platform === 'win32') {
    if (out.startsWith('\\\\?\\')) out = out.slice(4)
    out = out.toLowerCase()
  }
  return out
}

function isPathInside(child: string, parent: string): boolean {
  const normalizedChild = normalizePath(child)
  const normalizedParent = normalizePath(parent)
  if (normalizedParent.length === 0) return false
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + (process.platform === 'win32' ? '\\' : '/'))
}

/** 从 store 会话的投影快照里取初始用量统计。 */
function initialStatsOf(session: { projections: Map<string, { value: unknown }> } | undefined): SessionStatsView | undefined {
  if (session === undefined) return undefined
  const stats: SessionStatsView = {}
  const pick = (key: string, field: string): void => {
    const entry = session.projections.get(key)
    const record = entry?.value as Record<string, unknown> | undefined
    const value = record?.[field]
    if (typeof value === 'number' && Number.isFinite(value)) {
      ;(stats as Record<string, unknown>)[field] = value
    }
  }
  for (const field of ['turns', 'steps', 'llmMs', 'toolMs', 'decodeTokens']) pick('sessionStats', field)
  for (const field of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) pick('tokenUsage', field)
  for (const field of ['pressureTokens', 'projectedTokens', 'contextWindow']) pick('contextPressure', field)
  return Object.keys(stats).length > 0 ? stats : undefined
}
