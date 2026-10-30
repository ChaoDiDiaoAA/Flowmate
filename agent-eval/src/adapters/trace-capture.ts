import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CompactionObservationSchema } from '../../../packages/contracts/src/compaction.ts';
import { TraceBundleSchema, type TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';
import type { CaseExecutionResult, Observation } from '../types.ts';

/** Read only this Trial's committed capture; saved Gold never enters this projection. */
export function attachCapturedTrace(execution: CaseExecutionResult, trialDirectory: string): void {
  const directory = join(trialDirectory, 'agent-eval/traces'), bundles: TraceBundle[] = [], gaps: string[] = [];
  const runs = execution.evidence.runs?.actual;
  const originals = Array.isArray(runs) ? runs as Array<{ runId: number; sessionId: number; createdAt: string; kind: string }> : [];
  const sessions = new Set(originals.map(run => run.sessionId));
  const histories = execution.evidence['session-histories']?.actual;
  if (Array.isArray(histories)) for (const fact of histories)
    if (fact?.present === true && typeof fact.actual?.sessionId === 'number') sessions.add(fact.actual.sessionId);
  const operations = execution.evidence['history-operations']?.actual;
  const manual: Array<{ operationId: string; sessionId: number; observation: ReturnType<typeof CompactionObservationSchema.safeParse> }> = [];
  if (Array.isArray(operations)) for (const owner of operations) {
    if (owner?.action !== 'compact-history') continue;
    if (typeof owner.operationId !== 'string' || owner.command?.type !== 'compact_session' || typeof owner.command.input?.sessionId !== 'number'
      || owner.command.input.operationId !== owner.operationId || owner.after?.sessionId !== owner.command.input.sessionId) {
      gaps.push('manual-compaction-original-unavailable'); continue;
    }
    manual.push({ operationId: owner.operationId, sessionId: owner.command.input.sessionId,
      observation: CompactionObservationSchema.safeParse(owner.after.operation) });
  }
  for (const owner of manual) if (!sessions.has(owner.sessionId) || !owner.observation.success ||
    owner.observation.data.operationId !== owner.operationId || owner.observation.data.sessionId !== owner.sessionId ||
    owner.observation.data.reason !== 'manual' || owner.observation.data.runId !== null ||
    owner.observation.data.phase !== 'ended' || !owner.observation.data.stopped || !owner.observation.data.generated || !owner.observation.data.saved)
    gaps.push('manual-compaction-original-unconfirmed:' + owner.operationId);
  if (existsSync(directory)) {
    if (lstatSync(directory).isSymbolicLink()) throw Error('Linked Trace capture root');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^Trace-.+\.json$/.test(entry.name)) continue;
      const file = join(directory, entry.name);
      if (lstatSync(file).isSymbolicLink()) throw Error('Linked Trace capture');
      const bundle = TraceBundleSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      if (bundle.source.kind !== 'product' || bundle.source.productRoot !== join(realpathSync(trialDirectory), 'product') || bundles.some(value => value.id === bundle.id)) throw Error('Foreign Trace capture');
      if (bundle.source.operationId) {
        const owner = manual.find(owner => owner.operationId === bundle.source.operationId && String(owner.sessionId) === bundle.source.sessionId);
        const captured = CompactionObservationSchema.safeParse(bundle.facts.compaction);
        if (!owner || !owner.observation.success || !captured.success || !sessions.has(owner.sessionId) || bundle.source.runId !== undefined) throw Error('Foreign Trace capture');
        const original = owner.observation.data;
        if (['operationId', 'sessionId', 'nativeSessionId', 'runId', 'reason', 'phase', 'generated', 'nativeOutcome', 'entryId', 'saved', 'stopped'].some(key =>
          !isDeepStrictEqual(Reflect.get(captured.data, key), Reflect.get(original, key)))) throw Error('Foreign Trace capture');
      } else {
        const root = originals.find(run => String(run.runId) === bundle.source.runId && String(run.sessionId) === bundle.source.sessionId);
        const fact = bundle.facts.run as { createdAt?: string } | undefined;
        if (!root || root.createdAt !== fact?.createdAt) throw Error('Foreign Trace capture');
      }
      bundles.push(bundle);
    }
  }
  const observations: Observation[] = [], covered = new Set<number>(), capturedOperations = new Set<string>();
  for (const bundle of bundles) {
    gaps.push(...bundle.gaps);
    const maintenance = bundle.source.operationId;
    const rootId = execution.identity.trialId + (maintenance ? ':operation:' + maintenance : ':run:' + bundle.source.runId);
    observations.push({ id: rootId, kind: 'span', name: maintenance ? 'Manual compaction ' + maintenance : bundle.entry + ' Run ' + bundle.source.runId,
      startedAt: bundle.startedAt, endedAt: bundle.endedAt, input: bundle.input, output: bundle.output,
      ...(maintenance ? { parameters: { purpose: 'native-maintenance', operationId: maintenance, sessionId: Number(bundle.source.sessionId) } } : {}) });
    if (maintenance) capturedOperations.add(maintenance);
    const prefix = execution.identity.trialId + ':capture:' + bundle.id + ':';
    for (const value of bundle.events) {
      const event = value as Observation;
      observations.push({ ...event, id: prefix + event.id, parentId: event.parentId ? prefix + event.parentId : rootId });
    }
    const capturedRuns = bundle.facts.runs;
    if (Array.isArray(capturedRuns)) for (const run of capturedRuns) if (originals.some(value => value.runId === run.runId)) covered.add(run.runId);
  }
  for (const run of originals) if (!covered.has(run.runId)) gaps.push('run-capture-missing:' + run.runId);
  for (const owner of manual) if (!capturedOperations.has(owner.operationId)) gaps.push('manual-compaction-capture-missing:' + owner.operationId);
  if (!bundles.length) gaps.push('model-capture-missing');
  if (observations.length) execution.observations = observations;
  execution.evidence['trace-capture'] = { present: gaps.length === 0 && execution.evidence.runs?.present === true,
    actual: { bundles: bundles.map(bundle => ({ id: bundle.id, revision: bundle.revision, ...(bundle.source.runId ? { runId: bundle.source.runId } : {}),
        ...(bundle.source.operationId ? { operationId: bundle.source.operationId } : {}) })), gaps,
      operations: manual.map(owner => ({ operationId: owner.operationId, sessionId: owner.sessionId, observation: owner.observation.success ? owner.observation.data : null })),
      materials: bundles.flatMap(bundle => bundle.materials) }, source: 'Original model requests/responses and committed tool/Run facts from this isolated Trial Host' };
}
