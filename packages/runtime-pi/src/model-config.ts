import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";

/**
 * A deliberately small, non-secret projection of the model Pi actually
 * resolved. It is evidence, not a second model configuration format. Headers,
 * auth objects and URL query fragments are intentionally excluded.
 */
export type PiModelConfigSnapshot = {
  provider: string;
  modelId: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  samplingParams?: Record<string, unknown>;
  compat?: Record<string, unknown>;
  session: {
    autoCompactionEnabled: false;
    autoRetryEnabled: false;
  };
};

function redactBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // A malformed URL is still represented without query/fragment material.
    return value.replace(/[?#].*$/, "");
  }
}

const secretKey = /(?:api[-_]?key|authorization|headers?|auth|token|password|secret|credential|private[-_]?key)/i;

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 4 || secretKey.test(key)) return undefined;
  if (typeof value === "string") return /url/i.test(key) ? redactBaseUrl(value) : value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key, depth + 1)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([childKey, childValue]) => {
      const sanitized = sanitizeValue(childValue, childKey, depth + 1);
      return sanitized === undefined ? [] : [[childKey, sanitized] as const];
    }));
}

function copyRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return sanitizeValue(value) as Record<string, unknown>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function snapshotPiModel(model: Model<any>): PiModelConfigSnapshot {
  const snapshot: PiModelConfigSnapshot = {
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    api: model.api,
    baseUrl: redactBaseUrl(model.baseUrl),
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    session: { autoCompactionEnabled: false, autoRetryEnabled: false },
  };
  const thinkingLevelMap = copyRecord(model.thinkingLevelMap);
  if (thinkingLevelMap) snapshot.thinkingLevelMap = thinkingLevelMap as Record<string, string | null>;
  const samplingParams = copyRecord(model.samplingParams);
  if (samplingParams) snapshot.samplingParams = samplingParams;
  const compat = copyRecord(model.compat);
  if (compat) snapshot.compat = compat;
  return snapshot;
}

export function hashPiModelConfig(snapshot: PiModelConfigSnapshot): string {
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}

export function modelConfigEvidence(model: Model<any>): { snapshot: PiModelConfigSnapshot; hash: string } {
  const snapshot = snapshotPiModel(model);
  return { snapshot, hash: hashPiModelConfig(snapshot) };
}
