const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tuneCord", {
  state: () => ipcRenderer.invoke("state"),
  save: value => ipcRenderer.invoke("save", value),
  resetPairing: () => ipcRenderer.invoke("reset-pairing"),
  window: action => ipcRenderer.invoke("window", action),
  onState: listener => ipcRenderer.on("state", (_, state) => listener(state))
});
