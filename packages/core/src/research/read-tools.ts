import { z } from 'zod';
import { appError, ToolExecutionFailure, SourceSnapshotSchema, ResearchLocatorSchema, EvidenceRefSchema } from '@flowmate/contracts';
import type { ToolDefinition, ToolCallContext, ProductToolContext, Result, SourceSnapshot } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';
import type { FileStore } from '../storage/file-store.ts';
import { researchExcerpt, researchEvidenceRef } from './source-text.ts';
import { checkResearchControl } from './tools.ts';

const usageSchema = z.object({ requestId: z.string().max(256).nullable(), credits: z.number().min(0).nullable() }).strict();
const bodyReceipt = z.object({ source: SourceSnapshotSchema, excerpt: ResearchLocatorSchema, evidenceRef: EvidenceRefSchema.nullable(), usage: usageSchema }).strict();
const localInput = z.object({ artifactId: z.number().int().positive().nullable(), documentId: z.number().int().positive().nullable(),
  stepId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).optional() }).strict();

export function createResearchReadQueue() {
  const groups = new Map<number, { active: number; waiting: Array<() => void> }>();
  return async function run<T>(researchId: number, call: ToolCallContext, work: () => Promise<T>): Promise<T> {
    checkResearchControl(call);
    let group = groups.get(researchId);
    if (!group) { group = { active: 0, waiting: [] }; groups.set(researchId, group); }
    const current = group;
    if (current.active >= 2) await new Promise<void>((resolve, reject) => {
      const enter = () => { call.signal.removeEventListener('abort', cancel); current.active++; resolve(); };
      const cancel = () => {
        const index = current.waiting.indexOf(enter);
        if (index !== -1) current.waiting.splice(index, 1);
        call.signal.removeEventListener('abort', cancel);
        reject(new ToolExecutionFailure(appError('agent_cancelled', 'runtime', 'Research acquisition was cancelled while waiting.')));
      };
      current.waiting.push(enter);
      call.signal.addEventListener('abort', cancel, { once: true });
      if (call.signal.aborted) cancel();
    }); else current.active++;
    try { checkResearchControl(call); return await work(); }
    finally {
      current.active--; current.waiting.shift()?.();
      if (!current.active && !current.waiting.length) groups.delete(researchId);
    }
  };
}

