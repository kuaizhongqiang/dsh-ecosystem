// System tray: minimize-to-tray, show/hide, start/stop shared server
// (delegated to dsh-launcher), log/settings windows, check updates, quit.
import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import type { ShellController } from './controller.js'
import { logs } from './log-store.js'

let tray: Tray | null = null

export interface TrayActions {
  showMain: () => void
  toggleMain: () => void
  startServer: () => void
  stopServer: () => void
  openLogs: () => void
  openSettings: () => void
  checkUpdates: () => void
  quit: () => void
}

export function createTray(controller: ShellController, actions: TrayActions): Tray {
  const iconPath = join(app.getAppPath(), 'assets', 'icon.ico')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('dsh-desktop — DeepSeek Harness')

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏窗口', click: () => actions.toggleMain() },
    { type: 'separator' },
    { label: '启动服务（dsh-launcher）', click: () => actions.startServer() },
    { label: '停止服务（dsh-launcher）', click: () => actions.stopServer() },
    { type: 'separator' },
    { label: '打开日志', click: () => actions.openLogs() },
    { label: '设置', click: () => actions.openSettings() },
    { label: '检查更新', click: () => actions.checkUpdates() },
    { type: 'separator' },
    { label: '退出', click: () => actions.quit() },
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', () => actions.showMain())
  tray.on('click', () => actions.showMain())

  controller.onChanged(() => {
    const s = controller.getState()
    tray?.setToolTip(`dsh-desktop — dsh server: ${s.status}${s.url ? ` · ${s.url}` : ''}`)
  })

  logs.info('app', 'tray created')
  return tray
}
