import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { inspectEnvironment } from "./doctor.js";
import { freezeDataset, inspectSource, loadFrozenDataset, parseOriginal, parseParserProfile, type ParserInputRef, type SourceRoleMap } from "@flowmate/data";
import { makeInvoiceCandidate, TestCandidateSchema, type DatasetPurpose, type InvoiceCandidate } from "@flowmate/contracts";
import { exportHandoff, loadDotEnv, parseRuntimeProfile, verifyHandoff } from "@flowmate/core";
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
  evidencePath: string | null;
  datasetVersion: string | null;
  exportHandoff: boolean;
  outputRoot: string | null;
  inputPath: string | null;
  sourceId: string | null;
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
    attemptId?: string;
    inputHash?: string;
    outputRoot?: string;
    outputRefs?: number;
    parser?: { name: string; version: string; configHash: string };
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
  const evidenceIndex = rest.indexOf("--evidence");
  const datasetVersionIndex = rest.indexOf("--dataset-version");
  const outputIndex = rest.indexOf("--output");
  const inputIndex = rest.indexOf("--input");
  const sourceIdIndex = rest.indexOf("--source-id");
  const sampleIndex = rest.indexOf("--sample");
  const sourceRoot = rootIndex >= 0 ? rest[rootIndex + 1] ?? null : null;
  const roleMapPath = roleMapIndex >= 0 ? rest[roleMapIndex + 1] ?? null : null;
  const manifestPath = manifestIndex >= 0 ? rest[manifestIndex + 1] ?? null : null;
  const candidatePath = candidateIndex >= 0 ? rest[candidateIndex + 1] ?? null : null;
  const evidencePath = evidenceIndex >= 0 ? rest[evidenceIndex + 1] ?? null : null;
  const datasetVersion = datasetVersionIndex >= 0 ? rest[datasetVersionIndex + 1] ?? null : null;
  const outputRoot = outputIndex >= 0 ? rest[outputIndex + 1] ?? null : null;
  const inputPath = inputIndex >= 0 ? rest[inputIndex + 1] ?? null : null;
  const sourceId = sourceIdIndex >= 0 ? rest[sourceIdIndex + 1] ?? null : null;
  const sampleId = sampleIndex >= 0 ? rest[sampleIndex + 1] ?? null : null;
  const exportHandoff = rest.includes("--export");
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
  for (const index of [profileIndex, rootIndex, roleMapIndex, manifestIndex, candidateIndex, evidenceIndex, datasetVersionIndex, outputIndex, inputIndex, sourceIdIndex, sampleIndex]) {
    if (index >= 0) {
      consumed.add(index);
      if (index + 1 < rest.length) consumed.add(index + 1);
    }
  }
  for (const index of [rest.indexOf("--export")]) if (index >= 0) consumed.add(index);
  for (let index = 0; index < rest.length; index += 1) if (rest[index] === "--purpose") { consumed.add(index); consumed.add(index + 1); }
  const positional = rest.filter((arg, index) => arg !== "--live" && !consumed.has(index));
  return { kind, live, profile, positional, sourceRoot, roleMapPath, manifestPath, candidatePath, evidencePath, datasetVersion, exportHandoff, outputRoot, inputPath, sourceId, sampleId, purposes };
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
  const modulePaths = [
    resolve(cwd, "apps", "desktop", "dist", "main", "composition.js"),
    // `p0` is a Bun/tsx entry. The source fallback keeps the explicit CLI
    // usable after a clean checkout without requiring generated package output;
    // the normal build still prefers the checked TypeScript output above.
    resolve(cwd, "apps", "desktop", "src", "main", "composition.ts"),
  ];
  for (const modulePath of modulePaths) {
    try {
      return await import(pathToFileURL(modulePath).href) as unknown as DesktopCompositionModule;
    } catch {
      // Try the next known workspace entry, then report a single clear state.
    }
  }
  return null;
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

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".pdf": return "application/pdf";
    case ".webp": return "image/webp";
    case ".tif":
    case ".tiff": return "image/tiff";
    default: return "application/octet-stream";
  }
}

function controlledCandidateForSample(sampleId: string): InvoiceCandidate {
  const candidate = makeInvoiceCandidate();
  candidate.sampleId = sampleId;
  for (const key of Object.keys(candidate.fields) as Array<keyof InvoiceCandidate["fields"]>) {
    candidate.fields[key] = { raw: null, normalized: null, status: "missing", evidence: [] };
  }
  return candidate;
}

