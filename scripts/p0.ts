import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { inspectEnvironment } from "./doctor.js";
import { freezeDataset, inspectSource, loadFrozenDataset, type SourceRoleMap } from "@flowmate/data";
import { TestCandidateSchema, type DatasetPurpose } from "@flowmate/contracts";
import { verifyHandoff, type RuntimeProfile } from "@flowmate/core";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createControlledProvider, createPiRuntime, type PiRuntimeOptions } from "@flowmate/runtime-pi";

export type P0CommandKind = "inspect" | "freeze" | "run" | "parser" | "plugin-probe" | "handoff";
export type P0Command = {
  kind: P0CommandKind;
  live: boolean;
  profile: string | null;
  positional: string[];
  sourceRoot: string | null;
  roleMapPath: string | null;
  manifestPath: string | null;
  candidatePath: string | null;
  outputRoot: string | null;
  sampleId: string | null;
  purposes: Array<{ sampleId: string; purpose: DatasetPurpose }>;
};

export type P0CommandResult = {
  exitCode: 0 | 1 | 2;
  code: "READY" | "LIVE_PROFILE_REQUIRED" | "CAPABILITY_NOT_READY" | "INVALID_COMMAND";
  message: string;
  details?: {
    validEntries?: number;
    quarantinedEntries?: number;
    errors?: number;
    quarantined?: Array<{ sampleId: string; code: string }>;
    manifestHash?: string | null;
    jobId?: string;
    runId?: string;
    candidateId?: string;
    errorsList?: string[];
  };
};

const commandKinds = new Set<P0CommandKind>(["inspect", "freeze", "run", "parser", "plugin-probe", "handoff"]);

export function parseP0Args(args: string[]): P0Command {
  const [first, ...rest] = args;
  const kind = commandKinds.has(first as P0CommandKind) ? first as P0CommandKind : "inspect";
  const live = rest.includes("--live");
  const profileIndex = rest.indexOf("--profile");
  const profile = profileIndex >= 0 ? rest[profileIndex + 1] ?? null : null;
  const rootIndex = rest.indexOf("--root");
  const roleMapIndex = rest.indexOf("--role-map");
  const manifestIndex = rest.indexOf("--manifest");
  const candidateIndex = rest.indexOf("--candidate");
  const outputIndex = rest.indexOf("--output");
  const sampleIndex = rest.indexOf("--sample");
  const sourceRoot = rootIndex >= 0 ? rest[rootIndex + 1] ?? null : null;
  const roleMapPath = roleMapIndex >= 0 ? rest[roleMapIndex + 1] ?? null : null;
  const manifestPath = manifestIndex >= 0 ? rest[manifestIndex + 1] ?? null : null;
  const candidatePath = candidateIndex >= 0 ? rest[candidateIndex + 1] ?? null : null;
  const outputRoot = outputIndex >= 0 ? rest[outputIndex + 1] ?? null : null;
  const sampleId = sampleIndex >= 0 ? rest[sampleIndex + 1] ?? null : null;
  const purposes: Array<{ sampleId: string; purpose: DatasetPurpose }> = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== "--purpose") continue;
    const value = rest[index + 1] ?? "";
    const separator = value.indexOf("=");
    const sampleId = separator > 0 ? value.slice(0, separator) : "";
    const purpose = separator > 0 ? value.slice(separator + 1) : "";
    if (sampleId && (purpose === "development" || purpose === "test" || purpose === "holdout")) purposes.push({ sampleId, purpose });
  }
  const consumed = new Set<number>();
  for (const index of [profileIndex, rootIndex, roleMapIndex, manifestIndex, candidateIndex, outputIndex, sampleIndex]) {
    if (index >= 0) {
      consumed.add(index);
      if (index + 1 < rest.length) consumed.add(index + 1);
    }
  }
  for (let index = 0; index < rest.length; index += 1) if (rest[index] === "--purpose") { consumed.add(index); consumed.add(index + 1); }
  const positional = rest.filter((arg, index) => arg !== "--live" && !consumed.has(index));
  return { kind, live, profile, positional, sourceRoot, roleMapPath, manifestPath, candidatePath, outputRoot, sampleId, purposes };
}

export type P0CommandOptions = { cwd: string; sourceRoot?: string; roleMap?: SourceRoleMap };

type LiveApplication = {
  start(command: { sampleId: string; candidateId: string; clientRequestId: string }): Promise<{ jobId: string; runId: string }>;
  wait(runId: string): Promise<{ kind: "completed" | "aborted" | "failed"; sessionId: string; error?: string }>;
  getJob(command: { jobId: string }): { candidates: unknown[] };
  close(): Promise<void>;
};

type DesktopCompositionModule = {
  createApplication(config: unknown): LiveApplication;
};

