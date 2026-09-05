// electron-preload.ts —— 渲染进程桥：暴露最小化的窗口控制。
// 页面本身加载自本地 http 服务（server.ts），launcherBridge 由服务端注入；
// 这里只补桌面窗口特有的能力。

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronWindow', {
  isDesktop: true,
  minimize: () => ipcRenderer.send('win:minimize'),
  hide: () => ipcRenderer.send('win:hide'),
  close: () => ipcRenderer.send('win:close'),
  // #20：请求主进程按内容自然高度扩窗（invoke → ipcMain.handle('win:autosize')）
  autosize: (desiredH: number) => ipcRenderer.invoke('win:autosize', desiredH),
});
