import { isDeepStrictEqual } from 'node:util';
import { createRegistry } from '../scoring/registry.ts';
import type { CaseExecutionResult } from '../types.ts';
import { fixtureSelection } from '../dataset-loader/selection.ts';
import { resolveCandidateCase } from './publication.ts';
import { candidateConditions, readCandidate, readTrace, writeCandidate, acquireCandidateWrite } from './store.ts';
import { expandCandidate } from './expansion.ts';
import { type Candidate, type Validation } from './schemas.ts';

export type ReplayResult = Validation['replay'];
export type Replay = (input: { candidate: Candidate; mode: 'controlled'; signal?: AbortSignal }) => Promise<ReplayResult>;
function read(value: unknown, path: Array<string | number>): unknown {
    for (const key of path) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}
export async function validateCandidate(repo: string, id: string, input: { expectedRevision: number; replay?: boolean; signal?: AbortSignal }, replay?: Replay): Promise<Validation> {
    const candidate = readCandidate(repo, id);
    if (candidate.revision !== input.expectedRevision) throw Error('Stale candidate revision');
    const trace = readTrace(repo, candidate.traceRef.id), conditions = candidateConditions(repo, candidate, trace), issues: string[] = [];
    if (trace.revision !== candidate.traceRef.revision) issues.push('Source trace revision changed');
    if (!trace.complete || trace.gaps.length) issues.push('Source trace is incomplete');
    if (!candidate.case || !candidate.gold || !candidate.scenario) issues.push('Case, Gold and scenario are required');
    if (!candidate.sourceLabels.length) issues.push('Independent source labels are required');
    if (candidate.case && !isDeepStrictEqual({ prompt: candidate.case.input.prompt, ...(candidate.case.input.turns ? { turns: candidate.case.input.turns } : {}) },
        { prompt: trace.input.prompt, ...(trace.input.turns ? { turns: trace.input.turns } : {}) })) issues.push('Original user input and turn order must be preserved');
    if (candidate.kind === 'regression' && !candidate.reuseCaseId && !candidate.reviseCase && (candidate.case?.difficulty !== 'regression' || candidate.case.purpose !== 'regression' || candidate.case.source !== 'regression-bug'))
        issues.push('New regression labels must be regression/regression/regression-bug');
    if (candidate.kind === 'gold' && !['PASS', 'completed'].includes(trace.status)) issues.push('Gold requires an independently supported successful trace');
    for (const binding of candidate.bindings) {
        const material = trace.materials.find(value => value.id === binding.materialId);
        const text = material?.text ?? (material?.content === undefined ? undefined : Buffer.from(material.content, material.encoding ?? 'utf8').toString('utf8'));
        if (!text?.includes(binding.quote)) issues.push('Source quote does not match material: ' + binding.materialId);
        const targets = binding.target.kind === 'answer' ? [candidate.case?.expected.expectedAnswerHint] : candidate.case?.expected[binding.target.kind] ?? [];
        if (!targets.includes(binding.target.text)) issues.push('Source binding does not match a declared condition');
    }
    if (!candidate.bindings.some(binding => binding.target.kind === 'success') || !candidate.bindings.some(binding => binding.target.kind === 'answer'))
        issues.push('Independent success and answer source bindings are required');
    for (const binding of candidate.controlBindings) {
        const actual = read(candidate.controls?.[binding.control]?.evidence[binding.evidence]?.actual, binding.path);
        if (binding.source.kind === 'trace') {
            if (actual === undefined || !isDeepStrictEqual(actual, read(trace, binding.source.path))) issues.push('Original trace control binding differs');
        } else {
            const source = binding.source, material = trace.materials.find(value => value.id === source.materialId);
            const text = material?.text ?? (material?.content === undefined ? undefined : Buffer.from(material.content, material.encoding ?? 'utf8').toString('utf8'));
            if (!text?.includes(source.quote) || actual === undefined || !source.quote.includes(typeof actual === 'string' ? actual : JSON.stringify(actual)))
                issues.push('Independent material control binding differs');
        }
    }
    const safeActions = ['user-message', 'invoice-message', 'select-candidate', 'research-plan', 'research-confirm', 'research-replay'];
    if (candidate.scenario?.steps.some(step => !safeActions.includes(step.action))) issues.push('Replay permits controlled Q&A, invoice candidates and research only');
    if (candidate.scenario?.setup || candidate.scenario?.selection.enabledExtensions.length) issues.push('Replay does not allow arbitrary controllers or extensions');
    if ([...(candidate.case?.expected.requiredCapabilities ?? []), ...(candidate.case?.expected.optionalCapabilities ?? [])].some(name =>
        ['bash', 'powershell', 'write', 'edit', 'fill_invoice_form', 'accept_invoice_candidate', 'export_invoice'].includes(name)))
        issues.push('Replay does not allow shell, external writes or real forms');
    let expanded: ReturnType<typeof expandCandidate> | undefined;
    try {
        const target = resolveCandidateCase(repo, candidate, trace);
        expanded = expandCandidate(repo, candidate, trace, target.caseId ?? 'FM-063', 'candidate-validation', 1, repo, false, target.caseVersion, target.goldFiles, target.formalCase);
        fixtureSelection(expanded, expanded.cases[0]!, repo);
    } catch (error) { issues.push('Schema/resources: ' + (error instanceof Error ? error.message : String(error))); }
    const controls = { negative: 'NOT_RUN', positive: 'NOT_RUN' };
    const registry = createRegistry(), checks = candidate.gold?.checks.filter(check => check.required && registry.get(check.metric).kind === 'deterministic') ?? [];
    for (const kind of ['negative', 'positive'] as const) {
        const control = candidate.controls?.[kind]; if (!control || !expanded || !checks.length) continue;
        const result: CaseExecutionResult = { identity: { executionId: 'controlled', trialId: 'controlled', caseId: expanded.cases[0]!.id, caseVersion: expanded.cases[0]!.version },
            started: true, status: 'completed', endpointReached: true, input: { prompt: candidate.case!.input.prompt, materials: [] }, answer: null,
            artifacts: [], observations: [], evidence: Object.fromEntries(Object.entries(control.evidence).map(([key, fact]) => [key, { ...fact, actual: fact.actual }])),
            configuration: {}, usage: {}, startedAt: null, endedAt: null };
        const values = [];
        for (const check of checks) {
            const evaluator = registry.get(check.metric), context = { task: expanded.cases[0]!, result, projected: result.input, judge: null };
            const refs = evaluator.evidence(check, context);
            for (const evidence of refs) {
                const sourceKind = kind === 'negative' ? 'trace' : 'material';
                if (!candidate.controlBindings.some(binding => binding.control === kind && binding.evidence === evidence && binding.source.kind === sourceKind &&
                    (check.metric !== 'fact-check' || isDeepStrictEqual(binding.path, check.path ?? [])))) issues.push('Missing source control binding: ' + kind + '/' + evidence);
                if (candidate.kind === 'gold' && kind === 'positive' && !candidate.controlBindings.some(binding => binding.control === kind && binding.evidence === evidence && binding.source.kind === 'trace'))
                    issues.push('Gold successful output needs an original trace control binding');
            }
            if (refs.some(key => !control.evidence[key]?.present))
                values.push('UNJUDGEABLE');
            else values.push((await evaluator.evaluate(context, check)).status);
        }
        controls[kind] = values.includes('FAIL') ? 'FAIL' : values.every(status => status === 'PASS') ? 'PASS' : 'UNJUDGEABLE';
    }
    if (controls.positive !== 'PASS') issues.push('Independent correct positive control was not verified');
    if (candidate.kind !== 'gold' && controls.negative !== 'FAIL') issues.push('Original failure negative control was not reproduced');
    let replayResult: ReplayResult = { status: 'NOT_RUN', kind: 'controlled', reason: 'No actual model replay was run; validator controls are engineering evidence.' };
    if (input.replay && !issues.length) {
        if (!replay) replayResult.reason = 'Controlled replay adapter is unavailable; no model was called.';
        else try { replayResult = await replay({ candidate, mode: 'controlled', signal: input.signal }); }
        catch (error) { replayResult = { status: 'ERROR', kind: 'controlled', reason: error instanceof Error ? error.message : String(error) }; }
        if (replayResult.status !== 'PASS' && !(candidate.kind === 'regression' && replayResult.status === 'FAIL')) issues.push('Requested replay did not pass');
    }
    const validation: Validation = { revision: candidate.revision, at: new Date().toISOString(), status: issues.length ? 'BLOCKED' : 'PASS',
        issues, controls, replay: replayResult, conditions };
    const release = acquireCandidateWrite(repo, id);
    try {
        const current = readCandidate(repo, id);
        if (current.revision !== candidate.revision || !isDeepStrictEqual(candidateConditions(repo, current), validation.conditions)) throw Error('Candidate conditions changed during validation');
        if (!issues.length && current.reviseCase) resolveCandidateCase(repo, current, trace);
        writeCandidate(repo, { ...current, status: issues.length ? 'blocked' : 'validated', validation }); return validation;
    } finally { release(); }
}
