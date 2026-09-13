import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TestCandidateSchema } from "@flowmate/contracts";
import { createProjection, loadFrozenDataset } from "@flowmate/data";
import { loadDotEnv, parseRuntimeProfile, preflight } from "@flowmate/core";
import { createApplication, createPiRuntimeFactory, type Application, type RuntimeFactory } from "./composition.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DESKTOP_CONFIG_INVALID");
  return value as Record<string, unknown>;
}

function required(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`DESKTOP_CONFIG_INVALID: ${key}`);
  return value;
}

/** Configuration contains paths only. Credentials never cross the preload boundary.
 * An injected runtime factory is an explicit integration-test seam, not a profile fallback.
 */
export async function loadDesktopApplication(configFile: string, injectedFactory?: RuntimeFactory): Promise<Application> {
  const base = dirname(resolve(configFile));
  await loadDotEnv(resolve(base, ".env"), resolve(base, "..", ".env"), resolve(process.cwd(), ".env"));
  const config = object(JSON.parse(await readFile(configFile, "utf8")));
  const path = (key: string) => resolve(base, required(config, key));
  const inlineProfile = "profile" in config;
  const profileFile = inlineProfile ? undefined : path("profilePath");
  const profile = parseRuntimeProfile(
    inlineProfile ? config.profile : JSON.parse(await readFile(profileFile!, "utf8")),
    inlineProfile ? base : dirname(profileFile!),
  );
  if (profile.mode !== "live" && !(injectedFactory && profile.mode === "controlled")) throw new Error("DESKTOP_LIVE_PROFILE_REQUIRED");
  if (profile.environment !== "local-test" || profile.available !== true) throw new Error("PROFILE_UNAVAILABLE");
  if (profile.mode === "live") {
    if (profile.authPath !== undefined) {
      await readFile(profile.authPath, "utf8");
    }
    if (profile.modelsPath !== undefined) {
      await readFile(profile.modelsPath, "utf8");
    }
  }
  const candidate = TestCandidateSchema.parse(JSON.parse(await readFile(path("candidatePath"), "utf8")));
  const manifest = await loadFrozenDataset(path("manifestRoot"));
  const allowedCases = manifest.cases.filter((item) => !profile.allowedSampleIds || profile.allowedSampleIds.includes(item.sampleId));
  if (!allowedCases.length) throw new Error("DESKTOP_NO_ALLOWED_SAMPLES");
  for (const item of allowedCases) {
    const projection = await createProjection(manifest, item.sampleId);
    const check = preflight(candidate, { sampleId: item.sampleId, datasetVersion: manifest.datasetVersion, inputHash: projection.inputHash, allowed: true }, profile);
    if (!check.eligible) throw new Error(check.error.code);
  }
  const dataRoot = path("dataRoot");
  return createApplication({
    dataRoot, agentRoot: resolve(dataRoot, "agent"), manifest, candidate, profile,
    runtimeFactory: injectedFactory ?? createPiRuntimeFactory({
      modelRef: profile.modelRef!,
      ...(profile.authPath === undefined ? {} : { authPath: profile.authPath }),
      ...(profile.modelsPath === undefined ? {} : { modelsPath: profile.modelsPath }),
    }),
  });
}