export async function runP0Command(command: P0Command, options: P0CommandOptions): Promise<P0CommandResult> {
  await loadDotEnv(resolve(options.cwd, ".env"));
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
    const blocked = !report.node.supported || !report.bun.available || report.checks.some((check) => check.status === "blocked");
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
    if (command.exportHandoff) {
      if (!command.candidatePath || !command.outputRoot) {
        return { exitCode: 2, code: "INVALID_COMMAND", message: "handoff --export requires --candidate <candidate.json> and --output <manifest.json>" };
      }
      const candidateValue = await loadJson(isAbsolute(command.candidatePath) ? command.candidatePath : resolve(options.cwd, command.candidatePath));
      const candidateResult = TestCandidateSchema.safeParse(candidateValue);
      if (!candidateResult.success) return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "HANDOFF_CANDIDATE_INVALID: candidate file does not satisfy TestCandidate" };
      const datasetVersion = command.datasetVersion ?? candidateResult.data.datasetVersion;
      const evidenceValue = command.evidencePath
        ? await loadJson(isAbsolute(command.evidencePath) ? command.evidencePath : resolve(options.cwd, command.evidencePath))
        : {};
      if (evidenceValue === null || typeof evidenceValue !== "object" || Array.isArray(evidenceValue)) {
        return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "HANDOFF_EVIDENCE_INVALID: evidence file must contain a JSON object" };
      }
      try {
        const manifest = await exportHandoff(candidateResult.data.candidateId, {
          ...(evidenceValue as Record<string, unknown>),
          candidate: candidateResult.data,
          datasetVersion,
          outputPath: isAbsolute(command.outputRoot) ? command.outputRoot : resolve(options.cwd, command.outputRoot),
        });
        return { exitCode: 0, code: "READY", message: "handoff manifest exported", details: { manifestHash: manifest.manifestHash } };
      } catch (error) {
        return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: error instanceof Error ? error.message : "handoff manifest could not be exported" };
      }
    }
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
    if (!command.profile) return { exitCode: 2, code: "LIVE_PROFILE_REQUIRED", message: "parser requires an explicit --profile" };
    if (!command.inputPath || !command.sampleId) {
      return { exitCode: 2, code: "INVALID_COMMAND", message: "parser requires --input <original> and --sample <sampleId>" };
    }
    const selectedProfilePath = await profilePath(options.cwd, command.profile);
    if (!selectedProfilePath) return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "PARSER_ENV_NOT_READY: Parser Profile file was not found" };
    let profile;
    try {
      profile = parseParserProfile(await loadJson(selectedProfilePath), dirname(selectedProfilePath));
    } catch (error) {
      return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: error instanceof Error ? error.message : "PARSER_PROFILE_INVALID" };
    }
    if (profile.mode !== "live") return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "PARSER_ENV_NOT_READY: Parser Profile must declare mode=live" };
    const inputFile = isAbsolute(command.inputPath) ? command.inputPath : resolve(options.cwd, command.inputPath);
    let bytes: Buffer;
    try {
      bytes = await readFile(inputFile);
    } catch {
      return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "PARSER_INPUT_NOT_FOUND: original file is not readable" };
    }
    const sampleId = command.sampleId;
    const sourceId = command.sourceId ?? "original";
    const input: ParserInputRef = {
      assetId: `original:${sourceId}:${sampleId}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: mediaTypeForPath(inputFile),
      path: inputFile,
      sampleId,
      sourceId,
    };
    try {
      const attempt = await parseOriginal(input, profile);
      if (attempt.error || !attempt.document) {
        return {
          exitCode: 1,
          code: "CAPABILITY_NOT_READY",
          message: `${attempt.error?.code ?? "PARSER_OUTPUT_INVALID"}: ${attempt.error?.message ?? "Parser did not return a valid document"}`,
          details: {
            attemptId: attempt.attemptId,
            inputHash: attempt.inputHash,
            outputRoot: attempt.outputRoot,
            outputRefs: attempt.outputRefs.length,
            parser: attempt.parser,
            errorsList: attempt.error ? [attempt.error.message] : ["document is missing"],
          },
        };
      }
      return {
        exitCode: 0,
        code: "READY",
        message: `Parser completed: ${attempt.document.blocks.length} blocks`,
        details: {
          attemptId: attempt.attemptId,
          inputHash: attempt.inputHash,
          outputRoot: attempt.outputRoot,
          outputRefs: attempt.outputRefs.length,
          parser: attempt.parser,
        },
      };
    } catch (error) {
      return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: error instanceof Error ? error.message : "Parser execution failed" };
    }
  }
  if (command.kind === "run") {
    if (!command.profile) return { exitCode: 2, code: "LIVE_PROFILE_REQUIRED", message: "run requires an explicit --profile" };
    const selectedProfilePath = await profilePath(options.cwd, command.profile);
    if (!selectedProfilePath) return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "LIVE_PROFILE_INCOMPLETE: selected Profile file was not found" };
    let profile;
    try {
      profile = parseRuntimeProfile(await loadJson(selectedProfilePath), dirname(selectedProfilePath));
    } catch (error) {
      return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: error instanceof Error ? error.message : "RUNTIME_PROFILE_INVALID" };
    }
    if (profile.mode !== "live" && profile.mode !== "controlled") return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "RUNTIME_PROFILE_INCOMPLETE: Profile must declare mode=live or mode=controlled" };
    if (!command.manifestPath || !command.candidatePath || !command.sampleId) {
      return { exitCode: 2, code: "INVALID_COMMAND", message: "run requires --manifest <frozen-root> --candidate <candidate.json> --sample <sampleId>" };
    }
    if (profile.mode === "live") {
      try {
        if (profile.authPath) await readFile(profile.authPath, "utf8");
        if (profile.modelsPath) await readFile(profile.modelsPath, "utf8");
      } catch {
        return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "LIVE_PROFILE_INCOMPLETE: auth Profile is not readable" };
      }
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
      if (!desktop) return { exitCode: 1, code: "CAPABILITY_NOT_READY", message: "DESKTOP_COMPOSITION_NOT_BUILT: run bun run typecheck before the Live entry" };
      const controlledProvider = profile.mode === "controlled"
        ? createControlledProvider([
          { toolCall: { name: "read_parsed_document", arguments: {} } },
          { toolCall: { name: "submit_invoice_candidate", arguments: { candidate: controlledCandidateForSample(command.sampleId) } } },
          { text: "controlled candidate accepted" },
        ])
        : undefined;
      const app = desktop.createApplication({
        dataRoot: outputRoot,
        agentRoot,
        manifest,
        candidate: candidateResult.data,
        profile,
        runtimeFactory: ({ identity, gateway, context, cwd, agentDir, budget }: { identity: PiRuntimeOptions["identity"]; gateway: NonNullable<PiRuntimeOptions["gateway"]>; context: { systemPrompt: string }; cwd: string; agentDir: string; budget: NonNullable<PiRuntimeOptions["budget"]> }) => {
          const runtimeOptions: PiRuntimeOptions = {
            identity,
            gateway,
            cwd,
            agentDir,
            budget,
            systemPrompt: context.systemPrompt,
            ...(profile.modelRef === undefined ? {} : { modelRef: profile.modelRef }),
            ...(profile.authPath === undefined ? {} : { authPath: profile.authPath }),
            ...(profile.modelsPath === undefined ? {} : { modelsPath: profile.modelsPath }),
            ...(controlledProvider === undefined ? {} : { provider: controlledProvider }),
          };
          return createPiRuntime(runtimeOptions);
        },
      });
      try {
        const identity = await app.start({ sampleId: command.sampleId, candidateId: candidateResult.data.candidateId, clientRequestId: `cli-${Date.now()}-${command.sampleId}` });
        const outcome = await app.wait(identity.runId);
        const snapshot = app.getJob({ jobId: identity.jobId });
        const modeLabel = profile.mode === "controlled" ? "controlled" : "live";
        return {
          exitCode: outcome.kind === "completed" && snapshot.candidates.length > 0 ? 0 : 1,
          code: outcome.kind === "completed" && snapshot.candidates.length > 0 ? "READY" : "CAPABILITY_NOT_READY",
          message: outcome.kind === "completed" && snapshot.candidates.length > 0 ? `${modeLabel} extraction completed` : `${modeLabel} extraction did not produce an accepted candidate: ${outcome.error ?? outcome.kind}`,
          details: { jobId: identity.jobId, runId: identity.runId, candidateId: candidateResult.data.candidateId, errorsList: outcome.error ? [outcome.error] : [] },
        };
      } finally {
        await app.close();
        controlledProvider?.close();
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
