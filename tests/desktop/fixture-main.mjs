// Test-only entry. Production never selects a controlled Provider from environment variables.
import { bootstrap } from "../../out/main/index.js";
import { loadDesktopApplication } from "../../apps/desktop/dist/main/startup.js";
import { createControlledProvider, createPiRuntime } from "@flowmate/runtime-pi";
import { makeInvoiceCandidate } from "@flowmate/contracts";
import { app } from "electron";

const invoice = makeInvoiceCandidate();
for (const name of Object.keys(invoice.fields)) invoice.fields[name] = { raw: null, normalized: null, status: "missing", evidence: [] };
invoice.fields.invoiceNumber = {
  raw: "SYN-001", normalized: "SYN-001", status: "present",
  evidence: [{ assetId: "original:fixture-source:SYN-001", blockId: "b1", page: 1, quote: "SYN-001", bbox: null }],
};

export const probeResults = [];
globalThis.__flowmateDesktopProbe = probeResults;
export let runningApplication;

void bootstrap(async () => {
  runningApplication = await loadDesktopApplication(process.env.FLOWMATE_DESKTOP_CONFIG, async (options) => {
    const provider = createControlledProvider([
      ...(process.env.FLOWMATE_TEST_SUBAGENT === "1" ? [
        { toolCall: { name: "Agent", arguments: { prompt: "Read the evidence", description: "P0 probe", subagent_type: "p0-probe", run_in_background: false } } },
        { toolCall: { name: "read_evidence", arguments: { assetId: "original:fixture-source:SYN-001", blockId: "b1" } } },
        { text: "child read the evidence" },
      ] : []),
      { toolCall: { name: "read_parsed_document", arguments: {} }, delayMs: process.env.FLOWMATE_TEST_SLOW === "1" ? 1500 : 0 },
      { toolCall: { name: "submit_invoice_candidate", arguments: { candidate: invoice } } },
      { text: "candidate accepted" },
    ]);
    const runtime = await createPiRuntime({ ...options, provider, ...(process.env.FLOWMATE_TEST_SUBAGENT === "1" ? { subagent: {} } : {}) });
    return {
      sessionId: runtime.sessionId,
      run: runtime.run,
      abort: runtime.abort,
      close: async () => {
        await runtime.close();
        probeResults.push(...runtime.subagentOutcomes());
        provider.close();
      },
    };
  });
  return runningApplication;
}).catch((error) => { console.error(error); app.exit(1); });
