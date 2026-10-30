const { contextBridge, ipcRenderer } = require('electron');
const channels = [
  'state',
  'create',
  'update',
  'search',
  'folder',
  'rename-folder',
  'delete-folder',
  'restore-folder',
  'setting',
  'transcript',
  'edit-segment',
  'messages',
  'record',
  'stop',
  'keep-recording',
  'recording-url',
  'transcribe-recording',
  'restore-transcript',
  'deletion-size',
  'delete-forever',
  'calendar',
  'start-call',
  'join-call',
  'audio-devices',
  'languages',
  'install-language',
  'account',
  'ai-provider',
  'usage',
  'ai',
  'cancel-ai',
  'save-image',
  'export',
  'backup',
  'import',
  'import-source',
  'reveal',
  'open-privacy',
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
