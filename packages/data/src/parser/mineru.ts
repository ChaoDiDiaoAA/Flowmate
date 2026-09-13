import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { AssetRef, ParsedDocument } from "@flowmate/contracts";
import { ParsedDocumentSchema } from "@flowmate/contracts";
import { mapParserOutput } from "./output-map.js";

export type ParserInputRef = AssetRef & {
  path: string;
  sampleId: string;
  sourceId: string;
};

export type ParserProfile = {
  executable: string;
  parserName: string;
  parserVersion: string;
  outputRoot: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  modelCachePath?: string;
  allowedInputExtensions?: string[];
  timeoutMs: number;
};

const ParserProfileFileSchema = z.object({
  profileId: z.string().min(1),
  mode: z.enum(["controlled", "live"]),
  environment: z.enum(["local-test", "production"]),
  available: z.boolean(),
  executable: z.string().min(1),
  parserName: z.string().min(1),
  parserVersion: z.string().min(1),
  outputRoot: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  modelCachePath: z.string().min(1).optional(),
  allowedInputExtensions: z.array(z.string().regex(/^\.?[a-z0-9]+$/i)).min(1).optional(),
  timeoutMs: z.number().int().positive(),
}).strict();

export type ParserProfileFile = z.infer<typeof ParserProfileFileSchema>;

function unwrapParserProfile(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "parser" in value) {
    return (value as { parser?: unknown }).parser;
  }
  return value;
}

function resolveExecutable(value: string, profileDirectory: string): string {
  // Bare commands such as `mineru` must be resolved through PATH by spawn;
  // only an explicit file path is anchored to the Profile directory.
  return isAbsolute(value) || value.includes("/") || value.includes("\\")
    ? (isAbsolute(value) ? value : resolve(profileDirectory, value))
    : value;
}

/** Parse the on-disk Parser Profile, including the unified config's `parser` section. */
export function parseParserProfile(value: unknown, profileDirectory: string): ParserProfile & { profileId: string; mode: "controlled" | "live"; environment: "local-test" | "production"; available: boolean } {
  const parsed = ParserProfileFileSchema.safeParse(unwrapParserProfile(value));
  if (!parsed.success) throw new Error("PARSER_PROFILE_INVALID");
  const record = parsed.data;
  if (record.mode === "live" && record.environment !== "local-test") {
    throw new Error("PARSER_PROFILE_INVALID: live Parser Profiles must use local-test");
  }
  if (record.mode === "live" && !record.available) {
    throw new Error("PARSER_PROFILE_INCOMPLETE: Parser Profile is unavailable");
  }
  return {
    profileId: record.profileId,
    mode: record.mode,
    environment: record.environment,
    available: record.available,
    executable: resolveExecutable(record.executable, profileDirectory),
    parserName: record.parserName,
    parserVersion: record.parserVersion,
    outputRoot: isAbsolute(record.outputRoot) ? record.outputRoot : resolve(profileDirectory, record.outputRoot),
    ...(record.args === undefined ? {} : { args: [...record.args] }),
    ...(record.cwd === undefined ? {} : { cwd: isAbsolute(record.cwd) ? record.cwd : resolve(profileDirectory, record.cwd) }),
    ...(record.env === undefined ? {} : { env: { ...record.env } }),
    ...(record.modelCachePath === undefined ? {} : { modelCachePath: isAbsolute(record.modelCachePath) ? record.modelCachePath : resolve(profileDirectory, record.modelCachePath) }),
    ...(record.allowedInputExtensions === undefined ? {} : { allowedInputExtensions: record.allowedInputExtensions.map((item) => item.replace(/^\./, "").toLowerCase()) }),
    timeoutMs: record.timeoutMs,
  };
}

export type ParseAttempt = {
  attemptId: string;
  inputHash: string;
  parser: { name: string; version: string; configHash: string };
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputRoot: string;
  outputRefs: AssetRef[];
  document: ParsedDocument | null;
  error: { code: string; message: string; retryable: boolean } | null;
};

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function configHash(profile: ParserProfile): string {
  return digest(JSON.stringify({
    executable: resolve(profile.executable),
    parserName: profile.parserName,
    parserVersion: profile.parserVersion,
    args: profile.args ?? [],
    modelCachePath: profile.modelCachePath ? profile.modelCachePath.replaceAll("\\", "/") : null,
    allowedInputExtensions: profile.allowedInputExtensions ?? [],
    timeoutMs: profile.timeoutMs,
  }));
}

function makeId(): string {
  return "parse-" + digest(new Date().toISOString() + Math.random()).slice(0, 24);
}

async function readStable(path: string): Promise<{ bytes: Buffer; hash: string } | { error: string }> {
  const first = await readFile(path);
  const firstStat = await stat(path);
  const second = await readFile(path);
  const secondStat = await stat(path);
  if (firstStat.size !== secondStat.size || firstStat.mtimeMs !== secondStat.mtimeMs || !first.equals(second)) return { error: "input changed during read" };
  return { bytes: first, hash: digest(first) };
}

function appendBounded(current: string, chunk: Buffer, maxBytes = 128 * 1024): string {
  const next = current + chunk.toString("utf8");
  return Buffer.byteLength(next, "utf8") <= maxBytes ? next : next.slice(0, maxBytes) + "\n[truncated]";
}

