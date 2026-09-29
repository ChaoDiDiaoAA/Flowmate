import type { DocumentSnapshot, SourceRef } from '@flowmate/contracts';

export const MAX_RESULT_BYTES = 128 * 1024;

export function sourceFor(document: DocumentSnapshot, page: number, blockId: string | null, quote: string | null): SourceRef {
  return { documentId: document.documentRef.id, version: document.documentRef.version,
    artifactId: document.parsedArtifactId, page, blockId, quote: quote ? quote.slice(0, 1024) : null };
}
