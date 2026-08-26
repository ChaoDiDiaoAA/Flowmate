import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import type { CatalogOutboxEntry } from "./catalog-outbox.js";
import type { CatalogEntryRef } from "./types.js";

export interface CatalogPayload {
  entryType: CatalogEntryRef["entryType"];
  sourceId: string;
  artifactId?: string;
  title?: string;
  category?: string;
  sourceUrl?: string;
  retrievedAt?: string;
  rawSha256?: string;
  contentSha256?: string;
  rawRef?: string;
  derivedRef?: string;
  expectedRef?: string;
  sourceType?: string;
  sampleType?: string;
  fileFormat?: string;
  parserName?: string;
  parserVersion?: string;
  labelStatus?: string;
  scenarios?: string[];
  datasetVersion?: string;
  dataOwnerRole?: string;
  authorizationStatus?: string;
  businessReviewStatus?: string;
  licenseStatus?: string;
  privacyStatus?: string;
  qualityStatus?: string;
  pipelineStatus: string;
  reasonCodes?: string[];
}

const directories: Record<CatalogEntryRef["entryType"], string> = {
  knowledge: "30_PublicKnowledge",
  public_sample: "40_PublicSamples",
  business_asset: "50_BusinessAssets",
  quarantine: "70_Quarantine",
  failure: "80_Failures",
};

export class ObsidianCatalogWriter {
  public constructor(private readonly vault: string) {}

  public async flush(entries: CatalogOutboxEntry[]): Promise<CatalogEntryRef[]> {
    const written: CatalogEntryRef[] = [];
    for (const entry of entries) {
      const payload = await loadPayload(entry);
      const directory = directories[entry.entryType];
      const noteRef = path.posix.join(directory, `${safeNoteId(entry.entryId)}.md`);
      const notePath = path.join(this.vault, ...noteRef.split("/"));
      await mkdir(path.dirname(notePath), { recursive: true });
      await writeMarkdownAtomically(notePath, markdownFor(entry, payload));
      written.push({
        entryId: entry.entryId,
        entryType: entry.entryType,
        noteRef,
        sourceId: payload.sourceId,
        ...(payload.artifactId === undefined ? {} : { artifactId: payload.artifactId }),
        pipelineStatus: payload.pipelineStatus,
      });
    }
    return written;
  }
}

async function loadPayload(entry: CatalogOutboxEntry): Promise<CatalogPayload> {
  const payload = JSON.parse(await readFile(entry.payloadRef, "utf8")) as CatalogPayload;
  if (payload.entryType !== entry.entryType) {
    throw new Error(`Catalog payload entry type does not match ${entry.entryId}`);
  }
  if (!payload.sourceId || !payload.pipelineStatus) {
    throw new Error(`Catalog payload is missing required metadata for ${entry.entryId}`);
  }
  return payload;
}

function markdownFor(entry: CatalogOutboxEntry, payload: CatalogPayload): string {
  const metadata = removeUndefined({
    ...baseMetadata(payload),
    ...entryMetadata(entry, payload),
  });
  const heading = payload.title?.trim() || entry.entryId;
  return `---\n${stringify(metadata)}---\n\n# ${heading}\n`;
}

function baseMetadata(payload: CatalogPayload): Record<string, unknown> {
  return {
    source_id: payload.sourceId,
    artifact_id: payload.artifactId,
    title: payload.title,
    category: payload.category,
    source_url: payload.sourceUrl,
    retrieved_at: payload.retrievedAt,
    raw_sha256: payload.rawSha256,
    content_sha256: payload.contentSha256,
    raw_ref: payload.rawRef,
    derived_ref: payload.derivedRef,
    expected_ref: payload.expectedRef,
    license_status: payload.licenseStatus,
    privacy_status: payload.privacyStatus,
    quality_status: payload.qualityStatus,
    pipeline_status: payload.pipelineStatus,
  };
}

function entryMetadata(entry: CatalogOutboxEntry, payload: CatalogPayload): Record<string, unknown> {
  switch (entry.entryType) {
    case "knowledge":
      return { knowledge_id: entry.entryId };
    case "public_sample":
      return {
        sample_id: entry.entryId,
        sample_type: payload.sampleType,
        file_format: payload.fileFormat,
        parser_name: payload.parserName,
        parser_version: payload.parserVersion,
        label_status: payload.labelStatus ?? "unlabeled",
        scenarios: payload.scenarios ?? [],
        dataset_version: payload.datasetVersion ?? "unassigned",
      };
    case "business_asset":
      return {
        business_asset_id: entry.entryId,
        source_type: payload.sourceType,
        data_owner_role: payload.dataOwnerRole,
        authorization_status: payload.authorizationStatus,
        business_review_status: payload.businessReviewStatus,
        dataset_version: payload.datasetVersion ?? "unassigned",
      };
    case "quarantine":
      return { quarantine_id: entry.entryId, reason_codes: payload.reasonCodes ?? [] };
    case "failure":
      return { failure_id: entry.entryId, reason_codes: payload.reasonCodes ?? [] };
  }
}

function removeUndefined(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function safeNoteId(entryId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entryId)) {
    throw new Error(`Invalid catalog entry ID: ${entryId}`);
  }
  return entryId;
}

async function writeMarkdownAtomically(notePath: string, contents: string): Promise<void> {
  const temporaryPath = `${notePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, notePath);
}
