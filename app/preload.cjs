const { contextBridge, ipcRenderer } = require('electron');
const channels = [
  'state',
  'create',
  'update',
  'search',
  'folder',
  'setting',
  'transcript',
  'edit-segment',
  'messages',
  'record',
  'stop',
  'calendar',
  'account',
  'usage',
  'ai',
  'cancel-ai',
  'export',
  'backup',
  'import',
  'reveal',
  'finish-close',
];
contextBridge.exposeInMainWorld('stillnote', {
  call: (name, ...args) => {
    if (!channels.includes(name)) throw new Error('Unknown operation.');
    return ipcRenderer.invoke('stillnote:' + name, ...args);
  },
  subscribe: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('stillnote:event', listener);
    return () => ipcRenderer.removeListener('stillnote:event', listener);
  },
});
