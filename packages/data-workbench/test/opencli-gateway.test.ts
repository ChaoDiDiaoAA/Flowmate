import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OpenCliGateway } from "../src/opencli-gateway.js";
import type { OpenCliCommandDescriptor } from "../src/types.js";
import { RecordingProcessRunner } from "./helpers/recording-process-runner.js";

const registryFixture = JSON.parse(
  await readFile(new URL("./fixtures/opencli-registry.json", import.meta.url), "utf8"),
) as OpenCliCommandDescriptor[];

describe("OpenCliGateway", () => {
  it("discovers the current OpenCLI registry as JSON", async () => {
    const runner = new RecordingProcessRunner({
      stdout: JSON.stringify(registryFixture),
      stderr: "",
      exitCode: 0,
    });
    const gateway = new OpenCliGateway(runner);

    await expect(gateway.discover()).resolves.toEqual(registryFixture);
    expect(runner.lastCommand).toBe("opencli");
    expect(runner.lastArgs).toEqual(["list", "-f", "json"]);
  });

  it("rejects a dynamic registry descriptor with an invalid access value", async () => {
    const runner = new RecordingProcessRunner({
      stdout: JSON.stringify([{
        command: "brave/search",
        site: "brave",
        name: "search",
        access: "delete",
        strategy: "public",
        browser: true,
      }]),
      stderr: "",
      exitCode: 0,
    });
    const gateway = new OpenCliGateway(runner);

    await expect(gateway.discover()).rejects.toThrow(/registry entry 1.*access/i);
  });

  it("runs a discovered public read command with an argv array", async () => {
    const runner = new RecordingProcessRunner({ stdout: '[{"id":"1"}]', stderr: "", exitCode: 0 });
    const gateway = new OpenCliGateway(runner, registryFixture);

    const result = await gateway.runPublic({
      sourceId: "SRC-000001",
      site: "brave",
      command: "search",
      args: ["site:huggingface.co/datasets invoice OCR dataset license", "--limit", "10"],
    });

    expect(runner.lastCommand).toBe("opencli");
    expect(runner.lastArgs).toEqual([
      "brave", "search", "site:huggingface.co/datasets invoice OCR dataset license", "--limit", "10",
      "-f", "json", "--trace", "retain-on-failure",
    ]);
    expect(result.items).toEqual([{ id: "1" }]);
    expect(result.adapterRef).toBe("brave/search");
    expect(result.strategy).toBe("public");
  });

  it("rejects cookie commands before spawning opencli", async () => {
    const runner = new RecordingProcessRunner({ stdout: "[]", stderr: "", exitCode: 0 });
    const gateway = new OpenCliGateway(runner, registryFixture);

    await expect(gateway.runPublic({
      sourceId: "SRC-000002",
      site: "private-site",
      command: "search",
      args: [],
    })).rejects.toThrow(/PUBLIC read/);

    expect(runner.callCount).toBe(0);
  });

  it("retains the OpenCLI trace reference when a public command fails", async () => {
    const runner = new RecordingProcessRunner({
      stdout: "[]",
      stderr: "OpenCLI failed; trace: C:\\temp\\opencli-traces\\failure.json",
      exitCode: 1,
    });
    const gateway = new OpenCliGateway(runner, registryFixture);

    const result = await gateway.runPublic({
      sourceId: "SRC-000003",
      site: "brave",
      command: "search",
      args: [],
    });

    expect(result.items).toEqual([]);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.traceRef).toBe("C:\\temp\\opencli-traces\\failure.json");
  });
});
