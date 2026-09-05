import * as vscode from 'vscode'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export class StatusBar {
  private readonly item: vscode.StatusBarItem
  private state: ConnectionState = 'disconnected'
  private detail = ''
  private readonly disposables: vscode.Disposable[] = []

  constructor() {
    this.item = vscode.window.createStatusBarItem('dsh.connection', vscode.StatusBarAlignment.Left, 100)
    this.item.name = 'DSH'
    this.item.command = 'dsh.openChat'
    this.item.tooltip = 'DSH (DeepSeek Harness)\n点击打开聊天'
    this.disposables.push(this.item)
    this.render()
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  setState(state: ConnectionState, detail = ''): void {
    this.state = state
    this.detail = detail
    this.render()
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose()
  }

  private render(): void {
    switch (this.state) {
      case 'connected':
        this.item.text = `$(plug) DSH${this.detail ? ` · ${this.detail}` : ''}`
        this.item.backgroundColor = undefined
        break
      case 'connecting':
        this.item.text = '$(sync~spin) DSH 连接中…'
        this.item.backgroundColor = undefined
        break
      case 'error':
        this.item.text = '$(error) DSH 未连接'
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
        break
      default:
        this.item.text = '$(plug) DSH 未连接'
        this.item.backgroundColor = undefined
        break
    }
    this.item.show()
  }
}
