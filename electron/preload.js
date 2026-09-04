const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tuneCord", {
  state: () => ipcRenderer.invoke("state"),
  save: value => ipcRenderer.invoke("save", value),
  resetPairing: () => ipcRenderer.invoke("reset-pairing"),
  scanBrowsers: () => ipcRenderer.invoke("scan-browsers"),
  installExtension: browserId => ipcRenderer.invoke("install-extension", browserId),
  launchBrowser: () => ipcRenderer.invoke("launch-browser"),
  skipSetup: () => ipcRenderer.invoke("skip-setup"),
  resetSetup: () => ipcRenderer.invoke("reset-setup"),
  window: action => ipcRenderer.invoke("window", action),
  onState: listener => ipcRenderer.on("state", (_, state) => listener(state)),
  onBridgeError: listener => ipcRenderer.on("bridge-error", (_, message) => listener(message))
});
