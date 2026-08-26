import { access, link, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

export interface AcquisitionOrchestratorHooks {
  afterReceiptWritten?(jobId: string): Promise<void>;
  afterDeadClaimChecked?(): Promise<void>;
}

interface ClaimOwner {
  pid: number;
  nonce: string;
}

interface AcquiredClaim {
  owner: ClaimOwner;
  ownerPath: string;
}

let temporaryFileCounter = 0;

export class AcquisitionOrchestrator {
  public constructor(
    private readonly idAllocator: IdAllocator,
    private readonly gateway: PublicOpenCliGateway,
    private readonly paths: DataPaths,
    private readonly clock: Clock,
    private readonly sourcePolicy: SourcePolicy,
    private readonly hooks: AcquisitionOrchestratorHooks = {},
  ) {}

  public async run(request: OpenCliAcquisitionRequest): Promise<AcquisitionJob> {
    assertSourceId(request.sourceId);
    assertRunnablePolicy(this.sourcePolicy, request.sourceId);
    const claim = await acquireGlobalClaim(this.paths.staging);
    try {
      const jobId = assertAcquisitionJobId(await this.idAllocator.next("acquisition"));
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
      await this.hooks.afterReceiptWritten?.(jobId);
      job = {
        ...job,
        status: "STAGED",
        counts: { ...job.counts, discovered: receipt.items.length },
      };
      await writeJsonAtomically(path.join(jobDirectory, "job.json"), job);
      return job;
    } finally {
      await releaseOwnedClaim(this.paths.staging, claim);
    }
  }

  public async resume(jobId: string): Promise<AcquisitionJob> {
    assertAcquisitionJobId(jobId);
    await acquireRecoveryLock(this.paths.staging);
    let claim: AcquiredClaim | undefined;
    try {
      await removeDeadClaimForRecovery(this.paths.staging, this.hooks);
      claim = await acquireGlobalClaim(this.paths.staging, true);
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
      return stagedJob;
    } finally {
      if (claim !== undefined) {
        await releaseOwnedClaim(this.paths.staging, claim);
      }
      await releaseRecoveryLock(this.paths.staging);
    }
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

function recoveryLockDirectory(stagingPath: string): string {
  return path.join(stagingPath, ".acquisition-recovery-lock");
}

function claimOwnerPath(stagingPath: string, owner: ClaimOwner): string {
  return path.join(stagingPath, `.acquisition-owner-${owner.pid}-${owner.nonce}.json`);
}

async function acquireGlobalClaim(
  stagingPath: string,
  whileRecovering = false,
): Promise<AcquiredClaim> {
  await mkdir(stagingPath, { recursive: true });
  if (!whileRecovering) {
    await rejectIfRecoveryInProgress(stagingPath);
  }
  const owner: ClaimOwner = { pid: process.pid, nonce: randomUUID() };
  const ownerPath = claimOwnerPath(stagingPath, owner);
  await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await link(ownerPath, claimDirectory(stagingPath));
    return { owner, ownerPath };
  } catch (error: unknown) {
    await unlink(ownerPath);
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error("An acquisition job is already running", { cause: error });
    }
    throw error;
  }
}

async function releaseOwnedClaim(stagingPath: string, claim: AcquiredClaim): Promise<void> {
  await removePublishedClaimIfOwned(stagingPath, claim.owner);
  try {
    await unlink(claim.ownerPath);
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function acquireRecoveryLock(stagingPath: string): Promise<void> {
  await mkdir(stagingPath, { recursive: true });
  try {
    await mkdir(recoveryLockDirectory(stagingPath));
  } catch (error: unknown) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error("Acquisition recovery is already in progress", { cause: error });
    }
    throw error;
  }
}

async function releaseRecoveryLock(stagingPath: string): Promise<void> {
  try {
    await rmdir(recoveryLockDirectory(stagingPath));
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function rejectIfRecoveryInProgress(stagingPath: string): Promise<void> {
  try {
    await access(recoveryLockDirectory(stagingPath));
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new Error("Acquisition recovery is already in progress");
}

async function removeDeadClaimForRecovery(
  stagingPath: string,
  hooks: AcquisitionOrchestratorHooks,
): Promise<void> {
  const owner = await readPublishedClaimOwner(stagingPath);
  if (owner === undefined) {
    return;
  }
  if (isProcessLive(owner.pid)) {
    throw new Error("Acquisition claim is still running");
  }
  await hooks.afterDeadClaimChecked?.();
  await removePublishedClaimIfOwned(stagingPath, owner);
}

async function removePublishedClaimIfOwned(stagingPath: string, expectedOwner: ClaimOwner): Promise<void> {
  const owner = await readPublishedClaimOwner(stagingPath);
  if (owner === undefined || owner.pid !== expectedOwner.pid || owner.nonce !== expectedOwner.nonce) {
    return;
  }
  await unlink(claimDirectory(stagingPath));
}

async function readPublishedClaimOwner(stagingPath: string): Promise<ClaimOwner | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(claimDirectory(stagingPath), "utf8"));
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw new Error("Acquisition claim requires explicit recovery", { cause: error });
  }
  if (!isClaimOwner(parsed)) {
    throw new Error("Acquisition claim requires explicit recovery");
  }
  return parsed;
}

function isClaimOwner(value: unknown): value is ClaimOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === "number" && Number.isSafeInteger(candidate.pid) &&
    candidate.pid > 0 && candidate.pid <= 2_147_483_647 &&
    typeof candidate.nonce === "string" && candidate.nonce.length > 0
  );
}

function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !hasErrorCode(error, "ESRCH");
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
