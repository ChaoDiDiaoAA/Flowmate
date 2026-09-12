import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeInvoiceCandidate } from "../../packages/contracts/src/invoice.ts";
import { freezeDataset, inspectSource } from "../../packages/data/src/index.ts";
import { freezeCandidate } from "../../packages/core/src/configuration/candidate.ts";
import { hashModelProfile, type ModelProfile } from "../../packages/core/src/configuration/model-profile.ts";
import { parseP0Args, runP0Command } from "../../scripts/p0.ts";
import { withSourceFixture } from "../support/workspace.js";

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function stream(response: ServerResponse, payload: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  for (const item of payload) response.write(`data: ${JSON.stringify(item)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server did not bind");
  return address.port;
}

const modelProfile: ModelProfile = {
  profileId: "p0-cli-loopback",
  version: "1",
  modelRef: { provider: "flowmate-cli-loopback", modelId: "invoice-model" },
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1/v1",
  capabilities: { contextWindow: 32_000, maxOutputTokens: 2_048, inputTypes: ["text"], toolCalling: true, streaming: true },
  generation: { temperature: 0, topP: 1, thinking: "none" },
  credential: { profileId: "p0-cli-env", source: "env", envVar: "FLOWMATE_TEST_LLM_KEY" },
  budget: { maxModelRequests: 6, maxToolCalls: 12, wallTimeMs: 30_000, maxKnownTokens: null, maxKnownCost: null, unknownUsagePolicy: "stop" },
  purpose: { environment: "local-test", roles: ["invoice-extractor"], allowedSampleIds: ["SYN-001"] },
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("P0 live CLI entry", () => {
  it("runs the same Application path with a real loopback Provider and accepts one candidate", async () => {
    await withSourceFixture("normal", async ({ root, roleMap }) => {
      const manifest = await freezeDataset(await inspectSource(root, roleMap), { "SYN-001": "development" }, { outputRoot: join(root, "frozen") });
      const portRef = { value: 0 };
      let requestNumber = 0;
      const candidate = makeInvoiceCandidate();
      for (const name of Object.keys(candidate.fields)) candidate.fields[name] = { raw: null, normalized: null, status: "missing", evidence: [] };
      candidate.fields.invoiceNumber = { raw: "SYN-001", normalized: "SYN-001", status: "present", evidence: [{ assetId: "original:fixture-source:SYN-001", blockId: "b1", page: 1, quote: "SYN-001", bbox: null }] };
      const server = createServer(async (_request, response) => {
        await readBody(_request);
        requestNumber += 1;
        if (requestNumber === 2) {
          stream(response, [
            { id: "cli-1", model: "invoice-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "submit-cli", type: "function", function: { name: "submit_invoice_candidate", arguments: JSON.stringify({ candidate }) } }] }, finish_reason: null }] },
            { id: "cli-1", model: "invoice-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 18, completion_tokens: 9, total_tokens: 27 } },
          ]);
          return;
        }
        if (requestNumber === 3) {
          stream(response, [
            { id: "cli-2", model: "invoice-model", choices: [{ index: 0, delta: { role: "assistant", content: "candidate accepted" }, finish_reason: null }] },
            { id: "cli-2", model: "invoice-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 24, completion_tokens: 3, total_tokens: 27 } },
          ]);
          return;
        }
        stream(response, [
          { id: "cli-0", model: "invoice-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "read-cli", type: "function", function: { name: "read_parsed_document", arguments: "{}" } }] }, finish_reason: null }] },
          { id: "cli-0", model: "invoice-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
        ]);
      });
      portRef.value = await listen(server);
      const profile = {
        profileId: "p0-cli-live",
        mode: "live" as const,
        environment: "local-test" as const,
        available: true,
        modelRef: modelProfile.modelRef,
        modelProfile: { ...modelProfile, baseUrl: `http://127.0.0.1:${portRef.value}/v1` },
        modelsPath: "models.json",
        authPath: "auth.json",
        allowedSampleIds: ["SYN-001"],
      };
      const models = { providers: { "flowmate-cli-loopback": { baseUrl: `http://127.0.0.1:${portRef.value}/v1`, api: "openai-completions", apiKey: "$FLOWMATE_TEST_LLM_KEY", models: [{ id: "invoice-model", name: "Loopback", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_048 }] } } };
      const profilePath = join(root, "profile.json");
      await writeFile(profilePath, JSON.stringify(profile), "utf8");
      await writeFile(join(root, "models.json"), JSON.stringify(models), "utf8");
      await writeFile(join(root, "auth.json"), "{}\n", "utf8");
      const candidateFile = freezeCandidate({
        schemaVersion: "1", appSourceHash: digest("app"), lockHash: digest("lock"), runtimeLockHash: digest("runtime"), datasetVersion: manifest.datasetVersion,
        modelProfileHash: hashModelProfile(profile.modelProfile), promptHash: digest("prompt"), toolVersions: { read_parsed_document: "1", read_evidence: "1", submit_invoice_candidate: "1" }, extensionVersions: {}, environment: "local-test", budget: { maxModelRequests: 6, maxToolCalls: 12, wallTimeMs: 30_000 }, eligibility: "test",
      });
      const candidatePath = join(root, "candidate.json");
      await writeFile(candidatePath, JSON.stringify(candidateFile), "utf8");
      const previousKey = process.env.FLOWMATE_TEST_LLM_KEY;
      process.env.FLOWMATE_TEST_LLM_KEY = "loopback-test-key";
      try {
        const result = await runP0Command(parseP0Args(["run", "--profile", profilePath, "--manifest", join(root, "frozen"), "--candidate", candidatePath, "--sample", "SYN-001"]), { cwd: process.cwd() });
        expect(result).toMatchObject({ code: "READY", exitCode: 0 });
      } finally {
        if (previousKey === undefined) delete process.env.FLOWMATE_TEST_LLM_KEY;
        else process.env.FLOWMATE_TEST_LLM_KEY = previousKey;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }, 60_000);
});
