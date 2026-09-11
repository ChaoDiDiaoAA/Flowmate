import { basename, extname } from "node:path";

export type SourceRole = "original" | "parsed" | "metadata" | "labels";

export type RoleSelector = {
  patterns: string[];
};

export type SourceRoleMap = {
  sourceId: string;
  parserVersion: string;
  encoding?: BufferEncoding;
  /** A regex over slash-separated relative paths. Use a named `sampleId` group or the first capture group. */
  sampleIdRegex?: string;
  roles: {
    original: RoleSelector;
    parsed: RoleSelector;
    metadata?: RoleSelector;
    labels?: RoleSelector;
  };
};

export type SourceIssueCode =
  | "SOURCE_UNSTABLE"
  | "EMPTY_CONTENT"
  | "SOURCE_PAIR_MISSING"
  | "PAGE_MISSING"
  | "UNSUPPORTED_PARSE_FORMAT"
  | "HASH_MISMATCH"
  | "SOURCE_ROLE_DUPLICATE"
  | "INVALID_PARSE_JSON"
  | "INVALID_PARSED_DOCUMENT"
  | "SAMPLE_ID_MISMATCH"
  | "SOURCE_ID_MISMATCH";

export type SourceIssue = {
  code: SourceIssueCode;
  message: string;
  sampleId?: string;
  paths: string[];
};

export type SourceFile = {
  role: SourceRole;
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  mediaType: string;
};

export type SourceEntry = {
  sampleId: string;
  sourceId: string;
  parserVersion: string;
  original: SourceFile;
  parsed: SourceFile;
  metadata?: SourceFile;
  labels?: SourceFile;
};

export type QuarantinedEntry = {
  sampleId: string;
  issue: SourceIssue;
};

export type InspectionReport = {
  root: string;
  sourceId: string;
  validEntries: SourceEntry[];
  quarantinedEntries: QuarantinedEntry[];
  errors: SourceIssue[];
};

export function expandPattern(pattern: string): string[] {
  const match = pattern.match(/^(.*)\{([^{}]+)\}(.*)$/);
  if (!match) return [pattern];
  const [, before = "", alternatives = "", after = ""] = match;
  return alternatives.split(",").flatMap((alternative) => expandPattern(`${before}${alternative}${after}`));
}

export function matchesPattern(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  for (const expanded of expandPattern(pattern)) {
    let expression = "^";
    for (let index = 0; index < expanded.length; index += 1) {
      const character = expanded[index];
      if (character === "*" && expanded[index + 1] === "*") {
        if (expanded[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else if (character === "*") {
        expression += "[^/]*";
      } else if (character === "?") {
        expression += "[^/]";
      } else {
        expression += character?.replace(/[\\^$+.()|[\]{}]/g, "\\$&") ?? "";
      }
    }
    if (new RegExp(`${expression}$`).test(normalized)) return true;
  }
  return false;
}

export function sampleIdFromPath(relativePath: string, sampleIdRegex?: string): string | null {
  if (sampleIdRegex) {
    let match: RegExpExecArray | null;
    try {
      match = new RegExp(sampleIdRegex).exec(relativePath.replaceAll("\\", "/"));
    } catch {
      return null;
    }
    if (!match) return null;
    const named = match.groups?.sampleId;
    return named ?? match[1] ?? null;
  }
  const value = basename(relativePath, extname(relativePath));
  return value.length > 0 ? value : null;
}

export function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".pdf": return "application/pdf";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".md":
    case ".markdown":
    case ".txt": return "text/plain";
    case ".json": return "application/json";
    default: return "application/octet-stream";
  }
}
