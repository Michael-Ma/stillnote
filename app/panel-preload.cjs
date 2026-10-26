const { contextBridge, ipcRenderer } = require('electron');
// The floating panel is told what to show and reports the choice made in it; nothing else.
contextBridge.exposeInMainWorld('stillnotePanel', {
  onShow: (listener) => ipcRenderer.on('stillnote-panel:show', (_event, panel) => listener(panel)),
  act: (id, action) => ipcRenderer.invoke('stillnote-panel:act', id, action),
  menu: (id, x, y) => ipcRenderer.invoke('stillnote-panel:menu', id, x, y),
});
