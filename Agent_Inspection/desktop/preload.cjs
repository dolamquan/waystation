const { contextBridge, ipcRenderer } = require('electron');

ipcRenderer.on('desktop:status', (_event, detail) => {
  const element = document.getElementById('detail');
  if (element && typeof detail === 'string') element.textContent = detail;
});

// Expose actions, never Electron, Node, raw IPC, tokens, or arbitrary filesystem access.
contextBridge.exposeInMainWorld('waystationDesktop', Object.freeze({
  getSettings: () => ipcRenderer.invoke('desktop:settings'),
  saveSettings: (preferences) => ipcRenderer.invoke('desktop:save-settings', preferences),
  choosePath: (kind) => ipcRenderer.invoke('desktop:choose-path', kind),
  onNavigate: (listener) => {
    const handle = (_event, destination) => { if (destination === 'setup' || destination === 'attention') listener(destination); };
    ipcRenderer.on('desktop:navigate', handle);
    return () => ipcRenderer.removeListener('desktop:navigate', handle);
  },
}));
