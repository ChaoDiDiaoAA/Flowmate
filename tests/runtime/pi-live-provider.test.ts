import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { makeParsedDocument } from "../../packages/contracts/src/invoice.ts";
import { BudgetLedger, createGateway, openStore } from "../../packages/core/src/index.ts";
import { createPiRuntime } from "../../packages/runtime-pi/src/index.ts";

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

function sse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server did not bind a port");
  return address.port;
}

describe("Pi custom Provider protocol", () => {
  it("uses the explicit models path and executes a real loopback Chat Completions stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-pi-loopback-provider-"));
    const requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];
    let requestNumber = 0;
    const server = createServer(async (request, response) => {
      const raw = await body(request);
      requests.push({ authorization: request.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
      requestNumber += 1;
      if (requestNumber === 1) {
        sse(response, [
          { id: "loopback-1", model: "loopback-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-read", type: "function", function: { name: "read_parsed_document", arguments: "{}" } }] }, finish_reason: null }] },
          { id: "loopback-1", model: "loopback-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
        ]);
        return;
      }
      sse(response, [
        { id: "loopback-2", model: "loopback-model", choices: [{ index: 0, delta: { role: "assistant", content: "loopback complete" }, finish_reason: null }] },
        { id: "loopback-2", model: "loopback-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } },
      ]);
    });
    const port = await listen(server);
    const modelsPath = join(root, "models.json");
    const authPath = join(root, "auth.json");
    await writeFile(modelsPath, JSON.stringify({ providers: {
      "flowmate-loopback": {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "local-test-key",
        models: [{ id: "loopback-model", name: "Loopback", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_048 }],
      },
    } }), "utf8");
    await writeFile(authPath, "{}\n", "utf8");
    const store = openStore(join(root, "store"));
    const job = store.createJob({ jobType: "invoice-extract", sampleId: "SYN-001", inputHash: "a".repeat(64), candidateId: "candidate-1" });
    const run = store.startRun(job.id, job.candidateId);
    const parsed = makeParsedDocument();
    const budget = new BudgetLedger({ maxModelRequests: 4, maxToolCalls: 4, wallTimeMs: 20_000 });
    const gateway = createGateway({ store, input: { sampleId: "SYN-001", parsed, allowedAssetIds: [parsed.original.assetId] }, budget });
    const runtime = await createPiRuntime({
      cwd: join(root, "cwd"),
      agentDir: join(root, "agent"),
      identity: { jobId: job.id, runId: run.runId, generation: run.generation, candidateId: job.candidateId },
      modelRef: { provider: "flowmate-loopback", modelId: "loopback-model" },
      modelsPath,
      authPath,
      gateway,
      budget,
    });
    try {
      await expect(runtime.run({ taskPrompt: "Read the parsed invoice and report completion." })).resolves.toMatchObject({ kind: "completed" });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.authorization).toBe("Bearer local-test-key");
      expect(requests[0]?.body.model).toBe("loopback-model");
      expect(requests[0]?.body.stream).toBe(true);
      expect(JSON.stringify(requests[1]?.body.messages)).toContain("SYN-001");
      expect(budget.remaining().usage).toMatchObject({ known: true, inputTokens: 32, outputTokens: 7, unknownSamples: 0 });
    } finally {
      await runtime.close();
      store.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("stops on an authentication failure without a hidden provider retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-pi-provider-error-"));
    let requests = 0;
    const server = createServer(async (request, response) => {
      await body(request);
      requests += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid credentials" } }));
    });
    const port = await listen(server);
    const modelsPath = join(root, "models.json");
    const authPath = join(root, "auth.json");
    await writeFile(modelsPath, JSON.stringify({ providers: {
      "flowmate-error": {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "local-test-key",
        models: [{ id: "error-model", name: "Error", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_048 }],
      },
    } }), "utf8");
    await writeFile(authPath, "{}\n", "utf8");
    const store = openStore(join(root, "store"));
    const job = store.createJob({ jobType: "invoice-extract", sampleId: "SYN-001", inputHash: "a".repeat(64), candidateId: "candidate-1" });
    const run = store.startRun(job.id, job.candidateId);
    const runtime = await createPiRuntime({
      cwd: join(root, "cwd"),
      agentDir: join(root, "agent"),
      identity: { jobId: job.id, runId: run.runId, generation: run.generation, candidateId: job.candidateId },
      modelRef: { provider: "flowmate-error", modelId: "error-model" },
      modelsPath,
      authPath,
    });
    try {
      const outcome = await runtime.run({ taskPrompt: "Make one request." });
      expect(outcome.kind).toBe("failed");
      expect(requests).toBe(1);
      expect(outcome.error).not.toContain("local-test-key");
    } finally {
      await runtime.close();
      store.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
