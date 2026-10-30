import { lstatSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EvaluationWorkflowResultSchema, type EvaluationWorkflowRequest as Request, type EvaluationWorkflowResult as Response,
  type WorkflowRecordReference } from '../../../packages/contracts/src/evaluation-workflow.ts';
import type { TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';
import { candidateFile, listCandidates, listTraces, readCandidate, readTrace, readTraceState, traceFile } from '../curation/store.ts';
import { listFeedback } from '../curation/feedback.ts';
import { humanFeedbackFile } from '../reports/feedback.ts';
import { archiveReference, findArchive, readArchivePart } from '../reports/archive.ts';
import { listBaselines } from '../experiments/index.ts';
import { publishedBenchmarkFile } from '../curation/publication.ts';
import type { Candidate } from '../curation/schemas.ts';
import type { BaselineRecord } from '../../../packages/contracts/src/evaluation-experiments.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
import { page } from './results.ts';

type Identity = Pick<WorkflowRecordReference, 'kind' | 'id' | 'part' | 'experimentId'>;
type ReadRequest = Extract<Request, { action: 'record.read' }>;
type ListRequest = Extract<Request, { action: 'trace.list' | 'candidate.list' | 'baseline.list' }>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (value: string) => value.slice(0, 2000);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pick = (value: unknown, keys: string[]) => Object.fromEntries(keys.filter(key => key in object(value)).map(key => [key, object(value)[key]]));

/** Fixed business identities select existing files; a caller never supplies a filesystem path. */
export function createWorkflowRecordReader(repo: string) {
  function source(identity: Identity) {
    let path: string, parsed: unknown, raw: string | undefined;
    if (identity.kind === 'trace') {
      if (!uuidPattern.test(identity.id)) throw Error('Invalid Trace identity');
      path = traceFile(repo, identity.id);
      if (identity.part === 'record' && !path.includes('#')) { raw = readFileSync(path, 'utf8'); parsed = JSON.parse(raw); }
      else {
        const trace = readTrace(repo, identity.id), state = readTraceState(repo, identity.id);
        if (identity.part === 'feedback') { parsed = listFeedback(repo, { kind: 'trace-feedback', id: trace.id, revision: trace.revision }); path = humanFeedbackFile(repo) + '#trace=' + trace.id; }
        else if (identity.part === 'platform') { if (!state.platformSnapshot) throw Error('No saved platform snapshot'); parsed = state.platformSnapshot; path += '#platformSnapshot'; }
        else parsed = { ...trace, ...state };
      }
    } else if (identity.kind === 'candidate') {
      if (!uuidPattern.test(identity.id) || identity.part === 'platform') throw Error('Invalid candidate identity or view');
      const candidate = readCandidate(repo, identity.id);
      path = candidateFile(repo, identity.id);
      if (identity.part === 'feedback') { parsed = listFeedback(repo, { kind: 'candidate-review', id: candidate.id, revision: candidate.revision }); path = humanFeedbackFile(repo) + '#candidate=' + candidate.id; }
      else parsed = candidate;
    } else {
      if (identity.part !== 'record') throw Error('This entity has no requested evidence view');
      if (identity.kind === 'baseline') {
        parsed = listBaselines(repo).find(record => record.id === identity.id); path = join(repo, 'agent-eval/baselines.json') + '#records=' + identity.id;
        if (!parsed) throw Error('Unknown Baseline');
      } else {
        if (!identity.experimentId) throw Error('Gate reads require the original experiment identity');
        path = archiveReference(findArchive(repo, identity.experimentId), 'gates', identity.id); parsed = readArchivePart(path);
      }
    }
    raw ??= JSON.stringify(parsed, null, 2) + '\n';
    const entity = identity.part === 'platform' ? object(parsed).trace : parsed;
    if (identity.part !== 'feedback' && object(entity).id !== identity.id) throw Error('Saved record identity differs from its directory');
    const revision = object(entity).revision;
    const reference: WorkflowRecordReference = { ...identity, location: relative(repo, path).replaceAll('\\', '/'),
      characters: raw.length, bytes: Buffer.byteLength(raw), ...(Number.isSafeInteger(revision) && Number(revision) > 0 ? { revision: Number(revision) } : {}) };
    return { path, raw, parsed, reference };
  }
  const reference = (kind: Identity['kind'], id: string, part: Identity['part'] = 'record', experimentId?: string) =>
    source({ kind, id, part, ...(experimentId ? { experimentId } : {}) }).reference;
  let view: { viewId: string; identity: Identity; path: string; raw: string; text: string; redacted: boolean; reference: WorkflowRecordReference } | null = null;
  const lists = new Map<string, { viewId: string; query: unknown; all: Identity[]; selected: Identity[] }>();
  const otherLists = new Map<string, { viewId: string; items: unknown[] }>();

  function traceSummary(trace: TraceBundle, part: Identity['part'] = 'record') {
    const scopeAllowed = trace.source.kind === 'product' && !Array.isArray(trace.facts.langfuseObservations) && part !== 'platform';
    const uploads = Object.keys(readTraceState(repo, trace.id).operations.uploads ?? {});
    const uploadEligible = scopeAllowed && !uploads.length && trace.complete && !trace.gaps.length && !!trace.endedAt;
    return { projection: 'summary' as const, id: trace.id, revision: trace.revision, source: trace.source, entry: trace.entry,
      startedAt: trace.startedAt, endedAt: trace.endedAt, status: trace.status, complete: trace.complete, gapCount: trace.gaps.length,
      inputPreview: trace.input.prompt.slice(0, 2000), inputTruncated: trace.input.prompt.length > 2000,
      eventCount: trace.events.length, materialCount: trace.materials.length, uploadEligible,
      uploadReason: trace.source.kind === 'evaluation' ? 'Use the saved Execution Export/resend service for Benchmark observations, Judge and scores.'
        : !scopeAllowed ? 'A platform snapshot/import may be queried or mined, but cannot be re-uploaded with its original ID.'
        : uploads.length ? 'Original upload operation already exists: ' + uploads.slice(0, 5).join(', ') + '. Recheck the original receipt; a new operation or revision cannot resubmit this Trace.'
        : !uploadEligible ? 'Original product capture is incomplete; inspect its gaps before uploading.' : 'Explicit upload of this original local product Trace is available.',
      record: reference('trace', trace.id, part) };
  }
  function validationSummary(value: unknown) {
    const validation = object(value), replay = object(validation.replay), issues = Array.isArray(validation.issues) ? validation.issues : [];
    return { ...pick(validation, ['revision', 'at', 'status', 'controls']), projection: 'summary', issueCount: issues.length,
      issues: issues.slice(0, 10).map(item => clip(String(item))), replay: { ...pick(replay, ['status', 'kind']), reason: clip(String(replay.reason ?? '')) },
      omittedFields: ['conditions', 'remaining issues; full original is available through record.read'] };
  }
  function candidateSummary(candidate: Candidate) {
    return { ...pick(candidate, ['id', 'revision', 'kind', 'status', 'traceRef', 'createdAt', 'updatedAt', 'reuseCaseId', 'reviseCase']),
      projection: 'summary' as const, reason: clip(candidate.reason), reasonTruncated: candidate.reason.length > 2000,
      sourceLabels: candidate.sourceLabels.slice(0, 10).map(clip), record: reference('candidate', candidate.id),
      ...(candidate.validation ? { validation: validationSummary(candidate.validation) } : {}) };
  }
  function feedbackSummary(feedback: ReturnType<typeof listFeedback>[number]) {
    const { conditions: _, ...safe } = feedback;
    return { ...safe, projection: 'summary' as const, note: clip(feedback.note), noteTruncated: feedback.note.length > 2000,
      record: reference(feedback.target.kind === 'trace-feedback' ? 'trace' : 'candidate', feedback.target.id, 'feedback') };
  }
  function baselineSummary(value: BaselineRecord) {
    const { conditions, reference:measured, ...safe } = value;
    return { ...safe, projection: 'summary' as const, plan: { ...pick(value.plan, ['benchmark', 'repeats', 'environment', 'axes']),
      control: pick(value.plan.control, ['id', 'model', 'codeRef']), candidates: value.plan.candidates?.map(arm => pick(arm, ['id', 'model', 'codeRef'])) ?? [] },
      ...(measured?{referenceSummary:{metricCount:measured.metrics.length,assertionCount:measured.assertions.length,measurementCount:measured.measurements.length}}:{}),
      conditionCount: conditions.length, conditionsSummary: conditions.map(condition => {
        const item = object(condition), snapshot = object(item.snapshot), runtime = object(snapshot.runtimeSource);
        return { dataset: pick(item.dataset, ['id', 'version', 'subject']), scoring: pick(item.scoringConfiguration, ['version', 'judgeMode']),
          configuration: pick(snapshot.configuration, ['model', 'api', 'baseUrl', 'reasoning', 'environment']),
          sourceFileCount: Array.isArray(runtime.files) ? runtime.files.length : null, fullConditionIncluded: false };
      }), record: reference('baseline', value.id) };
  }
  function identities(request: ListRequest): Identity[] {
    const kind: Identity['kind'] = request.action === 'trace.list' ? 'trace' : request.action === 'baseline.list' ? 'baseline' : 'candidate';
    const records = request.action === 'trace.list' ? listTraces(repo) : request.action === 'baseline.list' ? listBaselines(repo) : listCandidates(repo, request.kind);
    return records.map(record => ({ kind, id: record.id, part: 'record' as const })).sort((a, b) => a.id.localeCompare(b.id));
  }
  return {
    read(request: ReadRequest): Response {
      const identity: Identity = { kind: request.kind, id: request.id, part: request.part ?? 'record', ...(request.experimentId ? { experimentId: request.experimentId } : {}) };
      const offset = request.offset ?? 0, limit = request.limit ?? 16000;
      if (request.viewId) {
        if (!view || view.viewId !== request.viewId || !isDeepStrictEqual(view.identity, identity)) throw Error('Original record view expired; start from the first page');
        const changed = view.path.includes('#') ? source(identity).raw !== view.raw
          : lstatSync(view.path).isSymbolicLink() || readFileSync(view.path, 'utf8') !== view.raw;
        if (changed) throw Error('Original record changed; restart from the first page');
      } else {
        if (offset !== 0) throw Error('Later chunks require the original view identity');
        const saved = source(identity), safe = scanEvidence(saved.raw).value;
        view = { viewId: randomUUID(), identity, path: saved.path, raw: saved.raw, text: safe, redacted: safe !== saved.raw, reference: saved.reference };
      }
      return EvaluationWorkflowResultSchema.parse({ action: 'record.read', exitCode: 0, data: { record: { ...view.reference,
        viewId: view.viewId, page: page(view.text.length, offset, limit, 'characters'), text: view.text.slice(offset, offset + limit),
        redacted: view.redacted, sourceUnchanged: true } } });
    },
    list(request: ListRequest): Response {
      const offset = request.offset ?? 0, limit = request.limit ?? 25, query = request.action === 'trace.list' ? request.source : request.action === 'candidate.list' ? request.kind : null;
      const all = identities(request);
      let current = lists.get(request.action);
      if (request.viewId) {
        if (!current || current.viewId !== request.viewId || !isDeepStrictEqual(current.query, query) || !isDeepStrictEqual(current.all, all))
          throw Error('Saved collection changed or its view expired; refresh from the first page');
      } else {
        if (offset !== 0) throw Error('Later list pages require the original view identity');
        const selected = request.action === 'trace.list' && request.source ? all.filter(identity => {
          const trace = readTrace(repo, identity.id); return Object.entries(request.source!).every(([key, value]) => Reflect.get(trace.source, key) === value);
        }) : all;
        current = { viewId: randomUUID(), query, all, selected }; lists.set(request.action, current);
      }
      const items: unknown[] = []; let bytes = 0;
      for (const identity of current.selected.slice(offset, offset + limit)) {
        const item = identity.kind === 'trace' ? traceSummary(readTrace(repo, identity.id)) : identity.kind === 'candidate'
          ? candidateSummary(readCandidate(repo, identity.id)) : baselineSummary(source(identity).parsed as BaselineRecord);
        const size = Buffer.byteLength(JSON.stringify(item));
        if (items.length && bytes + size > 512 * 1024) break;
        if (size > 512 * 1024) throw Error('Record metadata exceeds the bounded desktop summary capacity');
        items.push(item); bytes += size;
      }
      return EvaluationWorkflowResultSchema.parse({ action: request.action, exitCode: 0, data: { items, viewId: current.viewId,
        page: page(current.selected.length, offset, Math.max(1, items.length), 'rows') } });
    },
    project(value: Response, request?: Request): Response {
      let data: unknown = value.data;
      switch (value.action) {
        case 'trace.show': {
          const trace = value.data.trace as TraceBundle;
          data = { trace: traceSummary(trace), feedback: value.data.feedback?.map(item => feedbackSummary(item as ReturnType<typeof listFeedback>[number])),
            ...(value.data.platformSnapshot ? { platformSnapshot: { readAt: value.data.platformSnapshot.readAt,
              trace: traceSummary(value.data.platformSnapshot.trace as TraceBundle, 'platform') } } : {}) }; break;
        }
        case 'trace.pull': data = { ...value.data, items: value.data.items.slice(0, 25).map(item => traceSummary(item as TraceBundle)),
          page: page(value.data.items.length, 0, 25, 'rows') }; break;
        case 'candidate.show': case 'candidate.edit': data = { candidate: candidateSummary(value.data.candidate as Candidate),
          ...('feedback' in value.data ? { feedback: value.data.feedback?.map(item => feedbackSummary(item as ReturnType<typeof listFeedback>[number])) } : {}) }; break;
        case 'candidate.validate': data = { validation: validationSummary(value.data.validation) }; break;
        case 'candidate.review': case 'trace.feedback': data = { feedback: feedbackSummary(value.data.feedback as ReturnType<typeof listFeedback>[number]) }; break;
        case 'baseline.create': data = { baseline: baselineSummary(value.data.baseline as BaselineRecord) }; break;
        case 'benchmark.list': case 'experiment.list': {
          const items = value.action === 'benchmark.list' ? value.data.items.map(item => {
            if ('projection' in item) return item;
            return { id: item.id, revision: item.revision, at: item.at, projection: 'summary', memberCount: item.members.length,
              regressionCount: item.regressionCaseIds.length, smokeCount: item.smokeCaseIds.length,
              location: relative(repo, publishedBenchmarkFile(repo, item.id, item.revision)).replaceAll('\\', '/') };
          }) : value.data.items.map(item => ({ ...item, projection: 'summary', reason: item.reason ? clip(item.reason) : undefined,
            plan: { ...pick(item.plan, ['benchmark', 'repeats', 'environment', 'axes']), originalPlanIncluded: false },
            arms: item.arms.map(arm => ({ ...arm, reason: arm.reason ? clip(arm.reason) : undefined })) }));
          const listRequest = request?.action === 'benchmark.list' || request?.action === 'experiment.list' ? request : undefined;
          const offset = listRequest?.offset ?? 0, limit = listRequest?.limit ?? 25;
          let current = otherLists.get(value.action);
          if (listRequest?.viewId) {
            if (!current || current.viewId !== listRequest.viewId || !isDeepStrictEqual(current.items, items)) throw Error('Collection changed; refresh the first page');
          } else { if (offset) throw Error('Later pages require the original view'); current = { viewId: randomUUID(), items }; otherLists.set(value.action, current); }
          const selected: unknown[] = []; let bytes = 0;
          for (const item of current.items.slice(offset, offset + limit)) {
            const size = Buffer.byteLength(JSON.stringify(item)); if (selected.length && bytes + size > 512 * 1024) break;
            if (size > 512 * 1024) throw Error('Summary exceeds desktop metadata capacity');
            selected.push(item); bytes += size;
          }
          data = { items: selected, viewId: current.viewId, page: page(current.items.length, offset, Math.max(1, selected.length), 'rows') }; break;
        }
        case 'gate.check': {
          const gate = value.data.gate;
          if (gate.id && gate.experimentId) data = { gate: { ...gate, projection: 'summary', reasonCount: gate.reasons.length, deltaCount: gate.deltas.length,
            reasons: gate.reasons.slice(0, 20).map(reason => ({ ...reason, ...(typeof reason.message === 'string' ? { message: clip(reason.message) } : {}),
              ...(Array.isArray(reason.evidenceRefs) ? { evidenceRefs: reason.evidenceRefs.slice(0, 3) } : {}) })),
            deltas: gate.deltas.slice(0, 50).map(delta => ({ ...delta, ...(Array.isArray(delta.evidenceRefs) ? { evidenceRefs: delta.evidenceRefs.slice(0, 3) } : {}) })),
            record: reference('gate', gate.id, 'record', gate.experimentId) } };
          break;
        }
        case 'trace.upload': {
          const { conditions: _, ...operation } = object(value.data.operation);
          data = { operation: { ...operation, projection: 'summary', sourceRecord: reference('trace', String(operation.traceId)) } }; break;
        }
        case 'trace.process': {
          const upload = { ...value.data.upload }, mining = { ...value.data.mining };
          for (const [owner, key] of [[upload, 'operation'], [mining, 'triage']] as const) {
            if (owner[key] && typeof owner[key] === 'object') {
              const { conditions: _, ...content } = object(owner[key]);
              owner[key] = { ...content, projection: 'summary', sourceRecord: reference('trace', value.data.traceId) };
            }
          }
          data = { ...value.data, upload, mining }; break;
        }
      }
      return EvaluationWorkflowResultSchema.parse({ ...value, data });
    },
  };
}
