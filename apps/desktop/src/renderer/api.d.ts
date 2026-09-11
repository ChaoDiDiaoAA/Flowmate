import type { DesktopCommand } from "@flowmate/contracts";

type FlowmateApi = {
  listSamples(): Promise<unknown>;
  start(command: Omit<Extract<DesktopCommand, { type: "start" }>, "type">): Promise<unknown>;
  rebuild(command: Omit<Extract<DesktopCommand, { type: "rebuild" }>, "type">): Promise<unknown>;
  cancel(command: Omit<Extract<DesktopCommand, { type: "cancel" }>, "type">): Promise<unknown>;
  getJob(command: Omit<Extract<DesktopCommand, { type: "getJob" }>, "type">): Promise<unknown>;
  getEvidence(command: Omit<Extract<DesktopCommand, { type: "getEvidence" }>, "type">): Promise<unknown>;
  getDiagnostics(): Promise<unknown>;
};

declare global {
  interface Window { flowmate: FlowmateApi; }
}
export {};
