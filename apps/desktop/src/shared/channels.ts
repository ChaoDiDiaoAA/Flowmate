export const IPC_CHANNELS = Object.freeze({
  listSamples: "flowmate:listSamples",
  start: "flowmate:start",
  rebuild: "flowmate:rebuild",
  cancel: "flowmate:cancel",
  getJob: "flowmate:getJob",
  getEvidence: "flowmate:getEvidence",
  getDiagnostics: "flowmate:getDiagnostics",
} as const);
