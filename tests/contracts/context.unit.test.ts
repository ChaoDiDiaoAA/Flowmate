import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import * as contracts from '../../packages/contracts/src/index.ts';

const at = '2026-10-03T00:00:00.000Z';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function schema(name: string): z.ZodType<unknown> {
  const found: unknown = Reflect.get(contracts, name);
  expect(found, `${name} must be exported`).toBeInstanceOf(z.ZodType);
  if (!(found instanceof z.ZodType)) throw new Error(`Missing ${name}`);
  return found;
}
const projection = { taskGoal: null, candidate: null, fragments: [], issues: [], gaps: [] };
const budgets = { projectionBytes: 65536, fragmentBytes: 4096, fragments: 32, issueCount: 20, snapshotBytes: 262144 };
const json = { version: 1, policyVersion: 'p8-context-v1', text: 'Explain the tax amount.', goalMode: 'answer',
  workingDirectory: null, workspaceContext: null, allowedDocumentIds: [], allowedArtifactIds: [],
  resourcePolicy: 'none', modelProjection: projection, budgets };
const snapshot = { id: 51, sessionId: 5, runId: 31, jobId: null, sequence: 1, json, createdAt: at };
const publicJson = { version: 1, policyVersion: 'p8-context-v1', text: json.text, goalMode: 'answer',
  workspaceContext: null, hasWorkingDirectory: false, resourcePolicy: 'none', modelProjection: projection, budgets };
const publicSnapshot = { ...snapshot, json: publicJson };
const input = { inputId: 100, sessionId: 5, clientSequence: 1, mode: 'prompt', goalMode: 'answer', runId: 31,
  status: 'consumed', processingStatus: 'pending', nativeEntryId: 'e100', resultEntryId: null,
  dispatchedAt: at, createdAt: at, updatedAt: at, error: null };
const source = { documentId: 7, version: 'vA', artifactId: 9, page: 1, blockId: 'b6', quote: 'Tax 13.00' };
const fragment = { documentRef: { id: 7, version: 'vA' }, artifactId: 9, page: 1, blockId: 'b6',
  reasons: ['candidate-source'], sources: [source], windows: [{ start: 0, end: 9, text: 'Tax 13.00' }],
  originalBytes: 9, includedBytes: 9, truncated: false };
const field = { raw: '13.00', normalized: '13.00', state: 'present', alternatives: [], sources: [source] };
const userBinding = { originRunId: 31, inputId: 100, nativeEntryId: 'e100', snapshotId: 51 };
const toolBinding = { nativeToolCallId: 'call_1', toolCallId: 71, originRunId: 30,
  context: { snapshotId: 50, requestSequence: 1 } };
const binding = { runId: 31, sessionId: 5, nativeSessionId: 'native-5', requestSequence: 1, callSequence: 1,
  inputId: 100, snapshotId: 51, includedBindings: [userBinding], includedToolResults: [toolBinding], includedNativeContexts: [] };
const attempt = { attempt: 1, preparedAt: at, enteredAt: null, responseAt: null, responseStatus: null,
  transportErrorCode: null, nativeRequestId: null, wireInclusion: 'confirmed', wireReason: null };
const request = { binding, api: 'openai-responses', boundAt: at,
  sdkPayload: { observedAt: null, inclusion: 'unavailable', reason: 'payload_codec_unavailable' },
  transport: 'observed-fetch', attempts: [] };
const summary = { id: 51, sessionId: 5, runId: 31, jobId: null, sequence: 1, createdAt: at, inputId: 100,
  mode: 'prompt', documentRef: null, candidateRef: null, selection: null, fragmentCount: 0, gapCount: 0 };

