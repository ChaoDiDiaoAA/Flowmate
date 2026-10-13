import { z } from 'zod';
import { createHash } from 'node:crypto';
import { appError, ToolExecutionFailure, SourceSnapshotSchema, ResearchLocatorSchema } from '@flowmate/contracts';
import type { ToolDefinition, ToolCallContext, ProductToolContext, Result } from '@flowmate/contracts';
import type { ResearchRepository } from './repository.ts';
import type { FileStore } from '../storage/file-store.ts';
import type { DocumentRepository, ToolCallRepository } from '../storage/repositories.ts';
import { researchExcerpt } from './source-text.ts';

const usageSchema = z.object({ requestId: z.string().max(256).nullable(), credits: z.number().min(0).nullable() }).strict();
const bodyReceipt = z.object({ source: SourceSnapshotSchema, excerpt: ResearchLocatorSchema, usage: usageSchema }).strict();
const localInput = z.object({ artifactId: z.number().int().positive().nullable(), documentId: z.number().int().positive().nullable() }).strict();

export function createResearchReadTools(options: { research: ResearchRepository; calls: ToolCallRepository; files: FileStore;
  documents: DocumentRepository; now: () => string;
  readDocument: (documentId: number, context: ProductToolContext) => Result<{ text: string; artifactId: number; title: string }> }): ToolDefinition<any, any>[] {
  function identity(call: ToolCallContext, context: ProductToolContext) {
    if (call.signal.aborted) throw new ToolExecutionFailure(appError('agent_cancelled', 'runtime', 'Research acquisition was cancelled.'));
    const binding = options.research.bindingForRun(context.runId);
    if (!binding.ok) throw new ToolExecutionFailure(binding.error);
    if (!binding.data) throw new ToolExecutionFailure(appError('research_identity_conflict', 'tool', 'This Run has no research identity.'));
    const actual = options.calls.get({ runId: context.runId, sessionId: context.sessionId, nativeToolCallId: call.nativeToolCallId });
    if (!actual.ok) throw new ToolExecutionFailure(actual.error);
    return { binding: binding.data, toolCallId: actual.data.toolCallId };
  }
  function publish(text: string, source: { kind: 'local' | 'document'; address: string; title: string; artifactId: number | null; documentId: number | null },
    call: ToolCallContext, context: ProductToolContext, usage: z.infer<typeof usageSchema>) {
    const { binding, toolCallId } = identity(call, context), at = options.now();
    const published = options.files.publishResearchSource({ researchId: binding.researchId, text });
    if (!published.ok) throw new ToolExecutionFailure(published.error);
    const saved = options.research.saveSource({ researchId: binding.researchId, runId: context.runId, toolCallId, at,
      source: { ...source, ...published.data, fetchedAt: at, publishedAt: null, truncated: false } });
    if (!saved.ok) throw new ToolExecutionFailure(saved.error);
    const excerpt = researchExcerpt(text, 0, 4000);
    if (!excerpt.ok) throw new ToolExecutionFailure(excerpt.error);
    return { source: saved.data, excerpt: excerpt.data.excerpt, usage };
  }
  return [
    { name: 'read_research_local', version: 'p15-v1', label: 'Read selected research material', effect: 'READ', executionMode: 'parallel',
      description: 'Read exactly one explicitly selected local text/Markdown artifact or parsed document. Set the other ID to null. Saves a body snapshot and returns an exact excerpt.',
      inputSchema: localInput, outputSchema: bodyReceipt,
      execute: async (input, call, context) => {
        const { binding } = identity(call, context);
        const denied = () => { throw new ToolExecutionFailure(appError('research_source_denied', 'tool', 'This local material is outside the frozen research scope.')); };
        if ((input.artifactId === null) === (input.documentId === null) || context.scope.version !== 2) return denied();
        let text: string, title: string, artifactId: number;
        if (input.documentId !== null) {
          if (!binding.sourcePolicy.documentIds.includes(input.documentId) || !context.scope.allowedDocumentIds.includes(input.documentId)) return denied();
          const loaded = options.readDocument(input.documentId, context);
          if (!loaded.ok) throw new ToolExecutionFailure(loaded.error);
          ({ text, title, artifactId } = loaded.data);
        } else {
          artifactId = input.artifactId!;
          if (!binding.sourcePolicy.artifactIds.includes(artifactId) || !context.scope.allowedArtifactIds.includes(artifactId)) return denied();
          const artifact = options.documents.getArtifact(artifactId);
          if (!artifact.ok) throw new ToolExecutionFailure(artifact.error);
          if (!/\.(?:txt|md)$/.test(artifact.data.relativePath) || !['text/plain', 'text/markdown'].includes(artifact.data.mimeType)) return denied();
          const bytes = options.files.read(artifact.data);
          if (!bytes.ok) throw new ToolExecutionFailure(bytes.error);
          if (artifact.data.metadata.sourceKey !== 'research-local-v1'
            || createHash('sha256').update(bytes.data).digest('hex') !== artifact.data.metadata.sourceVersion)
            throw new ToolExecutionFailure(appError('research_source_unavailable', 'tool', 'Selected text has changed since import.'));
          try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.data); }
          catch { throw new ToolExecutionFailure(appError('research_source_unavailable', 'tool', 'Selected text is not valid UTF-8.')); }
          title = artifact.data.metadata.sourceRecordId;
        }
        return publish(text, { kind: input.documentId === null ? 'local' : 'document', title,
          address: input.documentId === null ? `artifact:${artifactId}` : `document:${input.documentId}`, artifactId, documentId: input.documentId }, call, context,
          { requestId: null, credits: null });
      } },
  ];
}
