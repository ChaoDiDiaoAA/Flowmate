import type { TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';
import { isDeepStrictEqual } from 'node:util';

export const miningViewByteLimit = 192 * 1024;
type Omission = { pointer: string; reason: string; originalBytes: number };
export type MiningViewAudit = { contract: 'flowmate-mining-view/v1'; sourceTraceId: string; sourceRevision: number; sourceJsonBytes: number;
    maxBytes: number; viewJsonBytes: number; ready: boolean; projectionComplete: boolean; originalEventCount: number; retainedEventCount: number;
    omitted: Omission[]; additionalOmittedScopes: number; unknown: string[]; tokenCount: null };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? 'null');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pointer = (parent: string, key: string | number) => parent + '/' + String(key).replaceAll('~', '~0').replaceAll('/', '~1');

/** A partial data view; every retained array entry points into the immutable original Trace. */
export function buildMiningView(trace: TraceBundle, maxBytes = miningViewByteLimit) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096) throw Error('Mining view byte budget must be at least 4096');
    const audit: MiningViewAudit = { contract: 'flowmate-mining-view/v1', sourceTraceId: trace.id, sourceRevision: trace.revision,
        sourceJsonBytes: bytes(trace), maxBytes, viewJsonBytes: 0, ready: true, projectionComplete: true, originalEventCount: trace.events.length,
        retainedEventCount: 0, omitted: [], additionalOmittedScopes: 0, unknown: [], tokenCount: null };
    const events: Array<Record<string, unknown>> = [], materials: Array<Record<string, unknown>> = [], definitions: Array<Record<string, unknown>> = [];
    const facts: Record<string, unknown> = {}, evidence: Record<string, unknown> = {};
    const view = { id: trace.id, revision: trace.revision, source: structuredClone(trace.source), entry: trace.entry, startedAt: trace.startedAt, endedAt: trace.endedAt,
        input: { prompt: trace.input.prompt, ...(trace.input.turns ? { turns: structuredClone(trace.input.turns) } : {}) } as Record<string, unknown>,
        status: trace.status, complete: trace.complete, gaps: [...trace.gaps], configuration: {} as unknown, output: null as unknown,
        materials, facts, events, toolDefinitions: definitions, audit };
    const omitted = (path: string, reason: string, value: unknown) => {
        audit.projectionComplete = false;
        if (audit.omitted.length < 128) audit.omitted.push({ pointer: path, reason, originalBytes: bytes(value) });
        else audit.additionalOmittedScopes++;
    };
    const canonicalOutcomes: Array<{ pointer: string; value: unknown }> = [];
    const clean = (value: unknown, path: string): unknown => {
        if (typeof value === 'string' && /^data:(?:image|application\/pdf)\//i.test(value)) {
            omitted(path, 'Binary data URL omitted', value); return { pointer: path, omitted: true };
        }
        if (value && typeof value === 'object') {
            const same = canonicalOutcomes.find(item => item.pointer !== path && isDeepStrictEqual(item.value, value));
            if (same) { omitted(path, 'Exact duplicate; complete value retained at ' + same.pointer, value); return { pointer: path, duplicateOf: same.pointer }; }
        }
        if (Array.isArray(value)) return value.map((item, index) => clean(item, pointer(path, index)));
        if (!value || typeof value !== 'object') return value;
        const record = object(value);
        return Object.fromEntries(Object.entries(record).map(([key, item]) => {
            const child = pointer(path, key);
            if (['base64', 'contentBase64'].includes(key) || key === 'content' && record.encoding === 'base64' || key === 'data' && record.type === 'base64') {
                omitted(child, 'Binary/base64 payload omitted', item); return [key, { pointer: child, omitted: true }];
            }
            if (['runtimeSource', 'sourceCode', 'sourceFiles'].includes(key) || key === 'files' && /(?:environment|runtimeSource|isolation)/.test(path)) {
                omitted(child, 'Environment source/assets omitted', item); return [key, { pointer: child, omitted: true }];
            }
            return [key, clean(item, child)];
        }));
    };
    const undo: Array<() => void> = [];
    const reserve = Math.min(12 * 1024, Math.floor(maxBytes / 4));
    const offer = (path: string, original: unknown, apply: (value: unknown) => () => void) => {
        const sanitized = clean(original, path), remove = apply(sanitized);
        if (bytes(view) > maxBytes - reserve) { remove(); omitted(path, 'Whole entry omitted by view byte budget', original); return false; }
        undo.push(() => { remove(); omitted(path, 'Whole entry omitted by final view byte budget', original); }); return true;
    };
    const property = (target: Record<string, unknown>, key: string) => (value: unknown) => { target[key] = value; return () => { delete target[key]; }; };
    const append = (target: Array<Record<string, unknown>>, path: string) => (value: unknown) => {
        const entry = { ...object(value), pointer: path }, index = target.length; target.push(entry);
        return () => { target.splice(index, 1); };
    };
    if (bytes(view) > maxBytes - reserve) {
        omitted('/input', 'Mandatory Goal/turns exceed the view budget; model must not be called', trace.input);
        view.input = { pointer: '/input', omitted: true }; audit.ready = false;
    }
    offer('/configuration', trace.configuration, value => { view.configuration = value; return () => { view.configuration = {}; }; });
    if (offer('/output', trace.output, value => { view.output = value; return () => { view.output = null; }; })) {
        const remember = (value: unknown, path: string) => {
            if (!value || typeof value !== 'object' || bytes(value) < 1024) return;
            canonicalOutcomes.push({ pointer: path, value });
            for (const [key, child] of Object.entries(value)) remember(child, pointer(path, key));
        };
        remember(trace.output, '/output');
    }
    if (trace.input.materials) offer('/input/materials', trace.input.materials, property(view.input, 'materials'));
    for (const key of ['caseId', 'caseVersion', 'executionKind', 'started', 'status', 'error', 'infrastructure', 'judgeErrors'])
        if (Object.hasOwn(trace.facts, key)) offer(pointer('/facts', key), trace.facts[key], property(facts, key));
    const scores = Array.isArray(trace.facts.scores) ? trace.facts.scores : [];
    const keptScores: Array<Record<string, unknown>> = []; facts.scores = keptScores;
    for (const [index, score] of scores.entries()) offer(pointer('/facts/scores', index), score, append(keptScores, pointer('/facts/scores', index)));
    for (const [index, material] of trace.materials.entries()) {
        const path = pointer('/materials', index), item: Record<string, unknown> = { id: material.id, path: material.path, encoding: material.encoding };
        if (material.text !== undefined) item.text = material.text;
        else if (material.content !== undefined && material.encoding !== 'base64') item.content = material.content;
        else if (material.content !== undefined) {
            if (/\.(?:jpe?g|png|gif|webp|pdf|zip|gz|exe|woff2?)$/i.test(material.path ?? '')) omitted(path + '/content', 'Binary original retained only in the original Trace', material.content);
            else try {
                item.text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(material.content, 'base64'));
                item.representation = 'decoded-utf8-base64'; item.contentPointer = path + '/content';
            } catch { omitted(path + '/content', 'Non-text base64 retained only in the original Trace', material.content); }
        }
        offer(path, item, append(materials, path));
    }
    const originalEvidence = object(trace.facts.evidence); facts.evidence = evidence;
    const priority = ['candidate-values', 'candidate-fields', 'candidate-line-items', 'invoice', 'task-endpoint', 'new-candidates', 'cleanup', 'answer',
        'material-registration', 'input-projection', 'initial-input', 'inputs', 'interaction-history', 'runs'];
    // Actual tool observations retain raw/final arguments and original returned outcomes, without SDK history copies.
    for (const [index, raw] of trace.events.entries()) {
        const event = object(raw); if (event.kind !== 'tool') continue;
        offer(pointer('/events', index), event, append(events, pointer('/events', index)));
    }
    for (const key of priority) if (Object.hasOwn(originalEvidence, key)) {
        const path = pointer('/facts/evidence', key), original = object(originalEvidence[key]);
        const actual = key === 'runs' && Array.isArray(original.actual) ? original.actual.map((run, index) => {
            const { input, config, output, ...record } = object(run);
            for (const field of ['input', 'config', 'output']) if (Object.hasOwn(object(run), field)) omitted(path + '/actual/' + index + '/' + field, 'Run payload copy omitted; canonical Goal/outcome and tool entries are retained', object(run)[field]);
            return record;
        }) : original.actual;
        offer(path, { ...original, actual }, property(evidence, key));
    }
    for (const [key, original] of Object.entries(originalEvidence)) if (!priority.includes(key)) {
        omitted(pointer('/facts/evidence', key), 'Detailed acquisition/history/context copy omitted; original pointer remains authoritative', original);
        evidence[key] = { pointer: pointer('/facts/evidence', key), present: object(original).present, source: object(original).source, detailOmitted: true };
    }
    const used = new Set(trace.events.map(object).filter(event => event.kind === 'tool').map(event => event.name));
    const seenDefinitions: unknown[] = [];
    for (const [index, raw] of trace.events.entries()) {
        const event = object(raw), path = pointer('/events', index); if (event.kind === 'tool') continue;
        const input = object(event.input), tools = Array.isArray(input.tools) ? input.tools : [];
        if (tools.length) {
            for (const [toolIndex, tool] of tools.entries()) {
                const definition = object(tool), name = definition.name ?? object(definition.function).name;
                if (used.has(name) && !seenDefinitions.some(prior => isDeepStrictEqual(prior, definition))) {
                    seenDefinitions.push(definition); offer(path + '/input/tools/' + toolIndex, definition, append(definitions, path + '/input/tools/' + toolIndex));
                }
            }
        }
        const { input: ignoredInput, output: originalOutput, ...header } = event;
        if (Object.hasOwn(event, 'input')) omitted(path + '/input', 'Full SDK request/history omitted; used tool definitions are separately retained once', event.input);
        const output = event.kind === 'span' ? (() => {
            const { agent, ...value } = object(originalOutput);
            if (agent !== undefined) omitted(path + '/output/agent', 'Nested native result copy omitted; canonical outcomes and tool observations retained', agent);
            return value;
        })() : originalOutput;
        offer(path, { ...header, ...(output === undefined ? {} : { output }) }, append(events, path));
    }
    for (const [key, value] of Object.entries(trace.facts)) if (!Object.hasOwn(facts, key))
        offer(pointer('/facts', key), value, property(facts, key));
    audit.unknown = ['This is a selected partial view, not the complete Trace. Omitted data is not evidence of absence.',
        'Agent output and scores are observations; independent materials and business requirements must support Gold.',
        'Use original JSON pointers and material IDs for bindings, not projected array indexes. Decoded base64 text is a representation, not a new original Trace field.',
        'Native input token count is unmeasured; byte limits are not a token estimate.'];
    if (audit.additionalOmittedScopes) audit.unknown.push('Additional omission scopes exceed the bounded audit list; consult the full original Trace.');
    const measure = () => { audit.retainedEventCount = events.length; for (let i = 0; i < 3; i++) audit.viewJsonBytes = bytes(view); };
    measure(); while (bytes(view) > maxBytes && undo.length) { undo.pop()!(); measure(); }
    if (bytes(view) > maxBytes) {
        audit.ready = false; view.input = { pointer: '/input', omitted: true }; view.gaps = [];
        for (const key of Object.keys(facts)) delete facts[key];
        events.splice(0); materials.splice(0); definitions.splice(0); view.output = null; view.configuration = {};
        view.source = { kind: trace.source.kind };
        audit.omitted = [{ pointer: '/', reason: 'Mandatory metadata exceeds budget; original Trace required and no model call is allowed', originalBytes: audit.sourceJsonBytes }];
        audit.unknown = ['Mandatory metadata could not fit. This unavailable view must not be sent to a model.']; measure();
    }
    events.sort((left, right) => Number(String(left.pointer).split('/').at(-1)) - Number(String(right.pointer).split('/').at(-1)));
    return view;
}
