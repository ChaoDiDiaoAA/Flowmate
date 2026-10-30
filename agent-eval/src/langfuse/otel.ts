import { randomUUID } from 'node:crypto';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { tracing } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor, type LangfuseSpanProcessorParams } from '@langfuse/otel';
import type { LocalReport } from '../reports/store.ts';
import type { LangfuseConnection } from '../configuration.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
import { TraceBundleSchema, type TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';

export type ObservationNode = {
  id: string; traceId: string; parentId?: string; name: string;
  type: 'agent' | 'generation' | 'tool' | 'span' | 'evaluator';
  start: string; end: string; input?: unknown; output?: unknown; model?: string;
  parameters?: Record<string, unknown>; usage?: unknown; metadata: Record<string, unknown>;
};

/** Only original product I/O is projected; independent quality references remain local. */
export function buildObservationTree(report: LocalReport): ObservationNode[] {
  if (report.history || !report.endedAt || report.scoring !== 'complete') throw Error('Only complete original reports may be exported');
  const nodes: ObservationNode[] = [];
  for (const trial of report.trials) {
    const execution = trial.execution, rootId = trial.traceId + ':root';
    const actualEnds = [execution?.endedAt, ...(execution?.observations ?? []).map(observation => observation.endedAt),
      ...trial.judgeCalls.map(call => call.endedAt)].filter((end): end is string => typeof end === 'string');
    const trialEnd = actualEnds.length ? actualEnds.reduce((last, end) => Date.parse(end) > Date.parse(last) ? end : last) : report.endedAt;
    const metadata = { flowmate: true, sourceKind: 'evaluation', entry: 'evaluation', revision: 1,
      executionId: report.executionId, trialId: trial.trialId, caseId: trial.caseId, caseVersion: trial.caseVersion,
      ...(report.runId ? { runId: report.runId } : {}), ...(trial.sessionId ? { sessionId: trial.sessionId } : {}),
      ...(report.userId ? { userId: report.userId } : {}),
      datasetId: report.dataset.id, datasetVersion: report.dataset.version, environment: report.environment,
      repetition: trial.repetition, status: trial.status, code: report.code, configuration: execution?.configuration };
    nodes.push({ id: rootId, traceId: trial.traceId, name: trial.caseName, type: 'agent',
      start: execution?.startedAt ?? report.startedAt, end: trialEnd,
      input: execution?.input, output: { answer: execution?.answer ?? null, endpointReached: execution?.endpointReached ?? false,
        status: trial.status, artifacts: execution?.artifacts ?? [] }, metadata });
    for (const observation of execution?.observations ?? []) {
      if (!observation.endedAt) throw Error('Cannot export unfinished observation: ' + observation.id);
      nodes.push({ id: trial.traceId + ':' + observation.id, traceId: trial.traceId,
        parentId: observation.parentId ? trial.traceId + ':' + observation.parentId : rootId,
        name: observation.name, type: observation.kind, start: observation.startedAt, end: observation.endedAt,
        input: observation.input, output: observation.output, model: observation.model,
        parameters: observation.parameters, usage: observation.usage, metadata });
    }
    for (const call of trial.judgeCalls) nodes.push({ id: trial.traceId + ':judge:' + call.callId, traceId: trial.traceId,
      parentId: rootId, name: 'Judge', type: 'evaluator', start: call.startedAt, end: call.endedAt,
      model: call.configuration.model, usage: call.usageSource === 'unknown' ? undefined : call.usage,
      output: trial.scores.filter(score => score.method === 'llm-judge').map(score => ({ metricId: score.metricId, status: score.status,
        value: score.value, statistics: score.statistics })),
      metadata: { ...metadata, judge: call.configuration, error: call.error, usageSource: call.usageSource,
        originalUsage: call.usageSource === 'unknown' ? undefined : call.usage,
        inputOmittedReason: 'independent-quality-reference', inputOmittedSource: 'local-judge-request' } });
  }
  return validateObservationTree(nodes);
}

export function traceBundleToObservationTree(value: TraceBundle): ObservationNode[] {
  const bundle = TraceBundleSchema.parse(value);
  if (!bundle.complete || bundle.gaps.length || !bundle.endedAt) throw Error('Only complete original Trace bundles may be exported');
  const traceId = bundle.id.replaceAll('-', ''), rootId = traceId + ':root';
  const metadata = { flowmate: true, sourceKind: bundle.source.kind, ...bundle.source, entry: bundle.entry,
    revision: bundle.revision, configuration: bundle.configuration, materials: bundle.materials, status: bundle.status };
  const nodes: ObservationNode[] = [{ id: rootId, traceId, name: 'Flowmate · ' + bundle.entry, type: 'agent',
    start: bundle.startedAt, end: bundle.endedAt, input: bundle.input, output: bundle.output, metadata }];
  for (const raw of bundle.events) {
    if (!raw || typeof raw !== 'object') throw Error('Invalid Trace observation');
    const event = raw as Record<string, unknown>;
    if (typeof event.id !== 'string' || typeof event.name !== 'string' || typeof event.startedAt !== 'string' ||
      typeof event.endedAt !== 'string' || !['agent', 'generation', 'tool', 'span', 'evaluator'].includes(String(event.kind)))
      throw Error('Incomplete Trace observation');
    nodes.push({ id: traceId + ':' + event.id, traceId, parentId: event.parentId ? traceId + ':' + String(event.parentId) : rootId,
      name: event.name, type: event.kind as ObservationNode['type'], start: event.startedAt, end: event.endedAt,
      input: event.input, output: event.output, ...(typeof event.model === 'string' ? { model: event.model } : {}),
      parameters: event.parameters as Record<string, unknown> | undefined, usage: event.usage, metadata });
  }
  return validateObservationTree(nodes);
}
export function sendTraceBundle(bundle: TraceBundle, connection: LangfuseConnection,
  options: Parameters<typeof sendObservationTree>[2] = {}) {
  return sendObservationTree(traceBundleToObservationTree(bundle), connection, options);
}

export function usageDetails(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>, result: Record<string, number> = {};
  // Codex cached input and reasoning output are subsets; Langfuse adds flat buckets.
  if (['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens'].some(key => key in raw)) {
    for (const [target, key] of [['input', 'input_tokens'], ['output', 'output_tokens'], ['total', 'total_tokens']] as const) {
      const count = raw[key];
      if (typeof count === 'number' && Number.isFinite(count) && count >= 0) result[target] = count;
    }
    return Object.keys(result).length ? result : undefined;
  }
  for (const [target, aliases] of Object.entries({ input: ['input', 'inputTokens', 'input_tokens'], output: ['output', 'outputTokens', 'output_tokens'], total: ['total', 'totalTokens', 'total_tokens'],
    cache_read: ['cacheRead', 'cacheReadTokens', 'cached_input_tokens'], cache_creation: ['cacheWrite', 'cacheWriteTokens', 'cache_write_input_tokens'], reasoning: ['reasoning', 'reasoning_output_tokens'] })) {
    const number = aliases.map(key => raw[key]).find(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
    if (typeof number === 'number') result[target] = number;
  }
  return Object.keys(result).length ? result : undefined;
}

export function validateObservationTree(nodes: ObservationNode[]): ObservationNode[] {
  const ids = new Map(nodes.map(node => [node.id, node]));
  if (ids.size !== nodes.length) throw Error('Duplicate observation identity');
  for (const node of nodes) {
    if (!/^[0-9a-f]{32}$/i.test(node.traceId) || !Number.isFinite(Date.parse(node.start)) || !Number.isFinite(Date.parse(node.end)) ||
      Date.parse(node.end) < Date.parse(node.start)) throw Error('Invalid observation identity or timing');
    if (node.parentId && (!ids.has(node.parentId) || ids.get(node.parentId)!.traceId !== node.traceId)) throw Error('Missing or foreign observation parent');
    const visited = new Set<string>([node.id]); let parent = node.parentId;
    while (parent) { if (visited.has(parent)) throw Error('Cyclic observation parent'); visited.add(parent); parent = ids.get(parent)?.parentId; }
  }
  const scanned = scanEvidence(nodes);
  if ((scanned.fact.actual as { leaked: boolean }).leaked) throw Error('Protected data in observation export');
  return scanned.value;
}

/** Isolated provider avoids replacing other application instrumentation or credentials. */
export async function sendObservationTree(nodes: ObservationNode[], connection: LangfuseConnection,
  options: { exporter?: LangfuseSpanProcessorParams['exporter'] } = {}): Promise<{ traceIds: string[]; observationIds: string[] }> {
  nodes = validateObservationTree(nodes);
  let currentTraceId = '';
  const processor = new LangfuseSpanProcessor({ ...connection, exporter: options.exporter, exportMode: 'batched',
    mediaUploadEnabled: false, shouldExportSpan: () => true, additionalHeaders: { 'x-langfuse-ingestion-version': '4' } });
  const provider = new tracing.BasicTracerProvider({ spanProcessors: [processor], idGenerator: {
    generateTraceId: () => currentTraceId, generateSpanId: () => randomUUID().replaceAll('-', '').slice(0, 16),
  } });
  const tracer = provider.getTracer('flowmate'), spans = new Map<string, ReturnType<typeof tracer.startSpan>>();
  const remaining = [...nodes];
  try {
    while (remaining.length) {
      const index = remaining.findIndex(node => !node.parentId || spans.has(node.parentId));
      if (index < 0) throw Error('Observation hierarchy cannot be resolved');
      const node = remaining.splice(index, 1)[0]!; currentTraceId = node.traceId;
      const attributes: Record<string, string> = { 'langfuse.observation.type': node.type,
        'langfuse.trace.name': nodes.find(root => root.traceId === node.traceId && !root.parentId)?.name ?? node.name,
        'langfuse.observation.metadata.localObservationId': node.id };
      if (node.input !== undefined) { attributes['langfuse.observation.input'] = JSON.stringify(node.input);
        if (!node.parentId) attributes['langfuse.trace.input'] = JSON.stringify(node.input); }
      if (node.output !== undefined) { attributes['langfuse.observation.output'] = JSON.stringify(node.output);
        if (!node.parentId) attributes['langfuse.trace.output'] = JSON.stringify(node.output); }
      if (node.model) attributes['langfuse.observation.model.name'] = node.model;
      if (node.parameters) attributes['langfuse.observation.model.parameters'] = JSON.stringify(node.parameters);
      const usage = usageDetails(node.usage);
      if (usage) attributes['langfuse.observation.usage_details'] = JSON.stringify(usage);
      for (const [key, value] of Object.entries(node.metadata)) if (value !== undefined) {
        attributes['langfuse.trace.metadata.' + key] = typeof value === 'string' ? value : JSON.stringify(value);
        attributes['langfuse.observation.metadata.' + key] = typeof value === 'string' ? value : JSON.stringify(value);
      }
      if (typeof node.metadata.environment === 'string') attributes['langfuse.environment'] = node.metadata.environment;
      if (typeof node.metadata.sessionId === 'string') attributes['session.id'] = node.metadata.sessionId;
      if (typeof node.metadata.userId === 'string') attributes['user.id'] = node.metadata.userId;
      const parentContext = node.parentId ? trace.setSpan(ROOT_CONTEXT, spans.get(node.parentId)!) : ROOT_CONTEXT;
      const span = tracer.startSpan(node.name, { startTime: new Date(node.start), attributes }, parentContext);
      spans.set(node.id, span); span.end(new Date(node.end));
    }
    await provider.forceFlush();
    return { traceIds: [...new Set(nodes.map(node => node.traceId))], observationIds: [...spans.values()].map(span => span.spanContext().spanId) };
  } finally { await provider.shutdown(); }
}
