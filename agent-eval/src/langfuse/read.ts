import { z } from 'zod';
import { TraceBundleSchema, type TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';
import { langfuseConfig, langfuseConnection, type LangfuseConnection } from '../configuration.ts';
import { isDeepStrictEqual } from 'node:util';
import { usageDetails, type ObservationNode } from './otel.ts';

export type ObservationRow = Record<string, unknown> & { id: string; traceId: string };
export type ObservationRange = { from: string; to: string; traceId?: string; traceIds?: string[] };
type ReadDependencies = { fetcher?: (url: string, init: RequestInit) => Promise<Response> };
const pageSchema = z.object({ data: z.array(z.object({ id: z.string().min(1), traceId: z.string().min(1) }).passthrough()),
  meta: z.object({ cursor: z.string().nullish() }).passthrough() });
export async function queryLangfuseObservations(connection: LangfuseConnection, range: ObservationRange,
  deps: ReadDependencies = {}): Promise<ObservationRow[]> {
  connection = langfuseConnection(connection);
  if (!Number.isFinite(Date.parse(range.from)) || !Number.isFinite(Date.parse(range.to)) || Date.parse(range.from) >= Date.parse(range.to))
    throw Error('Langfuse read requires a bounded time range');
  const rows: ObservationRow[] = [];
  for (const traceId of range.traceIds ?? [range.traceId]) {
    let cursor: string | undefined; const seen = new Set<string>();
    do {
      const url = new URL(connection.baseUrl + '/api/public/v2/observations');
      for (const [key, value] of Object.entries({ fromStartTime: range.from, toStartTime: range.to, traceId, cursor,
        limit: '1000', fields: 'core,basic,time,io,metadata,model,usage,trace_context',
        expandMetadata: 'flowmate,sourceKind,entry,executionId,trialId,runId,sessionId,userId,caseId,caseVersion,datasetId,datasetVersion,environment,repetition,productRoot,operationId,revision,configuration,localObservationId,materials,status,judge,code,originalUsage,inputOmittedReason,inputOmittedSource' }))
        if (value !== undefined) url.searchParams.set(key, value);
      const response = await (deps.fetcher ?? fetch)(url.href, { headers: { Authorization: 'Basic ' +
        Buffer.from(connection.publicKey + ':' + connection.secretKey).toString('base64') }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw Error('Langfuse observation query failed (' + response.status + ')');
      const page = pageSchema.parse(await response.json()); rows.push(...page.data);
      cursor = page.meta.cursor ?? undefined;
      if (cursor && seen.has(cursor)) throw Error('Repeated Langfuse observation cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  return rows;
}
export function parsePlatformValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
function object(value: unknown): Record<string, unknown> {
  value = parsePlatformValue(value); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Confirms original declared facts; transport acceptance and matching IDs alone are insufficient. */
export function matchObservationTree(nodes: ObservationNode[], rows: ObservationRow[]): { complete: boolean; matchedIds: string[]; gaps: string[] } {
  const gaps: string[] = [], matchedIds: string[] = [];
  const localId = (row: ObservationRow) => object(row.metadata).localObservationId;
  const declaredValue = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const metadataValue = (actual: unknown, expected: unknown) => typeof expected === 'string'
    ? typeof actual === 'number' && Number.isSafeInteger(actual) ? String(actual) : actual : parsePlatformValue(actual);
  const ioMatches = (actual: unknown, expected: unknown) => expected === undefined ? actual === undefined || actual === null
    : actual !== undefined && isDeepStrictEqual(parsePlatformValue(actual), declaredValue(expected));
  for (const node of nodes) {
    const matches = rows.filter(row => row.traceId === node.traceId && localId(row) === node.id);
    if (matches.length !== 1) { gaps.push(node.id + ': missing or duplicate observation'); continue; }
    const row = matches[0]!, metadata = object(row.metadata), failures: string[] = [];
    if (row.name !== node.name) failures.push('name');
    if (String(row.type).toLowerCase() !== node.type) failures.push('type');
    const start = Date.parse(node.start), end = Date.parse(node.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start ||
      typeof row.startTime !== 'string' || Date.parse(row.startTime) !== start ||
      typeof row.endTime !== 'string' || Date.parse(row.endTime) !== end) failures.push('time');
    const parent = nodes.find(parent => parent.id === node.parentId && parent.traceId === node.traceId);
    const parentRows = parent ? rows.filter(row => row.traceId === parent.traceId && localId(row) === parent.id) : [];
    if (node.parentId ? parentRows.length !== 1 || row.parentObservationId !== parentRows[0]!.id : !!row.parentObservationId) failures.push('parent');
    if (!ioMatches(row.input, node.input) || !ioMatches(row.output, node.output)) failures.push('input/output');
    if (node.model !== undefined && (row.providedModelName ?? row.model) !== node.model) failures.push('model');
    if (node.parameters !== undefined && !isDeepStrictEqual(parsePlatformValue(row.modelParameters), declaredValue(node.parameters))) failures.push('parameters');
    const usage = usageDetails(node.usage), remoteUsage = object(row.usageDetails);
    if (usage && Object.entries(usage).some(([key, value]) => remoteUsage[key] !== value)) failures.push('declared usage');
    for (const [key, expected] of Object.entries(node.metadata)) if (expected !== undefined &&
      !isDeepStrictEqual(metadataValue(metadata[key], expected), declaredValue(expected))) failures.push('metadata.' + key);
    if (failures.length) gaps.push(node.id + ': differing ' + failures.join(', ')); else matchedIds.push(node.id);
  }
  const targetRows = rows.filter(row => nodes.some(node => node.traceId === row.traceId));
  if (new Set(targetRows.map(row => row.traceId + ':' + row.id)).size !== targetRows.length) gaps.push('Duplicate remote span identities');
  if (targetRows.some(row => !nodes.some(node => node.traceId === row.traceId && node.id === localId(row)))) gaps.push('Unexpected remote observation');
  return { complete: nodes.length > 0 && matchedIds.length === nodes.length && gaps.length === 0, matchedIds, gaps };
}
export async function pullLangfuseTraces(repo: string, range: ObservationRange & { entry?: TraceBundle['entry'] },
  deps: ReadDependencies & { connection?: LangfuseConnection } = {}): Promise<TraceBundle[]> {
  const rows = await queryLangfuseObservations(deps.connection ?? langfuseConfig(repo), range, deps);
  const bundles: TraceBundle[] = [];
  for (const traceId of new Set(rows.map(row => row.traceId))) {
    if (!/^[a-f0-9]{32}$/i.test(traceId)) throw Error('Unsupported Langfuse trace identity');
    const observations = rows.filter(row => row.traceId === traceId), roots = observations.filter(row => !row.parentObservationId);
    const root = roots[0] ?? observations[0]!, metadata = Object.fromEntries(Object.entries(object(root.metadata)).map(([k, v]) =>
      [k, ['executionId', 'trialId', 'runId', 'sessionId', 'productRoot', 'operationId'].includes(k)
        && (typeof v === 'string' || typeof v === 'number' && Number.isSafeInteger(v)) ? String(v) : parsePlatformValue(v)]));
    if (range.entry && metadata.entry !== range.entry) continue;
    const gaps: string[] = [], input = object(root.input), ids = new Set(observations.map(row => row.id));
    if (roots.length !== 1) gaps.push('Missing or multiple root observations');
    if (ids.size !== observations.length) gaps.push('Duplicate observation identities');
    if (observations.some(row => row.parentObservationId && !ids.has(String(row.parentObservationId)))) gaps.push('Missing observation parent');
    if (observations.some(row => !row.endTime)) gaps.push('Unfinished observations');
    if (observations.some(row => {
      const declared = object(row.metadata), omitted = String(row.type).toLowerCase() === 'evaluator' &&
        parsePlatformValue(declared.flowmate) === true && declared.sourceKind === 'evaluation' &&
        declared.inputOmittedReason === 'independent-quality-reference' && declared.inputOmittedSource === 'local-judge-request';
      return (!omitted && (row.input === undefined || row.input === null)) || row.output === undefined || row.output === null;
    }))
      gaps.push('Missing original observation input/output');
    for (const row of observations) {
      const visited = new Set<string>([row.id]); let parent = row.parentObservationId;
      while (typeof parent === 'string' && ids.has(parent)) {
        if (visited.has(parent)) { gaps.push('Cyclic observation parent'); break; }
        visited.add(parent); parent = observations.find(item => item.id === parent)?.parentObservationId;
      }
    }
    const sourceKind = metadata.sourceKind === 'evaluation' ? 'evaluation' : 'product';
    if (metadata.flowmate !== true || !['product', 'evaluation'].includes(String(metadata.sourceKind)) ||
      !(sourceKind === 'evaluation' ? metadata.executionId && metadata.trialId : metadata.runId || metadata.sessionId)) gaps.push('Unsupported Flowmate provenance');
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) gaps.push('Missing original root input');
    if (root.output === undefined || root.output === null) gaps.push('Missing original root output');
    const materials = Array.isArray(metadata.materials) ? metadata.materials : Array.isArray(input.materials) ? input.materials.map((raw, i) => {
      const m = object(raw); return { id: String(m.id ?? (m.sample && m.file ? m.sample + ':' + m.file : m.sample ?? i)),
        ...(typeof (m.path ?? m.file) === 'string' ? { path: m.path ?? m.file } : {}),
        ...(typeof m.text === 'string' ? { text: m.text } : {}), ...(typeof m.content === 'string' ? { content: m.content } : {}),
        ...(m.encoding === 'utf8' || m.encoding === 'base64' ? { encoding: m.encoding } : {}) };
    }) : [];
    if (!Array.isArray(input.materials) && !Array.isArray(metadata.materials)) gaps.push('Missing original materials');
    if (materials.some(raw => { const m = object(raw); return m.text === undefined && m.content === undefined; })) gaps.push('Missing material contents');
    const entry = ['chats', 'invoices', 'research', 'evaluation'].includes(String(metadata.entry)) ? metadata.entry as TraceBundle['entry'] : 'evaluation';
    if (!['chats', 'invoices', 'research', 'evaluation'].includes(String(metadata.entry))) gaps.push('Missing or unsupported source entry');
    const configuration = object(metadata.configuration); if (!Object.keys(configuration).length) gaps.push('Missing execution configuration');
    const startedAt = typeof root.startTime === 'string' && Number.isFinite(Date.parse(root.startTime)) ? root.startTime : range.from;
    if (startedAt === range.from && root.startTime !== range.from) gaps.push('Missing root start time');
    const endedAt = typeof root.endTime === 'string' ? root.endTime : null;
    const events = observations.filter(row => row !== root).map(row => {
      const kind = typeof row.type === 'string' ? row.type.toLowerCase() : 'span';
      if (!['agent', 'generation', 'tool', 'span', 'evaluator'].includes(kind)) gaps.push('Unsupported observation type: ' + kind);
      if (typeof row.name !== 'string' || !row.name.trim()) gaps.push('Missing observation name');
      return { id: row.id, ...(row.parentObservationId && row.parentObservationId !== root.id ? { parentId: row.parentObservationId } : {}),
        kind, name: row.name, startedAt: row.startTime, endedAt: row.endTime, input: parsePlatformValue(row.input), output: parsePlatformValue(row.output),
        model: row.providedModelName ?? row.model, parameters: parsePlatformValue(row.modelParameters), usage: row.usageDetails };
    });
    const candidate = { id: traceId.replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5'),
      revision: typeof metadata.revision === 'number' ? metadata.revision : 1,
      source: { kind: sourceKind, ...Object.fromEntries(['executionId', 'trialId', 'runId', 'sessionId', 'userId', 'productRoot', 'operationId'].flatMap(key => typeof metadata[key] === 'string' ? [[key, metadata[key]]] : [])) },
      entry, startedAt, endedAt, input: { prompt: typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt : '[Original input unavailable]',
        ...(Array.isArray(input.turns) ? { turns: input.turns } : {}), ...(Array.isArray(input.materials) ? { materials: input.materials } : {}) },
      output: parsePlatformValue(root.output), status: metadata.status ?? (endedAt ? 'completed' : 'running'), complete: gaps.length === 0, gaps,
      configuration, events, facts: { langfuseObservations: observations }, materials };
    bundles.push(TraceBundleSchema.parse(candidate));
  }
  return bundles;
}
