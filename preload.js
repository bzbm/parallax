const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  switchTo: (i) => ipcRenderer.send('switch', i),
  getConfig: () => ipcRenderer.invoke('config'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
