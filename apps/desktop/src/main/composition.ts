import { join } from "node:path";
import type { DatasetManifest, TestCandidate, RunIdentity } from "@flowmate/contracts";
import { createProjection, type InputProjection } from "@flowmate/data";
import { buildContext, BudgetLedger, preflight, type RuntimeProfile } from "@flowmate/core";
import { createGateway } from "@flowmate/core";
import { createJobService, openStore, type ControlledRuntime, type JobSnapshot, type Store } from "@flowmate/core";
import { createPiRuntime, type PiRuntimeOptions } from "@flowmate/runtime-pi";

export type StartCommand = { sampleId: string; candidateId: string; clientRequestId: string };
export type RebuildCommand = { jobId: string; clientRequestId: string };
export type StartResult = RunIdentity;
export type SampleSummary = { sampleId: string; sourceId: string; purpose: string; parserVersion: string };
export type ApplicationDiagnostics = { activeRunCount: number; datasetVersion: string; candidateId: string; profileId: string };
export type EvidenceView = { assetId: string; sampleId: string; blocks: Array<{ id: string; text: string; page: number | null }> };

export type RuntimeFactory = (options: { identity: RunIdentity; gateway: ReturnType<typeof createGateway>; projection: InputProjection; context: ReturnType<typeof buildContext>; cwd: string; agentDir: string; budget: BudgetLedger }) => Promise<ControlledRuntime>;
export type ApplicationConfig = {
  dataRoot: string;
  agentRoot: string;
  manifest: DatasetManifest;
  candidate: TestCandidate;
  profile: RuntimeProfile;
  runtimeFactory: RuntimeFactory;
  store?: Store;
};

export type Application = {
  listSamples(): SampleSummary[];
  start(command: StartCommand): Promise<StartResult>;
  rebuild(command: RebuildCommand): Promise<StartResult>;
  cancel(command: { runId: string }): Promise<{ status: "complete" | "incomplete"; reason?: string }>;
  wait(runId: string): Promise<Awaited<ReturnType<ControlledRuntime["run"]>>>;
  getJob(command: { jobId: string }): JobSnapshot;
  getEvidence(command: { jobId: string; assetId: string }): Promise<EvidenceView>;
  getDiagnostics(): ApplicationDiagnostics;
  close(): Promise<void>;
};

/**
 * Build the production composition seam around the embedded Pi Runtime. The
 * caller must provide a real model/modelRef or an explicit controlled Provider
 * for offline tests; `createPiRuntime` no longer invents a provider when the
 * application has no model configuration.
 */
export function createPiRuntimeFactory(
  runtimeOptions: Omit<PiRuntimeOptions, "identity" | "gateway" | "cwd" | "agentDir" | "budget"> = {},
): RuntimeFactory {
  return ({ identity, gateway, context, cwd, agentDir, budget }) => createPiRuntime({
    ...runtimeOptions,
    identity,
    gateway,
    cwd,
    agentDir,
    budget,
    systemPrompt: runtimeOptions.systemPrompt ?? context.systemPrompt,
  });
}

const activeStatuses = new Set(["created", "running", "cancelling"]);

