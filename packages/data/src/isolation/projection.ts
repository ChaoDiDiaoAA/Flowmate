import { createHash } from "node:crypto";
import type { DatasetManifest, ParsedDocument } from "@flowmate/contracts";
import { scopeForSample, stateFor } from "./freeze.js";
import type { AssetScope } from "./asset-reader.js";

export type InputProjection = {
  schemaVersion: "1";
  sampleId: string;
  datasetVersion: string;
  inputHash: string;
  parsed: ParsedDocument;
  allowedAssetIds: string[];
  scope: AssetScope;
};

export async function createProjection(manifest: DatasetManifest, sampleId: string): Promise<InputProjection> {
  const state = stateFor(manifest);
  const document = state.documents[sampleId];
  if (!document) throw new Error(`SAMPLE_NOT_IN_DATASET: ${sampleId}`);
  const scope = scopeForSample(manifest, sampleId);
  const projected = {
    schemaVersion: "1" as const,
    sampleId,
    datasetVersion: manifest.datasetVersion,
    parsed: document,
    allowedAssetIds: Object.keys(scope.assets).sort(),
  };
  const inputHash = createHash("sha256").update(JSON.stringify(projected)).digest("hex");
  return { ...projected, inputHash, scope };
}
