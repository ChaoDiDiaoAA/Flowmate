import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TestCandidateSchema } from "@flowmate/contracts";
import { assertAssetManifest, freezeAssets, importAuthoring } from "./assets.js";
import { planEvalRun } from "./runner.js";
import { validateCatalog } from "./schema.js";

export type EvalCliResult = {
  exitCode: 0 | 1 | 2;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function pathFrom(cwd: string, value: string | null): string | null {
  return value === null ? null : resolve(cwd, value);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function invalid(message: string): EvalCliResult {
  return { exitCode: 2, code: "INVALID_COMMAND", message };
}

function unreadable(code: string, error: unknown): EvalCliResult {
  return { exitCode: 1, code, message: error instanceof Error ? error.message : "evaluation input could not be read" };
}

async function checkAssets(cwd: string, args: string[]): Promise<EvalCliResult> {
  const file = pathFrom(cwd, valueAfter(args, "--catalog") ?? (args[1]?.startsWith("--") ? null : args[1] ?? null))
    ?? resolve(cwd, "agent-eval/config/p0.catalog.json");
  try {
    const catalog = await readJson(file);
    const check = validateCatalog(catalog);
    const pendingAssets = check.ok && catalog && typeof catalog === "object" && "items" in catalog && Array.isArray((catalog as { items?: unknown }).items)
      ? (catalog as { items: Array<{ caseId?: string; inputRef?: { sha256?: string | null }; goldRef?: { sha256?: string | null } }> }).items
        .filter((item) => item.inputRef?.sha256 === null || item.goldRef?.sha256 === null)
        .map((item) => item.caseId ?? "unknown")
      : [];
    return {
      exitCode: check.ok ? 0 : 1,
      code: check.ok ? "READY" : "ASSET_CATALOG_INVALID",
      message: check.ok ? "evaluation catalog is structurally valid" : "evaluation catalog is invalid",
      details: { ...check, pendingAssets },
    };
  } catch (error) {
    return unreadable("ASSET_CATALOG_UNREADABLE", error);
  }
}

async function freeze(cwd: string, args: string[]): Promise<EvalCliResult> {
  const input = pathFrom(cwd, valueAfter(args, "--input"));
  const output = pathFrom(cwd, valueAfter(args, "--output"));
  if (!input || !output) return invalid("freeze requires --input <authoring-directory> and --output <manifest.json>");
  const assetVersion = valueAfter(args, "--version") ?? "p0-seed-1";
  try {
    const batch = await importAuthoring(input);
    const manifest = freezeAssets(batch, assetVersion);
    await writeJson(output, manifest);
    return {
      exitCode: 0,
      code: "READY",
      message: `evaluation assets frozen: ${manifest.cases.length} cases`,
      details: { assetVersion: manifest.assetVersion, cases: manifest.cases.length, output },
    };
  } catch (error) {
    return unreadable("ASSET_FREEZE_FAILED", error);
  }
}

async function checkReadiness(cwd: string, args: string[]): Promise<EvalCliResult> {
  const catalogPath = pathFrom(cwd, valueAfter(args, "--catalog"));
  const manifestPath = pathFrom(cwd, valueAfter(args, "--manifest"));
  const candidatePath = pathFrom(cwd, valueAfter(args, "--candidate"));
  const live = args.includes("--live");
  const profilePath = pathFrom(cwd, valueAfter(args, "--profile"));
  if (!manifestPath || !candidatePath) return invalid("check-readiness requires --manifest <asset-manifest.json> and --candidate <candidate.json>");
  if (live && !profilePath) return invalid("check-readiness --live requires --profile <profile.json>");
  try {
    const catalogValue = catalogPath === null ? null : await readJson(catalogPath);
    if (catalogValue !== null) {
      const catalogCheck = validateCatalog(catalogValue);
      if (!catalogCheck.ok) return { exitCode: 1, code: "ASSET_CATALOG_INVALID", message: "evaluation catalog is invalid", details: catalogCheck };
    }
    const manifest = assertAssetManifest(await readJson(manifestPath));
    const candidate = TestCandidateSchema.parse(await readJson(candidatePath));
    const pendingCatalogItems = catalogValue && typeof catalogValue === "object" && "items" in catalogValue && Array.isArray((catalogValue as { items?: unknown }).items)
      ? (catalogValue as { items: Array<{ caseId?: string; inputRef?: { sha256?: string | null }; goldRef?: { sha256?: string | null } }> }).items
        .filter((item) => item.inputRef?.sha256 === null || item.goldRef?.sha256 === null)
        .map((item) => item.caseId ?? "unknown")
      : [];
    if (pendingCatalogItems.length > 0) {
      return { exitCode: 1, code: "ASSETS_PENDING", message: "evaluation assets are structurally valid but input or Gold references are still pending", details: { pendingCases: pendingCatalogItems, manifestVersion: manifest.assetVersion, candidateId: candidate.candidateId } };
    }
    type ProfileProbe = { mode?: unknown; available?: unknown; modelRef?: { provider?: unknown; modelId?: unknown } };
    if (profilePath) {
      const value = await readJson(profilePath);
      if (!value || typeof value !== "object" || Array.isArray(value)) return { exitCode: 1, code: "PROFILE_INVALID", message: "evaluation profile must contain a JSON object" };
      const loadedProfile = value as ProfileProbe;
      if (live && (loadedProfile.mode !== "live" || loadedProfile.available !== true || !loadedProfile.modelRef || typeof loadedProfile.modelRef.provider !== "string" || typeof loadedProfile.modelRef.modelId !== "string")) {
        return { exitCode: 1, code: "LIVE_PROFILE_INCOMPLETE", message: "Live Profile is unavailable or does not declare a model reference" };
      }
      if (loadedProfile.modelRef && (loadedProfile.modelRef.provider !== candidate.modelRef.provider || loadedProfile.modelRef.modelId !== candidate.modelRef.modelId)) {
        return { exitCode: 1, code: "MODEL_REF_MISMATCH", message: "candidate model reference differs from the selected evaluation profile" };
      }
    }
    return { exitCode: 0, code: "READY", message: live ? "evaluation is ready for an explicit Live run" : "evaluation is ready for an offline run", details: { assetVersion: manifest.assetVersion, cases: manifest.cases.length, candidateId: candidate.candidateId, modelRef: candidate.modelRef, live } };
  } catch (error) {
    return unreadable("EVALUATION_READINESS_FAILED", error);
  }
}

async function plan(cwd: string, args: string[]): Promise<EvalCliResult> {
  const manifestPath = pathFrom(cwd, valueAfter(args, "--manifest"));
  const candidateId = valueAfter(args, "--candidate");
  const output = pathFrom(cwd, valueAfter(args, "--output"));
  if (!manifestPath || !candidateId) return invalid("plan requires --manifest <asset-manifest.json> and --candidate <candidateId>");
  const attemptsValue = valueAfter(args, "--attempts");
  const attempts = attemptsValue === null ? undefined : Number.parseInt(attemptsValue, 10);
  const maxWallTimeValue = valueAfter(args, "--max-wall-time-ms");
  const maxWallTimeMs = maxWallTimeValue === null ? undefined : Number.parseInt(maxWallTimeValue, 10);
  try {
    const manifest = assertAssetManifest(await readJson(manifestPath));
    const profile: Parameters<typeof planEvalRun>[1] = { candidateId, live: args.includes("--live") };
    const evalRunId = valueAfter(args, "--eval-run");
    if (evalRunId !== null) profile.evalRunId = evalRunId;
    if (attempts !== undefined) profile.attempts = attempts;
    if (maxWallTimeMs !== undefined) profile.maxWallTimeMs = maxWallTimeMs;
    const evalPlan = planEvalRun(manifest, profile);
    if (output) await writeJson(output, evalPlan);
    return { exitCode: 0, code: "READY", message: `evaluation plan created: ${evalPlan.cases.length} cases`, details: { evalRunId: evalPlan.evalRunId, cases: evalPlan.cases.length, attempts: evalPlan.cases[0]?.attempts ?? 0, output: output ?? null } };
  } catch (error) {
    return unreadable("EVALUATION_PLAN_FAILED", error);
  }
}

export async function runEvalCli(args: string[], cwd = process.cwd()): Promise<EvalCliResult> {
  const command = args[0] ?? "check-assets";
  if (command === "check-assets") return checkAssets(cwd, args);
  if (command === "freeze") return freeze(cwd, args);
  if (command === "check-readiness") return checkReadiness(cwd, args);
  if (command === "plan") return plan(cwd, args);
  return { exitCode: 2, code: "CAPABILITY_NOT_READY", message: `evaluation command is not implemented: ${command}` };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = await runEvalCli(process.argv.slice(2));
  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode;
}
