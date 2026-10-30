import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RunSnapshot, ToolCallSnapshot, RuntimeEvent, CompactionObservation, UsageRecord } from '@flowmate/contracts';
import { TraceBundleSchema, type TraceBundle, type TraceMaterialSchema } from '../../contracts/src/evaluation-loop.ts';
import type { ModelTraceObservation } from '../../contracts/src/trace-observation.ts';
import type { z } from 'zod';
import { acquireEvaluationWrite, atomicText, readableTimestamp } from '@flowmate/shared';

export type CapturedRun = Pick<RunSnapshot, 'kind' | 'runId' | 'sessionId' | 'status' | 'input' | 'output' | 'config' |
  'cleanup' | 'createdAt' | 'startedAt' | 'endedAt'> & { parentRunId?: number; originToolCallId?: number; usage?: Readonly<UsageRecord> };
type CapturedTool = Pick<ToolCallSnapshot, 'toolCallId' | 'runId' | 'nativeToolCallId' | 'toolName' | 'status' | 'args' | 'result' |
  'requestedAt' | 'startedAt' | 'endedAt'>;
type Material = z.infer<typeof TraceMaterialSchema>;
type Observation = { id: string; parentId?: string; kind: 'span' | 'generation' | 'tool'; name: string;
  startedAt: string; endedAt: string | null; input?: unknown; output?: unknown; model?: string; usage?: Record<string, number>; parameters?: Record<string, unknown> };
const terminal = new Set(['completed', 'failed', 'cancelled']);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function generationUsage(record: Readonly<UsageRecord> | undefined, callSequence: number, callCount: number) {
  const call = record?.version === 2 ? record.calls.find(call => call.callSequence === callSequence)?.usage
    : callCount === 1 ? record : undefined;
  const usage: Record<string, number> = {};
  if (call?.source === 'sdk' && call.sdkValues) for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
    const value = call.sdkValues[field];
    // Pi initializes missing counters to zero; the contract has no per-field presence proof.
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) usage[field] = value;
  }
  return { ...(Object.keys(usage).length ? { usage } : {}),
    parameters: { usageSource: call?.source ?? 'unknown', usageReason: call ? call.reason : 'model-call-usage-unavailable' } };
}

export function redactTrace<T>(value: T, secrets: readonly string[]): T {
  const visit = (input: unknown): unknown => {
    if (typeof input === 'string') return secrets.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), input);
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key,
      /^(api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)$/i.test(key) ? '[REDACTED]' : visit(item)]));
    return input;
  };
  return visit(value) as T;
}

