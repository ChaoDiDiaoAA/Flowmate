import { createHash, randomUUID } from "node:crypto";
import type { AssetRef } from "@flowmate/contracts";
import type { SqliteDatabase } from "./database.js";

export type ArtifactRecord = { ref: AssetRef; runId: string; kind: string; bytes: Buffer; createdAt: string };

export function insertArtifact(db: SqliteDatabase, runId: string, kind: string, bytes: Uint8Array): AssetRef {
  const value = Buffer.from(bytes);
  const sha256 = createHash("sha256").update(value).digest("hex");
  const assetId = `artifact:${runId}:${kind}:${randomUUID()}`;
  const mediaType = kind.includes("json") || kind.includes("request") || kind.includes("result") ? "application/json" : "application/octet-stream";
  db.prepare("INSERT INTO artifacts (asset_id, run_id, kind, sha256, media_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    assetId, runId, kind, sha256, mediaType, value, new Date().toISOString(),
  );
  return { assetId, sha256, mediaType };
}

export function selectArtifact(db: SqliteDatabase, assetId: string): ArtifactRecord {
  const row = db.prepare("SELECT asset_id, run_id, kind, sha256, media_type, bytes, created_at FROM artifacts WHERE asset_id = ?").get(assetId) as {
    asset_id: string; run_id: string; kind: string; sha256: string; media_type: string; bytes: Buffer; created_at: string;
  } | undefined;
  if (!row) throw new Error("ARTIFACT_NOT_FOUND");
  return {
    ref: { assetId: row.asset_id, sha256: row.sha256, mediaType: row.media_type },
    runId: row.run_id,
    kind: row.kind,
    bytes: Buffer.from(row.bytes),
    createdAt: row.created_at,
  };
}