describe('P9 T01 native context evidence', () => {
  // These catch legacy backfill, new writers omitting proof, or derived messages forging Input identity.
  it('distinguishes legacy native context evidence from explicit empty arrays', () => {
    const { includedNativeContexts: _omitted, ...legacyBinding } = binding;
    const legacy = { version: 1, requests: [{ ...request, binding: legacyBinding }] };
    const bytesBefore = JSON.stringify(legacy);
    expect(JSON.stringify(schema('ContextObservationsSchema').parse(legacy))).toBe(bytesBefore);
    const reordered = { requests: [{ attempts: [], transport: request.transport, sdkPayload: request.sdkPayload,
      boundAt: at, api: request.api, binding: legacyBinding }], version: 1 };
    expect(JSON.stringify(schema('ContextObservationsSchema').parse(reordered))).toBe(JSON.stringify(reordered));
    const read = Reflect.get(contracts, 'readContextObservations');
    expect(read).toBeFunction();
    expect(read(legacy)).toMatchObject({ ok: true, data: { requests: [{ binding: { includedNativeContexts: null } }] } });
    expect(JSON.stringify(legacy)).toBe(bytesBefore);
    expect(read(legacy, 'p9-native-history-v1')).toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
    expect(read({ version: 1, requests: [request] }, 'p9-native-history-v1')).toMatchObject({ ok: true,
      data: { requests: [{ binding: { includedNativeContexts: [] } }] } });
    expect(schema('RequestContextBindingSchema').safeParse(legacyBinding).success).toBe(false);
    const derived = { nativeEntryId: 'custom-entry', originSessionId: 2, entryType: 'custom_message', messageRole: 'custom',
      contextMessageIndex: 0, referenceEntryIds: [] };
    expect(schema('NativeDerivedContextBindingSchema').safeParse(derived).success).toBe(true);
    for (const patch of [{ inputId: 100 }, { snapshotId: 51 }, { contextMessageIndex: -1 },
      { contextMessageIndex: Number.MAX_SAFE_INTEGER + 1 }, { entryType: 'compaction' }, { referenceEntryIds: ['root'] }])
      expect(schema('NativeDerivedContextBindingSchema').safeParse({ ...derived, ...patch }).success).toBe(false);
    const validator = schema('RequestContextBindingSchema');
    expect(validator.safeParse({ ...binding, includedToolResults: Array(510).fill(toolBinding), includedNativeContexts: [derived] }).success).toBe(true);
    expect(validator.safeParse({ ...binding, includedToolResults: Array(511).fill(toolBinding), includedNativeContexts: [derived] }).success).toBe(false);
    const publicPage = { sessionId: 5, runId: 31, collection: 'collected',
      items: [{ ...request, binding: { ...legacyBinding, includedNativeContexts: null } }], nextBeforeRequestSequence: null };
    expect(schema('ContextRequestsResultSchema').safeParse({ ok: true, data: publicPage }).success).toBe(true);
    expect(schema('ContextRequestsResultSchema').safeParse({ ok: true, data: { ...publicPage, items: legacy.requests } }).success).toBe(false);
  });
});

