// IPC surface between main and the app:// renderers. Kept minimal: renderers
// only ever see the events/handlers listed here.
import { app, dialog, ipcMain } from 'electron'
import type { ShellController } from './controller.js'
import { getSettings, saveSettings } from './settings.js'
import { logs } from './log-store.js'
import { checkForUpdates, downloadUpdate, installUpdate, onUpdateStatus, updateMode } from './updater.js'
import { openView, broadcastEvent } from './windows.js'

export interface AppState {
  appVersion: string
  connect: ReturnType<ShellController['getState']>
  launcherPath: string
  settings: ReturnType<typeof getSettings>
  updateEnabled: boolean
  updateMode: ReturnType<typeof updateMode>
}

export function registerIpc(controller: ShellController, onQuit: () => void): void {
  ipcMain.handle('app:get-state', (): AppState => ({
    appVersion: app.getVersion(),
    connect: controller.getState(),
    launcherPath: controller.launcherPath(),
    settings: getSettings(),
    updateEnabled: true,
    updateMode: updateMode(),
  }))

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: object) => {
    const next = saveSettings(patch as Parameters<typeof saveSettings>[0])
    broadcastEvent({ type: 'settings', settings: next })
    return next
  })
  ipcMain.handle('settings:choose-dir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0] ?? null
  })

  // Shared-server actions (never spawned by the desktop itself)
  ipcMain.handle('server:connect', () => controller.connect())
  ipcMain.handle('server:start', () => controller.start())
  ipcMain.handle('server:stop', () => controller.stop())
  ipcMain.handle('server:open-browser', () => { controller.openInBrowser(); return true })
  ipcMain.handle('launcher:open', () => { controller.openLauncher(); return true })

  ipcMain.handle('log:get', () => logs.getRecent(500))
  ipcMain.handle('log:clear', () => { logs.clear(); return true })
  ipcMain.handle('log:export', async () => {
    const r = await dialog.showSaveDialog({
      defaultPath: `dsh-desktop-logs-${Date.now()}.log`,
      filters: [{ name: 'log', extensions: ['log', 'txt'] }],
    })
    if (r.canceled || !r.filePath) return null
    logs.exportTo(r.filePath)
    return r.filePath
  })

  ipcMain.handle('updater:check', () => checkForUpdates())
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:install', () => installUpdate())

  ipcMain.handle('window:open', (_e, view: string) => {
    openView(view)
    return true
  })

  ipcMain.handle('app:quit', () => { onQuit(); return true })

  // Stream main-process events to renderers.
  controller.onChanged(() => broadcastEvent({ type: 'connect', state: controller.getState() }))
  logs.on('entry', (entry) => broadcastEvent({ type: 'log', entry }))
  onUpdateStatus((status) => broadcastEvent({ type: 'update', status }))
}