export function createApplication(config: ApplicationConfig): Application {
  const store = config.store ?? openStore(config.dataRoot);
  const startRequests = new Map<string, Promise<StartResult>>();
  const jobService = createJobService(store);
  const activeSamples = new Map<string, string>();
  const pendingSamples = new Set<string>();
  const pendingLaunches = new Set<Promise<StartResult>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const launchRun = async (sampleId: string, candidateId: string, existingJobId?: string): Promise<StartResult> => {
    if (candidateId !== config.candidate.candidateId) throw new Error("CANDIDATE_NOT_FOUND");
    if (!existingJobId && activeSamples.has(sampleId)) throw new Error("RUN_BUSY");
    const projection = await createProjection(config.manifest, sampleId);
    const eligibility = preflight(config.candidate, { sampleId, datasetVersion: projection.datasetVersion, inputHash: projection.inputHash, allowed: true }, config.profile);
    if (!eligibility.eligible) throw new Error(eligibility.error.code);
    const job = existingJobId ? store.getJob(existingJobId).job : store.createJob({ jobType: "invoice-extract", sampleId, inputHash: projection.inputHash, candidateId });
    if (job.sampleId !== sampleId) throw new Error("SAMPLE_MISMATCH");
    let run;
    try {
      run = store.startRun(job.id, candidateId);
    } catch (error) {
      if (error instanceof Error && error.message === "RUN_ALREADY_ACTIVE") throw new Error("RUN_BUSY");
      throw error;
    }
    const identity: RunIdentity = { jobId: job.id, runId: run.runId, generation: run.generation, candidateId };
    const context = buildContext(identity, projection, config.candidate);
    const budget = new BudgetLedger(config.candidate.budget);
    const gateway = createGateway({ store, input: { sampleId, parsed: projection.parsed, allowedAssetIds: projection.allowedAssetIds }, budget });
    try {
      const runtime = await config.runtimeFactory({ identity, gateway, projection, context, cwd: join(config.dataRoot, "runtime", run.runId, "cwd"), agentDir: join(config.dataRoot, "runtime", run.runId, "agent"), budget });
      const handle = jobService.start({ runtime, identity, context });
      activeSamples.set(sampleId, run.runId);
      void handle.done.finally(() => {
        if (activeSamples.get(sampleId) === run.runId) activeSamples.delete(sampleId);
      });
      return identity;
    } catch (error) {
      if (activeSamples.get(sampleId) === run.runId) activeSamples.delete(sampleId);
      store.finishRun(run.runId, "failed", "incomplete");
      throw error;
    }
  };

  const launch = (sampleId: string, candidateId: string, existingJobId?: string): Promise<StartResult> => {
    if (closing) return Promise.reject(new Error("APPLICATION_CLOSED"));
    if (pendingSamples.has(sampleId) || activeSamples.has(sampleId)) return Promise.reject(new Error("RUN_BUSY"));
    // Reserve before the first await: concurrent IPC calls must not both pass preflight.
    pendingSamples.add(sampleId);
    const request = launchRun(sampleId, candidateId, existingJobId);
    pendingLaunches.add(request);
    const release = () => { pendingSamples.delete(sampleId); pendingLaunches.delete(request); };
    void request.then(release, release);
    return request;
  };

  return {
    listSamples() { return config.manifest.cases.filter((item) => !config.profile.allowedSampleIds || config.profile.allowedSampleIds.includes(item.sampleId)).map((item) => ({ sampleId: item.sampleId, sourceId: item.sourceId, purpose: item.purpose, parserVersion: item.parserVersion })); },
    start(command) {
      if (closing) return Promise.reject(new Error("APPLICATION_CLOSED"));
      const existing = startRequests.get(command.clientRequestId);
      if (existing) return existing;
      const request = launch(command.sampleId, command.candidateId);
      startRequests.set(command.clientRequestId, request);
      return request;
    },
    async rebuild(command) {
      if (closing) throw new Error("APPLICATION_CLOSED");
      const snapshot = store.getJob(command.jobId);
      if (snapshot.runs.some((run) => activeStatuses.has(run.status))) throw new Error("RUN_BUSY");
      return launch(snapshot.job.sampleId, snapshot.job.candidateId, command.jobId);
    },
    async cancel(command) {
      return jobService.cancel(command.runId, "user");
    },
    async wait(runId) {
      return jobService.wait(runId);
    },
    getJob(command) { return store.getJob(command.jobId); },
    async getEvidence(command) {
      const snapshot = store.getJob(command.jobId);
      const projection = await (() => {
        // The manifest is frozen in this process; createProjection is the only
        // path that reconstructs the approved sample projection.
        return createProjection(config.manifest, snapshot.job.sampleId);
      })();
      const value = projection;
      if (!value.allowedAssetIds.includes(command.assetId)) throw new Error("ASSET_NOT_ALLOWED");
      return { assetId: command.assetId, sampleId: snapshot.job.sampleId, blocks: value.parsed.blocks.map((block) => ({ id: block.id, text: block.text, page: block.evidence.page })) };
    },
    getDiagnostics() { return { activeRunCount: jobService.activeRunCount(), datasetVersion: config.manifest.datasetVersion, candidateId: config.candidate.candidateId, profileId: config.profile.profileId }; },
    async close() {
      closing = true;
      closePromise ??= (async () => {
        await Promise.allSettled([...pendingLaunches]);
        const cleanup = await jobService.close("application_close");
        if (cleanup.status !== "complete") throw new Error(`APPLICATION_CLEANUP_INCOMPLETE: ${cleanup.reason}`);
        if (!config.store) store.close();
      })();
      try { await closePromise; } catch (error) { closePromise = undefined; throw error; }
    },
  };
}
