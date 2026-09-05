// Preload: minimal, typed-ish bridge between the app:// renderers and main.
// contextIsolation is on; renderers never touch Node/Electron directly.
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getState: () => ipcRenderer.invoke('app:get-state'),
  onEvent: (cb) => {
    const listener = (_e, ev) => cb(ev)
    ipcRenderer.on('app:event', listener)
    return () => ipcRenderer.removeListener('app:event', listener)
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseDirectory: () => ipcRenderer.invoke('settings:choose-dir'),
  serverConnect: () => ipcRenderer.invoke('server:connect'),
  serverStart: () => ipcRenderer.invoke('server:start'),
  serverStop: () => ipcRenderer.invoke('server:stop'),
  serverOpenBrowser: () => ipcRenderer.invoke('server:open-browser'),
  launcherOpen: () => ipcRenderer.invoke('launcher:open'),
  getLogs: () => ipcRenderer.invoke('log:get'),
  clearLogs: () => ipcRenderer.invoke('log:clear'),
  exportLogs: () => ipcRenderer.invoke('log:export'),
  checkUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  openView: (view) => ipcRenderer.invoke('window:open', view),
  quitApp: () => ipcRenderer.invoke('app:quit'),
}

contextBridge.exposeInMainWorld('dshApi', api)
