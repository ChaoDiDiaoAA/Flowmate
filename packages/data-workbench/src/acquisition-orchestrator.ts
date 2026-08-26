import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DataPaths } from "./filesystem-layout.js";
import type { IdAllocator } from "./ids.js";
import type { OpenCliAcquisitionRequest } from "./opencli-gateway.js";
import { acquisitionJobSchema } from "./schemas.js";
import { assertAcquisitionJobId, assertSourceId } from "./stable-ids.js";
import type { AcquisitionJob, AcquisitionResult, SourcePolicy } from "./types.js";

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
  public constructor(
    private readonly idAllocator: IdAllocator,
    private readonly gateway: PublicOpenCliGateway,
    private readonly paths: DataPaths,
    private readonly clock: Clock,
    private readonly sourcePolicy: SourcePolicy,
  ) {}

  public async run(request: OpenCliAcquisitionRequest): Promise<AcquisitionJob> {
    assertSourceId(request.sourceId);
    assertRunnablePolicy(this.sourcePolicy, request.sourceId);
    await acquireGlobalClaim(this.paths.staging);
    let jobId: string | undefined;
    try {
      jobId = assertAcquisitionJobId(await this.idAllocator.next("acquisition"));
      await writeJsonAtomically(claimOwnerPath(this.paths.staging), { jobId });
      const jobDirectory = stagingJobDirectory(this.paths.staging, jobId);
      let job: AcquisitionJob = {
        jobId,
        sourceId: request.sourceId,
        objective: `${request.site}/${request.command}`,
        status: "CREATED",
        startedAt: this.clock.now(),
        counts: emptyCounts(),
      };
      await writeJsonAtomically(path.join(jobDirectory, "job.json"), job);

      job = { ...job, status: "DISCOVERING_ADAPTER" };
      await writeJsonAtomically(path.join(jobDirectory, "job.json"), job);
      job = { ...job, status: "FETCHING" };
      await writeJsonAtomically(path.join(jobDirectory, "job.json"), job);

      let result: AcquisitionResult;
      try {
        result = await this.gateway.runPublic(request);
      } catch {
        await persistFetchFailure(jobDirectory, job, this.clock);
        throw new Error("OpenCLI acquisition failed");
      }
      if (result.status !== "succeeded") {
        await persistFetchFailure(jobDirectory, job, this.clock);
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
      await writeJsonAtomically(path.join(jobDirectory, "acquisition-result.json"), receipt);
      job = {
        ...job,
        status: "STAGED",
        counts: { ...job.counts, discovered: receipt.items.length },
      };
      await writeJsonAtomically(path.join(jobDirectory, "job.json"), job);
      return job;
    } finally {
      await releaseGlobalClaim(this.paths.staging, jobId);
    }
  }

  public async resume(jobId: string): Promise<AcquisitionJob> {
    assertAcquisitionJobId(jobId);
    const jobDirectory = stagingJobDirectory(this.paths.staging, jobId);
    const job = await readJob(path.join(jobDirectory, "job.json"));
    const receipt = await readReceipt(path.join(jobDirectory, "acquisition-result.json"));
    if (receipt.jobId !== job.jobId || receipt.sourceId !== job.sourceId) {
      throw new Error(`Staging receipt does not match acquisition job: ${jobId}`);
    }
    const stagedJob = toStagedJob(job, receipt.items.length);
    if (job.status !== "STAGED" || job.counts.discovered !== receipt.items.length) {
      await writeJsonAtomically(path.join(jobDirectory, "job.json"), stagedJob);
    }
    await releaseGlobalClaim(this.paths.staging, jobId);
    return stagedJob;
  }
}

function assertRunnablePolicy(policy: SourcePolicy, sourceId: string): void {
  if (
    policy.sourceId !== sourceId || policy.accessStrategy !== "public" ||
    !policy.enabled || policy.sourcePolicy !== "allowed"
  ) {
    throw new Error("Acquisition source policy must be enabled, allowed, and public");
  }
}

function emptyCounts(): AcquisitionJob["counts"] {
  return { discovered: 0, stored: 0, duplicated: 0, quarantined: 0, failed: 0 };
}

async function persistFetchFailure(
  jobDirectory: string,
  job: AcquisitionJob,
  clock: Clock,
): Promise<void> {
  await writeJsonAtomically(path.join(jobDirectory, "job.json"), {
    ...job,
    status: "FETCH_FAILED",
    finishedAt: clock.now(),
    counts: { ...job.counts, failed: job.counts.failed + 1 },
  });
}

function toStagedJob(job: AcquisitionJob, discovered: number): AcquisitionJob {
  const stagedJob: AcquisitionJob = {
    ...job,
    status: "STAGED",
    counts: { ...job.counts, discovered },
  };
  delete stagedJob.finishedAt;
  return stagedJob;
}

function stagingJobDirectory(stagingPath: string, jobId: string): string {
  return path.join(stagingPath, assertAcquisitionJobId(jobId));
}

function claimDirectory(stagingPath: string): string {
  return path.join(stagingPath, ".acquisition-claim");
}

function claimOwnerPath(stagingPath: string): string {
  return path.join(claimDirectory(stagingPath), "owner.json");
}

async function acquireGlobalClaim(stagingPath: string): Promise<void> {
  await mkdir(stagingPath, { recursive: true });
  try {
    await mkdir(claimDirectory(stagingPath));
  } catch (error: unknown) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error("An acquisition job is already running", { cause: error });
    }
    throw error;
  }
}

async function releaseGlobalClaim(stagingPath: string, expectedJobId: string | undefined): Promise<void> {
  const ownerPath = claimOwnerPath(stagingPath);
  if (expectedJobId !== undefined) {
    try {
      const owner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
      if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
        return;
      }
      if ((owner as Record<string, unknown>).jobId !== expectedJobId) {
        return;
      }
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) {
        // This process created the claim, but failed before its owner record was durable.
        // The empty claim directory is still safe to release.
      }
      else {
        throw error;
      }
    }
  }
  try {
    await unlink(ownerPath);
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  try {
    await rmdir(claimDirectory(stagingPath));
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
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
