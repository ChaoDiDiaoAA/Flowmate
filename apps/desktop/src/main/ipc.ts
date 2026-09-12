import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { DesktopCommandSchema, type DesktopCommand } from "@flowmate/contracts";
import type { Application } from "./composition.js";
import { IPC_CHANNELS } from "../shared/channels.js";

export { IPC_CHANNELS } from "../shared/channels.js";

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (event.sender !== window.webContents) throw new Error("IPC_SENDER_REJECTED");
  if (!event.senderFrame || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== window.webContents.getURL()) {
    throw new Error("IPC_FRAME_REJECTED");
  }
}

function commandForChannel(channel: string, value: unknown): DesktopCommand {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const typeByChannel: Record<string, DesktopCommand["type"]> = {
    [IPC_CHANNELS.listSamples]: "listSamples",
    [IPC_CHANNELS.start]: "start",
    [IPC_CHANNELS.rebuild]: "rebuild",
    [IPC_CHANNELS.cancel]: "cancel",
    [IPC_CHANNELS.getJob]: "getJob",
    [IPC_CHANNELS.getEvidence]: "getEvidence",
    [IPC_CHANNELS.getDiagnostics]: "getDiagnostics",
  };
  const type = typeByChannel[channel];
  if (!type) throw new Error("IPC_CHANNEL_UNKNOWN");
  const parsed = DesktopCommandSchema.safeParse({ ...payload, type });
  if (!parsed.success) throw new Error("IPC_ARGUMENT_INVALID");
  return parsed.data;
}

export function registerIpcHandlers(window: BrowserWindow, application: Application): () => void {
  const handlers = [
    [IPC_CHANNELS.listSamples, (command: DesktopCommand) => application.listSamples()],
    [IPC_CHANNELS.start, (command: DesktopCommand) => command.type === "start" ? application.start(command) : undefined],
    [IPC_CHANNELS.rebuild, (command: DesktopCommand) => command.type === "rebuild" ? application.rebuild(command) : undefined],
    [IPC_CHANNELS.cancel, (command: DesktopCommand) => command.type === "cancel" ? application.cancel(command) : undefined],
    [IPC_CHANNELS.getJob, (command: DesktopCommand) => command.type === "getJob" ? application.getJob(command) : undefined],
    [IPC_CHANNELS.getEvidence, (command: DesktopCommand) => command.type === "getEvidence" ? application.getEvidence(command) : undefined],
    [IPC_CHANNELS.getDiagnostics, (command: DesktopCommand) => application.getDiagnostics()],
  ] as const;
  for (const [channel, handler] of handlers) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, value: unknown) => {
      assertTrustedSender(event, window);
      return handler(commandForChannel(channel, value));
    });
  }
  return () => { for (const [channel] of handlers) ipcMain.removeHandler(channel); };
}
