import { contextBridge, ipcRenderer } from "electron";
import type { DesktopCommand } from "@flowmate/contracts";
import { IPC_CHANNELS } from "../shared/channels.js";

const flowmate = Object.freeze({
  listSamples: () => ipcRenderer.invoke(IPC_CHANNELS.listSamples, {}),
  start: (command: Omit<Extract<DesktopCommand, { type: "start" }>, "type">) => ipcRenderer.invoke(IPC_CHANNELS.start, command),
  rebuild: (command: Omit<Extract<DesktopCommand, { type: "rebuild" }>, "type">) => ipcRenderer.invoke(IPC_CHANNELS.rebuild, command),
  cancel: (command: Omit<Extract<DesktopCommand, { type: "cancel" }>, "type">) => ipcRenderer.invoke(IPC_CHANNELS.cancel, command),
  getJob: (command: Omit<Extract<DesktopCommand, { type: "getJob" }>, "type">) => ipcRenderer.invoke(IPC_CHANNELS.getJob, command),
  getEvidence: (command: Omit<Extract<DesktopCommand, { type: "getEvidence" }>, "type">) => ipcRenderer.invoke(IPC_CHANNELS.getEvidence, command),
  getDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.getDiagnostics, {}),
});

contextBridge.exposeInMainWorld("flowmate", flowmate);
