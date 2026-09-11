import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatasetManifestSchema, ParsedDocumentSchema, type AssetRef, type DatasetManifest, type DatasetPurpose, type ParsedDocument } from "@flowmate/contracts";
import { importParsed } from "../source/parsed-import.js";
import { readStableFile } from "../source/inspect.js";
import type { InspectionReport, SourceEntry, SourceFile } from "../source/role-map.js";
import type { AssetScope, FrozenAssetRecord } from "./asset-reader.js";

export type FreezeOptions = { outputRoot?: string };
export type PurposeMap = Record<string, DatasetPurpose>;

export type FrozenState = {
  outputRoot: string;
  assets: Record<string, FrozenAssetRecord>;
  documents: Record<string, ParsedDocument>;
  bySample: Record<string, { original: string; parsed: string }>;
};

export type FrozenDatasetManifest = DatasetManifest;

const stateByManifest = new WeakMap<DatasetManifest, FrozenState>();
const STATE_KEY = Symbol.for("flowmate.frozen-dataset-state");

export function stateFor(manifest: DatasetManifest): FrozenState {
  const state = stateByManifest.get(manifest) ?? (manifest as DatasetManifest & { [STATE_KEY]?: FrozenState })[STATE_KEY];
  if (!state) throw new Error("DATASET_STATE_UNAVAILABLE: loadFrozenDataset must load this manifest before creating a projection");
  return state;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assetId(role: "original" | "parsed" | "labels", entry: SourceEntry): string {
  return `${role}:${entry.sourceId}:${entry.sampleId}`;
}

function ref(record: FrozenAssetRecord): AssetRef {
  return { assetId: record.assetId, sha256: record.sha256, mediaType: record.mediaType };
}

async function copyAsset(source: SourceFile, targetPath: string, asset: FrozenAssetRecord): Promise<void> {
  const result = await readStableFile(source.path);
  if ("code" in result || result.sha256 !== source.sha256) throw new Error("SOURCE_UNSTABLE: source changed while freezing");
  await mkdir(resolve(targetPath, ".."), { recursive: true });
  await writeFile(targetPath, result.bytes);
  asset.sha256 = result.sha256;
  asset.mediaType = source.mediaType;
}

async function writeAtomic(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

export async function freezeDataset(report: InspectionReport, purposeMap: PurposeMap, options: FreezeOptions = {}): Promise<FrozenDatasetManifest> {
  const selected = report.validEntries.filter((entry) => purposeMap[entry.sampleId] !== undefined);
  for (const entry of selected) {
    if (!purposeMap[entry.sampleId]) throw new Error(`PURPOSE_REQUIRED: ${entry.sampleId}`);
  }
  if (selected.length === 0) throw new Error("DATASET_EMPTY: no inspected entries have a purpose");

  const preliminary = selected.map((entry) => ({
    sampleId: entry.sampleId,
    sourceId: entry.sourceId,
    parserVersion: entry.parserVersion,
    purpose: purposeMap[entry.sampleId]!,
    original: { assetId: assetId("original", entry), sha256: entry.original.sha256, mediaType: entry.original.mediaType },
    parsed: { assetId: assetId("parsed", entry), sha256: entry.parsed.sha256, mediaType: entry.parsed.mediaType },
  }));
  const datasetVersion = `p0-${digest(preliminary).slice(0, 16)}`;
  const outputRoot = options.outputRoot ?? resolve(process.cwd(), "FlowmateData", "p0", "inputs", datasetVersion);
  await mkdir(outputRoot, { recursive: true });
  await mkdir(join(outputRoot, "documents"), { recursive: true });
  const state: FrozenState = { outputRoot, assets: {}, documents: {}, bySample: {} };
  const cases: DatasetManifest["cases"] = [];
  const checksums: Record<string, string> = {};

  for (const entry of selected) {
    const originalRecord: FrozenAssetRecord = { assetId: assetId("original", entry), path: join(outputRoot, "assets", `${entry.sampleId}.original`), sha256: entry.original.sha256, mediaType: entry.original.mediaType, role: "original" };
    const parsedRecord: FrozenAssetRecord = { assetId: assetId("parsed", entry), path: join(outputRoot, "assets", `${entry.sampleId}.parsed${entry.parsed.mediaType === "application/json" ? ".json" : ".md"}`), sha256: entry.parsed.sha256, mediaType: entry.parsed.mediaType, role: "parsed" };
    await copyAsset(entry.original, originalRecord.path, originalRecord);
    await copyAsset(entry.parsed, parsedRecord.path, parsedRecord);
    const labelRecord = entry.labels
      ? { assetId: assetId("labels", entry), path: join(outputRoot, "quality", `${entry.sampleId}.label`), sha256: entry.labels.sha256, mediaType: entry.labels.mediaType, role: "labels" as const }
      : null;
    if (labelRecord && entry.labels) await copyAsset(entry.labels, labelRecord.path, labelRecord);

    const frozenEntry: SourceEntry = { ...entry, original: { ...entry.original, path: originalRecord.path, sha256: originalRecord.sha256 }, parsed: { ...entry.parsed, path: parsedRecord.path, sha256: parsedRecord.sha256 } };
    const imported = await importParsed(frozenEntry);
    if (!imported.ok) throw new Error(`${imported.error.code}: ${imported.error.message}`);
    const document = imported.value;
    // Keep parsed document references tied to the content-addressed frozen original.
    document.original = ref(originalRecord);
    document.blocks = document.blocks.map((block) => ({ ...block, evidence: { ...block.evidence, assetId: originalRecord.assetId } }));
    await writeAtomic(join(outputRoot, "documents", `${entry.sampleId}.json`), JSON.stringify(document) + "\n");
    state.assets[originalRecord.assetId] = originalRecord;
    state.assets[parsedRecord.assetId] = parsedRecord;
    if (labelRecord) state.assets[labelRecord.assetId] = labelRecord;
    state.documents[entry.sampleId] = document;
    state.bySample[entry.sampleId] = { original: originalRecord.assetId, parsed: parsedRecord.assetId };
    const datasetCase = {
      sampleId: entry.sampleId,
      sourceId: entry.sourceId,
      sourceGroup: `${entry.sourceId}:${entry.parserVersion}`,
      purpose: purposeMap[entry.sampleId]!,
      original: ref(originalRecord),
      parsed: ref(parsedRecord),
      parserVersion: entry.parserVersion,
      isolatedLabelRef: labelRecord ? ref(labelRecord) : null,
      checks: [
        { id: "original-nonempty", ok: originalRecord.sha256.length === 64, message: "frozen original has a verified digest" },
        { id: "parsed-nonempty", ok: parsedRecord.sha256.length === 64, message: "frozen parsed output has a verified digest" },
      ],
    };
    cases.push(datasetCase);
    checksums[entry.sampleId] = digest(datasetCase);
  }
  const manifest = DatasetManifestSchema.parse({ schemaVersion: "1", datasetVersion, createdAt: new Date().toISOString(), cases, checksums });
  await writeAtomic(join(outputRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  stateByManifest.set(manifest, state);
  Object.defineProperty(manifest, STATE_KEY, { value: state, enumerable: false, configurable: false });
  return manifest;
}

/**
 * Reopen a frozen dataset created by a previous process. The manifest is the
 * public index; the parsed documents and frozen assets are revalidated before
 * they become available to an InputProjection. Quality labels are indexed for
 * custody but are never added to the per-sample runtime scope.
 */
export async function loadFrozenDataset(outputRoot: string): Promise<FrozenDatasetManifest> {
  const root = resolve(outputRoot);
  const manifestPath = join(root, "manifest.json");
  const manifest = DatasetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const state: FrozenState = { outputRoot: root, assets: {}, documents: {}, bySample: {} };
  for (const item of manifest.cases) {
    const originalPath = join(root, "assets", `${item.sampleId}.original`);
    const parsedExtension = item.parsed.mediaType === "application/json" ? ".json" : ".md";
    const parsedPath = join(root, "assets", `${item.sampleId}.parsed${parsedExtension}`);
    const originalResult = await readStableFile(originalPath);
    if ("code" in originalResult || originalResult.sha256 !== item.original.sha256) throw new Error(`FROZEN_ASSET_INVALID: ${item.sampleId} original`);
    const parsedResult = await readStableFile(parsedPath);
    if ("code" in parsedResult || parsedResult.sha256 !== item.parsed.sha256) throw new Error(`FROZEN_ASSET_INVALID: ${item.sampleId} parsed`);
    const document = ParsedDocumentSchema.parse(JSON.parse(await readFile(join(root, "documents", `${item.sampleId}.json`), "utf8")) as unknown);
    if (document.sampleId !== item.sampleId || document.sourceId !== item.sourceId || document.original.assetId !== item.original.assetId || document.original.sha256 !== item.original.sha256) {
      throw new Error(`FROZEN_DOCUMENT_INVALID: ${item.sampleId}`);
    }
    const originalRecord: FrozenAssetRecord = { assetId: item.original.assetId, path: originalPath, sha256: item.original.sha256, mediaType: item.original.mediaType, role: "original" };
    const parsedRecord: FrozenAssetRecord = { assetId: item.parsed.assetId, path: parsedPath, sha256: item.parsed.sha256, mediaType: item.parsed.mediaType, role: "parsed" };
    state.assets[originalRecord.assetId] = originalRecord;
    state.assets[parsedRecord.assetId] = parsedRecord;
    if (item.isolatedLabelRef) {
      const labelPath = join(root, "quality", `${item.sampleId}.label`);
      const labelResult = await readStableFile(labelPath);
      if ("code" in labelResult || labelResult.sha256 !== item.isolatedLabelRef.sha256) throw new Error(`FROZEN_ASSET_INVALID: ${item.sampleId} label`);
      state.assets[item.isolatedLabelRef.assetId] = { assetId: item.isolatedLabelRef.assetId, path: labelPath, sha256: item.isolatedLabelRef.sha256, mediaType: item.isolatedLabelRef.mediaType, role: "labels" };
    }
    state.documents[item.sampleId] = document;
    state.bySample[item.sampleId] = { original: originalRecord.assetId, parsed: parsedRecord.assetId };
  }
  stateByManifest.set(manifest, state);
  Object.defineProperty(manifest, STATE_KEY, { value: state, enumerable: false, configurable: false });
  return manifest;
}

export function scopeForSample(manifest: DatasetManifest, sampleId: string): AssetScope {
  const state = stateFor(manifest);
  const selected = state.bySample[sampleId];
  if (!selected) throw new Error(`SAMPLE_NOT_IN_DATASET: ${sampleId}`);
  const assets: Record<string, FrozenAssetRecord> = {};
  for (const id of [selected.original, selected.parsed]) {
    const asset = state.assets[id];
    if (asset) assets[id] = asset;
  }
  return { scopeId: `${manifest.datasetVersion}:${sampleId}`, root: state.outputRoot, assets };
}