export function createProductTraceRecorder(options: { workspaceRoot: string; productRoot?: string; enabled(): boolean; secrets?(): readonly string[];
  onComplete?(trace: TraceBundle): void }) {
  const workspace = realpathSync(options.workspaceRoot), directory = join(workspace, 'agent-eval/traces');
  const observations = new Map<number | string, ModelTraceObservation[]>(), saved = new Map<string, string>();
  let scanned = false;
  const key = (run: CapturedRun, productRoot: string | null = options.productRoot ?? null) => JSON.stringify([productRoot, run.runId, run.sessionId, run.createdAt]);
  const maintenanceKey = (operationId: string, sessionId: string, productRoot: string | null = options.productRoot ?? null) => JSON.stringify([productRoot, 'manual', sessionId, operationId]);
  const safe = <T>(value: T) => redactTrace(value, options.secrets?.() ?? []);
  function captured(file: string) {
    if (lstatSync(file).isSymbolicLink()) throw Error('Linked Trace capture');
    const { operations: _, platformSnapshot: __, ...trace } = JSON.parse(readFileSync(file, 'utf8'));
    return TraceBundleSchema.parse(trace);
  }
  function find(identity: string): TraceBundle | undefined {
    const cached = saved.get(identity);
    if (cached) return captured(join(directory, cached));
    if (scanned || !existsSync(directory)) { scanned = true; return; }
    scanned = true;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^Trace-.+\.json$/.test(entry.name)) continue;
      const file = join(directory, entry.name);
      if (!existsSync(file) || lstatSync(file).isSymbolicLink()) continue;
      const parsed = TraceBundleSchema.safeParse(captured(file));
      if (parsed.success && parsed.data.source.kind === 'product') {
        const fact = object(parsed.data.facts.run);
        if (fact) saved.set(key(fact as CapturedRun, parsed.data.source.productRoot ?? null), entry.name);
        if (parsed.data.source.operationId && parsed.data.source.sessionId)
          saved.set(maintenanceKey(parsed.data.source.operationId, parsed.data.source.sessionId, parsed.data.source.productRoot ?? null), entry.name);
      }
    }
    const file = saved.get(identity);
    if (file) return captured(join(directory, file));
  }
  function restoredCalls(prior?: TraceBundle): ModelTraceObservation[] {
    const calls: ModelTraceObservation[] = [];
    if (Array.isArray(prior?.facts.modelCalls)) for (const raw of prior.facts.modelCalls) {
      const meta = object(raw);
      if (!meta || !(typeof meta.runId === 'number' || meta.runId === null && typeof meta.operationId === 'string') || typeof meta.sessionId !== 'number'
        || typeof meta.callSequence !== 'number' || !['request', 'response'].includes(String(meta.phase))
        || typeof meta.at !== 'string' || typeof meta.model !== 'string' || typeof meta.api !== 'string') continue;
      const event = prior.events.map(object).find(event => event?.id === 'model-' + (meta.runId ?? meta.operationId) + '-' + meta.callSequence);
      if (event) calls.push({ ...meta, data: meta.phase === 'request' ? event.input : event.output } as ModelTraceObservation);
    }
    return calls;
  }
  function persist(value: TraceBundle, prior: TraceBundle | undefined, identity: string): TraceBundle {
    if (prior && isDeepStrictEqual(prior, value)) return prior;
    if (prior) value.revision++;
    let resolved = workspace;
    for (const part of ['agent-eval', 'traces']) {
      resolved = join(resolved, part);
      const stat = lstatSync(resolved, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('Linked Trace directory rejected');
      if (!stat) mkdirSync(resolved);
    }
    const boundary = relative(workspace, realpathSync(resolved));
    if (isAbsolute(boundary) || boundary === '..' || boundary.startsWith('..\\') || boundary.startsWith('../')) throw Error('Trace storage escapes evaluation workspace');
    const release = acquireEvaluationWrite(join(resolved, 'collection'));
    try {
      const purpose = value.configuration.purpose === 'native-maintenance' ? 'native-maintenance' : 'task';
      const prefix = 'Trace-' + readableTimestamp(new Date(value.startedAt)) + '-' + (value.entry === 'research' ? 'deep-research' : value.entry) + '-' + purpose;
      let name = saved.get(identity), sequence = 1;
      if (!name) do { name = prefix + '-' + String(sequence++).padStart(2, '0') + '.json'; } while (existsSync(join(resolved, name)));
      const target = join(resolved, name), unlock = acquireEvaluationWrite(target);
      try {
        const previous = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
        if (prior && !isDeepStrictEqual(captured(target), prior)) throw Error('Trace source changed before capture update');
        atomicText(target, JSON.stringify({ ...previous, ...value }, null, 2) + '\n');
        saved.set(identity, name);
      } finally { unlock(); }
    } finally { release(); }
    return value;
  }
  return {
    observeModel(value: ModelTraceObservation): void {
      if (!options.enabled()) return;
      const identity = value.runId === null ? value.operationId : value.runId;
      const calls = observations.get(identity) ?? []; calls.push(JSON.parse(JSON.stringify(safe(value)))); observations.set(identity, calls);
    },
    observeCompaction(operation: CompactionObservation, at = new Date().toISOString()): TraceBundle | null {
      if (!options.enabled() || operation.reason !== 'manual' || operation.runId !== null) return null;
      const identity = maintenanceKey(operation.operationId, String(operation.sessionId)), prior = find(identity), calls = restoredCalls(prior);
      for (const call of observations.get(operation.operationId) ?? []) if (!calls.some(previous => isDeepStrictEqual(previous, call))) calls.push(call);
      const requests = calls.filter(call => call.phase === 'request'), gaps: string[] = [], events: Observation[] = [];
      if (!requests.length) gaps.push('manual-summary-request-missing:' + operation.operationId);
      if (operation.phase !== 'ended') gaps.push('manual-compaction-unfinished:' + operation.operationId);
      if (!operation.stopped) gaps.push('manual-compaction-stop-unconfirmed:' + operation.operationId);
      if (!operation.saved || !operation.entryId || operation.saved.leafId !== operation.entryId) gaps.push('manual-compaction-save-unconfirmed:' + operation.operationId);
      if (!operation.mayContinue) gaps.push('manual-compaction-verification-pending:' + operation.operationId);
      if (!operation.generated || operation.nativeOutcome !== 'succeeded' || operation.error) gaps.push('manual-compaction-not-succeeded:' + operation.operationId);
      for (const request of requests) {
        if (request.runId !== null || request.operationId !== operation.operationId || request.sessionId !== operation.sessionId) throw Error('Foreign manual summary observation');
        const response = calls.find(call => call.phase === 'response' && call.callSequence === request.callSequence && call.sessionId === operation.sessionId);
        const measured = generationUsage(operation.usage, request.callSequence, requests.length);
        if (!response) gaps.push('manual-summary-response-missing:' + operation.operationId + ':' + request.callSequence);
        events.push({ id: 'model-' + operation.operationId + '-' + request.callSequence, kind: 'generation', name: request.model,
          model: request.model, startedAt: request.at, endedAt: response?.at ?? null, input: request.data, output: response?.data,
          ...measured, parameters: { ...measured.parameters, purpose: request.purpose, operationId: operation.operationId } });
      }
      const value = TraceBundleSchema.parse(JSON.parse(JSON.stringify(safe({ id: prior?.id ?? randomUUID(), revision: prior?.revision ?? 1,
        source: { kind: 'product', sessionId: String(operation.sessionId), operationId: operation.operationId,
          ...(options.productRoot ? { productRoot: options.productRoot } : {}) }, entry: 'evaluation',
        startedAt: prior?.startedAt ?? requests[0]?.at ?? at, endedAt: operation.phase === 'ended' ? at : null,
        input: { prompt: JSON.stringify(requests[0]?.data ?? operation), materials: [] }, output: calls.filter(call => call.phase === 'response').at(-1)?.data ?? operation,
        status: operation.nativeOutcome === 'succeeded' ? 'completed' : operation.nativeOutcome === 'cancelled' ? 'cancelled' : operation.nativeOutcome === 'failed' ? 'failed' : 'running',
        complete: gaps.length === 0, gaps, configuration: { purpose: 'native-maintenance', operation: 'manual-compaction',
          inputKind: requests.length ? 'native-summarizer-request' : 'compaction-observation' }, events,
        facts: { compaction: operation, modelCalls: calls.map(({ data: _, ...identity }) => identity) }, materials: [] }))));
      const stored = persist(value, prior, identity);
      if (operation.phase === 'ended') observations.delete(operation.operationId);
      if (stored.complete && (!prior || !prior.complete)) options.onComplete?.(stored);
      return stored;
    },
    complete(input: { run: CapturedRun; tools: CapturedTool[]; events: RuntimeEvent[]; children?: CapturedRun[];
      entry?: TraceBundle['entry']; turns?: NonNullable<TraceBundle['input']['turns']>; materials?: Material[]; gaps?: string[] }): TraceBundle | null {
      const { run } = input;
      if (!options.enabled() || run.kind === 'provider' || !terminal.has(run.status) || !run.endedAt) return null;
      const prior = find(key(run)), id = prior?.id ?? randomUUID(), gaps = [...(input.gaps ?? [])], events: Observation[] = [];
      const runs = [run, ...(input.children ?? [])], material: Material[] = [...(input.materials ?? prior?.materials ?? [])];
      const calls = restoredCalls(prior);
      for (const current of runs) for (const call of observations.get(current.runId) ?? [])
        if (!calls.some(previous => isDeepStrictEqual(previous, call))) calls.push(call);
      for (const current of runs) {
        if (current.cleanup.stopped !== true) gaps.push('run-stop-unconfirmed:' + current.runId);
        if (!current.endedAt) gaps.push('child-run-unfinished:' + current.runId);
        const root = current === run ? undefined : 'run-' + current.runId;
        if (root) events.push({ id: root, parentId: current.originToolCallId ? 'tool-' + current.originToolCallId : undefined,
          kind: 'span', name: 'Subagent ' + current.runId, startedAt: current.startedAt ?? current.createdAt, endedAt: current.endedAt,
          input: current.input, output: current.output });
        const runCalls = calls.filter(call => call.runId === current.runId);
        if (!runCalls.some(call => call.phase === 'request')) gaps.push('model-request-missing:' + current.runId);
        for (const request of runCalls.filter(call => call.phase === 'request')) {
          const response = runCalls.find(call => call.phase === 'response' && call.callSequence === request.callSequence);
          const measured = generationUsage(current.usage, request.callSequence, runCalls.filter(call => call.phase === 'request').length);
          if (!response) gaps.push('model-response-missing:' + current.runId + ':' + request.callSequence);
          events.push({ id: 'model-' + current.runId + '-' + request.callSequence, parentId: root, kind: 'generation',
            name: request.model, model: request.model, startedAt: request.at, endedAt: response?.at ?? null,
            input: request.data, output: response?.data, ...measured,
            parameters: { ...measured.parameters, ...(request.purpose ? { purpose: request.purpose } : {}) } });
          const body = object(request.data), messages = body?.messages;
          if (Array.isArray(messages)) for (const [messageIndex, message] of messages.entries()) {
            const user = object(message); if (user?.role !== 'user') continue;
            const parts = typeof user.content === 'string' ? [{ text: user.content }] : user.content;
            if (Array.isArray(parts)) for (const [partIndex, part] of parts.entries()) {
              const text = object(part)?.text;
              if (typeof text === 'string' && text.trim()) {
                const id = `request-${current.runId}-${request.callSequence}-${messageIndex}-${partIndex}`;
                material.push({ id, path: `materials/${id}/source.txt`, text });
              }
            }
          }
        }
      }
      for (const tool of input.tools) {
        const requests = calls.filter(call => call.runId === tool.runId);
        const model = requests.find(call => call.phase === 'response' && Array.isArray(object(call.data)?.content) &&
          (object(call.data)!.content as unknown[]).some(part => object(part)?.type === 'toolCall' && object(part)?.id === tool.nativeToolCallId));
        if (!tool.endedAt) gaps.push('tool-unfinished:' + tool.toolCallId);
        events.push({ id: 'tool-' + tool.toolCallId, parentId: model ? 'model-' + tool.runId + '-' + model.callSequence :
          tool.runId === run.runId ? undefined : 'run-' + tool.runId, kind: 'tool', name: tool.toolName,
          startedAt: tool.startedAt ?? tool.requestedAt, endedAt: tool.endedAt, input: tool.args, output: tool.result });
      }
      const observedIds = new Set(events.map(event => event.id));
      for (const event of events) if (event.parentId && !observedIds.has(event.parentId)) { gaps.push('parent-observation-missing:' + event.parentId); delete event.parentId; }
      const config = object(run.config.agent);
      const entry = input.entry ?? prior?.entry ?? (input.tools.some(tool => /invoice|candidate/.test(tool.toolName)) ? 'invoices' : 'chats');
      const materials = [...new Map(material.map(item => [item.id, item])).values()];
      const value = TraceBundleSchema.parse(JSON.parse(JSON.stringify(safe({ id, revision: prior?.revision ?? 1, source: { kind: 'product', runId: String(run.runId),
        ...(options.productRoot ? { productRoot: options.productRoot } : {}),
        ...(run.sessionId !== null ? { sessionId: String(run.sessionId) } : {}) }, entry, startedAt: run.startedAt ?? run.createdAt,
        endedAt: run.endedAt, input: { prompt: run.input.text, ...(input.turns ? { turns: input.turns } : {}), materials }, output: run.output, status: run.status,
        complete: gaps.length === 0, gaps: [...new Set(gaps)], configuration: run.config, events,
        facts: { run, runs, tools: input.tools, persistedEvents: input.events, model: config ?? null,
          modelCalls: calls.map(({ data: _, ...identity }) => identity) },
        materials }))));
      const stored = persist(value, prior, key(run));
      for (const current of runs) observations.delete(current.runId);
      if (!prior || !prior.complete && stored.complete) options.onComplete?.(stored);
      return stored;
    },
  };
}
