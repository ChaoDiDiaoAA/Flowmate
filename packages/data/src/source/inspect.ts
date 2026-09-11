import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import {
  mediaTypeForPath,
  matchesPattern,
  sampleIdFromPath,
  type InspectionReport,
  type QuarantinedEntry,
  type SourceEntry,
  type SourceFile,
  type SourceIssue,
  type SourceIssueCode,
  type SourceRole,
  type SourceRoleMap,
} from "./role-map.js";

export type StableRead = {
  bytes: Buffer;
  sha256: string;
  size: number;
  mtimeMs: number;
};

export async function readStableFile(path: string, encoding: BufferEncoding = "utf8"): Promise<StableRead | SourceIssue> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      return issue("SOURCE_UNSTABLE", "source path is not a regular file", [path]);
    }
    const first = await readFile(path);
    const after = await lstat(path);
    const second = await readFile(path);
    const firstHash = createHash("sha256").update(first).digest("hex");
    const secondHash = createHash("sha256").update(second).digest("hex");
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || firstHash !== secondHash || first.length !== second.length) {
      return issue("SOURCE_UNSTABLE", "source file changed while it was being read", [path]);
    }
    // Keep the encoding parameter in the contract so callers can explicitly select it;
    // the returned bytes remain canonical for hashing and parsing.
    void encoding;
    return { bytes: second, sha256: secondHash, size: after.size, mtimeMs: after.mtimeMs };
  } catch {
    return issue("SOURCE_UNSTABLE", "source file could not be read consistently", [path]);
  }
}

function issue(code: SourceIssueCode, message: string, paths: string[], sampleId?: string): SourceIssue {
  return { code, message, paths, ...(sampleId ? { sampleId } : {}) };
}

type DiscoveredFile = { path: string; relativePath: string };

async function walk(root: string, current = root): Promise<DiscoveredFile[]> {
  const result: DiscoveredFile[] = [];
  for (const item of await readdir(current, { withFileTypes: true })) {
    const path = join(current, item.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      result.push(...await walk(root, path));
    } else if (stat.isFile()) {
      result.push({ path, relativePath: relative(root, path).split(sep).join("/") });
    }
  }
  return result;
}

function roleFor(relativePath: string, roleMap: SourceRoleMap): SourceRole | null {
  const roles: SourceRole[] = ["original", "parsed", "metadata", "labels"];
  for (const role of roles) {
    const selector = roleMap.roles[role];
    if (selector?.patterns.some((pattern) => matchesPattern(relativePath, pattern))) return role;
  }
  return null;
}

function sourceFile(role: SourceRole, file: DiscoveredFile, stable: StableRead): SourceFile {
  return {
    role,
    path: file.path,
    relativePath: file.relativePath,
    size: stable.size,
    mtimeMs: stable.mtimeMs,
    sha256: stable.sha256,
    mediaType: mediaTypeForPath(file.path),
  };
}

function parsedOriginalHash(bytes: Buffer, extension: string): string | null {
  if (extension !== ".json") return null;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as { original?: { sha256?: unknown } };
    return typeof value.original?.sha256 === "string" ? value.original.sha256 : null;
  } catch {
    return null;
  }
}

function pageIssue(metadata: SourceFile | undefined, parsedBytes: Buffer): boolean {
  if (!metadata) return false;
  // A source may provide an optional page manifest. It is quality metadata, not model input.
  try {
    const metadataValue = JSON.parse(readFileSync(metadata.path, "utf8")) as { pageCount?: unknown; pages?: unknown };
    if (typeof metadataValue.pageCount !== "number" || !Array.isArray(metadataValue.pages)) return false;
    return metadataValue.pages.length < metadataValue.pageCount;
  } catch {
    void parsedBytes;
    return false;
  }
}

export async function inspectSource(root: string, roleMap: SourceRoleMap): Promise<InspectionReport> {
  const files = await walk(root);
  const errors: SourceIssue[] = [];
  const grouped = new Map<string, Partial<Record<SourceRole, SourceFile[]>>>();
  for (const file of files) {
    const role = roleFor(file.relativePath, roleMap);
    if (!role) continue;
    const sampleId = sampleIdFromPath(file.relativePath, roleMap.sampleIdRegex);
    if (!sampleId) {
      errors.push(issue("SOURCE_PAIR_MISSING", "role-mapped file has no sample id", [file.relativePath]));
      continue;
    }
    const stable = await readStableFile(file.path, roleMap.encoding ?? "utf8");
    if ("code" in stable) {
      errors.push({ ...stable, sampleId, paths: [file.relativePath] });
      continue;
    }
    const value = sourceFile(role, file, stable);
    const roles = grouped.get(sampleId) ?? {};
    const values = roles[role] ?? [];
    values.push(value);
    roles[role] = values;
    grouped.set(sampleId, roles);
  }

  const validEntries: SourceEntry[] = [];
  const quarantinedEntries: QuarantinedEntry[] = [];
  for (const sampleId of [...grouped.keys()].sort()) {
    const roles = grouped.get(sampleId)!;
    const original = roles.original ?? [];
    const parsed = roles.parsed ?? [];
    const metadata = roles.metadata ?? [];
    const labels = roles.labels ?? [];
    const paths = [...original, ...parsed, ...metadata, ...labels].map((file) => file.relativePath);
    let failure: SourceIssue | null = null;
    if (original.length !== 1 || parsed.length !== 1) {
      failure = issue("SOURCE_PAIR_MISSING", "each sample must have exactly one original and one parsed file", paths, sampleId);
    } else if (original[0]!.size === 0 || parsed[0]!.size === 0) {
      failure = issue("EMPTY_CONTENT", "original and parsed files must not be empty", paths, sampleId);
    } else if (![".json", ".md", ".markdown"].includes(extname(parsed[0]!.path).toLowerCase())) {
      failure = issue("UNSUPPORTED_PARSE_FORMAT", "parsed file format is not supported", paths, sampleId);
    } else {
      const parsedRead = await readStableFile(parsed[0]!.path, roleMap.encoding ?? "utf8");
      if ("code" in parsedRead) {
        failure = { ...parsedRead, sampleId, paths };
      } else if (parsedOriginalHash(parsedRead.bytes, extname(parsed[0]!.path).toLowerCase()) && parsedOriginalHash(parsedRead.bytes, extname(parsed[0]!.path).toLowerCase()) !== original[0]!.sha256) {
        failure = issue("HASH_MISMATCH", "parsed metadata does not match the original digest", paths, sampleId);
      } else if (pageIssue(metadata[0], parsedRead.bytes)) {
        failure = issue("PAGE_MISSING", "page manifest contains fewer pages than declared", paths, sampleId);
      }
    }
    if (failure) {
      quarantinedEntries.push({ sampleId, issue: failure });
      continue;
    }
    validEntries.push({
      sampleId,
      sourceId: roleMap.sourceId,
      parserVersion: roleMap.parserVersion,
      original: original[0]!,
      parsed: parsed[0]!,
      ...(metadata[0] ? { metadata: metadata[0] } : {}),
      ...(labels[0] ? { labels: labels[0] } : {}),
    });
  }
  return { root, sourceId: roleMap.sourceId, validEntries, quarantinedEntries, errors };
}
