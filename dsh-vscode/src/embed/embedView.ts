/**
 * EmbedWebviewProvider —— 侧栏「DSH 网页」WebviewView 宿主（milestone #2 #21）。
 *
 * 承载方式按 #20 设计结论：薄壳 + iframe 全量复用 dsh web，前提是 dsh server
 * 提供 embed seam（§9）。本 provider 负责：
 *   - 探测 seam 能力（见 embedModel.decideEmbed）；
 *   - seam 可用 → iframe 内嵌 seam URL（含一次性 token 与可选会话深链）；
 *   - 不可用/无 token → 降级卡（在浏览器打开 / 重试探测），绝不给空白页。
 */

import * as vscode from 'vscode'
import { decideEmbed, type EmbedDecision, type EmbedTargetInput } from './embedModel.ts'
import { embedViewHtml } from './embedViewHtml.ts'

export interface EmbedViewDeps {
  /** 当前连接/令牌/会话输入（每次取最新）。 */
  getTarget: () => EmbedTargetInput
  /** 打开默认浏览器的回调（由宿主注入，便于测试）。 */
  openExternal: (url: string) => void
  /**
   * 可选的扩展侧本机代理：服务器没有 embed seam 时，用它把 iframe 指向
   * 一个带 cookie 转发的 127.0.0.1 源（对任意 dsh 版本可用）。
   */
  setupProxy?: (target: EmbedTargetInput) => Promise<{ origin: string } | undefined>
}

export class EmbedWebviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'dsh.web'

  private view: vscode.WebviewView | undefined
  private decision: EmbedDecision | undefined
  private resolving = false

  constructor(private readonly deps: EmbedViewDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    }
    webviewView.webview.html = embedViewHtml()

    webviewView.webview.onDidReceiveMessage((msg: { type?: string; url?: string }) => {
      if (msg.type === 'ready') {
        void this.push()
      } else if (msg.type === 'retry') {
        this.push(true)
      } else if (msg.type === 'open-external' && typeof msg.url === 'string') {
        this.deps.openExternal(msg.url)
      }
    })
  }

  /** 重新探测并推送（retry 时绕过能力缓存）。 */
  async push(force = false): Promise<void> {
    if (!this.view || this.resolving) return
    this.resolving = true
    try {
      this.post({ type: 'busy', busy: true })
      const input = this.deps.getTarget()
      const decision = await decideEmbed(input, { cache: !force })
      this.decision = decision
      if (decision.kind === 'embed') {
        this.post({ type: 'load', url: decision.url })
      } else if (this.deps.setupProxy !== undefined && input.token !== undefined && input.token !== '') {
        // 无 seam（服务器版本旧）→ 走扩展本机代理，仍可内嵌。
        const proxied = await this.deps.setupProxy(input)
        this.post(
          proxied !== undefined
            ? { type: 'load', url: `${proxied.origin}/` }
            : { type: 'fallback', reason: 'proxy-failed', url: decision.url, browserUrl: decision.browserUrl },
        )
      } else {
        this.post({
          type: 'fallback',
          reason: decision.reason,
          url: decision.url,
          browserUrl: decision.browserUrl,
        })
      }
      this.post({ type: 'busy', busy: false })
    } catch (e) {
      this.post({
        type: 'fallback',
        reason: 'unreachable',
        url: '',
        browserUrl: '',
      })
      this.post({ type: 'busy', busy: false })
      const err = e instanceof Error ? e.message : String(e)
      void vscode.window.showWarningMessage(`DSH 内嵌探测失败：${err}`)
    } finally {
      this.resolving = false
    }
  }

  /** 供宿主在连接/会话变化后刷新（不绕过缓存）。 */
  refresh(): void {
    void this.push(false)
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg)
  }
}
