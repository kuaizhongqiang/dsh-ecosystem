// dsh-desktop main process entry (pure shell): single instance → settings →
// tray/updater → connect to the shared dsh server. The desktop never spawns
// dsh: whoever started first (dsh-launcher / dsh-vscode / `dsh web`) owns the
// server process; this app just embeds its Web UI.
import { app, protocol } from 'electron'
import { ShellController } from './controller.js'
import { APP_ID } from './constants.js'
import { getSettings, loadSettings } from './settings.js'
import { logs } from './log-store.js'
import { registerIpc } from './ipc.js'
import { initUpdater, checkForUpdates } from './updater.js'
import { createTray } from './tray.js'
import { createMainWindow, getMainWindow, initWindows, openView, showConnectPage } from './windows.js'

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  const controller = new ShellController()
  let reallyQuit = false

  app.setAppUserModelId(APP_ID)

  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.on('window-all-closed', () => {
    // Merely having this listener keeps the app alive when every window closes;
    // tray mode (closeToTray) is the default, so no quit here.
    if (!getSettings().closeToTray || reallyQuit) app.quit()
  })

  app.on('before-quit', () => {
    reallyQuit = true
  })

  app.whenReady().then(() => {
    loadSettings()
    initWindows()
    registerIpc(controller, () => app.quit())
    logs.info('app', `dsh-desktop starting (v${app.getVersion()}) — pure shell over the shared dsh server`)
    initUpdater()

    // Tray window helpers: restore from minimized, then show+focus.
    const showMainWindow = (): void => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }

    createTray(controller, {
      showMain: showMainWindow,
      toggleMain: () => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        // visible AND not minimized → hide to tray; otherwise show/restore
        if (win.isVisible() && !win.isMinimized()) win.hide()
        else showMainWindow()
      },
      startServer: () => void controller.start(),
      stopServer: () => void controller.stop(),
      openLogs: () => openView('log'),
      openSettings: () => openView('settings'),
      checkUpdates: () => void checkForUpdates(),
      quit: () => app.quit(),
    })

    void boot()
  })

  async function boot(): Promise<void> {
    const win = createMainWindow()
    // Close-to-tray: closing the window hides it instead of destroying it, so
    // the tray can always re-show it. A real quit bypasses this (before-quit
    // sets reallyQuit, and closeToTray=false quits via window-all-closed).
    win.on('close', (e) => {
      if (getSettings().closeToTray && !reallyQuit) {
        e.preventDefault()
        win.hide()
      }
    })
    // Paint the connect page immediately ("检测中…"), then connect() either
    // navigates to the shared dsh UI or keeps/steps the connect page.
    showConnectPage(win)
    // update checks run regardless of server state (npm registry / GitHub feed)
    void checkForUpdates()
    await controller.connect()
  }
}
