import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourcePolicyRepository } from "../src/source-policy-repository.js";
import type { DataPaths } from "../src/filesystem-layout.js";

const temporaryRoots: string[] = [];

async function createRepository(frontmatter: string): Promise<SourcePolicyRepository> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-source-policy-"));
  temporaryRoots.push(root);
  const vault = path.join(root, "vault");
  const paths: DataPaths = {
    root,
    vault,
    staging: path.join(root, "staging"),
    webRaw: path.join(root, "web-raw"),
    derivedMineru: path.join(root, "derived", "mineru"),
    manifests: path.join(root, "manifests"),
    releases: path.join(root, "releases"),
    quarantine: path.join(root, "quarantine"),
    failures: path.join(root, "failures"),
    backups: path.join(root, "backups"),
  };
  const sourceDirectory = path.join(vault, "10_Sources");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(path.join(sourceDirectory, "SRC-000001.md"), `---\n${frontmatter}---\n`, "utf8");
  return new SourcePolicyRepository(paths);
}

const allowedPolicy = `source_id: SRC-000001
domain: example.com
source_type: public_web
access_strategy: public
source_policy: allowed
raw_retention: allowed
dataset_usage: allowed
synthetic: false
contains_synthetic_identifiers: false
enabled: true
`;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("SourcePolicyRepository", () => {
  it("loads an enabled, allowed public source policy from Obsidian frontmatter", async () => {
    const repository = await createRepository(allowedPolicy);

    await expect(repository.load("SRC-000001")).resolves.toEqual({
      sourceId: "SRC-000001",
      domain: "example.com",
      sourceType: "public_web",
      accessStrategy: "public",
      sourcePolicy: "allowed",
      rawRetention: "allowed",
      datasetUsage: "allowed",
      synthetic: false,
      containsSyntheticIdentifiers: false,
      enabled: true,
    });
  });

  it("rejects a disabled source policy", async () => {
    const repository = await createRepository(allowedPolicy.replace("enabled: true", "enabled: false"));

    await expect(repository.load("SRC-000001")).rejects.toThrow(/enabled/i);
  });

  it("rejects an authenticated source policy", async () => {
    const repository = await createRepository(allowedPolicy.replace("access_strategy: public", "access_strategy: authenticated"));

    await expect(repository.load("SRC-000001")).rejects.toThrow(/accessStrategy|public/i);
  });

  it("rejects a source policy that omits raw retention", async () => {
    const repository = await createRepository(allowedPolicy.replace("raw_retention: allowed\n", ""));

    await expect(repository.load("SRC-000001")).rejects.toThrow(/rawRetention/i);
  });
});