describe('P8 Context strict contracts', () => {
  it('rejects malformed or impossible fact dates without throwing', () => {
    const validator = schema('ContextSnapshotSchema');
    for (const createdAt of ['not-time', '2026-02-30T00:00:00.000Z', '2026-10-03T25:00:00.000Z']) {
      expect(validator.safeParse({ ...snapshot, createdAt }).success).toBe(false);
    }
  });
  it('accepts empty business snapshots and rejects unknown or unsafe identity fields', () => {
    const validator = schema('ContextSnapshotSchema');
    expect(validator.safeParse(snapshot).success).toBe(true);
    for (const patch of [{ id: 0 }, { runId: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { extra: true },
      { json: { ...json, sdk: {} } }, { json: { ...json, policyVersion: 'later' } },
      { json: { ...json, budgets: { ...budgets, fragments: 33 } } }]) {
      expect(validator.safeParse({ ...snapshot, ...patch }).success).toBe(false);
    }
    expect(schema('ContextReferenceSchema').safeParse({ snapshotId: 51, requestSequence: 1 }).success).toBe(true);
    expect(schema('ContextReferenceSchema').safeParse({ snapshotId: 51, requestSequence: 0 }).success).toBe(false);
    expect(schema('ContextBuildResultSchema').safeParse({ snapshot, promptText: 'frozen prompt' }).success).toBe(true);
  });

  it('allows only registered unique candidate paths and stored human provenance', () => {
    const validator = schema('ContextProjectionSchema');
    const candidate = { id: 42, sequence: 3, origin: 'model', statusAtSelection: 'generated',
      values: [{ fieldPath: 'fields.taxAmount', value: field }] };
    expect(validator.safeParse({ ...projection, candidate }).success).toBe(true);
    for (const fieldPath of ['fields.fake', 'lines.00.taxAmount', 'lines.200.taxAmount', 'lines.0.fake']) {
      expect(validator.safeParse({ ...projection, candidate: { ...candidate, values: [{ fieldPath, value: field }] } }).success).toBe(false);
    }
    expect(validator.safeParse({ ...projection, candidate: { ...candidate, values: [...candidate.values, ...candidate.values] } }).success).toBe(false);
    expect(validator.safeParse({ ...projection, candidate: { ...candidate, origin: 'human_edit', values: [
      { fieldPath: 'fields.taxAmount', value: { ...field, sources: [], valueOrigin: 'user-provided' } },
    ] } }).success).toBe(true);
    expect(validator.safeParse({ ...projection, candidate: { ...candidate, values: [
      { fieldPath: 'fields.taxAmount', value: { ...field, valueOrigin: 'user-provided' } },
    ] } }).success).toBe(false);
  });

  it('counts independent UTF8 windows exactly and rejects overlap duplicate sources or reasons', () => {
    const validator = schema('ContextFragmentSchema');
    expect(validator.safeParse(fragment).success).toBe(true);
    const unicode = { ...fragment, sources: [], windows: [{ start: 0, end: 2, text: '😀' },
      { start: 3, end: 4, text: '税' }], originalBytes: 8, includedBytes: 7, truncated: true };
    expect(validator.safeParse(unicode).success).toBe(true);
    for (const patch of [{ includedBytes: 3 }, { originalBytes: 6 }, { reasons: ['selection', 'selection'] },
      { sources: [source, source] }, { sources: [{ ...source, artifactId: 10 }] },
      { windows: [{ start: 0, end: 0, text: '' }] }, { windows: [{ start: 0, end: 2, text: 'a' }] },
      { windows: [{ start: 1, end: 2, text: 'a' }, { start: 0, end: 1, text: 'b' }], includedBytes: 2 },
      { windows: [{ start: 0, end: 2, text: 'ab' }, { start: 1, end: 2, text: 'b' }], includedBytes: 3 }]) {
      expect(validator.safeParse({ ...fragment, ...patch }).success).toBe(false);
    }
    expect(validator.safeParse({ ...fragment, sources: [], windows: [], originalBytes: 0, includedBytes: 0 }).success).toBe(true);
    expect(validator.safeParse({ ...fragment, sources: [], windows: [{ start: 0, end: 4096, text: 'x'.repeat(4096) }],
      originalBytes: 4096, includedBytes: 4096 }).success).toBe(true);
    expect(validator.safeParse({ ...fragment, sources: [], windows: [{ start: 0, end: 4097, text: 'x'.repeat(4097) }],
      originalBytes: 4097, includedBytes: 4097 }).success).toBe(false);
  });

  it('limits the whole escaped projection and snapshot JSON without trimming text', () => {
    const validator = schema('ContextProjectionSchema');
    const base = { ...projection, taskGoal: '' };
    const exact = { ...base, taskGoal: 'x'.repeat(65536 - bytes(base)) };
    expect(bytes(exact)).toBe(65536);
    expect(validator.safeParse(exact).success).toBe(true);
    expect(validator.safeParse({ ...exact, taskGoal: exact.taskGoal + 'x' }).success).toBe(false);
    expect(validator.safeParse({ ...projection, taskGoal: '\u0000'.repeat(11000) }).success).toBe(false);
    expect(validator.safeParse({ ...projection, fragments: Array.from({ length: 33 }, (_, i) => ({ ...fragment, blockId: `b${i + 1}`,
      sources: [] })) }).success).toBe(false);
    const issue = { code: 'missing', severity: 'warning', origin: 'rule', fieldPaths: [], message: 'Missing value.', rule: null };
    expect(validator.safeParse({ ...projection, issues: Array(21).fill(issue) }).success).toBe(false);
    expect(schema('ContextSnapshotJsonSchema').safeParse({ ...json, text: '税'.repeat(21667) }).success).toBe(false);
    expect(schema('ContextSnapshotJsonSchema').safeParse({ ...json, text: '\u0000'.repeat(50000) }).success).toBe(false);
  });

  it('keeps fill snapshots as references and validates build and material structures', () => {
    const validator = schema('ContextSnapshotJsonSchema');
    const candidate = { id: 42, sequence: 3, origin: 'model', statusAtSelection: 'generated', values: [] };
    const workspaceContext = { formatVersion: 1, revision: 4, sessionId: 5, documentRef: { id: 7, version: 'vA' },
      jobId: 12, candidateRef: { id: 42, sequence: 3 }, activeView: 'candidate', selection: null };
    const fill = { ...json, goalMode: 'fill-form', workspaceContext, allowedDocumentIds: [7], allowedArtifactIds: [9],
      modelProjection: { ...projection, candidate } };
    expect(validator.safeParse(fill).success).toBe(true);
    expect(validator.safeParse({ ...fill, modelProjection: { ...projection, candidate, fragments: [fragment] } }).success).toBe(false);
    expect(validator.safeParse({ ...fill, modelProjection: { ...projection, candidate: { ...candidate,
      values: [{ fieldPath: 'fields.taxAmount', value: field }] } } }).success).toBe(false);
    const build = { runId: 31, sessionId: 5, jobId: null, text: json.text, goalMode: 'answer', workspaceContext: null,
      workspaceInput: null, allowedDocumentIds: [], allowedArtifactIds: [], workingDirectory: null, createdAt: at };
    expect(schema('ContextBuildRequestSchema').safeParse(build).success).toBe(true);
    expect(schema('ContextBuildRequestSchema').safeParse({ ...build, snapshotId: 51 }).success).toBe(false);
    expect(schema('ContextBuildRequestSchema').safeParse({ ...build, workspaceContext }).success).toBe(false);
    expect(schema('ContextMaterialRequestSchema').safeParse({ documentRef: fragment.documentRef,
      allowedDocumentIds: [7], allowedArtifactIds: [9] }).success).toBe(true);
    const document = { documentRef: fragment.documentRef, displayName: 'Invoice', isHidden: false, status: 'available',
      pageCount: 1, originalArtifactId: 8, parsedArtifactId: 9, warnings: [], unavailableReason: null, createdAt: at, updatedAt: at };
    const material = { document, parsed: { formatVersion: 2, pages: [{ page: 1, blocks: [] }],
      completeness: { status: 'complete', checks: [], warnings: [] } } };
    expect(schema('ContextParsedMaterialSchema').safeParse(material).success).toBe(true);
    expect(schema('ContextParsedMaterialSchema').safeParse({ ...material, parsed: { ...material.parsed, sdk: {} } }).success).toBe(false);
  });

  it('permits verified legacy binding shapes without making them a current primary source', () => {
    const user = schema('NativeInputContextBindingSchema');
    for (const originRunId of [null, 30]) expect(user.safeParse({ originRunId, inputId: null,
      nativeEntryId: 'old-entry', snapshotId: null }).success).toBe(true);
    expect(user.safeParse({ ...userBinding, originRunId: null }).success).toBe(false);
    expect(user.safeParse({ ...userBinding, inputId: null }).success).toBe(false);
    expect(user.safeParse({ ...userBinding, nativeEntryId: 'x'.repeat(257) }).success).toBe(false);
    const tool = schema('NativeToolResultContextBindingSchema');
    expect(tool.safeParse({ nativeToolCallId: 'old-call', toolCallId: null, originRunId: null, context: null }).success).toBe(true);
    expect(tool.safeParse({ ...toolBinding, context: null }).success).toBe(true);
    expect(tool.safeParse({ ...toolBinding, originRunId: null }).success).toBe(false);
    expect(tool.safeParse({ ...toolBinding, toolCallId: null }).success).toBe(false);
    expect(schema('RequestContextBindingSchema').safeParse({ ...binding, includedBindings: [
      { originRunId: null, inputId: null, nativeEntryId: 'old', snapshotId: null },
    ] }).success).toBe(false);
  });

  it('uses the last current Run nonnull user and caps the combined provenance at 512', () => {
    const validator = schema('RequestContextBindingSchema');
    expect(validator.safeParse(binding).success).toBe(true);
    const newer = { ...userBinding, inputId: 101, nativeEntryId: 'e101', snapshotId: 52 };
    expect(validator.safeParse({ ...binding, includedBindings: [userBinding, newer] }).success).toBe(false);
    expect(validator.safeParse({ ...binding, inputId: 101, snapshotId: 52, includedBindings: [userBinding, newer] }).success).toBe(true);
    expect(validator.safeParse({ ...binding, callSequence: 2 }).success).toBe(false);
    expect(validator.safeParse({ ...binding, nativeSessionId: 'x'.repeat(257) }).success).toBe(false);
    const tools = Array(511).fill(toolBinding);
    expect(validator.safeParse({ ...binding, includedToolResults: tools }).success).toBe(true);
    expect(validator.safeParse({ ...binding, includedToolResults: [...tools, toolBinding] }).success).toBe(false);
    expect(validator.safeParse({ ...binding, includedToolResults: [toolBinding, toolBinding] }).success).toBe(true);
  });

  it('requires explicit evidence reasons safe API identifiers and registered error codes', () => {
    const validator = schema('ContextRequestEvidenceSchema');
    expect(validator.safeParse(request).success).toBe(true);
    expect(validator.safeParse({ ...request, api: 'a'.repeat(64) }).success).toBe(true);
    for (const api of ['a'.repeat(65), 'https://secret.example', 'UPPER', {}])
      expect(validator.safeParse({ ...request, api }).success).toBe(false);
    for (const sdkPayload of [{ observedAt: at, inclusion: 'confirmed', reason: 'body_unavailable' },
      { observedAt: at, inclusion: 'confirmed', reason: null, sdk: {} },
      { observedAt: null, inclusion: 'unavailable', reason: null },
      { observedAt: null, inclusion: 'unavailable', reason: 'unknown' }]) {
      expect(validator.safeParse({ ...request, sdkPayload }).success).toBe(false);
    }
    expect(schema('ContextSafeErrorCodeSchema').safeParse('provider_transport_error').success).toBe(true);
    expect(schema('ContextSafeErrorCodeSchema').safeParse('storage_write_failed').success).toBe(true);
    expect(schema('ContextSafeErrorCodeSchema').safeParse('internal_error').success).toBe(true);
    for (const code of ['runtime_interrupted', 'agent_model_call_budget', 'agent_unexpected_continuation'])
      expect(schema('ContextSafeErrorCodeSchema').safeParse(code).success).toBe(true);
    for (const code of ['safe_looking_but_unregistered', 'request body secret', 'x'.repeat(129)])
      expect(schema('ContextSafeErrorCodeSchema').safeParse(code).success).toBe(false);
  });

  it('keeps initial bound requests free of invented SDK payload observations', () => {
    const unobserved = { ...request, sdkPayload: null, attempts: [] };
    expect(schema('ContextRequestEvidenceSchema').safeParse(unobserved).success).toBe(true);
    expect(schema('ContextObservationsSchema').safeParse({ version: 1, requests: [unobserved] }).success).toBe(true);
    expect(schema('ContextRequestsResultSchema').safeParse({ ok: true, data: {
      sessionId: 5, runId: 31, collection: 'collected', items: [unobserved], nextBeforeRequestSequence: null,
    } }).success).toBe(true);
    const { sdkPayload: _omitted, ...missing } = request;
    expect(schema('ContextRequestEvidenceSchema').safeParse(missing).success).toBe(false);
    expect(schema('ContextRequestEvidenceSchema').safeParse({ ...request,
      sdkPayload: { observedAt: null, inclusion: 'confirmed', reason: null } }).success).toBe(false);
    expect(schema('ContextRequestEvidenceSchema').safeParse({ ...request,
      sdkPayload: { observedAt: at, inclusion: 'unavailable', reason: 'payload_codec_unavailable' } }).success).toBe(true);
  });

  it('separates prepared entered response and transport failure facts', () => {
    const validator = schema('ContextTransportEvidenceSchema');
    expect(validator.safeParse(attempt).success).toBe(true);
    // Response can be durable when entered persistence failed; never backfill the missing time.
    expect(validator.safeParse({ ...attempt, responseAt: at, responseStatus: 200, nativeRequestId: 'req-1' }).success).toBe(true);
    for (const patch of [{ attempt: 3 }, { responseAt: at }, { responseStatus: 200 }, { nativeRequestId: 'req-1' },
      { wireInclusion: 'unavailable' }, { transportErrorCode: 'arbitrary_sdk_error' },
      { responseAt: at, responseStatus: 200, transportErrorCode: 'provider_transport_error' }]) {
      expect(validator.safeParse({ ...attempt, ...patch }).success).toBe(false);
    }
    expect(validator.safeParse({ ...attempt, transportErrorCode: 'provider_transport_error' }).success).toBe(true);
    expect(validator.safeParse({ ...attempt, wireInclusion: 'unavailable', wireReason: 'body_unavailable' }).success).toBe(true);
    expect(schema('ContextRequestEvidenceSchema').safeParse({ ...request, transport: 'not-observable', attempts: [attempt] }).success).toBe(false);
    expect(schema('ContextRequestEvidenceSchema').safeParse({ ...request, attempts: [{ ...attempt, attempt: 2 }] }).success).toBe(false);
    expect(schema('ContextRequestEvidenceSchema').safeParse({ ...request, attempts: [attempt, { ...attempt, attempt: 2 }] }).success).toBe(true);
    expect(schema('ContextEvidenceUpdateSchema').safeParse({ kind: 'response', attempt: 1, at, status: 200, nativeRequestId: null }).success).toBe(true);
    expect(schema('ContextEvidenceUpdateSchema').safeParse({ kind: 'transport-failed', attempt: 1, at, code: 'raw_sdk_exception' }).success).toBe(false);
  });

  it('keeps journal request sequences continuous and bounds total serialized evidence', () => {
    const validator = schema('ContextObservationsSchema');
    expect(validator.safeParse({ version: 1, requests: [] }).success).toBe(true);
    const requests = Array.from({ length: 64 }, (_, i) => ({ ...request,
      binding: { ...binding, requestSequence: i + 1, callSequence: i + 1 } }));
    expect(validator.safeParse({ version: 1, requests }).success).toBe(true);
    expect(validator.safeParse({ version: 1, requests: [requests[1]] }).success).toBe(false);
    expect(validator.safeParse({ version: 1, requests: [request, request] }).success).toBe(false);
    expect(validator.safeParse({ version: 1, requests: [...requests, { ...request,
      binding: { ...binding, requestSequence: 65, callSequence: 65 } }] }).success).toBe(false);
    const large = requests.map(value => ({ ...value, binding: { ...value.binding,
      includedToolResults: Array(511).fill({ ...toolBinding, nativeToolCallId: 'x'.repeat(256) }) } }));
    expect(bytes({ version: 1, requests: large })).toBeGreaterThan(4194304);
    expect(validator.safeParse({ version: 1, requests: large }).success).toBe(false);
  });

  it('preserves v1 and v2 content bytes and requires explicit nullable association', () => {
    const v1 = { version: 1, text: 'Old', workspaceContext: { formatVersion: 1, revision: 0, documentRef: null,
      jobId: null, candidateRef: null, sessionId: 5, activeView: 'parsed', selection: null },
      allowedDocumentIds: [], allowedArtifactIds: [] };
    const v2 = { version: 2, text: 'New', workspaceContext: null, workspaceInput: null,
      allowedDocumentIds: [], allowedArtifactIds: [], promptText: 'unchanged frozen prompt' };
    for (const content of [v1, v2]) {
      const raw = JSON.stringify(content);
      expect(JSON.stringify(contracts.SessionInputContentSchema.parse(content))).toBe(raw);
      const result = contracts.SessionInputSnapshotSchema.safeParse({ ...input, content, contextSnapshotId: null });
      expect(result.success).toBe(true);
      expect(contracts.SessionInputSnapshotSchema.safeParse({ ...input, content, contextSnapshotId: 51 }).success).toBe(true);
      expect(contracts.SessionInputSnapshotSchema.safeParse({ ...input, content }).success).toBe(false);
    }
  });

  it('rejects internal detail fields while preserving user supplied path text', () => {
    const validator = schema('ContextSnapshotDetailSchema');
    const detail = { snapshot: publicSnapshot, input };
    expect(validator.safeParse(detail).success).toBe(true);
    expect(validator.safeParse({ ...detail, snapshot: { ...publicSnapshot, json: { ...publicJson,
      text: 'My path is C:\\user-entered\\file.txt' } } }).success).toBe(true);
    for (const patch of [{ workingDirectory: 'C:\\managed' }, { allowedDocumentIds: [] }, { allowedArtifactIds: [] },
      { thinking: 'secret' }, { sdk: {} }]) {
      expect(validator.safeParse({ ...detail, snapshot: { ...publicSnapshot, json: { ...publicJson, ...patch } } }).success).toBe(false);
    }
    for (const patch of [{ content: json }, { promptText: 'secret' }, { requestHash: 'secret' },
      { error: { code: 'internal_error', category: 'internal', retryable: false, message: 'raw secret' } },
      { error: { code: 'safe_looking_but_unregistered', category: 'internal', retryable: false } },
      { sessionId: 6 }, { runId: 32 }]) {
      expect(validator.safeParse({ ...detail, input: { ...input, ...patch } }).success).toBe(false);
    }
    expect(validator.safeParse({ ...detail, input: { ...input, error: { code: 'internal_error', category: 'internal', retryable: false } } }).success).toBe(true);
    expect(validator.safeParse({ ...detail, input: { ...input, error: { code: 'internal_error', category: 'runtime', retryable: false } } }).success).toBe(false);
  });

  it('keeps page ownership on empty pages and rejects malformed cursors or legacy collections', () => {
    const snapshots = schema('ContextSnapshotsPageSchema');
    expect(snapshots.safeParse({ sessionId: 5, runId: null, items: [], nextBeforeId: null }).success).toBe(true);
    expect(snapshots.safeParse({ items: [], nextBeforeId: null }).success).toBe(false);
    expect(snapshots.safeParse({ sessionId: 5, runId: 31, items: [{ ...summary, sessionId: 6 }], nextBeforeId: null }).success).toBe(false);
    expect(snapshots.safeParse({ sessionId: 5, runId: 31, items: [summary], nextBeforeId: 52 }).success).toBe(false);
    const requests = schema('ContextRequestsPageSchema');
    expect(requests.safeParse({ sessionId: 5, runId: 31, collection: 'not-collected', items: [], nextBeforeRequestSequence: null }).success).toBe(true);
    expect(requests.safeParse({ sessionId: 5, runId: 31, collection: 'collected', items: [], nextBeforeRequestSequence: null }).success).toBe(true);
    expect(requests.safeParse({ sessionId: 5, runId: 31, collection: 'not-collected', items: [request], nextBeforeRequestSequence: null }).success).toBe(false);
    expect(requests.safeParse({ sessionId: 6, runId: 31, collection: 'collected', items: [request], nextBeforeRequestSequence: null }).success).toBe(false);
    expect(schema('ContextSnapshotsRequestSchema').parse({ sessionId: 5 })).toEqual({ sessionId: 5, limit: 20 });
    for (const patch of [{ limit: 21 }, { limit: 0 }, { beforeId: 0 }, { snapshotId: 51 }])
      expect(schema('ContextSnapshotsRequestSchema').safeParse({ sessionId: 5, ...patch }).success).toBe(false);
    expect(schema('ContextSnapshotRequestSchema').safeParse({ sessionId: 5, runId: 31, snapshotId: 51 }).success).toBe(true);
    expect(schema('ContextRequestsRequestSchema').safeParse({ sessionId: 5, runId: 31, beforeRequestSequence: 0 }).success).toBe(false);
  });

  it('counts complete successful Result envelopes and preserves strict failure results', () => {
    const summaries = Array.from({ length: 20 }, (_, i) => ({ ...summary, id: 51 - i,
      documentRef: { id: 7, version: '税'.repeat(512) },
      selection: { formatVersion: 1, kind: 'source', target: 'document', targetId: 7,
        targetVersion: '税'.repeat(512), artifactId: 9, page: 1 } }));
    const page = { sessionId: 5, runId: 31, items: summaries, nextBeforeId: null };
    expect(schema('ContextSnapshotsResultSchema').safeParse({ ok: true, data: page }).success).toBe(true);
    const requestPage = { sessionId: 5, runId: 31, collection: 'collected', items: [request], nextBeforeRequestSequence: null };
    expect(schema('ContextRequestsResultSchema').safeParse({ ok: true, data: requestPage }).success).toBe(true);
    const bulkyRequest = { ...request, binding: { ...binding, includedToolResults: Array(511).fill({ ...toolBinding,
      nativeToolCallId: 'x'.repeat(256) }) } };
    const bulkyPage = { ...requestPage, items: Array.from({ length: 10 }, (_, i) => ({ ...bulkyRequest,
      binding: { ...bulkyRequest.binding, requestSequence: 10 - i, callSequence: 10 - i } })) };
    expect(bytes({ ok: true, data: bulkyPage })).toBeGreaterThan(1048576);
    expect(schema('ContextRequestsResultSchema').safeParse({ ok: true, data: bulkyPage }).success).toBe(false);
    expect(schema('ContextSnapshotResultSchema').safeParse({ ok: true, data: { snapshot: publicSnapshot, input } }).success).toBe(true);
    expect(schema('ContextSnapshotResultSchema').safeParse({ ok: true, data: { snapshot: { ...publicSnapshot,
      json: { ...publicJson, text: '\u0000'.repeat(50000) } }, input } }).success).toBe(false);
    const failure = { ok: false, error: { code: 'context_snapshot_not_found', category: 'input', message: 'Missing snapshot.', retryable: false } };
    expect(schema('ContextSnapshotResultSchema').safeParse(failure).success).toBe(true);
    expect(schema('ContextSnapshotResultSchema').safeParse({ ...failure, extra: true }).success).toBe(false);
    expect(schema('ContextSnapshotResultSchema').safeParse({ ...failure, error: { ...failure.error, retryable: true } }).success).toBe(false);
  });

  it('maps P8 event errors without adding event types and keeps optional trusted tool bindings strict', () => {
    for (const [code, category] of [['context_evidence_too_large', 'runtime'], ['context_binding_unknown', 'runtime'],
      ['context_binding_conflict', 'runtime'], ['context_payload_mismatch', 'runtime'], ['context_snapshot_not_found', 'input'],
      ['provider_transport_error', 'provider']]) {
      const error = { code, category, message: 'Safe product error.', retryable: false };
      expect(contracts.RuntimeEventErrorSchema.safeParse(error).success).toBe(true);
      expect(contracts.RuntimeEventErrorSchema.safeParse({ ...error, retryable: true }).success).toBe(false);
    }
    const toolContext = { runId: 31, sessionId: 5, nativeToolCallId: 'new-call',
      scope: { version: 2, allowedTools: [], allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] },
      signal: new AbortController().signal };
    expect(contracts.ToolExecutionContextSchema.safeParse(toolContext).success).toBe(true);
    expect(contracts.ToolExecutionContextSchema.safeParse({ ...toolContext, requestBinding: binding }).success).toBe(true);
    expect(contracts.ToolExecutionContextSchema.safeParse({ ...toolContext, requestBinding: { ...binding, sessionId: 6 } }).success).toBe(false);
  });
});


it('P9 T04 fix1 admits the actual root entry reference only for compaction', () => {
  const validator = schema('NativeDerivedContextBindingSchema');
  const binding = { nativeEntryId: 'compact', originSessionId: 2, entryType: 'compaction', messageRole: 'compactionSummary',
    contextMessageIndex: 0, referenceEntryIds: ['root'] };
  expect(validator.safeParse(binding).success).toBe(true);
  for (const patch of [
    { entryType: 'branch_summary', messageRole: 'branchSummary' },
    { entryType: 'message', messageRole: 'branchSummary' },
    { entryType: 'custom_message', messageRole: 'custom' },
    { entryType: 'message', messageRole: 'compactionSummary' },
    { referenceEntryIds: ['root', 'root'] },
    { referenceEntryIds: ['ordinary', 'ordinary'] },
    { inputId: 3 },
  ]) expect(validator.safeParse({ ...binding, ...patch }).success).toBe(false);
  expect(validator.safeParse({ ...binding, referenceEntryIds: ['root', 'ordinary'] }).success).toBe(true);
});
