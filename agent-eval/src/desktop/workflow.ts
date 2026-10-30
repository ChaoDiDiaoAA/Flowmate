import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { EvaluationWorkflowRequestSchema, EvaluationWorkflowResultSchema, ObservabilitySettingsSchema,
    WorkflowUploadOperationSchema, WorkflowMiningOperationSchema, type EvaluationWorkflowRequest, type EvaluationWorkflowResult, type ObservabilitySettings } from '../../../packages/contracts/src/evaluation-workflow.ts';
import type { TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';
import { experimentPlanSchema } from '../../../packages/contracts/src/evaluation-experiments.ts';
import { createCurationService, type GenerateJSON, type Replay } from '../curation/index.ts';
import { createControlledReplay } from '../curation/replay.ts';
import { miningModelInput } from '../curation/mining-contract.ts';
import { buildMiningView, type MiningViewAudit } from '../curation/mining-view.ts';
import { directory, readTrace, readTraceState, readTraceOperation, writeTraceOperation, updateTraceState, traceFile } from '../curation/store.ts';
import { listPublishedBenchmarks, loadPublishedBenchmark } from '../curation/publication.ts';
import { agentConfig, miningConfig, langfuseConfig, langfuseConnection, type LangfuseConnection } from '../configuration.ts';
import { judgeConfig, publicJudgeConfig } from '../scoring/judges/client.ts';
import { generateJSON as nativeGenerateJSON, type ProcessRunner } from '../text-model/codex.ts';
import { pullLangfuseTraces, matchObservationTree } from '../langfuse/read.ts';
import { sendTraceBundle, traceBundleToObservationTree, buildObservationTree } from '../langfuse/otel.ts';
import { readReport, reportPath } from '../reports/store.ts';
import { platformClient } from '../langfuse/export.ts';
import { findDataset } from '../execution/plan.ts';
import { selectCases, resolveCase } from '../dataset-loader/local.ts';
import { listExperiments, runExperiment, compareExperiment, listBaselines, createBaseline, checkGate,
    type ExperimentDependencies } from '../experiments/index.ts';
import { atomicJson, acquireEvaluationWrite } from '../reports/files.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
import { createWorkflowRecordReader } from './workflow-records.ts';
import { runBenchmarkWorkflow } from '../execution/benchmark.ts';
import { runProgress } from '../reports/readme.ts';
import { retryScoring, listScoringRevisions, readScoringRevisionReport } from '../execution/score-retry.ts';
export { isWorkflowReadOnly } from '../../../packages/contracts/src/evaluation-workflow.ts';
import { readObservabilitySettings } from '../observability-settings.ts';
export { readObservabilitySettings } from '../observability-settings.ts';

export type WorkflowDependencies = { env?: NodeJS.ProcessEnv; signal?: AbortSignal; nativeRunner?: ProcessRunner;
    workspaceUnavailableReason?: string; queryProjects?: (connection: LangfuseConnection) => Promise<unknown>;
    desktopReader?: ReturnType<typeof createWorkflowRecordReader>;
    generateJSON?: GenerateJSON; replay?: Replay; connection?: LangfuseConnection; experiments?: ExperimentDependencies;
    pullTraces?: typeof pullLangfuseTraces; sendTrace?: typeof sendTraceBundle;
    fetcher?: (url: string, init: RequestInit) => Promise<Response> };
export function saveObservabilitySettings(repo: string, value: unknown): ObservabilitySettings {
    const settings = ObservabilitySettingsSchema.parse(value), root = directory(repo, ['agent-eval', 'configs'], true);
    const release = acquireEvaluationWrite(join(root, 'observability.json'));
    try { atomicJson(join(root, 'observability.json'), settings); return settings; } finally { release(); }
}
function settingsView(repo: string, deps: WorkflowDependencies) {
    const env = deps.env ?? process.env;
    let agent: Record<string, unknown> | null = null, judge: Record<string, unknown> | null = null, mining: Record<string, unknown> | null = null;
    let langfuse: { configured: boolean; baseUrl: string | null } = { configured: false, baseUrl: null };
    try { agent = { ...agentConfig(repo, env).configuration, availability: 'not-checked' }; } catch { /* Unconfigured roles remain explicit. */ }
    try { const selected = judgeConfig(env, repo); if (selected) judge = { ...publicJudgeConfig(selected), availability: 'not-checked' }; } catch { /* Independent role. */ }
    try { const { executable, ...configuration } = miningConfig(repo, env); mining = { ...configuration, availability: 'not-checked' }; } catch { /* Independent role. */ }
    try { const connection = deps.connection ? langfuseConnection(deps.connection) : langfuseConfig(repo, env); langfuse = { configured: true, baseUrl: connection.baseUrl }; } catch { /* No connection probe. */ }
    return { settings: readObservabilitySettings(repo), roles: { agent, judge, mining }, langfuse,
        workspace: { available: !deps.workspaceUnavailableReason, reason: deps.workspaceUnavailableReason ?? null } };
}
const draftGuide = `Return only {"draftJson":"<serialized JSON candidate draft>"}. The inner object has reason:string, sourceLabels:string[], optional case, gold, scenario, review, controls, reuseCaseId, and arrays bindings and controlBindings. Do not include candidate id/revision/kind/traceRef/status or validation. Case fields: name (three snake_case words), category (task|tools|context|memory|compaction|skills|extensions|subagents|runtime|safety|research), difficulty (golden|difficult|long_tail|tool_failure|regression|adversarial), purpose (capability|regression), source (hand-authored|real-trace|regression-bug|provider-fixture|historical-issue), input:{prompt,turns?:[{id,role:'user',content,mode?:'prompt'|'followUp'|'steer'}]}, expected:{success:string[],failure:string[],maxToolCalls:integer,mustHaveEvidence:boolean,expectedAnswerHint:string,requiredCapabilities?:string[],optionalCapabilities?:string[],forbiddenCapabilities?:string[]}, scoring:{deterministic:string[],judge:string[],manual:string},risks:string[],tags:string[]. New regression uses regression/regression/regression-bug; Gold kind never forces golden difficulty. Gold:{values:object,checks:[{metric,required,evidence?,path?,equals?}],opportunities:{'task-success':1},sources:string[],basis:string}. Scenario:{requires:['agent'|'invoice'|'workspace'|'research'],materials:[{source:'local-text',sample,file}],steps:[{id,action:'user-message',instruction:'$input'} or {id,action:'user-message',turnId}],selection:{enabledSkills:[],enabledExtensions:[]}}. bindings:[{materialId,quote,label,target:{kind:'success'|'failure'|'answer',text}}]. controls:{negative?:{label,evidence:{<key>:{present:boolean,actual:any,source:string}}},positive?:same}. controlBindings:[{control:'negative'|'positive',evidence,path,source:{kind:'trace',path} or {kind:'material',materialId,quote}}]. Trace paths address the supplied original trace; positive controls need independent material bindings. Omit unsupported case/gold/scenario instead of inventing missing source facts. Human approval and actual model replay are always pending.`;
function miner(repo: string, deps: WorkflowDependencies): GenerateJSON {
    return deps.generateJSON ?? (async request => {
        const configuration = miningConfig(repo, deps.env);
        const projected = miningModelInput(request.prompt, request.schema);
        const input = { system: request.system + '\n' + draftGuide, data: JSON.stringify(projected),
            schema: { type: 'object', properties: { draftJson: { type: 'string' } }, required: ['draftJson'], additionalProperties: false },
            signal: request.signal ?? deps.signal };
        const response = await observeMiningModel(repo, request.operation, 'mining', configuration, () => nativeGenerateJSON(configuration, input, { runner: deps.nativeRunner }),
            { ...input, view: projected.task.trace.audit });
        return JSON.parse(z.object({ draftJson: z.string() }).strict().parse(response.value).draftJson);
    });
}
function modelObservation(value: unknown, fallbackVersion?: unknown) {
    const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const usage = data.usage && typeof data.usage === 'object' ? Object.fromEntries(Object.entries(data.usage)
        .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) : null;
    return scanEvidence({ cliVersion: typeof data.cliVersion === 'string' ? data.cliVersion : typeof fallbackVersion === 'string' ? fallbackVersion : null,
        responseModel: typeof data.responseModel === 'string' ? data.responseModel : null, usage,
        usageSource: data.usageSource === 'codex-cli' ? 'codex-cli' : 'unknown',
        cost: typeof data.cost === 'number' && Number.isFinite(data.cost) ? data.cost : null,
        internalRetries: typeof data.internalRetries === 'number' ? data.internalRetries : null }).value;
}
async function observeMiningModel(repo: string, context: Parameters<GenerateJSON>[0]['operation'], role: 'mining' | 'triage',
    selected: ReturnType<typeof miningConfig>, call: () => ReturnType<typeof nativeGenerateJSON>, input?: { system: string; data: string; schema: Record<string, unknown>; view: MiningViewAudit }) {
    const operation = z.object({ traceId: z.string().uuid(), operationId: z.string().uuid() }).strict().parse(context);
    const save = (value: unknown) => writeTraceOperation(repo, operation.traceId, 'models', operation.operationId, value);
    const { executable, ...configuration } = selected;
    const startedAt = new Date().toISOString(), initial = scanEvidence({ contract: 'flowmate-mining-model-call/v1', ...operation, role,
        configuration, startedAt, endedAt: null, status: 'unknown', observed: null, error: null,
        ...(input ? { requestedInput: { systemUtf8Bytes: Buffer.byteLength(input.system), dataUtf8Bytes: Buffer.byteLength(input.data),
            schemaUtf8Bytes: Buffer.byteLength(JSON.stringify(input.schema)), view: input.view } } : {}) }).value;
    updateTraceState(repo, operation.traceId, state => {
        if (state.operations.models?.[operation.operationId] !== undefined) {
            const previous = state.operations.models[operation.operationId];
            const unconfirmed = previous && typeof previous === 'object' && 'stopConfirmed' in previous && previous.stopConfirmed === false;
            throw Object.assign(Error('Model operation already exists; inspect its original outcome instead of rerunning.'), unconfirmed ? { stopConfirmed: false } : {});
        }
        (state.operations.models ??= {})[operation.operationId] = initial;
    });
    let response: Awaited<ReturnType<typeof nativeGenerateJSON>>;
    try {
        if (input && !input.view.ready) throw Object.assign(Error('Mandatory Trace content exceeds the mining view budget; no model was called.'), { stopConfirmed: true });
        response = await call();
    }
    catch (error) {
        const failure = error && typeof error === 'object' ? error as { response?: unknown; cliVersion?: unknown; stopConfirmed?: unknown } : {};
        const stopConfirmed = typeof failure.stopConfirmed === 'boolean' ? failure.stopConfirmed : undefined;
        try { save({ ...initial, status: stopConfirmed === false ? 'unknown' : 'error', endedAt: new Date().toISOString(),
            observed: modelObservation(failure.response, failure.cliVersion), error: { name: error instanceof Error ? error.name : 'Error', message: short(error) },
            ...(stopConfirmed === undefined ? {} : { stopConfirmed }) }); }
        catch (writeError) { throw Object.assign(writeError instanceof Error ? writeError : Error(String(writeError)), stopConfirmed === false ? { stopConfirmed: false } : {}); }
        throw error;
    }
    save({ ...initial, status: 'completed', endedAt: new Date().toISOString(), observed: modelObservation(response), stopConfirmed: true });
    return response;
}
function previewExperiment(repo: string, value: unknown, deps: WorkflowDependencies) {
    const plan = experimentPlanSchema.parse(value);
    const datasets = deps.experiments?.loadBenchmark?.(repo, plan.benchmark.id, plan.benchmark.revision) ?? (plan.benchmark.id === 'baseline'
        ? plan.benchmark.revision === 1 ? ['flowmate-agent-v1', 'flowmate-research-v1'].map(dataset => findDataset(repo, { dataset, version: 1 })) : []
        : loadPublishedBenchmark(repo, plan.benchmark.id, plan.benchmark.revision));
    if (!datasets.length) throw Error('Requested benchmark revision is unavailable');
    const arms = plan.candidates.length + 1;
    const selected = datasets.map(dataset => {
        const cases = selectCases(dataset, plan.benchmark.selection);
        if (!cases.length) throw Error('Benchmark selection contains no Cases');
        cases.forEach(task => resolveCase(dataset, task, repo));
        return { id: dataset.manifest.id, revision: dataset.manifest.version, caseIds: cases.map(task => task.id),
            regressionCaseIds: dataset.published?.regressionCaseIds ?? cases.filter(task => task.purpose === 'regression').map(task => task.id),
            caseCount: cases.length, total: cases.length * plan.repeats * arms };
    });
    return { plan, attribution: plan.axes.length === 1 ? 'single-axis' as const : 'combination' as const, arms,
        datasets: selected, caseCount: selected.reduce((sum, item) => sum + item.caseCount, 0), totalTrials: selected.reduce((sum, item) => sum + item.total, 0) };
}
function short(error: unknown) { return String(scanEvidence(error instanceof Error ? error.message : String(error)).value).slice(0, 2000); }
function uploadedMatches(original: TraceBundle, pulled: TraceBundle) {
    if (!pulled.complete || pulled.gaps.length || !isDeepStrictEqual(pulled.input, original.input) || !isDeepStrictEqual(pulled.output, original.output) ||
        !isDeepStrictEqual(pulled.materials, original.materials)) return false;
    const rows = z.array(z.object({ id: z.string().min(1), traceId: z.string().min(1) }).passthrough()).safeParse(pulled.facts.langfuseObservations);
    return rows.success && matchObservationTree(traceBundleToObservationTree(original), rows.data).complete;
}
async function uploadTrace(repo: string, request: Extract<EvaluationWorkflowRequest, { action: 'trace.upload' }>, deps: WorkflowDependencies) {
    const curation = createCurationService(repo), trace = curation.readTrace(request.traceId);
    if (trace.source.kind !== 'product') throw Error('Benchmark traces must use the saved Execution Export/resend service; generic product upload is unavailable.');
    if (Array.isArray(trace.facts.langfuseObservations)) throw Error('A platform-imported Trace is read-only for upload; query or mine the saved copy without resubmitting its ID.');
    const save = (value: unknown) => writeTraceOperation(repo, trace.id, 'uploads', request.operationId, value);
    const selected = deps.connection ? langfuseConnection(deps.connection) : langfuseConfig(repo, deps.env);
    const target = async () => {
        const projects = z.object({ data: z.array(z.object({ id: z.string().min(1).max(200) }).passthrough()),
            meta: z.object({ totalItems: z.literal(1).optional(), totalPages: z.literal(1).optional() }).passthrough().optional() }).passthrough()
            .parse(await (deps.queryProjects ? deps.queryProjects(selected) : (await platformClient(repo, selected)).api.projects.get({ maxRetries: 0 })));
        if (projects.data.length !== 1) throw Error('Langfuse target requires a unique project');
        const value = { baseUrl: selected.baseUrl, projectId: projects.data[0]!.id };
        if ((scanEvidence(value).fact.actual as { leaked: boolean }).leaked) throw Error('Langfuse target contains a configured secret');
        return value;
    };
    const verify = async (operation: z.infer<typeof WorkflowUploadOperationSchema>) => {
        if (operation.status === 'verified') return operation;
        try {
            const found = await (deps.pullTraces ?? pullLangfuseTraces)(repo, { from: new Date(Date.parse(operation.conditions.startedAt) - 1).toISOString(),
                to: new Date(Date.parse(operation.conditions.endedAt!) + 1).toISOString(), traceId: operation.traceId.replaceAll('-', '') }, { connection: selected, fetcher: deps.fetcher });
            if (found.some(item => item.id === operation.traceId && uploadedMatches(operation.conditions, item))) {
                operation = { ...operation, status: 'verified', reason: 'Original observations were read back and matched.' }; save(operation);
            }
        } catch { /* A failed readback never authorizes another submission. */ }
        return operation;
    };
    const prior = readTraceOperation(repo, trace.id, 'uploads', request.operationId);
    if (prior !== undefined) {
        const old = WorkflowUploadOperationSchema.parse(prior);
        if (old.traceId !== request.traceId || old.revision !== request.expectedRevision) throw Error('Upload operation differs from its original request');
        if (!old.target) throw Error('Historical upload target is unavailable; original receipt is read-only');
        if (!isDeepStrictEqual(old.target, await target())) throw Error('Langfuse target differs from the original upload');
        return verify(old);
    }
    if (trace.revision !== request.expectedRevision) throw Error('Stale Trace revision');
    traceBundleToObservationTree(trace); const selectedTarget = await target(); deps.signal?.throwIfAborted();
    let operation = WorkflowUploadOperationSchema.parse({ operationId: request.operationId, traceId: trace.id, revision: trace.revision,
        at: new Date().toISOString(), status: 'unknown', reason: 'Remote outcome unknown; do not resubmit this operation.', traceIds: [], observationIds: [], target: selectedTarget, conditions: trace });
    const release = acquireEvaluationWrite(join(directory(repo, ['agent-eval'], true), 'trace-upload'));
    try {
        for (const value of Object.values(readTraceState(repo, trace.id).operations.uploads ?? {})) {
            const previous = WorkflowUploadOperationSchema.parse(value);
            if (!previous.target) throw Error('Historical original upload operation has no target; its receipt is read-only');
            if (!isDeepStrictEqual(previous.target, selectedTarget)) throw Error('Langfuse target differs from the original upload operation');
            throw Error('Trace already has an original upload operation ' + previous.operationId + '; read that operation instead. A fresh operation or revision cannot resubmit the same Trace tree.');
        }
        for (const other of curation.listTraces()) {
            if (readTraceOperation(repo, other.id, 'uploads', request.operationId) !== undefined) throw Error('Upload operation already exists; read its original Trace operation');
        }
        save(operation);
    } finally { release(); }
    try {
        const sent = await (deps.sendTrace ?? sendTraceBundle)(trace, selected);
        operation = { ...operation, status: 'submitted', reason: 'Submitted; server persistence is unverified until readback.', ...sent };
    } catch (error) { operation = { ...operation, reason: 'Remote outcome unknown: ' + short(error) }; }
    save(operation); return verify(operation);
}
async function processTrace(repo: string, traceId: string, deps: WorkflowDependencies) {
    const trace = readTrace(repo, traceId), settings = readObservabilitySettings(repo);
    const disabled = (enabled: boolean) => ({ enabled, status: enabled ? 'blocked' : 'disabled' });
    const incomplete = !trace.complete || trace.gaps.length > 0;
    if (!trace.endedAt) return { traceId, revision: trace.revision, upload: disabled(settings.upload), mining: disabled(settings.mining) };
    if (!settings.upload && !settings.mining) return { traceId, revision: trace.revision, upload: disabled(false), mining: disabled(false) };
    const schema = z.object({ uploadOperationId: z.string().uuid(), triageOperationId: z.string().uuid(),
        miningOperationIds: z.object({ gold: z.string().uuid(), bad: z.string().uuid(), regression: z.string().uuid() }).strict() }).strict();
    let operations!: z.infer<typeof schema>;
    updateTraceState(repo, traceId, state => {
        const saved = state.operations.processing?.[String(trace.revision)];
        operations = saved === undefined ? { uploadOperationId: randomUUID(), triageOperationId: randomUUID(),
            miningOperationIds: { gold: randomUUID(), bad: randomUUID(), regression: randomUUID() } } : schema.parse(saved);
        (state.operations.processing ??= {})[String(trace.revision)] = operations;
    });
    let upload: Record<string, unknown> = disabled(false), mining: Record<string, unknown> = disabled(false);
    if (settings.upload && incomplete) upload = { enabled: true, status: 'blocked', reason: 'Incomplete original observations cannot be uploaded.' };
    else if (settings.upload) try { upload = { enabled: true, operation: await uploadTrace(repo, { action: 'trace.upload', traceId, expectedRevision: trace.revision, operationId: operations.uploadOperationId }, deps) }; }
    catch (error) { upload = { enabled: true, status: 'blocked', reason: short(error) }; }
    if (settings.mining && trace.configuration.purpose === 'native-maintenance')
        mining = { enabled: true, status: 'skipped', reason: 'Native maintenance request: automatic mining is skipped.' };
    else if (settings.mining && incomplete) {
        const curation = createCurationService(repo), candidateId = operations.miningOperationIds.bad;
        let candidate = curation.listCandidates('bad').find(item => item.id === candidateId) ??
            curation.saveCandidate({ id: candidateId, revision: 1, kind: 'bad', traceRef: { id: trace.id, revision: trace.revision },
                reason: 'Terminal capture gap signal: ' + (trace.gaps.join('; ') || 'Trace marked incomplete without additional detail.'),
                sourceLabels: ['trace-evidence-gap'], review: { source: 'execution-facts', classification: 'evidence-gap', sourceGaps: trace.gaps, sourceComplete: trace.complete } });
        if (!candidate.validation || candidate.validation.revision !== candidate.revision) {
            await curation.validateCandidate(candidate.id, { expectedRevision: candidate.revision }); candidate = curation.readCandidate(candidate.id);
        }
        mining = { enabled: true, status: 'completed', source: 'execution-facts', candidateId: candidate.id, candidateStatus: candidate.status, nativeGeneration: 'NOT_RUN' };
    }
    else if (settings.mining) try {
        const triage = await triageTrace(repo, trace, operations.triageOperationId, deps);
        if (triage.status !== 'completed' || !triage.classification) mining = { enabled: true, status: triage.status, triage, ...(triage.stopConfirmed === undefined ? {} : { stopConfirmed: triage.stopConfirmed }) };
        else {
            const classification = triage.classification;
            const businessFailure = classification.quality === 'suspected-failure' && classification.failureKind === 'business';
            const kinds: Array<'gold' | 'regression'> = classification.quality === 'supported-success' ? ['gold'] : businessFailure ? ['regression'] : [];
            const curation = createCurationService(repo, { generateJSON: miner(repo, deps) }), attempts = [];
            let badCandidateId: string | undefined, status = 'completed', stopConfirmed: boolean | undefined;
            let legacyBad: z.infer<typeof WorkflowMiningOperationSchema> | undefined;
            if (classification.quality !== 'supported-success') {
                const oldBad = readTraceOperation(repo, traceId, 'mining', operations.miningOperationIds.bad);
                if (oldBad !== undefined) {
                    legacyBad = WorkflowMiningOperationSchema.parse(oldBad);
                    if (!isDeepStrictEqual(legacyBad.request, { operationId: operations.miningOperationIds.bad, traceId, expectedRevision: trace.revision, kind: 'bad' }))
                        throw Error('Legacy Bad operation differs from this original Trace revision');
                }
                const id = legacyBad?.candidateId ?? operations.miningOperationIds.bad;
                let bad = curation.listCandidates('bad').find(item => item.id === id) ??
                    curation.saveCandidate({ id, revision: 1, kind: 'bad', traceRef: { id: trace.id, revision: trace.revision },
                        reason: classification.reason, sourceLabels: ['triage-' + classification.failureKind],
                        review: { source: 'agent', classification: 'suspected', triageOperationId: triage.operationId, triage: classification,
                            originalPointer: { path: relative(repo, traceFile(repo, trace.id)).replaceAll('\\', '/'), revision: trace.revision, pointers: ['/input', '/output', '/facts', '/gaps'] },
                            ...(businessFailure ? { regressionOperationId: operations.miningOperationIds.regression } : {}) } });
                if (bad.kind !== 'bad' || !isDeepStrictEqual(bad.traceRef, { id: trace.id, revision: trace.revision })) throw Error('Bad signal belongs to another Trace revision');
                if (!bad.validation || bad.validation.revision !== bad.revision) {
                    await curation.validateCandidate(bad.id, { expectedRevision: bad.revision }); bad = curation.readCandidate(bad.id);
                }
                badCandidateId = bad.id;
            }
            if (legacyBad?.status === 'unknown') {
                attempts.push(legacyBad); status = 'unknown'; stopConfirmed = legacyBad.stopConfirmed;
            } else for (const kind of kinds) {
                const attempt = await curation.mine({ traceId, expectedRevision: trace.revision, operationId: operations.miningOperationIds[kind], kind }, deps.signal);
                attempts.push(attempt);
                if (attempt.status !== 'completed' || !attempt.candidateId) { status = attempt.status; stopConfirmed = attempt.stopConfirmed; break; }
                let candidate = curation.readCandidate(attempt.candidateId);
                if (candidate.review?.triageOperationId !== triage.operationId) candidate = curation.editCandidate(candidate.id, { expectedRevision: candidate.revision,
                    review: { ...candidate.review, source: 'agent', classification: 'suspected', triageOperationId: triage.operationId,
                        triage: classification, ...(kind === 'regression' && badCandidateId ? { parentCandidateId: badCandidateId } : {}) } });
                if (!candidate.validation || candidate.validation.revision !== candidate.revision)
                    await curation.validateCandidate(candidate.id, { expectedRevision: candidate.revision });
            }
            mining = { enabled: true, status, triage, operations: attempts, ...(badCandidateId ? { badCandidateId } : {}),
                ...(legacyBad?.status === 'unknown' ? { reason: 'Bad signal recovered from completed triage; the original unknown Bad model operation is unchanged. Use an explicit independent Regression operation after confirming termination.' } : {}),
                ...(stopConfirmed === undefined ? {} : { stopConfirmed }) };
        }
    }
    catch (error) { mining = { enabled: true, status: 'blocked', reason: short(error) }; }
    return { traceId, revision: trace.revision, upload, mining };
}
const triageClassificationSchema = z.object({ quality: z.enum(['supported-success', 'suspected-failure', 'unjudgeable']),
    failureKind: z.enum(['business', 'infrastructure', 'judge', 'unknown']), reason: z.string().min(1), evidence: z.array(z.string().min(1)).min(1) }).strict();
const triageOperationSchema = z.object({ operationId: z.string().uuid(), traceId: z.string().uuid(), revision: z.number().int().positive(), at: z.string().datetime(),
    source: z.enum(['agent', 'execution-facts']), status: z.enum(['completed', 'rejected', 'unknown']), reason: z.string(), classification: triageClassificationSchema.optional(),
    stopConfirmed: z.boolean().optional(), conditions: z.unknown() }).strict();
async function triageTrace(repo: string, trace: TraceBundle, operationId: string, deps: WorkflowDependencies) {
    const save = (value: unknown) => writeTraceOperation(repo, trace.id, 'triage', operationId, value);
    const prior = readTraceOperation(repo, trace.id, 'triage', operationId);
    if (prior !== undefined) {
        const previous = triageOperationSchema.parse(prior);
        if (!isDeepStrictEqual(previous.conditions, trace)) throw Error('Triage source conditions changed'); return previous;
    }
    let operation: z.infer<typeof triageOperationSchema> = { operationId, traceId: trace.id, revision: trace.revision, at: new Date().toISOString(), source: 'agent',
        status: 'unknown', reason: 'Triage model outcome unknown; do not automatically retry.', conditions: trace };
    let existing: z.infer<typeof triageOperationSchema> | undefined;
    updateTraceState(repo, trace.id, state => {
        const saved = state.operations.triage?.[operationId];
        if (saved !== undefined) existing = triageOperationSchema.parse(saved);
        else { deps.signal?.throwIfAborted(); (state.operations.triage ??= {})[operationId] = operation; }
    });
    if (existing) return existing;
    const error = trace.facts.error;
    if (['ERROR', 'error', 'timeout', 'cancelled', 'NOT_RUN', 'UNJUDGEABLE', 'not-started'].includes(trace.status) ||
        trace.facts.infrastructure === true || error && typeof error === 'object' && 'infrastructure' in error && error.infrastructure === true) {
        operation = { ...operation, source: 'execution-facts', status: 'completed', reason: 'Execution-level failure or missing judgment is a Bad signal, without evidence of a business regression.',
            classification: { quality: 'unjudgeable', failureKind: trace.facts.infrastructure === true ? 'infrastructure' : 'unknown', reason: 'Original execution status: ' + trace.status, evidence: ['Original status and failure facts'] } };
        save(operation); return operation;
    }
    const system = 'Triage this original Flowmate Trace for evaluation candidate mining. Completed means execution ended, not answer quality. Inspect the actual user request, output, events, materials and any original scores/feedback. Return only a suspected classification, never human approval or an overwritten score. Detect wrong answers even when status is completed. Choose supported-success only when the requested result is independently supported; business failure means a likely violated user/business requirement. Infrastructure/judge failures remain separate. Insufficient evidence is unjudgeable. Cite concrete original facts in evidence; do not invent material facts.';
    let response: unknown;
    try {
        const context = { traceId: trace.id, operationId };
        const configuration = miningConfig(repo, deps.env);
        const view = buildMiningView(trace);
        const input = { system: system + ' The supplied Trace is an explicitly partial mining view. Preserve original statuses; use source pointers and independent material IDs. Omitted data is not evidence of absence.',
            data: JSON.stringify(view), signal: deps.signal,
                schema: { type: 'object', properties: { quality: { type: 'string', enum: ['supported-success', 'suspected-failure', 'unjudgeable'] },
                    failureKind: { type: 'string', enum: ['business', 'infrastructure', 'judge', 'unknown'] }, reason: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
                    required: ['quality', 'failureKind', 'reason', 'evidence'], additionalProperties: false } };
        if (deps.generateJSON && !view.audit.ready) throw Object.assign(Error('Mandatory Trace content exceeds the mining view budget; no model was called.'), { stopConfirmed: true });
        response = deps.generateJSON ? await deps.generateJSON({ system: input.system, prompt: input.data, schema: triageClassificationSchema, signal: deps.signal, operation: context }) :
            (await observeMiningModel(repo, context, 'triage', configuration, () => nativeGenerateJSON(configuration, input, { runner: deps.nativeRunner }), { ...input, view: view.audit })).value;
    } catch (error) {
        if (error && typeof error === 'object' && 'stopConfirmed' in error && typeof error.stopConfirmed === 'boolean') operation.stopConfirmed = error.stopConfirmed;
        operation.reason = 'Triage outcome unknown: ' + short(error); save(operation); return operation;
    }
    try { operation = { ...operation, status: 'completed', classification: triageClassificationSchema.parse(response), reason: 'Agent triage is a suspected classification; independent validation and human approval remain required.' }; }
    catch (error) { operation = { ...operation, status: 'rejected', reason: 'Invalid triage response: ' + short(error) }; }
    save(operation); return operation;
}

/** Shared by the worker and CLI; domain services remain the only execution implementations. */
export async function dispatchWorkflow(repo: string, value: unknown, deps: WorkflowDependencies = {}): Promise<EvaluationWorkflowResult> {
    const request = EvaluationWorkflowRequestSchema.parse(value); deps.signal?.throwIfAborted();
    if (request.action === 'record.read') return (deps.desktopReader ?? createWorkflowRecordReader(repo)).read(request);
    if (deps.desktopReader && ['trace.list', 'candidate.list', 'baseline.list'].includes(request.action))
        return deps.desktopReader.list(request as Extract<EvaluationWorkflowRequest, { action: 'trace.list' | 'candidate.list' | 'baseline.list' }>);
    const curation = createCurationService(repo, { generateJSON: miner(repo, deps), replay: deps.replay ?? createControlledReplay(repo, deps.env) });
    let data: unknown, exitCode: 0 | 1 | 2 = 0;
    switch (request.action) {
        case 'settings.get': data = settingsView(repo, deps); break;
        case 'settings.save': saveObservabilitySettings(repo, request.settings); data = settingsView(repo, deps); break;
        case 'trace.list': data = { items: curation.listTraces() }; break;
        case 'trace.show': {
            const trace = curation.readTrace(request.traceId), platformSnapshot = readTraceState(repo, trace.id).platformSnapshot ?? null;
            data = { trace, platformSnapshot, feedback: curation.listFeedback({ kind: 'trace-feedback', id: trace.id, revision: trace.revision }) }; break;
        }
        case 'trace.pull': {
            if (Date.parse(request.from) >= Date.parse(request.to)) throw Error('Trace pull requires an increasing bounded time range');
            const items = await (deps.pullTraces ?? pullLangfuseTraces)(repo, { from: request.from, to: request.to, entry: request.entry,
                ...(request.traceId ? { traceId: request.traceId.replaceAll('-', '') } : {}) }, { connection: deps.connection ? langfuseConnection(deps.connection) : langfuseConfig(repo, deps.env), fetcher: deps.fetcher });
            const known = new Map(curation.listTraces().map(trace => [trace.id, trace]));
            const gaps = items.flatMap(trace => trace.gaps);
            const saved = items.map(trace => {
                const old = known.get(trace.id), { revision: remoteRevision, ...content } = trace;
                if (old) {
                    updateTraceState(repo, trace.id, state => { state.platformSnapshot = { readAt: new Date().toISOString(), trace }; });
                    if (!Array.isArray(old.facts.langfuseObservations)) {
                        if (old.source.kind === 'evaluation' && old.source.executionId) {
                            const report = readReport(reportPath(repo, old.source.executionId));
                            const rows = z.array(z.object({ id: z.string().min(1), traceId: z.string().min(1) }).passthrough())
                                .safeParse(trace.facts.langfuseObservations);
                            const nodes = buildObservationTree(report).filter(node => node.traceId === old.id.replaceAll('-', ''));
                            if (!rows.success || !nodes.length || !matchObservationTree(nodes, rows.data).complete)
                                gaps.push('local-platform-content-diff:' + trace.id);
                            return old;
                        }
                        if (!isDeepStrictEqual(old.input, trace.input) || !isDeepStrictEqual(old.output, trace.output) ||
                            !isDeepStrictEqual(old.source, trace.source) || !isDeepStrictEqual(old.configuration, trace.configuration))
                            gaps.push('local-platform-content-diff:' + trace.id);
                        return old;
                    }
                }
                const oldContent = old ? (({ revision, ...rest }) => rest)(old) : undefined;
                return old && isDeepStrictEqual(content, oldContent) ? old : curation.saveTrace({ ...trace, revision: old ? old.revision + 1 : 1 });
            });
            data = { items: saved, saved: saved.length, gaps }; break;
        }
        case 'trace.upload': { const operation = await uploadTrace(repo, request, deps); data = { operation }; exitCode = operation.status === 'verified' ? 0 : 2; break; }
        case 'trace.process': {
            const processed = await processTrace(repo, request.traceId, deps); data = processed;
            exitCode = [processed.upload, processed.mining].some(item => item.enabled && (!('operation' in item) && !['completed', 'skipped'].includes(String(item.status)) ||
                'operation' in item && item.operation && typeof item.operation === 'object' && 'status' in item.operation && item.operation.status !== 'verified')) ? 2 : 0;
            break;
        }
        case 'trace.feedback': case 'candidate.review': { const { action, ...input } = request; data = { feedback: curation.addFeedback(input) }; break; }
        case 'mine': {
            const { action, ...input } = request, operation = await curation.mine(input, deps.signal); data = { operation };
            exitCode = operation.status === 'completed' ? 0 : operation.status === 'unknown' ? 2 : 1; break;
        }
        case 'candidate.list': data = { items: curation.listCandidates(request.kind) }; break;
        case 'candidate.show': { const candidate = curation.readCandidate(request.candidateId); data = { candidate,
            feedback: curation.listFeedback({ kind: 'candidate-review', id: candidate.id, revision: candidate.revision }) }; break; }
        case 'candidate.edit': data = { candidate: curation.editCandidate(request.candidateId, { ...request.patch, expectedRevision: request.expectedRevision }) }; break;
        case 'candidate.validate': {
            const validation = await curation.validateCandidate(request.candidateId, { expectedRevision: request.expectedRevision, replay: request.replay, signal: deps.signal });
            data = { validation }; exitCode = validation.status === 'PASS' ? 0 : 2; break;
        }
        case 'candidate.publish': { const { action, ...input } = request; data = { publication: curation.publish(input) }; break; }
        case 'benchmark.list': data = { items: listPublishedBenchmarks(repo) }; break;
        case 'score.retry': {
            const { action, ...input } = request;
            const scoring = await retryScoring(repo, input, { env: deps.env, fetcher: deps.fetcher, nativeRunner: deps.nativeRunner, signal: deps.signal });
            data = { scoring }; exitCode = scoring.status === 'complete' ? 0 : 2; break;
        }
        case 'score.list': data = { items: listScoringRevisions(repo, request.runId) }; break;
        case 'score.show': {
            const report = readScoringRevisionReport(repo, request.runId, request.revisionId, request.executionId);
            const trials = request.trialId ? report.trials.filter(t => t.trialId === request.trialId) : report.trials;
            if (request.trialId && !trials.length) throw Error('Trial is not present in the selected scoring source');
            data = { revision: { revisionId: request.revisionId, executionId: report.executionId,
                conditionsComplete: report.scoringRevision?.conditionsComplete ?? false, statisticsPolicyVersion: report.statisticsPolicyVersion ?? 1,
                trials: trials.map(t => ({ trialId: t.trialId, caseId: t.caseId, status: t.status, reason: t.reason, scoringState: t.scoringState })),
                ...(request.trialId ? { scores: trials[0]!.scores.map(({ actual, expected, evidence, ...score }) => ({ ...score, evidenceCount: evidence.length })) } : {}) } };
            break;
        }
        case 'score.upload': {
            const { uploadScoringRevisionScores } = await import('../langfuse/scoring-revision.ts');
            const upload = await uploadScoringRevisionScores(repo, request, { connection: deps.connection });
            data = { upload }; exitCode = upload.status === 'complete' ? 0 : 2; break;
        }
        case 'benchmark.run': {
            const run = await runBenchmarkWorkflow(repo, request.selection, { ...deps.experiments, env: deps.env, signal: deps.signal });
            data = { run }; exitCode = run.exitCode; break;
        }
        case 'experiment.preview': data = { preview: previewExperiment(repo, request.plan, deps) }; break;
        case 'experiment.run': {
            const plan = experimentPlanSchema.parse(request.plan); if (!plan.id) throw Error('Experiment run requires an explicit stable plan.id');
            const old = listExperiments(repo).find(item => item.id === plan.id);
            const previousPlan = old ? { ...old.plan } : undefined;
            if (previousPlan && plan.evaluationBudgets === undefined) delete previousPlan.evaluationBudgets;
            if (old && !isDeepStrictEqual(previousPlan, plan)) throw Error('Experiment identity differs from its original plan');
            const experiment = old ?? await runExperiment(repo, plan, { ...deps.experiments, env: deps.env ?? deps.experiments?.env, signal: deps.signal ?? deps.experiments?.signal });
            data = { experiment, progress: runProgress(experiment.arms.flatMap(arm => arm.executionIds.map(id => readReport(reportPath(repo,id))))) }; exitCode = experiment.status === 'complete' ? 0 : 2; break;
        }
        case 'experiment.list': data = { items: listExperiments(repo) }; break;
        case 'experiment.show': { const experiment = listExperiments(repo).find(item => item.id === request.experimentId); if (!experiment) throw Error('Unknown experiment'); data = { experiment, progress: runProgress(experiment.arms.flatMap(arm => arm.executionIds.map(id => readReport(reportPath(repo,id))))) }; break; }
        case 'experiment.compare': { const comparisons = compareExperiment(repo, request.experimentId, request.scoringRevision); data = { comparisons }; exitCode = comparisons.some(item => item.status === 'blocked') ? 2 : 0; break; }
        case 'baseline.create': { const { action, ...input } = request; data = { baseline: createBaseline(repo, input) }; break; }
        case 'baseline.list': data = { items: listBaselines(repo) }; break;
        case 'gate.check': {
            const { action, ...input } = request;
            let gate: ReturnType<typeof checkGate>;
            try { gate = checkGate(repo, input); }
            catch (error) { gate = { ...input, status: 'blocked', exitCode: 2, fullRelease: false, scope: { selection: 'unavailable', datasets: [], cases: 0, trials: 0 },
                reasons: [{ code: 'evidence-unavailable', message: short(error), evidenceRefs: [] }], deltas: [] }; }
            data = { gate }; exitCode = gate.exitCode; break;
        }
    }
    const result = EvaluationWorkflowResultSchema.parse({ action: request.action, exitCode, data });
    return deps.desktopReader ? deps.desktopReader.project(result, request) : result;
}
