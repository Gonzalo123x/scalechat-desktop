// Puente seguro entre la UI (renderer) y el proceso principal.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  addProfile: (data) => ipcRenderer.invoke("profiles:add", data),
  removeProfile: (id) => ipcRenderer.invoke("profiles:remove", id),
  reconnect: (id) => ipcRenderer.invoke("profiles:reconnect", id),
  onState: (cb) => ipcRenderer.on("state", (_e, list) => cb(list)),
  onLog: (cb) => ipcRenderer.on("log", (_e, line) => cb(line)),
});
