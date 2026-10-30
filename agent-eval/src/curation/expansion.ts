import { generatedCaseSchema } from '../dataset-loader/authoring.ts';
import { validateScenarioTurns } from '../dataset-loader/declarations.ts';
import { expandHarness } from '../dataset-loader/harness.ts';
import { decodeFile, type EmbeddedFile, type FlatDataset } from '../dataset-loader/flat.ts';
import { loadDataset, resolveCase } from '../dataset-loader/local.ts';
import { caseV2Schema } from '../dataset-loader/schema.ts';
import type { TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';
import { goldSchema, formalGoldSchema, scenarioSchema, safePath, type Candidate } from './schemas.ts';
import { sameCaseConditions, type CaseSnapshot } from './publication.ts';
import { isDeepStrictEqual } from 'node:util';

export function traceFiles(trace: TraceBundle): Record<string, EmbeddedFile> {
    const files: Record<string, EmbeddedFile> = {};
    for (const material of trace.materials) {
        if (!material.path || material.text === undefined && material.content === undefined) continue;
        const path = safePath.parse(material.path), encoding = material.text !== undefined ? 'utf8' as const : material.encoding ?? 'utf8';
        const content = material.text ?? material.content!, bytes = Buffer.from(content, encoding).length;
        const file = decodeFile({ path, encoding, content, bytes }).file;
        if (files[path]) {
            if (!decodeFile(files[path]).bytes.equals(decodeFile(file).bytes)) throw Error('Conflicting trace material path');
        } else files[path] = file;
    }
    return files;
}
/** JSON data expands through the same schemas and Harness as baseline declarations. */
export function expandCandidate(repo: string, candidate: Candidate, trace: TraceBundle, id: string, benchmarkId: string, revision: number,
    root: string, smoke = false, caseVersion = candidate.reviseCase ? candidate.reviseCase.version + 1 : 1, goldFiles: EmbeddedFile[] = [], formalCase?: CaseSnapshot) {
    const c = generatedCaseSchema.parse({ ...candidate.case, id }), strictGold = goldSchema.safeParse(candidate.gold), scenario = scenarioSchema.parse(candidate.scenario);
    if (!strictGold.success && !formalGoldSchema.safeParse(candidate.gold).success) throw strictGold.error;
    if (!strictGold.success && (!formalCase || candidate.reuseCaseId !== id || formalCase.case.id !== id || formalCase.version !== caseVersion ||
        !isDeepStrictEqual({ ...candidate.case, id }, formalCase.case) || !sameCaseConditions(candidate, formalCase, trace)))
        throw Error('Gold requires verified formal Case reuse; generated Gold must not overwrite Case constraint: semantic');
    const gold = strictGold.success ? strictGold.data : formalGoldSchema.parse(candidate.gold);
    validateScenarioTurns(c, scenario);
    const files = traceFiles(trace);
    for (const original of goldFiles) {
        const { file, bytes } = decodeFile(original);
        if (!gold.sources.includes(file.path)) throw Error('Unselected formal Gold source');
        if (files[file.path] && !decodeFile(files[file.path]).bytes.equals(bytes)) throw Error('Formal Gold source differs from Trace material');
        files[file.path] ??= file;
    }
    for (const [path, value] of Object.entries(scenario.files ?? {})) {
        safePath.parse(path);
        if (!path.endsWith('.json') && !path.endsWith('.txt') && !path.endsWith('.md')) throw Error('Scenario files must be data');
        if (files[path]) throw Error('Scenario must not overwrite source material');
        const bytes = Buffer.from(value.text ?? JSON.stringify(value.json));
        files[path] = { path, encoding: 'base64', content: bytes.toString('base64'), bytes: bytes.length };
    }
    const metadata = { contract: 'flowmate-agent-dataset/v2', id: benchmarkId, version: revision, name: benchmarkId, suite: 'published',
        environment: { profile: 'isolated-agent/v2', source: 'mixed', risks: c.risks },
        scoring: { version: 1, required: ['task-result', 'input-isolation', 'environment-isolation', 'no-secret', 'closed'],
            judges: [{ id: 'semantic-batch', required: false, requiredFor: c.scoring.judge.length ? [id] : [] }] } };
    if (gold.checks.some(check => !c.scoring.deterministic.includes(check.metric))) throw Error('Unselected deterministic check');
    const raw = { contract: 'flowmate-eval-case/v4', id, version: caseVersion, name: c.name, category: c.category, purpose: c.purpose,
        source: { type: 'controlled-workflow', basis: candidate.reason }, dataset: benchmarkId, smoke, tags: c.tags,
        requires: scenario.requires, input: { prompt: c.input.prompt, ...(c.input.turns ? { turns: c.input.turns } : {}), materials: scenario.materials },
        environment: 'isolated', ...(scenario.setup ? { setup: scenario.setup } : {}), steps: scenario.steps,
        expected: { ...c.expected, checks: gold.checks }, scoring: { methods: ['deterministic', 'llm-judge', 'human-review'],
            metrics: Object.fromEntries(Object.entries(gold.opportunities).filter(([key]) => key === 'task-success' || c.scoring.judge.includes(key) || c.scoring.deterministic.includes(key))),
            humanReview: c.scoring.manual }, risks: c.risks };
    const resources = Object.keys(files).filter(path => scenario.selection.enabledSkills.some(skill => path.startsWith(`resources/${skill}/`)));
    const expanded = expandHarness(raw, { contract: 'flowmate-eval-gold/v4', caseId: id, version: caseVersion, ...gold },
        { ...candidate.review, contract: 'flowmate-eval-review/v4', caseId: id, version: caseVersion, status: 'agent-reviewed', humanReview: 'pending' },
        { datasets: { [benchmarkId]: metadata }, files: Object.fromEntries(Object.keys(files).map(path => [path, path])), resources }, repo,
        path => { const file = files[path]; if (!file) throw Error('Missing snapshotted material: ' + path); return decodeFile(file).bytes; });
    const { files: visible, ...input } = expanded.task.input;
    const task = caseV2Schema.parse({ contract: 'flowmate-agent-case/v2', id, version: caseVersion, name: c.name, category: c.category,
        difficulty: c.difficulty, purpose: c.purpose, source: c.source, tags: c.tags, requires: expanded.task.requires, input,
        ...(expanded.task.setup ? { setup: expanded.task.setup } : {}), steps: expanded.task.steps,
        expected: { ...expanded.task.expected, ...expanded.gold.values }, review: { status: 'pending' } });
    const fixtureName = 'candidate-' + candidate.id;
    const flat: FlatDataset = { manifest: { ...metadata, members: [`cases/${id}.json`], smoke: smoke ? [id] : [] },
        tasks: { [`cases/${id}.json`]: task }, files, inputs: { [id]: [...visible, ...expanded.task.resourceFiles] },
        reviews: { [id]: expanded.review }, authored: { version: 'v1', cases: [{ ...c, input: { ...c.input, fixture: { name: fixtureName } } }],
            gold: { [id]: { ...gold, caseId: id, version: caseVersion } }, reviews: { [id]: { ...candidate.review, caseId: id, version: caseVersion } }, fixtures: { [fixtureName]: scenario } } };
    const dataset = loadDataset(root, repo, flat); resolveCase(dataset, task, repo);
    return dataset;
}
