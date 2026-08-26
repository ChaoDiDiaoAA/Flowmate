import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DataPaths } from "./filesystem-layout.js";
import type { IdAllocator } from "./ids.js";
import type { OpenCliAcquisitionRequest } from "./opencli-gateway.js";
import { acquisitionJobSchema } from "./schemas.js";
import type { AcquisitionJob, AcquisitionResult } from "./types.js";

export interface Clock {
  now(): string;
}

export interface AcquisitionReceipt {
  jobId: string;
  sourceId: string;
  adapterRef: string;
  strategy: "public";
  retrievedAt: string;
  items: unknown[];
}

export interface PublicOpenCliGateway {
  runPublic(request: OpenCliAcquisitionRequest): Promise<AcquisitionResult>;
}

let temporaryFileCounter = 0;

export class AcquisitionOrchestrator {
  private readonly runningSourceIds = new Set<string>();

  public constructor(
    private readonly idAllocator: IdAllocator,
    private readonly gateway: PublicOpenCliGateway,
    private readonly paths: DataPaths,
    private readonly clock: Clock,
  ) {}

  public async run(request: OpenCliAcquisitionRequest): Promise<AcquisitionJob> {
    await this.rejectIfAlreadyRunning(request.sourceId);
    this.runningSourceIds.add(request.sourceId);

    try {
      const jobId = await this.idAllocator.next("acquisition");
      const jobDirectory = path.join(this.paths.staging, jobId);
      let job: AcquisitionJob = {
        jobId,
        sourceId: request.sourceId,
        objective: `${request.site}/${request.command}`,
        status: "CREATED",
        startedAt: this.clock.now(),
        counts: emptyCounts(),
      };
      await writeJsonAtomically(path.join(jobDirectory, "job.json"), job);

      job = { ...job, status: "FETCHING" };
      await writeJsonAtomically(path.join(jobDirectory, "job.json"), job);
      const result = await this.gateway.runPublic(request);
      if (result.status !== "succeeded") {
        job = {
          ...job,
          status: "FETCH_FAILED",
          finishedAt: this.clock.now(),
          counts: { ...job.counts, failed: 1 },
        };
        await writeJsonAtomically(path.join(jobDirectory, "job.json"), job);
        throw new Error(`OpenCLI acquisition failed for ${request.site}/${request.command}`);
      }

      const receipt: AcquisitionReceipt = {
        jobId,
        sourceId: request.sourceId,
        adapterRef: result.adapterRef,
        strategy: "public",
        retrievedAt: this.clock.now(),
        items: result.items,
      };
      await writeJsonAtomically(
        path.join(jobDirectory, "acquisition-result.json"),
        receipt,
      );
      job = {
        ...job,
        status: "STAGED",
        counts: { ...job.counts, discovered: receipt.items.length },
      };
      await writeJsonAtomically(path.join(jobDirectory, "job.json"), job);
      return job;
    } finally {
      this.runningSourceIds.delete(request.sourceId);
    }
  }

  public async resume(jobId: string): Promise<AcquisitionJob> {
    const jobDirectory = path.join(this.paths.staging, jobId);
    const job = await readJob(path.join(jobDirectory, "job.json"));
    if (job.status !== "STAGED") {
      throw new Error(`Only STAGED acquisition jobs can be resumed: ${jobId}`);
    }
    const receipt = await readReceipt(path.join(jobDirectory, "acquisition-result.json"));
    if (receipt.jobId !== job.jobId || receipt.sourceId !== job.sourceId) {
      throw new Error(`Staging receipt does not match acquisition job: ${jobId}`);
    }
    return job;
  }

  private async rejectIfAlreadyRunning(sourceId: string): Promise<void> {
    if (this.runningSourceIds.has(sourceId)) {
      throw new Error(`Acquisition is already running for source: ${sourceId}`);
    }
    let entries: string[];
    try {
      entries = await readdir(this.paths.staging);
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      try {
        const job = await readJob(path.join(this.paths.staging, entry, "job.json"));
        if (job.sourceId === sourceId && isRunning(job.status)) {
          throw new Error(`Acquisition is already running for source: ${sourceId}`);
        }
      } catch (error: unknown) {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
  }
}

function emptyCounts(): AcquisitionJob["counts"] {
  return { discovered: 0, stored: 0, duplicated: 0, quarantined: 0, failed: 0 };
}

function isRunning(status: AcquisitionJob["status"]): boolean {
  return status === "CREATED" || status === "DISCOVERING_ADAPTER" || status === "FETCHING";
}

async function readJob(jobPath: string): Promise<AcquisitionJob> {
  const parsed: unknown = JSON.parse(await readFile(jobPath, "utf8"));
  const job = acquisitionJobSchema.parse(parsed);
  const { finishedAt, ...jobWithoutFinishedAt } = job;
  return finishedAt === undefined ? jobWithoutFinishedAt : { ...jobWithoutFinishedAt, finishedAt };
}

async function readReceipt(receiptPath: string): Promise<AcquisitionReceipt> {
  const value: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid acquisition staging receipt: ${receiptPath}`);
  }
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.jobId !== "string" || typeof receipt.sourceId !== "string" ||
    typeof receipt.adapterRef !== "string" || receipt.strategy !== "public" ||
    typeof receipt.retrievedAt !== "string" || !Array.isArray(receipt.items)
  ) {
    throw new Error(`Invalid acquisition staging receipt: ${receiptPath}`);
  }
  return value as AcquisitionReceipt;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  temporaryFileCounter += 1;
  const temporaryPath = `${filePath}.${process.pid}.${temporaryFileCounter}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