export function createResearchReadTools(options: { database: Pick<DbHandle, 'read' | 'transaction'>; files: FileStore; now: () => string;
  readDocument: (documentId: number, context: ProductToolContext) => Promise<Result<{ text: string; artifactId: number; title: string }>> }): ToolDefinition<any, any>[] {
  const run = createResearchReadQueue();
  async function identity(call: ToolCallContext, context: ProductToolContext) {
    return options.database.read(store => {
      checkResearchControl(call);
      const binding = store.research.bindingForRun(context.runId);
      if (!binding.ok) throw new ToolExecutionFailure(binding.error);
      if (!binding.data) throw new ToolExecutionFailure(appError('research_identity_conflict', 'tool', 'This Run has no research identity.'));
      const actual = store.toolCalls.get({ runId: context.runId, sessionId: context.sessionId, nativeToolCallId: call.nativeToolCallId });
      if (!actual.ok) throw new ToolExecutionFailure(actual.error);
      return { binding: binding.data, toolCallId: actual.data.toolCallId };
    }).catch(error => { throw error instanceof ToolExecutionFailure ? error
      : new ToolExecutionFailure(appError('research_read_failed', 'storage', 'Research storage is unavailable.', true)); });
  }
  async function publish(text: string, source: { kind: 'local' | 'document'; address: string; title: string; artifactId: number | null; documentId: number | null },
    call: ToolCallContext, context: ProductToolContext, usage: z.infer<typeof usageSchema>) {
    const { binding, toolCallId } = await identity(call, context), at = options.now();
    const published = await options.files.publishResearchSource({ researchId: binding.researchId, toolCallId, text });
    if (!published.ok) throw new ToolExecutionFailure(published.error);
    let confirmed: SourceSnapshot | undefined;
    const saved = await options.database.transaction(store => {
      checkResearchControl(call);
      const result = store.research.saveSource({ researchId: binding.researchId, runId: context.runId, toolCallId, at,
        source: { ...source, ...published.data, fetchedAt: at, publishedAt: null, truncated: false } });
      if (!result.ok) throw new ToolExecutionFailure(result.error);
      store.db.afterCommit?.(() => { confirmed = result.data; });
      return result.data;
    }).catch(error => { if (confirmed !== undefined) return confirmed;
      throw error instanceof ToolExecutionFailure ? error
      : new ToolExecutionFailure(appError('research_write_failed', 'storage', 'Research storage is unavailable.', true)); });
    const excerpt = researchExcerpt(text, 0, 4000);
    if (!excerpt.ok) throw new ToolExecutionFailure(excerpt.error);
    return { source: saved, excerpt: excerpt.data.excerpt, evidenceRef:researchEvidenceRef(binding,saved,excerpt.data.excerpt), usage };
  }
  return [
    { name: 'read_research_local', version: 'p15-v3', label: 'Read selected research material', effect: 'READ', executionMode: 'parallel',
      description: 'Read one selected local artifact or parsed document; set the other ID to null. For a plan with steps, pass its exact stepId and material parameters. A succeeded step reuses its original source. Saves a body snapshot. In investigation copy the complete returned evidenceRef into claim evidence[].ref; it already has the confirmed plan, original source execution and exact UTF-16 locator. During planning evidenceRef is null; query the saved source after confirmation to get a usable reference.',
      inputSchema: localInput, outputSchema: bodyReceipt,
      execute: async (input, call, context) => {
        input = structuredClone(input); call = { ...call }; context = structuredClone(context);
        const { binding, toolCallId } = await identity(call, context);
        const denied = () => { throw new ToolExecutionFailure(appError('research_source_denied', 'tool', 'This local material is outside the frozen research scope.')); };
        if ((input.artifactId === null) === (input.documentId === null) || context.scope.version !== 2) return denied();
        if (input.documentId !== null
          ? !binding.sourcePolicy.documentIds.includes(input.documentId) || !context.scope.allowedDocumentIds.includes(input.documentId)
          : !binding.sourcePolicy.artifactIds.includes(input.artifactId!) || !context.scope.allowedArtifactIds.includes(input.artifactId!)) return denied();
        const reusable = await options.database.transaction(store => {
          checkResearchControl(call);
          const result = store.research.bindStep({ ...input, researchId: binding.researchId, runId: context.runId, toolCallId, at: options.now() });
          if (!result.ok) throw new ToolExecutionFailure(result.error);
          return result.data;
        });
        return run(binding.researchId, call, async () => {
          if (reusable) {
            const body = await options.files.readResearchSource(reusable);
            if (!body.ok) throw new ToolExecutionFailure(body.error);
            checkResearchControl(call);
            const excerpt = researchExcerpt(body.data, 0, 4000);
            if (!excerpt.ok) throw new ToolExecutionFailure(excerpt.error);
            return { source: reusable, excerpt: excerpt.data.excerpt, evidenceRef: researchEvidenceRef(binding, reusable, excerpt.data.excerpt),
              usage: { requestId: null, credits: null } };
          }
          let text: string, title: string, artifactId: number;
          if (input.documentId !== null) {
            const loaded = await options.readDocument(input.documentId, context);
            if (!loaded.ok) throw new ToolExecutionFailure(loaded.error);
            ({ text, title, artifactId } = loaded.data);
          } else {
            artifactId = input.artifactId!;
            const material = await options.database.read(store => {
              checkResearchControl(call);
              const artifact = store.documents.getArtifact(artifactId);
              if (!artifact.ok) throw new ToolExecutionFailure(artifact.error);
              const name = artifact.data.relativePath.slice(artifact.data.relativePath.lastIndexOf('/') + 1);
              return { artifact: artifact.data, name, original: store.contents.read({ ownerKind: 'artifact', ownerId: String(artifactId), relativePath: name }) };
            }).catch(error => { throw error instanceof ToolExecutionFailure ? error
              : new ToolExecutionFailure(appError('research_read_failed', 'storage', 'Research storage is unavailable.', true)); });
            const artifact = material.artifact;
            if (!/\.(?:txt|md)$/.test(artifact.relativePath) || !['text/plain', 'text/markdown'].includes(artifact.mimeType)) return denied();
            checkResearchControl(call);
            const bytes = options.files.read(artifact, undefined, { read: owner => owner.ownerKind === 'artifact'
              && owner.ownerId === String(artifactId) && owner.relativePath === material.name ? material.original : null });
            if (!bytes.ok) throw new ToolExecutionFailure(bytes.error.code === 'artifact_unavailable'
              ? appError('research_source_unavailable', 'tool', 'Selected text is missing or has changed since import.') : bytes.error);
            if (artifact.metadata.sourceKey !== 'research-local-v1')
              throw new ToolExecutionFailure(appError('research_source_unavailable', 'tool', 'Selected text has changed since import.'));
            try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.data); }
            catch { throw new ToolExecutionFailure(appError('research_source_unavailable', 'tool', 'Selected text is not valid UTF-8.')); }
            title = artifact.metadata.sourceRecordId;
          }
          return publish(text, { kind: input.documentId === null ? 'local' : 'document', title,
            address: input.documentId === null ? `artifact:${artifactId}` : `document:${input.documentId}`, artifactId, documentId: input.documentId }, call, context,
            { requestId: null, credits: null });
        });
      } },
  ];
}
