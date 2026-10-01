import { describe, expect, it } from 'bun:test';
import { CandidateDraftSchema, FillInvoiceFormInputSchema, FillInvoiceFormOutputSchema, InvoiceFormApplicationReceiptSchema,
  InvoiceFormTargetSchema, INVOICE_REVIEW_TOOL_NAMES, INVOICE_TOOL_NAMES, invoiceToolSchemas, ParsedBlockSchema } from '../../packages/contracts/src/invoice.ts';
import { RunScopeSchema, ToolExecutionContextSchema, ToolExecutionModeSchema } from '../../packages/contracts/src/tools.ts';
import type { AgentTool, ProductToolContext, ToolCallContext, ToolDefinition } from '../../packages/contracts/src/tools.ts';
import { AppErrorSchema, InputRecordV2Schema, UsageRecordV2Schema } from '../../packages/contracts/src/runtime.ts';
import { appError } from '../../packages/contracts/src/errors.ts';
import type { BusinessEventSnapshot, ToolCallSnapshot } from '../../packages/contracts/src/activity.ts';
import type { P3AgentConfigFacts } from '../../packages/contracts/src/ports.ts';
import type { InputRecordV2, UsageRecordV2 } from '../../packages/contracts/src/runtime.ts';
import { WorkspaceContextSchema } from '../../packages/contracts/src/workspace.ts';
import type { WorkspaceContext, WorkspaceInput } from '../../packages/contracts/src/workspace.ts';
import { z } from 'zod';

const field = {
  raw: null,
  normalized: null,
  state: 'missing',
  alternatives: [],
  sources: [],
} as const;

const candidate = {
  fields: {
    invoiceNumber: field,
    issueDate: field,
    sellerName: field,
    sellerTaxId: field,
    buyerName: field,
    buyerTaxId: field,
    currency: field,
    netAmount: field,
    taxAmount: field,
    totalAmount: field,
  },
  lines: [],
  notes: [],
};
const documentRef = { id: 1, version: 'fixture-v1' };
const source = { documentId: 1, version: 'fixture-v1', artifactId: 2, page: 1, blockId: 'b1', quote: 'Invoice' };
const outputExamples = {
  list_invoice_pages: { documentRef, parsedArtifactId: 2, pageCount: 1, pages: [{ page: 1, blockCount: 1, tableCount: 0 }] },
  read_invoice_document: { documentRef, parsedArtifactId: 2, page: 1, pageCount: 1, blocks: [], nextAfterBlockId: null, completePage: true },
  search_invoice_document: { documentRef, parsedArtifactId: 2, query: 'Invoice', matches: [], nextAfterBlockId: null, complete: true },
  list_invoice_tables: { documentRef, parsedArtifactId: 2, tables: [], nextAfterBlockId: null, complete: true },
  read_invoice_evidence: { kind: 'parsed', source, text: 'Invoice', sourceType: 'text' },
  check_invoice_sources: { documentRef, results: [{ index: 0, status: 'valid', code: 'parsed_quote_matched' }] },
  normalize_invoice_values: { items: [{ index: 0, kind: 'decimal', raw: '1.0', status: 'normalized', value: '1', alternatives: [], reason: null }] },
  calculate_invoice_amounts: { operation: 'sum', exact: '0.3', rounded: '0.30', scale: 2, rounding: 'half_away_from_zero' },
  validate_invoice_candidate: { documentRef, saveable: true, violations: [], checks: [], issues: [] },
  list_invoice_candidates: { jobId: 3, candidates: [], nextBeforeSequence: null },
  get_invoice_candidate: { candidateId: 4, jobId: 3, runId: 2, sequence: 1, issueCount: 0, documentRef, toolCallId: 9, candidate, checks: [], issues: [] },
  compare_invoice_candidates: { jobId: 3, leftCandidateId: 4, rightCandidateId: 5, differences: [], nextAfterPath: null, complete: true },
  save_invoice_candidate: { candidateId: 4, jobId: 3, sequence: 1, issueCount: 0, checks: [] },
  fill_invoice_form: { candidateId: 4, candidateSequence: 1, applied: true },
} as const;

