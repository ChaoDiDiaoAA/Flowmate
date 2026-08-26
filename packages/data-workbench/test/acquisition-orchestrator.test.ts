import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcquisitionOrchestrator, type Clock } from "../src/acquisition-orchestrator.js";
import type { DataPaths } from "../src/filesystem-layout.js";
import type { IdAllocator } from "../src/ids.js";
import type { OpenCliAcquisitionRequest } from "../src/opencli-gateway.js";
import type { AcquisitionResult } from "../src/types.js";

const temporaryRoots: string[] = [];
const request: OpenCliAcquisitionRequest = {
  sourceId: "SRC-000001",
  site: "brave",
  command: "search",
  args: ["invoice OCR"],
};
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "..", "..");

class FixedClock implements Clock {
  public now(): string {
    return "2026-08-26T12:00:00+08:00";
  }
}

class FakeAllocator implements IdAllocator {
  public callCount = 0;

  public async next(): Promise<string> {
    this.callCount += 1;
    return "ACQ-20260826-0001";
  }
}

class FakeGateway {
  public callCount = 0;

  public async runPublic(): Promise<AcquisitionResult> {
    this.callCount += 1;
    return {
      jobId: "unused-by-orchestrator",
      adapterRef: "brave/search",
      strategy: "public",
      retrievedAt: "not-a-clock-value",
      status: "succeeded",
      exitCode: 0,
      items: [{ url: "https://example.com/one" }, { url: "https://example.com/two" }],
    };
  }
}

async function createPaths(): Promise<DataPaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-acquisition-"));
  temporaryRoots.push(root);
  return {
    root,
    vault: path.join(root, "vault"),
    staging: path.join(root, "staging"),
    webRaw: path.join(root, "web-raw"),
    derivedMineru: path.join(root, "derived", "mineru"),
    manifests: path.join(root, "manifests"),
    releases: path.join(root, "releases"),
    quarantine: path.join(root, "quarantine"),
    failures: path.join(root, "failures"),
    backups: path.join(root, "backups"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("AcquisitionOrchestrator", () => {
  it("allocates a job, stages its receipt, and counts discovered items", async () => {
    const paths = await createPaths();
    const allocator = new FakeAllocator();
    const gateway = new FakeGateway();
    const orchestrator = new AcquisitionOrchestrator(allocator, gateway, paths, new FixedClock());

    await expect(orchestrator.run(request)).resolves.toMatchObject({
      jobId: "ACQ-20260826-0001",
      sourceId: "SRC-000001",
      status: "STAGED",
      startedAt: "2026-08-26T12:00:00+08:00",
      counts: { discovered: 2, stored: 0, duplicated: 0, quarantined: 0, failed: 0 },
    });
    expect(allocator.callCount).toBe(1);
    expect(gateway.callCount).toBe(1);

    await expect(
      readFile(path.join(paths.staging, "ACQ-20260826-0001", "acquisition-result.json"), "utf8"),
    ).resolves.toMatchObject(expect.stringContaining(JSON.stringify({
      jobId: "ACQ-20260826-0001",
      sourceId: "SRC-000001",
      adapterRef: "brave/search",
      strategy: "public",
      retrievedAt: "2026-08-26T12:00:00+08:00",
      items: [{ url: "https://example.com/one" }, { url: "https://example.com/two" }],
    }, null, 2)));
  });

  it("resumes a staged job from its receipt without spawning OpenCLI again", async () => {
    const paths = await createPaths();
    const allocator = new FakeAllocator();
    const gateway = new FakeGateway();
    const orchestrator = new AcquisitionOrchestrator(allocator, gateway, paths, new FixedClock());
    await orchestrator.run(request);
    await writeFile(
      path.join(paths.staging, "ACQ-20260826-0001", "job.json"),
      `${JSON.stringify({
        jobId: "ACQ-20260826-0001",
        sourceId: "SRC-000001",
        objective: "brave/search",
        status: "STAGED",
        startedAt: "2026-08-26T12:00:00+08:00",
        counts: { discovered: 2, stored: 0, duplicated: 0, quarantined: 0, failed: 0 },
      })}\n`,
      "utf8",
    );

    await expect(orchestrator.resume("ACQ-20260826-0001")).resolves.toMatchObject({
      jobId: "ACQ-20260826-0001",
      status: "STAGED",
      counts: { discovered: 2 },
    });
    expect(gateway.callCount).toBe(1);
  });
});

describe("data-workbench acquire CLI", () => {
  it("rejects a missing source ID and unknown flags", () => {
    const missingSource = runAcquire(["--site", "brave", "--command", "search"]);
    const unknownFlag = runAcquire([
      "--source-id", "SRC-000001", "--site", "brave", "--command", "search", "--unknown",
    ]);

    expect(missingSource.status).not.toBe(0);
    expect(missingSource.stderr).toMatch(/source-id/i);
    expect(unknownFlag.status).not.toBe(0);
    expect(unknownFlag.stderr).toMatch(/unknown option/i);
  });

  it("rejects a source with an already running acquisition job before spawning OpenCLI", async () => {
    const paths = await createPaths();
    const existingJobDirectory = path.join(paths.staging, "ACQ-20260826-0001");
    await mkdir(existingJobDirectory, { recursive: true });
    await mkdir(path.join(paths.vault, "10_Sources"), { recursive: true });
    await writeFile(
      path.join(paths.vault, "10_Sources", "SRC-000001.md"),
      `---\nsource_id: SRC-000001\ndomain: example.com\nsource_type: public_web\naccess_strategy: public\nsource_policy: allowed\nraw_retention: allowed\ndataset_usage: allowed\nsynthetic: false\ncontains_synthetic_identifiers: false\nenabled: true\n---\n`,
      "utf8",
    );
    await writeFile(
      path.join(existingJobDirectory, "job.json"),
      `${JSON.stringify({
        jobId: "ACQ-20260826-0001",
        sourceId: "SRC-000001",
        objective: "brave/search",
        status: "FETCHING",
        startedAt: "2026-08-26T12:00:00+08:00",
        counts: { discovered: 0, stored: 0, duplicated: 0, quarantined: 0, failed: 0 },
      })}\n`,
      "utf8",
    );

    const result = runAcquire(
      [
        "--source-id", "SRC-000001", "--site", "brave", "--command", "search",
        "--arg", "site:huggingface.co/datasets", "--arg", "--limit", "--arg", "10",
      ],
      paths.root,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/already running/i);
  });
});

function runAcquire(args: string[], dataRoot?: string) {
  return spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(packageRoot, "src", "cli.ts"),
      "acquire",
      ...args,
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, ...(dataRoot ? { FLOWMATE_DATA_ROOT: dataRoot } : {}) },
    },
  );
}
