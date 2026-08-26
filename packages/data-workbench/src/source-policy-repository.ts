import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { DataPaths } from "./filesystem-layout.js";
import { sourcePolicySchema } from "./schemas.js";
import type { SourcePolicy } from "./types.js";

export class SourcePolicyRepository {
  public constructor(private readonly paths: DataPaths) {}

  public async load(sourceId: string): Promise<SourcePolicy> {
    const sourcePath = path.join(this.paths.vault, "10_Sources", `${sourceId}.md`);
    const frontmatter = extractFrontmatter(await readFile(sourcePath, "utf8"), sourcePath);
    const value = sourcePolicySchema.safeParse({
      sourceId: frontmatter.source_id,
      domain: frontmatter.domain,
      sourceType: frontmatter.source_type,
      accessStrategy: frontmatter.access_strategy,
      sourcePolicy: frontmatter.source_policy,
      rawRetention: frontmatter.raw_retention,
      datasetUsage: frontmatter.dataset_usage,
      synthetic: frontmatter.synthetic,
      containsSyntheticIdentifiers: frontmatter.contains_synthetic_identifiers,
      enabled: frontmatter.enabled,
    });
    if (!value.success) {
      const fields = value.error.issues.map((issue) => issue.path.join(".")).join(", ");
      throw new Error(`Invalid source policy frontmatter (${fields}): ${sourcePath}`);
    }
    if (value.data.sourceId !== sourceId) {
      throw new Error(`Source policy ID does not match its filename: ${sourcePath}`);
    }
    if (!value.data.enabled) {
      throw new Error(`Source policy is not enabled: ${sourceId}`);
    }
    if (value.data.sourcePolicy !== "allowed") {
      throw new Error(`Source policy is not allowed: ${sourceId}`);
    }
    return value.data;
  }
}

function extractFrontmatter(markdown: string, sourcePath: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) {
    throw new Error(`Source policy is missing YAML frontmatter: ${sourcePath}`);
  }
  const rawFrontmatter = match[1];
  if (rawFrontmatter === undefined) {
    throw new Error(`Source policy is missing YAML frontmatter: ${sourcePath}`);
  }
  const parsed: unknown = parse(rawFrontmatter);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Source policy frontmatter must be an object: ${sourcePath}`);
  }
  return parsed as Record<string, unknown>;
}