describe('P3 invoice tool contracts', () => {
  it('keeps form targets and application evidence out of the model tool input and output', () => {
    const target = { formInstanceId: 'form-1', expectedRevision: 0 };
    const base = { runId: 2, toolCallId: 9, formInstanceId: 'form-1', candidateId: 4, candidateSequence: 1,
      observedAt: '2026-10-01T00:00:00.000Z' };
    expect(InvoiceFormTargetSchema.safeParse(target).success).toBe(true);
    expect(InvoiceFormTargetSchema.safeParse({ ...target, expectedRevision: -1 }).success).toBe(false);
    expect(FillInvoiceFormInputSchema.parse({ candidateId: 4 })).toEqual({ candidateId: 4 });
    expect(FillInvoiceFormInputSchema.safeParse({ candidateId: 4, ...target }).success).toBe(false);
    expect(FillInvoiceFormOutputSchema.safeParse({ candidateId: 4, candidateSequence: 1, applied: true }).success).toBe(true);
    expect(FillInvoiceFormOutputSchema.safeParse({ candidateId: 4, candidateSequence: 1, applied: false }).success).toBe(false);
    expect(FillInvoiceFormOutputSchema.safeParse({ candidateId: 4, candidateSequence: 1, applied: true, ...target }).success).toBe(false);
    expect(InvoiceFormApplicationReceiptSchema.safeParse({ ...base, outcome: 'applied', appliedRevision: 1,
      appliedAt: base.observedAt }).success).toBe(true);
    expect(InvoiceFormApplicationReceiptSchema.safeParse({ ...base, outcome: 'not_applied', reason: 'revision_changed' }).success).toBe(true);
    expect(InvoiceFormApplicationReceiptSchema.safeParse({ ...base, outcome: 'unknown' }).success).toBe(true);
    expect(InvoiceFormApplicationReceiptSchema.safeParse({ ...base, outcome: 'unknown', appliedRevision: 1 }).success).toBe(false);
    expect(InvoiceFormApplicationReceiptSchema.safeParse({ ...base, outcome: 'applied', appliedRevision: 1 }).success).toBe(false);
    expect(InvoiceFormApplicationReceiptSchema.safeParse({ ...base, outcome: 'unknown', observedAt: '2026-10-01T08:00:00+08:00' }).success).toBe(false);
  });

  it('reads human edits with explicit provenance while rejecting them as model submissions', () => {
    const edited = { ...candidate, fields: { ...candidate.fields,
      invoiceNumber: { ...field, raw: 'MANUAL-1', normalized: 'MANUAL-1', state: 'present', valueOrigin: 'user-provided' },
    } };
    const human = { ...outputExamples.get_invoice_candidate, runId: null, toolCallId: null,
      origin: 'human_edit', basedOnCandidateId: 3, candidate: edited };
    expect(invoiceToolSchemas.get_invoice_candidate.output.safeParse(human).success).toBe(true);
    expect(invoiceToolSchemas.list_invoice_candidates.output.safeParse({ jobId: 3,
      candidates: [{ candidateId: 4, runId: null, sequence: 1, issueCount: 0,
        origin: 'human_edit', basedOnCandidateId: 3 }], nextBeforeSequence: null,
    }).success).toBe(true);
    for (const name of ['validate_invoice_candidate', 'save_invoice_candidate'] as const) {
      expect(invoiceToolSchemas[name].input.safeParse({ documentId: 1, candidate: edited }).success).toBe(false);
    }
    expect(invoiceToolSchemas.get_invoice_candidate.output.safeParse({ ...human, runId: 2 }).success).toBe(false);
    expect(invoiceToolSchemas.get_invoice_candidate.output.safeParse({ ...human, toolCallId: 9 }).success).toBe(false);
    expect(invoiceToolSchemas.get_invoice_candidate.output.safeParse({ ...human, basedOnCandidateId: 4 }).success).toBe(false);
    expect(invoiceToolSchemas.get_invoice_candidate.output.safeParse({ ...human, basedOnCandidateId: null }).success).toBe(false);
    expect(invoiceToolSchemas.get_invoice_candidate.output.safeParse({ ...human, origin: 'model' }).success).toBe(false);
    expect(invoiceToolSchemas.get_invoice_candidate.output.safeParse({ ...human, candidate: { ...edited,
      fields: { ...edited.fields, invoiceNumber: { ...edited.fields.invoiceNumber, sources: [source] } },
    } }).success).toBe(false);
    expect(invoiceToolSchemas.get_invoice_candidate.output.safeParse({ ...outputExamples.get_invoice_candidate, candidate: edited }).success).toBe(false);
    const { origin, ...missingOrigin } = human;
    expect(invoiceToolSchemas.get_invoice_candidate.output.safeParse(missingOrigin).success).toBe(false);
    const legacy = invoiceToolSchemas.get_invoice_candidate.output.parse(outputExamples.get_invoice_candidate);
    expect(legacy).toEqual(JSON.parse(JSON.stringify(outputExamples.get_invoice_candidate)));
    expect(Object.hasOwn(legacy, 'origin')).toBe(false);
    expect(Object.hasOwn(legacy.candidate.fields.invoiceNumber, 'valueOrigin')).toBe(false);
  });

  it('defines fourteen catalog schemas while retaining the thirteen review tool subset', () => {
    expect(INVOICE_REVIEW_TOOL_NAMES).toEqual([
      'list_invoice_pages',
      'read_invoice_document',
      'search_invoice_document',
      'list_invoice_tables',
      'read_invoice_evidence',
      'check_invoice_sources',
      'normalize_invoice_values',
      'calculate_invoice_amounts',
      'validate_invoice_candidate',
      'list_invoice_candidates',
      'get_invoice_candidate',
      'compare_invoice_candidates',
      'save_invoice_candidate',
    ]);
    expect(INVOICE_TOOL_NAMES).toEqual([...INVOICE_REVIEW_TOOL_NAMES, 'fill_invoice_form']);
    expect(Object.keys(invoiceToolSchemas)).toEqual([...INVOICE_TOOL_NAMES]);
    for (const name of INVOICE_TOOL_NAMES) {
      expect(invoiceToolSchemas[name].input).toBeDefined();
      expect(invoiceToolSchemas[name].output).toBeDefined();
      expect(invoiceToolSchemas[name].output.safeParse(outputExamples[name]).success).toBe(true);
      expect(invoiceToolSchemas[name].output.safeParse({ ...outputExamples[name], untrustedExtra: true }).success).toBe(false);
    }

    expect(invoiceToolSchemas.read_invoice_document.input.safeParse({
      documentId: 1, page: 1, afterBlockId: null, limit: 50,
    }).success).toBe(true);
    expect(invoiceToolSchemas.read_invoice_document.input.safeParse({
      documentId: 1, page: 1, afterBlockId: null, limit: 50, path: 'C:\\secret',
    }).success).toBe(false);
    expect(invoiceToolSchemas.read_invoice_document.input.safeParse({
      documentId: '1', page: 1, afterBlockId: null, limit: 50,
    }).success).toBe(false);
    expect(invoiceToolSchemas.read_invoice_document.input.safeParse({
      documentId: 1, page: 21, afterBlockId: null, limit: 50,
    }).success).toBe(false);
    expect(invoiceToolSchemas.read_invoice_document.input.safeParse({
      documentId: 1, page: 1, afterBlockId: 'b0', limit: 50,
    }).success).toBe(false);
    expect(invoiceToolSchemas.list_invoice_candidates.input.safeParse({
      beforeSequence: null, limit: 20, scope: { allowedTools: ['save_invoice_candidate'] },
    }).success).toBe(false);
    expect(invoiceToolSchemas.check_invoice_sources.input.safeParse({
      documentId: 1, sources: [{ ...source, blockId: 'b0' }],
    }).success).toBe(false);
    expect(invoiceToolSchemas.check_invoice_sources.input.safeParse({
      documentId: 1, sources: [{ ...source, quote: '' }],
    }).success).toBe(false);
    expect(invoiceToolSchemas.read_invoice_evidence.input.safeParse({
      documentId: 1, page: 1, kind: 'original', blockId: null,
    }).success).toBe(false);
    expect(invoiceToolSchemas.read_invoice_evidence.input.safeParse({
      documentId: 1, page: 1, kind: 'parsed', blockId: null,
    }).success).toBe(false);
    expect(invoiceToolSchemas.read_invoice_evidence.output.safeParse({
      kind: 'original', source: { ...source, artifactId: 1, blockId: null, quote: null },
      mimeType: 'image/png', bytes: 12,
    }).success).toBe(false);
    expect(CandidateDraftSchema.safeParse(candidate).success).toBe(true);
    expect(CandidateDraftSchema.safeParse({
      ...candidate,
      fields: { ...candidate.fields, invoiceNumber: { ...field, raw: 'INV-OLD', normalized: 'INV-OLD', state: 'present',
        sources: [{ documentId: 1, version: 'fixture-v1', artifactId: 1, page: 1, blockId: null, quote: null }] } },
    }).success).toBe(true);
    expect(CandidateDraftSchema.safeParse({ ...candidate, status: 'accepted' }).success).toBe(false);
    expect(CandidateDraftSchema.safeParse({
      ...candidate,
      fields: { ...candidate.fields, invoiceNumber: { ...field, extra: 'x' } },
    }).success).toBe(false);
    expect(CandidateDraftSchema.safeParse({
      ...candidate,
      lines: Array.from({ length: 201 }, () => ({})),
    }).success).toBe(false);
    expect(invoiceToolSchemas.calculate_invoice_amounts.input.safeParse({
      operation: 'sum', values: ['0.1', '0.2'], scale: 2,
    }).success).toBe(true);
    expect(invoiceToolSchemas.calculate_invoice_amounts.input.safeParse({
      operation: 'sum', values: ['1e3'], scale: 2,
    }).success).toBe(false);
    expect(invoiceToolSchemas.calculate_invoice_amounts.input.safeParse({
      operation: 'sum', values: ['1'], scale: 2, expression: '1+1',
    }).success).toBe(false);
    expect(ParsedBlockSchema.safeParse({
      id: 'b1', kind: 'text', text: 'invoice', sourceIndex: 0, sourceType: 'text', bbox: [0, 0, 1],
    }).success).toBe(false);
    expect(invoiceToolSchemas.list_invoice_candidates.output.safeParse({
      jobId: 3,
      candidates: [{ candidateId: 4, sequence: 1, runId: 2, issueCount: 0 }],
      nextBeforeSequence: null,
    }).success).toBe(true);
    expect(invoiceToolSchemas.list_invoice_candidates.output.safeParse({
      jobId: 3,
      candidates: [{ candidateId: 4, jobId: 3, sequence: 1, runId: 2, issueCount: 0 }],
      nextBeforeSequence: null,
    }).success).toBe(false);
    expect(invoiceToolSchemas.get_invoice_candidate.output.safeParse({
      candidateId: 4, jobId: 3, runId: 2, sequence: 1, issueCount: 0,
      documentRef: { id: 1, version: 'fixture-v1' }, toolCallId: 9,
      candidate, checks: [], issues: [],
    }).success).toBe(true);
  });

  it('defines the three contracts and separates call-scoped from trusted product context', () => {
    const scope = {
      version: 2 as const,
      allowedTools: ['get_invoice_candidate'],
      allowedDocumentIds: [1],
      allowedArtifactIds: [2],
      allowedResourcePaths: [],
    };
    const controller = new AbortController();
    expect(ToolExecutionModeSchema.safeParse('parallel').success).toBe(true);
    expect(ToolExecutionModeSchema.safeParse('unordered').success).toBe(false);
    expect(RunScopeSchema.safeParse(scope).success).toBe(true);
    expect(RunScopeSchema.safeParse({ ...scope, allowedDocumentIds: ['1'] }).success).toBe(false);
    expect(RunScopeSchema.safeParse({ ...scope, sessionId: 2 }).success).toBe(false);
    expect(ToolExecutionContextSchema.safeParse({
      runId: 3, sessionId: 2, nativeToolCallId: 'native-call-1', scope, signal: controller.signal,
    }).success).toBe(true);
    expect(ToolExecutionContextSchema.safeParse({
      runId: 3, sessionId: 2, nativeToolCallId: 'native-call-1', scope, signal: controller.signal, jobId: 5,
    }).success).toBe(false);

    const call: ToolCallContext = { nativeToolCallId: 'native-call-1', signal: controller.signal };
    const context: ProductToolContext = { runId: 3, sessionId: 2, scope };
    const definition: ToolDefinition<{ value: number }, { value: number }> = {
      name: 'test', version: '1', description: 'test',
      inputSchema: z.object({ value: z.number() }).strict(),
      outputSchema: z.object({ value: z.number() }).strict(),
      effect: 'READ', label: 'Test', executionMode: 'parallel',
      execute: async (input, receivedCall, receivedContext) => {
        expect(receivedCall).toBe(call);
        expect(receivedContext).toBe(context);
        return input;
      },
    };
    // @ts-expect-error Product context is a required third argument on this contract.
    const unbound: AgentTool<{ value: number }, { value: number }> = definition;
    const bound: AgentTool<{ value: number }, { value: number }> = {
      ...definition,
      execute: (input, receivedCall) => definition.execute(input, receivedCall, context),
    };
    expect(unbound).toBeDefined();
    expect(bound.executionMode).toBe('parallel');
    expect(INVOICE_REVIEW_TOOL_NAMES).toHaveLength(13);
  });

  it('retains optional Session and native call identity when normalizing AppError', () => {
    expect(appError('tool_failed', 'tool', 'Tool failed.')).toEqual({
      code: 'tool_failed', category: 'tool', message: 'Tool failed.', retryable: false,
    });
    expect(appError('tool_failed', 'tool', 'Tool failed.', false, 3, 2, 'native-call-1')).toEqual({
      code: 'tool_failed', category: 'tool', message: 'Tool failed.', retryable: false,
      runId: 3, sessionId: 2, toolCallId: 'native-call-1',
    });
  });

  it('exposes versioned P3 snapshots without changing the P2 record shape', () => {
    const documentRef = { id: 1, version: 'fixture-v1' } as const;
    const workspaceInput: WorkspaceInput = { documentRef, job: null, candidate: null };
    const context: WorkspaceContext = {
      formatVersion: 1, revision: 2, documentRef, jobId: null, candidateRef: null,
      sessionId: 3, activeView: 'original', selection: null,
    };
    const input: InputRecordV2 = {
      version: 2, goal: 'read invoice', text: 'invoice', messageTimestamp: 1, workspaceInput,
    };
    const usage: UsageRecordV2 = {
      version: 2, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: 0,
      attemptsComplete: true, costSource: null, updatedAt: '2026-09-28T00:00:00.000Z', calls: [],
    };
    const agent: P3AgentConfigFacts = {
      policyVersion: 'p3-invoice-tools-v1', nativeSessionId: 'native-1', systemPrompt: 'system',
      thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only',
      maxContextBytes: 8_388_608, maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288,
      maxModelCalls: 12, maxToolCalls: 24, toolTimeoutMs: 10_000, sessionRetry: false,
    };
    const event: BusinessEventSnapshot = {
      id: 1, type: 'task_started', occurredAt: '2026-09-28T00:00:00.000Z',
      actorSource: 'user', operationRef: 'sequence:1', documentId: 1, jobId: 2,
      candidateId: null, artifactId: null, runId: null, result: 'succeeded',
      safeSummary: 'Task started', errorCode: null,
    };
    const toolCall: ToolCallSnapshot = {
      toolCallId: 1, runId: 4, sessionId: 3, nativeToolCallId: 'native-call-1',
      toolName: 'get_invoice_candidate', toolVersion: '1', effect: 'READ', status: 'succeeded',
      args: { version: 1, raw: { candidateId: 5 }, final: { candidateId: 5 } },
      result: { version: 1, status: 'succeeded', data: { candidateId: 5 }, committedCandidateId: null },
      delivery: { version: 1, state: 'message_observed', messageObservedAt: '2026-09-28T00:00:00.000Z',
        includedInCallSequence: 1, requestDispatchedAt: null, error: null },
      cleanup: { version: 1, stopReason: null, stopped: true, errors: [] },
      requestedAt: '2026-09-28T00:00:00.000Z', startedAt: '2026-09-28T00:00:00.000Z',
      endedAt: '2026-09-28T00:00:00.000Z', stoppedAt: '2026-09-28T00:00:00.000Z',
    };
    expect(WorkspaceContextSchema.safeParse(context).success).toBe(true);
    expect(InputRecordV2Schema.safeParse(input).success).toBe(true);
    expect(InputRecordV2Schema.safeParse({ ...input, sessionId: 9 }).success).toBe(false);
    expect(UsageRecordV2Schema.safeParse(usage).success).toBe(true);
    const callUsage = {
      version: 1 as const, source: 'unknown' as const, reason: null, sdkValues: null,
      attempts: 0, attemptsComplete: true, costSource: null, updatedAt: usage.updatedAt,
    };
    expect(UsageRecordV2Schema.safeParse({ ...usage, calls: Array.from({ length: 13 }, (_, index) => ({
      callSequence: index + 1, usage: callUsage,
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    })) }).success).toBe(false);
    expect(AppErrorSchema.safeParse({
      code: 'tool_failed', category: 'tool', message: 'Tool failed.', retryable: false,
      runId: 4, sessionId: 3, toolCallId: 'native-call-1',
    }).success).toBe(true);
    expect(AppErrorSchema.safeParse({
      code: 'tool_failed', category: 'tool', message: 'Tool failed.', retryable: false,
      toolCallId: '',
    }).success).toBe(false);
    expect([context.selection, input.version, usage.calls.length, agent.maxToolCalls, event.result, toolCall.status])
      .toEqual([null, 2, 0, 24, 'succeeded', 'succeeded']);
  });
});
