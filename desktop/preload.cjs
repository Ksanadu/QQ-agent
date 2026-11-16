const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qqAgentShell', Object.freeze({
  refocus: () => ipcRenderer.send('desktop:refocus'),
  quit: () => ipcRenderer.send('desktop:quit'),
  openShutdownLog: job => ipcRenderer.invoke('desktop:shutdown-log', job),
  onPrepareLeave: callback => {
    const listener = async (_event, id) => {
      try { await callback(); ipcRenderer.send('desktop:leave-ready', { id, ok: true }); }
      catch (error) { ipcRenderer.send('desktop:leave-ready', { id, ok: false, error: error.message }); }
    };
    ipcRenderer.on('desktop:prepare-leave', listener);
    ipcRenderer.send('desktop:renderer-ready');
    return () => ipcRenderer.removeListener('desktop:prepare-leave', listener);
  }
}));
