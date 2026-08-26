import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataPaths } from "../src/filesystem-layout.js";
import type { IdAllocator } from "../src/ids.js";
import { RawArtifactStore } from "../src/raw-artifact-store.js";

const temporaryRoots: string[] = [];

class FixedIdAllocator implements IdAllocator {
  private nextArtifact = 1;

  async next(kind: "source" | "artifact" | "knowledge" | "sample" | "business" | "acquisition"): Promise<string> {
    if (kind !== "artifact") {
      throw new Error(`Unexpected ID kind: ${kind}`);
    }
    const id = `ART-${this.nextArtifact.toString().padStart(6, "0")}`;
    this.nextArtifact += 1;
    return id;
  }
}

async function createStore(): Promise<{ paths: DataPaths; store: RawArtifactStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-raw-store-"));
  temporaryRoots.push(root);
  const paths: DataPaths = {
    root,
    vault: path.join(root, "vault"),
    staging: path.join(root, "staging"),
    webRaw: path.join(root, "web-raw"),
    derivedMineru: path.join(root, "derived", "mineru"),
    manifests: path.join(root, "manifests"),
    releases: path.join(root, "releases"),
    quarantine: path.join(root, "quarantine"),
    failures: path.join(root, "failures"),
    backups: path.join(root, "backups"),
  };
  await mkdir(path.join(paths.staging, "ACQ-20260826-0001"), { recursive: true });
  await mkdir(path.join(paths.staging, "ACQ-20260826-0002"), { recursive: true });
  return { paths, store: new RawArtifactStore(paths, new FixedIdAllocator()) };
}

async function stage(paths: DataPaths, jobId: string, name: string, contents: string): Promise<string> {
  const file = path.join(paths.staging, jobId, name);
  await writeFile(file, contents, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RawArtifactStore", () => {
  it("hashes a staged file and promotes it into an immutable web-raw artifact", async () => {
    const { paths, store } = await createStore();
    const stagedFile = await stage(paths, "ACQ-20260826-0001", "invoice.txt", "raw invoice\n");

    const artifact = await store.ingest({
      sourceId: "SRC-000001",
      jobId: "ACQ-20260826-0001",
      canonicalUrl: "https://example.com/public/invoice.txt?signature=secret",
      stagedFile,
      mimeType: "text/plain",
      retentionStatus: "retained",
    });

    const rawFile = path.join(paths.webRaw, "example.com", "ACQ-20260826-0001", "ART-000001", "files", "invoice.txt");
    expect(artifact).toMatchObject({
      artifactId: "ART-000001",
      sourceIds: ["SRC-000001"],
      acquisitionJobIds: ["ACQ-20260826-0001"],
      canonicalUrl: "https://example.com/public/invoice.txt",
      rawRef: rawFile,
      rawSha256: createHash("sha256").update("raw invoice\n").digest("hex"),
      mimeType: "text/plain",
      retentionStatus: "retained",
    });
    await expect(readFile(rawFile, "utf8")).resolves.toBe("raw invoice\n");
    await expect(readFile(stagedFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(path.dirname(path.dirname(rawFile)), "source.json"), "utf8"))
      .resolves.not.toContain("signature=secret");
    await expect(readFile(path.join(path.dirname(path.dirname(rawFile)), "checksums.sha256"), "utf8"))
      .resolves.toContain(artifact.rawSha256);
  });

  it("reuses one immutable binary and records every source and job that supplied it", async () => {
    const { paths, store } = await createStore();
    const first = await store.ingest({
      sourceId: "SRC-000001",
      jobId: "ACQ-20260826-0001",
      canonicalUrl: "https://example.com/a.txt",
      stagedFile: await stage(paths, "ACQ-20260826-0001", "a.txt", "same bytes"),
      mimeType: "text/plain",
      retentionStatus: "retained",
    });
    const secondStagedFile = await stage(paths, "ACQ-20260826-0002", "a.txt", "same bytes");

    const second = await store.ingest({
      sourceId: "SRC-000002",
      jobId: "ACQ-20260826-0002",
      canonicalUrl: "https://example.com/a.txt",
      stagedFile: secondStagedFile,
      mimeType: "text/plain",
      retentionStatus: "retained",
    });

    expect(second.artifactId).toBe(first.artifactId);
    expect(second.sourceIds).toEqual(["SRC-000001", "SRC-000002"]);
    expect(second.acquisitionJobIds).toEqual(["ACQ-20260826-0001", "ACQ-20260826-0002"]);
    await expect(stat(path.join(paths.webRaw, "example.com", "ACQ-20260826-0002", "ART-000002")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(first.rawRef!, "utf8")).resolves.toBe("same bytes");
    await expect(readFile(secondStagedFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps only auditable metadata when policy forbids retaining the body", async () => {
    const { paths, store } = await createStore();
    const stagedFile = await stage(paths, "ACQ-20260826-0001", "private.txt", "do not retain");

    const artifact = await store.ingest({
      sourceId: "SRC-000001",
      jobId: "ACQ-20260826-0001",
      canonicalUrl: "https://example.com/private.txt",
      stagedFile,
      mimeType: "text/plain",
      retentionStatus: "metadata_only",
    });

    expect(artifact.rawRef).toBeUndefined();
    expect(artifact.retentionStatus).toBe("metadata_only");
    const artifactDirectory = path.join(paths.webRaw, "example.com", "ACQ-20260826-0001", "ART-000001");
    await expect(readFile(path.join(artifactDirectory, "source.json"), "utf8")).resolves.toContain("SRC-000001");
    await expect(readFile(path.join(artifactDirectory, "files", "private.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(stagedFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("associates a repeated metadata-only body without restoring or requiring a raw file", async () => {
    const { paths, store } = await createStore();
    await store.ingest({
      sourceId: "SRC-000001",
      jobId: "ACQ-20260826-0001",
      canonicalUrl: "https://example.com/private.txt",
      stagedFile: await stage(paths, "ACQ-20260826-0001", "private.txt", "do not retain"),
      mimeType: "text/plain",
      retentionStatus: "metadata_only",
    });

    const duplicate = await store.ingest({
      sourceId: "SRC-000002",
      jobId: "ACQ-20260826-0002",
      canonicalUrl: "https://example.com/private.txt",
      stagedFile: await stage(paths, "ACQ-20260826-0002", "private.txt", "do not retain"),
      mimeType: "text/plain",
      retentionStatus: "metadata_only",
    });

    expect(duplicate).toMatchObject({
      sourceIds: ["SRC-000001", "SRC-000002"],
      acquisitionJobIds: ["ACQ-20260826-0001", "ACQ-20260826-0002"],
    });
    expect(duplicate.rawRef).toBeUndefined();
  });

  it("rejects a staged file reached through a staging reparse point", async () => {
    const { paths, store } = await createStore();
    const outside = path.join(paths.root, "outside");
    const reparsePoint = path.join(paths.staging, "ACQ-20260826-0001", "escape");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "invoice.txt"), "outside staging", "utf8");
    await symlink(outside, reparsePoint, process.platform === "win32" ? "junction" : "dir");

    await expect(store.ingest({
      sourceId: "SRC-000001",
      jobId: "ACQ-20260826-0001",
      stagedFile: path.join(reparsePoint, "invoice.txt"),
      mimeType: "text/plain",
      retentionStatus: "retained",
    })).rejects.toThrow(/reparse|staging/i);
    await expect(readFile(path.join(outside, "invoice.txt"), "utf8")).resolves.toBe("outside staging");
  });
});
