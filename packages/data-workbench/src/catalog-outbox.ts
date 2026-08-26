import type { CatalogEntryRef, PolicyDecision } from "./types.js";

export interface CatalogOutboxEntry {
  entryId: string;
  entryType: CatalogEntryRef["entryType"];
  payloadRef: string;
  status: "pending" | "written" | "failed";
  attempts: number;
  lastErrorCode?: string;
}

export interface CatalogEntryWriter {
  flush(entries: CatalogOutboxEntry[]): Promise<CatalogEntryRef[]>;
}

/**
 * Keeps catalog work retryable until a writer has atomically persisted its note.
 * Persistence is intentionally delegated to the caller so jobs can choose their
 * own durable store without coupling the Vault to operational state.
 */
export class CatalogOutbox {
  private readonly entriesById = new Map<string, CatalogOutboxEntry>();

  public constructor(entries: CatalogOutboxEntry[] = []) {
    for (const entry of entries) this.entriesById.set(entry.entryId, { ...entry });
  }

  public enqueue(
    entry: Omit<CatalogOutboxEntry, "status" | "attempts" | "lastErrorCode">,
    decision: PolicyDecision,
  ): boolean {
    if (decision.action === "delete_content_keep_metadata" || this.entriesById.has(entry.entryId)) {
      return false;
    }
    this.entriesById.set(entry.entryId, { ...entry, status: "pending", attempts: 0 });
    return true;
  }

  public entries(): CatalogOutboxEntry[] {
    return [...this.entriesById.values()].map((entry) => ({ ...entry }));
  }

  public async flush(writer: CatalogEntryWriter): Promise<CatalogEntryRef[]> {
    const pending = [...this.entriesById.values()].filter((entry) => entry.status === "pending");
    if (pending.length === 0) return [];

    for (const entry of pending) entry.attempts += 1;
    try {
      const written = await writer.flush(pending.map((entry) => ({ ...entry })));
      const writtenIds = new Set(written.map((entry) => entry.entryId));
      for (const entry of pending) {
        if (writtenIds.has(entry.entryId)) {
          entry.status = "written";
          delete entry.lastErrorCode;
        }
      }
      return written;
    } catch (error: unknown) {
      const errorCode = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : error instanceof Error ? error.name : "CATALOG_WRITE_FAILED";
      for (const entry of pending) entry.lastErrorCode = errorCode;
      throw error;
    }
  }
}