async function findOutput(root: string): Promise<string | null> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findOutput(path);
      if (nested) files.push(nested);
    } else if (entry.isFile() && [".json", ".md", ".markdown"].includes(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }
  files.sort((left, right) => {
    const rank = (path: string) => path.toLowerCase().includes("content_list") ? 0 : path.toLowerCase().includes("content") ? 1 : 2;
    return rank(left) - rank(right) || left.localeCompare(right);
  });
  return files[0] ?? null;
}

export async function parseOriginal(input: ParserInputRef, profile: ParserProfile, signal?: AbortSignal): Promise<ParseAttempt> {
  const attemptId = makeId();
  const startedAt = new Date().toISOString();
  const outputRoot = resolve(profile.outputRoot, attemptId);
  const base: ParseAttempt = {
    attemptId,
    inputHash: input.sha256,
    parser: { name: profile.parserName, version: profile.parserVersion, configHash: configHash(profile) },
    startedAt,
    endedAt: startedAt,
    exitCode: null,
    stdout: "",
    stderr: "",
    outputRoot,
    outputRefs: [],
    document: null,
    error: null,
  };
  const extension = extname(input.path).replace(/^\./, "").toLowerCase();
  if (profile.allowedInputExtensions && !profile.allowedInputExtensions.includes(extension)) {
    return { ...base, endedAt: new Date().toISOString(), error: { code: "PARSER_INPUT_FORMAT_UNSUPPORTED", message: `Input extension .${extension || "(none)"} is not allowed by the Parser Profile`, retryable: false } };
  }
  if (profile.modelCachePath) {
    try {
      const cacheStat = await stat(profile.modelCachePath);
      if (!cacheStat.isDirectory()) throw new Error("model cache is not a directory");
    } catch {
      return { ...base, endedAt: new Date().toISOString(), error: { code: "PARSER_MODEL_CACHE_UNAVAILABLE", message: "Parser model cache is not readable", retryable: false } };
    }
  }
  const inputRead = await readStable(input.path);
  if ("error" in inputRead) return { ...base, endedAt: new Date().toISOString(), error: { code: "PARSER_INPUT_UNSTABLE", message: inputRead.error, retryable: true } };
  if (inputRead.hash !== input.sha256) return { ...base, inputHash: inputRead.hash, endedAt: new Date().toISOString(), error: { code: "PARSER_INPUT_HASH_MISMATCH", message: "input digest differs from the approved AssetRef", retryable: false } };

  const { mkdir } = await import("node:fs/promises");
  await mkdir(outputRoot, { recursive: true });
  const args = [...(profile.args ?? []), "-p", input.path, "-o", outputRoot];
  const child = spawn(profile.executable, args, {
    cwd: profile.cwd ?? outputRoot,
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...(profile.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let killed = false;
  let timedOut = false;
  let spawnError: string | undefined;
  const terminate = () => {
    if (killed) return;
    killed = true;
    try { child.kill(); } catch { /* process may have exited */ }
  };
  const timeout = setTimeout(() => { timedOut = true; terminate(); }, profile.timeoutMs);
  const abort = () => terminate();
  if (signal?.aborted) terminate();
  else signal?.addEventListener("abort", abort, { once: true });
  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.stdout.on("data", (chunk: Buffer) => { base.stdout = appendBounded(base.stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { base.stderr = appendBounded(base.stderr, chunk); });
    child.once("error", (error) => { spawnError = error.message; base.stderr = appendBounded(base.stderr, Buffer.from(error.message)); resolveExit(null); });
    child.once("close", (code) => resolveExit(code));
  });
  clearTimeout(timeout);
  signal?.removeEventListener("abort", abort);
  const endedAt = new Date().toISOString();
  if (timedOut) return { ...base, endedAt, exitCode, error: { code: "PARSER_TIMEOUT", message: "Parser process exceeded its deadline", retryable: true } };
  if (signal?.aborted || killed) return { ...base, endedAt, exitCode, error: { code: "PARSER_CANCELLED", message: "Parser process was cancelled", retryable: true } };
  if (spawnError) return { ...base, endedAt, exitCode, error: { code: "PARSER_EXECUTABLE_UNAVAILABLE", message: "Parser executable could not be started", retryable: false } };
  if (exitCode !== 0) return { ...base, endedAt, exitCode, error: { code: "PARSER_EXIT_NONZERO", message: "Parser exited with code " + String(exitCode), retryable: true } };
  const outputPath = await findOutput(outputRoot);
  if (!outputPath) return { ...base, endedAt, exitCode, error: { code: "PARSER_OUTPUT_INVALID", message: "Parser returned no JSON/Markdown output", retryable: false } };
  const output = await readStable(outputPath);
  if ("error" in output) return { ...base, endedAt, exitCode, error: { code: "PARSER_OUTPUT_UNSTABLE", message: output.error, retryable: true } };
  try {
    const document = await mapParserOutput({ input, outputPath, outputBytes: output.bytes, parser: { name: profile.parserName, version: profile.parserVersion } });
    const validated = ParsedDocumentSchema.parse(document);
    const outputRef: AssetRef = { assetId: "parser-output:" + attemptId, sha256: output.hash, mediaType: outputPath.toLowerCase().endsWith(".json") ? "application/json" : "text/plain" };
    return { ...base, endedAt, exitCode, outputRefs: [outputRef], document: validated, error: null };
  } catch (error) {
    return { ...base, endedAt, exitCode, error: { code: "PARSER_OUTPUT_INVALID", message: error instanceof Error ? error.message : "Parser output does not satisfy the contract", retryable: false } };
  }
}
