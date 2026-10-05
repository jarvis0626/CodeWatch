'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Specific actions only: no filesystem, raw IPC, credentials or command execution.
contextBridge.exposeInMainWorld('codewatchDesktop', Object.freeze({
  chooseFolder: () => ipcRenderer.invoke('codewatch:choose-folder'),
  getPreferences: () => ipcRenderer.invoke('codewatch:get-preferences'),
  setPreferences: (patch) => ipcRenderer.invoke('codewatch:set-preferences', patch),
}));
