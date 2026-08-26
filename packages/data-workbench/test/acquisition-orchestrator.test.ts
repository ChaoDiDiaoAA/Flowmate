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
import type { SourcePolicy } from "../src/types.js";

const temporaryRoots: string[] = [];
const request: OpenCliAcquisitionRequest = {
  sourceId: "SRC-000001",
  site: "brave",
  command: "search",
  args: ["invoice OCR"],
};
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "..", "..");
const allowedSourcePolicy: SourcePolicy = {
  sourceId: "SRC-000001",
  domain: "example.com",
  sourceType: "public_web",
  accessStrategy: "public",
  sourcePolicy: "allowed",
  rawRetention: "allowed",
  datasetUsage: "allowed",
  synthetic: false,
  containsSyntheticIdentifiers: false,
  enabled: true,
};

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

class ThrowingGateway extends FakeGateway {
  public override async runPublic(): Promise<AcquisitionResult> {
    this.callCount += 1;
    throw new Error("Authorization: Bearer gateway-secret");
  }
}

class BlockingGateway extends FakeGateway {
  public entered: Promise<void>;
  private markEntered: (() => void) | undefined;
  private releaseRun: (() => void) | undefined;
  private readonly completion: Promise<void>;

  public constructor() {
    super();
    this.entered = new Promise((resolve) => {
      this.markEntered = resolve;
    });
    this.completion = new Promise((resolve) => {
      this.releaseRun = resolve;
    });
  }

  public override async runPublic(): Promise<AcquisitionResult> {
    this.callCount += 1;
    this.markEntered?.();
    await this.completion;
    return super.runPublic();
  }

  public release(): void {
    this.releaseRun?.();
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
    const orchestrator = new AcquisitionOrchestrator(allocator, gateway, paths, new FixedClock(), allowedSourcePolicy);

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

  it("recovers the receipt-write crash window without spawning OpenCLI again", async () => {
    const paths = await createPaths();
    const allocator = new FakeAllocator();
    const gateway = new FakeGateway();
    const orchestrator = new AcquisitionOrchestrator(allocator, gateway, paths, new FixedClock(), allowedSourcePolicy);
    await orchestrator.run(request);
    await writeFile(
      path.join(paths.staging, "ACQ-20260826-0001", "job.json"),
      `${JSON.stringify({
        jobId: "ACQ-20260826-0001",
        sourceId: "SRC-000001",
        objective: "brave/search",
        status: "FETCHING",
        startedAt: "2026-08-26T12:00:00+08:00",
        counts: { discovered: 2, stored: 0, duplicated: 0, quarantined: 0, failed: 0 },
      })}\n`,
      "utf8",
    );
    await mkdir(path.join(paths.staging, ".acquisition-claim"), { recursive: true });
    await writeFile(
      path.join(paths.staging, ".acquisition-claim", "owner.json"),
      '{"jobId":"ACQ-20260826-0001"}\n',
      "utf8",
    );

    await expect(orchestrator.resume("ACQ-20260826-0001")).resolves.toMatchObject({
      jobId: "ACQ-20260826-0001",
      status: "STAGED",
      counts: { discovered: 2 },
    });
    expect(gateway.callCount).toBe(1);
    await expect(
      readFile(path.join(paths.staging, ".acquisition-claim", "owner.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists FETCH_FAILED when the gateway throws", async () => {
    const paths = await createPaths();
    const orchestrator = new AcquisitionOrchestrator(
      new FakeAllocator(), new ThrowingGateway(), paths, new FixedClock(), allowedSourcePolicy,
    );

    await expect(orchestrator.run(request)).rejects.toThrow(/OpenCLI acquisition failed/i);
    await expect(
      readFile(path.join(paths.staging, "ACQ-20260826-0001", "job.json"), "utf8"),
    ).resolves.toContain('"status": "FETCH_FAILED"');
  });

  it("uses a single durable staging claim across concurrent orchestrators", async () => {
    const paths = await createPaths();
    const gateway = new BlockingGateway();
    const first = new AcquisitionOrchestrator(
      new FakeAllocator(), gateway, paths, new FixedClock(), allowedSourcePolicy,
    );
    const second = new AcquisitionOrchestrator(
      new FakeAllocator(), new FakeGateway(), paths, new FixedClock(), {
        ...allowedSourcePolicy, sourceId: "SRC-000002",
      },
    );

    const firstRun = first.run(request);
    await gateway.entered;
    await expect(second.run({ ...request, sourceId: "SRC-000002" })).rejects.toThrow(/already running/i);
    gateway.release();
    await expect(firstRun).resolves.toMatchObject({ status: "STAGED" });
  });

  it("rejects disallowed policy at the orchestrator API boundary", async () => {
    const paths = await createPaths();
    const allocator = new FakeAllocator();
    const orchestrator = new AcquisitionOrchestrator(
      allocator, new FakeGateway(), paths, new FixedClock(), { ...allowedSourcePolicy, enabled: false },
    );

    await expect(orchestrator.run(request)).rejects.toThrow(/enabled.*allowed.*public/i);
    expect(allocator.callCount).toBe(0);
  });

  it("rejects traversal-like job IDs before reading staging files", async () => {
    const paths = await createPaths();
    const orchestrator = new AcquisitionOrchestrator(
      new FakeAllocator(), new FakeGateway(), paths, new FixedClock(), allowedSourcePolicy,
    );

    await expect(orchestrator.resume("../outside")).rejects.toThrow(/invalid acquisition job ID/i);
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
    const globalClaimDirectory = path.join(paths.staging, ".acquisition-claim");
    await mkdir(globalClaimDirectory, { recursive: true });
    await writeFile(
      path.join(globalClaimDirectory, "owner.json"),
      '{"jobId":"ACQ-20260826-0001"}\n',
      "utf8",
    );
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
