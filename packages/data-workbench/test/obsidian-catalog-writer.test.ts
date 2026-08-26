import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogOutboxEntry } from "../src/catalog-outbox.js";
import { ObsidianCatalogWriter, type CatalogPayload } from "../src/obsidian-catalog-writer.js";
import { initializeObsidianVault } from "../src/obsidian-templates.js";

const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-obsidian-catalog-"));
  temporaryRoots.push(root);
  return root;
}

async function writePayload(root: string, entryId: string, payload: CatalogPayload): Promise<CatalogOutboxEntry> {
  const payloadRef = path.join(root, `${entryId}.json`);
  await writeFile(payloadRef, JSON.stringify(payload), "utf8");
  return { entryId, entryType: payload.entryType, payloadRef, status: "pending", attempts: 0 };
}

function frontmatter(markdown: string): Record<string, unknown> {
  const closingDelimiter = "\n---\n\n";
  const closingOffset = markdown.indexOf(closingDelimiter, 4);
  return parse(closingOffset === -1 ? "" : markdown.slice(4, closingOffset)) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("ObsidianCatalogWriter", () => {
  it("maps every catalog entry type to its logical database", async () => {
    const root = await createTemporaryRoot();
    const vault = path.join(root, "vault");
    const writer = new ObsidianCatalogWriter(vault);
    const entries = await Promise.all([
      writePayload(root, "KNOW-000001", publicPayload("knowledge")),
      writePayload(root, "SAMPLE-000001", publicPayload("public_sample")),
      writePayload(root, "BIZ-000001", publicPayload("business_asset")),
      writePayload(root, "QUAR-000001", publicPayload("quarantine")),
      writePayload(root, "FAIL-000001", publicPayload("failure")),
    ]);

    const result = await writer.flush(entries);

    expect(result.map((entry) => entry.noteRef)).toEqual([
      "30_PublicKnowledge/KNOW-000001.md",
      "40_PublicSamples/SAMPLE-000001.md",
      "50_BusinessAssets/BIZ-000001.md",
      "70_Quarantine/QUAR-000001.md",
      "80_Failures/FAIL-000001.md",
    ]);
    await Promise.all(result.map(async (entry) => expect(await readFile(path.join(vault, entry.noteRef), "utf8")).toContain("---\n")));
  });

  it("writes escaped YAML metadata and references without copying a raw PDF", async () => {
    const root = await createTemporaryRoot();
    const vault = path.join(root, "vault");
    const writer = new ObsidianCatalogWriter(vault);
    const entry = await writePayload(root, "KNOW-000001", {
      ...publicPayload("knowledge"),
      title: "Invoice: a # heading\n---\nnot frontmatter",
    });

    await writer.flush([entry]);

    const notePath = path.join(vault, "30_PublicKnowledge", "KNOW-000001.md");
    const note = await readFile(notePath, "utf8");
    expect(frontmatter(note)).toMatchObject({
      knowledge_id: "KNOW-000001",
      source_id: "SRC-000001",
      artifact_id: "ART-000001",
      license_status: "allowed",
      privacy_status: "passed",
      quality_status: "passed",
      pipeline_status: "cataloged",
      title: "Invoice: a # heading\n---\nnot frontmatter",
    });
    expect(frontmatter(note)).not.toHaveProperty("raw_ref");
    expect(frontmatter(note)).not.toHaveProperty("derived_ref");
    expect(await readdir(path.join(vault, "30_PublicKnowledge"))).toEqual(["KNOW-000001.md"]);
    await expect(readFile(path.join(vault, "30_PublicKnowledge", "original.pdf"))).rejects.toThrow();
  });

  it("writes the exact Public Sample file-reference schema without generic aliases", async () => {
    const root = await createTemporaryRoot();
    const vault = path.join(root, "vault");
    const writer = new ObsidianCatalogWriter(vault);
    const entry = await writePayload(root, "SAMPLE-000001", publicPayload("public_sample"));

    await writer.flush([entry]);

    const metadata = frontmatter(await readFile(path.join(vault, "40_PublicSamples", "SAMPLE-000001.md"), "utf8"));
    expect(metadata).toMatchObject({
      sample_id: "SAMPLE-000001",
      raw_file_ref: "../web-raw/example.com/ART-000001/original.pdf",
      derived_ref: "../derived/mineru/ART-000001/content.md",
    });
    expect(metadata).not.toHaveProperty("raw_ref");
  });

  it("writes the exact Business Asset file-reference schema without generic aliases", async () => {
    const root = await createTemporaryRoot();
    const vault = path.join(root, "vault");
    const writer = new ObsidianCatalogWriter(vault);
    const entry = await writePayload(root, "BIZ-000001", {
      ...publicPayload("business_asset"),
      sourceType: "internal_finance",
      dataOwnerRole: "finance_ap",
      authorizationStatus: "approved_for_development",
      businessReviewStatus: "approved",
      sanitizedFileRef: "../files/private-sanitized/BIZ-000001.pdf",
      expectedRef: "../labels/BIZ-000001.expected.json",
    });

    await writer.flush([entry]);

    const metadata = frontmatter(await readFile(path.join(vault, "50_BusinessAssets", "BIZ-000001.md"), "utf8"));
    expect(metadata).toMatchObject({
      business_asset_id: "BIZ-000001",
      raw_file_ref: "../web-raw/example.com/ART-000001/original.pdf",
      sanitized_file_ref: "../files/private-sanitized/BIZ-000001.pdf",
      expected_ref: "../labels/BIZ-000001.expected.json",
    });
    expect(metadata).not.toHaveProperty("raw_ref");
    expect(metadata).not.toHaveProperty("derived_ref");
  });

  it("creates the P0 Vault directories and templates without overwriting an existing note", async () => {
    const root = await createTemporaryRoot();
    const vault = path.join(root, "vault");

    await initializeObsidianVault(vault);
    const sourceTemplate = path.join(vault, "90_Templates", "Source.md");
    await writeFile(sourceTemplate, "user customization\n", "utf8");
    await initializeObsidianVault(vault);

    await expect(readFile(sourceTemplate, "utf8")).resolves.toBe("user customization\n");
    await Promise.all([
      "00_Dashboard", "10_Sources", "20_AcquisitionJobs", "30_PublicKnowledge", "40_PublicSamples",
      "50_BusinessAssets", "60_DatasetReleases", "70_Quarantine", "80_Failures", "90_Templates",
    ].map(async (directory) => expect(await readdir(path.join(vault, directory))).toBeDefined()));
  });
});

function publicPayload(entryType: CatalogPayload["entryType"]): CatalogPayload {
  return {
    entryType,
    sourceId: "SRC-000001",
    artifactId: "ART-000001",
    title: "Invoice field definition",
    category: "invoice_rule",
    sourceUrl: "https://example.com/page",
    retrievedAt: "2026-08-26T10:00:00+08:00",
    rawSha256: "a".repeat(64),
    contentSha256: "b".repeat(64),
    rawFileRef: "../web-raw/example.com/ART-000001/original.pdf",
    derivedRef: "../derived/mineru/ART-000001/content.md",
    fileFormat: "pdf",
    parserName: "mineru",
    parserVersion: "mineru-version",
    licenseStatus: "allowed",
    privacyStatus: "passed",
    qualityStatus: "passed",
    pipelineStatus: "cataloged",
    scenarios: ["normal"],
  };
}
