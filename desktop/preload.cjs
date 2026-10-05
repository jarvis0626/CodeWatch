'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Specific actions only: no filesystem, raw IPC, credentials or command execution.
contextBridge.exposeInMainWorld('codewatchDesktop', Object.freeze({
  chooseFolder: () => ipcRenderer.invoke('codewatch:choose-folder'),
  getPreferences: () => ipcRenderer.invoke('codewatch:get-preferences'),
  setPreferences: (patch) => ipcRenderer.invoke('codewatch:set-preferences', patch),
  onPreferencesChanged: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('A preference listener is required');
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('codewatch:preferences-changed', receive);
    return () => ipcRenderer.removeListener('codewatch:preferences-changed', receive);
  },
}));