async function loadDesktopComposition(cwd: string): Promise<DesktopCompositionModule | null> {
  try {
    const modulePath = resolve(cwd, "apps", "desktop", "dist", "main", "composition.js");
    return await import(pathToFileURL(modulePath).href) as unknown as DesktopCompositionModule;
  } catch {
    return null;
  }
}

async function loadRoleMap(path: string): Promise<SourceRoleMap | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    const candidate = value && typeof value === "object" && "roleMap" in value
      ? (value as { roleMap?: unknown }).roleMap
      : value;
    if (!candidate || typeof candidate !== "object") return null;
    return candidate as SourceRoleMap;
  } catch {
    return null;
  }
}

async function loadJson(path: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; } catch { return null; }
}

async function profilePath(cwd: string, profile: string): Promise<string | null> {
  const candidates = [
    isAbsolute(profile) ? profile : resolve(cwd, profile),
    resolve(cwd, "config", "profiles", `${profile}.json`),
    resolve(cwd, "config", `${profile}.json`),
  ];
  for (const candidate of candidates) {
    try { await readFile(candidate, "utf8"); return candidate; } catch { /* try the next explicit location */ }
  }
  return null;
}

function runtimeProfile(value: unknown, cwd: string): RuntimeProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["profileId", "mode", "environment", "available", "modelProfileHash", "modelRef", "authPath", "allowedSampleIds"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return null;
  if (typeof record.profileId !== "string" || typeof record.modelProfileHash !== "string" || typeof record.available !== "boolean") return null;
  if (!/^[a-f0-9]{64}$/.test(record.modelProfileHash)) return null;
  if (record.environment !== "local-test" && record.environment !== "production") return null;
  const modelValue = record.modelRef;
  const modelProvider = modelValue && typeof modelValue === "object" && !Array.isArray(modelValue)
    ? (modelValue as Record<string, unknown>).provider
    : undefined;
  const modelId = modelValue && typeof modelValue === "object" && !Array.isArray(modelValue)
    ? (modelValue as Record<string, unknown>).modelId
    : undefined;
  const modelRef = typeof modelProvider === "string" && typeof modelId === "string"
    ? { provider: modelProvider, modelId }
    : undefined;
  const mode = record.mode === "live" || record.mode === "controlled" ? record.mode : undefined;
  const authPath = typeof record.authPath === "string" ? record.authPath : undefined;
  const allowedSampleIds = Array.isArray(record.allowedSampleIds) && record.allowedSampleIds.every((item) => typeof item === "string")
    ? record.allowedSampleIds as string[]
    : undefined;
  return {
    profileId: record.profileId,
    environment: record.environment,
    modelProfileHash: record.modelProfileHash,
    available: record.available,
    ...(mode === undefined ? {} : { mode }),
    ...(modelRef === undefined ? {} : { modelRef }),
    ...(authPath === undefined ? {} : { authPath: isAbsolute(authPath) ? authPath : resolve(cwd, authPath) }),
    ...(allowedSampleIds === undefined ? {} : { allowedSampleIds }),
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function runP0Command(command: P0Command, options: P0CommandOptions): Promise<P0CommandResult> {
  if (command.live && command.profile === null) {
    return { exitCode: 2, code: "LIVE_PROFILE_REQUIRED", message: "a Live Profile must be selected explicitly" };
  }
  if ((command.kind === "run" || command.kind === "parser") && command.profile === null) {
    return { exitCode: 2, code: "LIVE_PROFILE_REQUIRED", message: `${command.kind} requires an explicit --profile` };
  }
  if (command.kind === "inspect") {
    const sourceRoot = command.sourceRoot ?? options.sourceRoot;
    if (sourceRoot) {
      const roleMap = options.roleMap ?? (command.roleMapPath ? await loadRoleMap(resolve(options.cwd, command.roleMapPath)) : null);
      if (!roleMap) {
        return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "source inspection requires a validated role map" };
      }
      try {
        const root = isAbsolute(sourceRoot) ? sourceRoot : resolve(options.cwd, sourceRoot);
        const report = await inspectSource(root, roleMap);
        return {
          exitCode: 0,
          code: "READY",
          message: `source inspected: ${report.validEntries.length} valid, ${report.quarantinedEntries.length} quarantined`,
          details: {
            validEntries: report.validEntries.length,
            quarantinedEntries: report.quarantinedEntries.length,
            errors: report.errors.length,
            quarantined: report.quarantinedEntries.map((entry) => ({ sampleId: entry.sampleId, code: entry.issue.code })),
          },
        };
      } catch {
        return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "source root could not be inspected" };
      }
    }
    const report = await inspectEnvironment({ cwd: options.cwd });
    const blocked = !report.node.supported || !report.npm.available || report.checks.some((check) => check.status === "blocked");
    return { exitCode: blocked ? 1 : 0, code: blocked ? "CAPABILITY_NOT_READY" : "READY", message: blocked ? "environment is not ready" : "environment is ready" };
  }
  if (command.kind === "freeze") {
    const sourceRoot = command.sourceRoot ?? options.sourceRoot;
    if (!sourceRoot) return { exitCode: 2, code: "INVALID_COMMAND", message: "freeze requires --root <sourceRoot>" };
    const roleMap = options.roleMap ?? (command.roleMapPath ? await loadRoleMap(resolve(options.cwd, command.roleMapPath)) : null);
    if (!roleMap) return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "dataset freeze requires a validated role map" };
    if (command.purposes.length === 0) return { exitCode: 2, code: "INVALID_COMMAND", message: "freeze requires one or more --purpose SAMPLE_ID=development|test|holdout values" };
    try {
      const root = isAbsolute(sourceRoot) ? sourceRoot : resolve(options.cwd, sourceRoot);
      const report = await inspectSource(root, roleMap);
      const purposeMap = Object.fromEntries(command.purposes.map((item) => [item.sampleId, item.purpose]));
      const manifest = await freezeDataset(report, purposeMap, command.outputRoot ? { outputRoot: isAbsolute(command.outputRoot) ? command.outputRoot : resolve(options.cwd, command.outputRoot) } : {});
      return {
        exitCode: 0,
        code: "READY",
        message: `dataset frozen: ${manifest.cases.length} cases`,
        details: {
          validEntries: report.validEntries.length,
          quarantinedEntries: report.quarantinedEntries.length,
          errors: report.errors.length,
          manifestHash: hashJson(manifest),
        },
      };
    } catch (error) {
      return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: error instanceof Error ? error.message : "dataset could not be frozen" };
    }
  }
  if (command.kind === "handoff") {
    if (!command.manifestPath) {
      return { exitCode: 2, code: "CAPABILITY_NOT_READY", message: "handoff verification requires --manifest <path>" };
    }
    try {
      const manifest = JSON.parse(await readFile(resolve(options.cwd, command.manifestPath), "utf8")) as unknown;
      const checked = verifyHandoff(manifest);
      return {
        exitCode: checked.ok ? 0 : 1,
        code: checked.ok ? "READY" : "CAPABILITY_NOT_READY",
        message: checked.ok ? "handoff manifest is valid" : "handoff manifest is invalid",
        details: { manifestHash: checked.manifestHash, errorsList: checked.errors },
      };
    } catch (error) {
      return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: error instanceof Error ? error.message : "handoff manifest could not be read" };
    }
  }
  if (command.kind === "plugin-probe") {
    const root = await mkdtemp(join(tmpdir(), "flowmate-cli-plugin-probe-"));
    const provider = createControlledProvider([
      { toolCall: { name: "Agent", arguments: { prompt: "Read the synthetic probe evidence.", description: "P0 probe", subagent_type: "p0-probe", run_in_background: false } } },
      { toolCall: { name: "read_evidence", arguments: { assetId: "original:cli-probe:SYN-001", blockId: "b1" } } },
      { text: "child probe complete" },
      { text: "parent observed child probe" },
    ]);
    const identity = { jobId: "job-cli-probe", runId: "run-cli-probe", generation: 1, candidateId: "candidate-cli-probe" };
    const childExtensionPath = fileURLToPath(new URL("../packages/runtime-pi/src/subagent/child-extension.ts", import.meta.url));
    try {
      const runtime = await createPiRuntime({
        cwd: join(root, "cwd"),
        agentDir: join(root, "agent"),
        identity,
        provider,
        subagent: {
          childExtensionPath,
          invoke: async (toolName, args) => ({ ok: true, value: { toolName, args, text: "synthetic probe evidence" }, evidence: [] }),
        },
      });
      try {
        const outcome = await runtime.run({ taskPrompt: "Use the native Agent to run the probe." });
        const delegations = runtime.subagentOutcomes();
        const successful = outcome.kind === "completed" && delegations.length === 1 && delegations[0]?.status === "succeeded" && delegations[0].cleanupStatus === "complete";
        return {
          exitCode: successful ? 0 : 1,
          code: successful ? "READY" : "CAPABILITY_NOT_READY",
          message: successful ? "native Agent plugin probe completed" : "native Agent plugin probe did not complete",
          details: { errorsList: successful ? [] : [outcome.kind === "failed" ? outcome.error : "delegation did not succeed"] },
        };
      } finally {
        await runtime.close();
      }
    } catch (error) {
      return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: error instanceof Error ? error.message : "native Agent plugin probe failed" };
    } finally {
      provider.close();
      await rm(root, { recursive: true, force: true });
    }
  }
  if (command.kind === "parser") {
    return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "PARSER_ENV_NOT_READY: a verified local Parser Profile and an unparsed original are required" };
  }
  if (command.kind === "run") {
    if (!command.profile) return { exitCode: 2, code: "LIVE_PROFILE_REQUIRED", message: "run requires an explicit --profile" };
    const selectedProfilePath = await profilePath(options.cwd, command.profile);
    if (!selectedProfilePath) return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "LIVE_PROFILE_INCOMPLETE: selected Profile file was not found" };
    const profile = runtimeProfile(await loadJson(selectedProfilePath), options.cwd);
    if (!profile || profile.mode !== "live" || !profile.modelRef || !profile.authPath) {
      return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "LIVE_PROFILE_INCOMPLETE: Profile must declare mode=live, modelRef and authPath" };
    }
    if (!command.manifestPath || !command.candidatePath || !command.sampleId) {
      return { exitCode: 2, code: "INVALID_COMMAND", message: "run requires --manifest <frozen-root> --candidate <candidate.json> --sample <sampleId>" };
    }
    try {
      await readFile(profile.authPath, "utf8");
    } catch {
      return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "LIVE_PROFILE_INCOMPLETE: auth Profile is not readable" };
    }
    const manifestRoot = isAbsolute(command.manifestPath) ? command.manifestPath : resolve(options.cwd, command.manifestPath);
    const candidateFile = isAbsolute(command.candidatePath) ? command.candidatePath : resolve(options.cwd, command.candidatePath);
    const candidateValue = await loadJson(candidateFile);
    const candidateResult = TestCandidateSchema.safeParse(candidateValue);
    if (!candidateResult.success) return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "LIVE_PROFILE_INCOMPLETE: candidate file does not satisfy TestCandidate" };
    try {
      const manifest = await loadFrozenDataset(manifestRoot);
      if (!manifest.cases.some((item) => item.sampleId === command.sampleId)) return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "SAMPLE_NOT_IN_DATASET: selected sample is not in the frozen manifest" };
      const outputRoot = command.outputRoot ? (isAbsolute(command.outputRoot) ? command.outputRoot : resolve(options.cwd, command.outputRoot)) : resolve(manifestRoot, "runs");
      const agentRoot = resolve(outputRoot, "agent");
      const desktop = await loadDesktopComposition(options.cwd);
      if (!desktop) return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "DESKTOP_COMPOSITION_NOT_BUILT: run npm run typecheck before the Live entry" };
      const app = desktop.createApplication({
        dataRoot: outputRoot,
        agentRoot,
        manifest,
        candidate: candidateResult.data,
        profile,
        runtimeFactory: ({ identity, gateway, cwd, agentDir, budget }: { identity: PiRuntimeOptions["identity"]; gateway: NonNullable<PiRuntimeOptions["gateway"]>; cwd: string; agentDir: string; budget: NonNullable<PiRuntimeOptions["budget"]> }) => {
          const runtimeOptions: PiRuntimeOptions = {
            identity,
            gateway,
            cwd,
            agentDir,
            budget,
            ...(profile.modelRef === undefined ? {} : { modelRef: profile.modelRef }),
            ...(profile.authPath === undefined ? {} : { authPath: profile.authPath }),
          };
          return createPiRuntime(runtimeOptions);
        },
      });
      try {
        const identity = await app.start({ sampleId: command.sampleId, candidateId: candidateResult.data.candidateId, clientRequestId: `cli-${Date.now()}-${command.sampleId}` });
        const outcome = await app.wait(identity.runId);
        const snapshot = app.getJob({ jobId: identity.jobId });
        return {
          exitCode: outcome.kind === "completed" && snapshot.candidates.length > 0 ? 0 : 1,
          code: outcome.kind === "completed" && snapshot.candidates.length > 0 ? "READY" : "CAPABILITY_NOT_READY",
          message: outcome.kind === "completed" && snapshot.candidates.length > 0 ? "live extraction completed" : `live extraction did not produce an accepted candidate: ${outcome.error ?? outcome.kind}`,
          details: { jobId: identity.jobId, runId: identity.runId, candidateId: candidateResult.data.candidateId, errorsList: outcome.error ? [outcome.error] : [] },
        };
      } finally {
        await app.close();
      }
    } catch (error) {
      return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: error instanceof Error ? error.message : "live extraction could not start" };
    }
  }
  return { exitCode: 2, code: "CAPABILITY_NOT_READY", message: `${command.kind} is not implemented in the current P0 slice` };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  const result = await runP0Command(parseP0Args(process.argv.slice(2)), { cwd: process.cwd() });
  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode;
}
