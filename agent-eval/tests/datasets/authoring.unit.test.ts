import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { authorCaseSchema, authorDatasetSchema } from '../../src/dataset-loader/authoring.ts';
import { caseV2Schema, controllerStepsSchema } from '../../src/dataset-loader/schema.ts';
import { validateScenarioTurns } from '../../src/dataset-loader/declarations.ts';
import { discoverDatasets, resolveCase, REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { flowmateAgentV1Dataset } from '../../src/datasets/cases.ts';
import { reviewByCaseId } from '../../src/datasets/review.ts';
import { scenariosByName } from '../../src/testing/scenarios.ts';
import { expandHarness } from '../../src/dataset-loader/harness.ts';

const sample = () => structuredClone(flowmateAgentV1Dataset.cases[0]!) as any;
test('authoring requires explicit limits and rejects typos, invalid identities, conflicting constraints and fake types', () => {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '20', undefined]) {
        const draft = sample(); draft.expected.maxToolCalls = value;
        expect(() => authorCaseSchema.parse(draft)).toThrow();
    }
    for (const mutate of [
        (c: any) => { c.expected.maxToolCalls = 0; },
        (c: any) => { c.expected.mustHaveEvidence = 'true'; },
        (c: any) => { c.expected.maxToolsCalls = 20; },
        (c: any) => { c.input.workspaceContext = { environment: 'ignored' }; },
        (c: any) => { c.extra = 'silently ignored'; },
        (c: any) => { c.difficulty = 'invented'; },
        (c: any) => { c.source = 'invented'; },
        (c: any) => { c.expected.requiredCapabilities = ['save_invoice_candidte']; },
        (c: any) => { c.expected.requiredCapabilities = ['save_invoice_candidate', 'save_invoice_candidate']; },
        (c: any) => { c.expected.optionalCapabilities = ['save_invoice_candidate']; },
        (c: any) => { c.expected.forbiddenCapabilities = ['save_invoice_candidate']; },
        (c: any) => { c.expected.requiredSkills = ['missing-skill']; },
        (c: any) => { c.expected.requiredSkills = ['invoice-header-extraction']; c.expected.forbiddenSkills = ['invoice-header-extraction']; },
        (c: any) => { c.expected.requiredSubagentRoles = ['imaginary-role']; },
        (c: any) => { c.scoring.judge = ['imaginary-metric']; },
    ]) {
        const draft = sample(); mutate(draft); expect(() => authorCaseSchema.parse(draft)).toThrow();
    }
    const noTools = sample(); noTools.expected.maxToolCalls = 0; delete noTools.expected.requiredCapabilities;
    expect(authorCaseSchema.parse(noTools).expected.maxToolCalls).toBe(0);
    const simple = sample(); delete simple.input.fixture;
    expect(authorCaseSchema.parse(simple).input.fixture).toBeUndefined();
    expect(() => authorDatasetSchema.parse({ version: 'v1', cases: [simple, simple] })).toThrow('Duplicate Case');
});

test('turn scripts contain only subsequent user inputs and reject duplicate IDs, invalid roles, empty content and modes', () => {
    for (const turn of [
        { id: 'later', role: 'assistant', content: 'A prewritten answer.' },
        { id: 'later', role: 'user', content: ' ' },
        { id: '../later', role: 'user', content: 'Continue.' },
        { id: 'later', role: 'user', content: 'Continue.', mode: 'unknown' },
        { id: 'later', role: 'user', content: 'Continue.', toolResult: 'fake' },
    ]) { const draft = sample(); draft.input.turns = [turn]; expect(() => authorCaseSchema.parse(draft)).toThrow(); }
    const turn = { id: 'later', role: 'user', content: 'Now save the invoice.' };
    const draft = sample(); draft.input.turns = [turn, turn];
    expect(() => authorCaseSchema.parse(draft)).toThrow('Duplicate user turn');
    for (const mode of ['prompt', 'followUp', 'steer']) {
        draft.input.turns = [{ ...turn, mode }]; expect(authorCaseSchema.parse(draft).input.turns).toHaveLength(1);
    }
    draft.input.prompt = '  Keep this exact input.\n'; draft.input.turns = [{ ...turn, content: '  Exact later input.\n' }];
    const parsed = authorCaseSchema.parse(draft);
    expect(parsed.input.prompt).toBe(draft.input.prompt); expect(parsed.input.turns![0]!.content).toBe(draft.input.turns[0].content);
    for (const step of [
        { id: 'later', action: 'user-message' },
        { id: 'later', action: 'user-message', turnId: 'later', instruction: 'Duplicate text.' },
    ]) expect(() => controllerStepsSchema.parse([step])).toThrow();
    expect(controllerStepsSchema.parse([{ id: 'later', action: 'user-message', turnId: 'later' }])).toHaveLength(1);
});

test('Gold cannot overwrite authored Case constraints during Harness expansion', () => {
    const raw = { contract:'flowmate-eval-case/v4', id:'FM-999', version:1, name:'task_guard_gold', category:'task', purpose:'regression',
        source:{type:'controlled-workflow',basis:'Synthetic contract test.'}, dataset:'synthetic', smoke:false, tags:['synthetic'], requires:['agent'],
        input:{prompt:'Answer the current request.',materials:[]}, environment:'isolated', expected:{maxToolCalls:0},
        scoring:{methods:['deterministic'],metrics:{'task-success':1},humanReview:'Pending.'}, risks:['No writes.'] };
    for (const values of [{maxToolCalls:100},{expectedAnswerHint:'Overridden.'},{requiredSkills:['invoice-header-extraction']}])
        expect(() => expandHarness(raw,{contract:'flowmate-eval-gold/v4',caseId:'FM-999',version:1,values,sources:[]},
            {contract:'flowmate-eval-review/v4',caseId:'FM-999',version:1,status:'agent-reviewed',humanReview:'pending'},
            {datasets:{synthetic:{}},files:{},resources:[]},'/not-used')).toThrow('Gold must not overwrite Case constraint');
});

test('scenario triggers resolve each later turn and require actual Skill and role assembly', () => {
    const case10 = structuredClone(flowmateAgentV1Dataset.cases.find(c => c.id === 'FM-010')!) as any;
    const scenario = structuredClone(scenariosByName[case10.input.fixture.name]);
    expect(() => validateScenarioTurns(case10, scenario)).not.toThrow();
    scenario.steps[1].turnId = 'missing'; expect(() => validateScenarioTurns(case10, scenario)).toThrow('unknown scenario turnId');
    scenario.steps[1].turnId = 'confirm'; case10.input.turns[0].mode = 'steer';
    expect(() => validateScenarioTurns(case10, scenario)).toThrow('mode differs');
    delete case10.input.turns[0].mode; case10.input.turns.push({ id: 'unused', role: 'user', content: 'Never submitted.' });
    expect(() => validateScenarioTurns(case10, scenario)).toThrow('no scenario trigger');
    const skillCase = structuredClone(flowmateAgentV1Dataset.cases.find(c => c.id === 'FM-027')!);
    const missingSkill = structuredClone(scenariosByName[skillCase.input.fixture.name]); missingSkill.selection.enabledSkills = [];
    expect(() => validateScenarioTurns(skillCase, missingSkill)).toThrow('not assembled');
    scenario.steps[1] = { id: 'confirm', action: 'user-message', instruction: 'Keep duplicate later text.' };
    expect(() => validateScenarioTurns(case10, scenario)).toThrow('belongs in input.turns');
    const case25 = flowmateAgentV1Dataset.cases.find(c => c.id === 'FM-025')!;
    const laterTurns = case25.input.turns!;
    const autoScenario = structuredClone(scenariosByName[case25.input.fixture.name]);
    const seed = autoScenario.files['quality-controls/FM-025/history-seed.json'].json;
    expect(laterTurns).toHaveLength(17);
    expect(seed.turns).toHaveLength(16);
    for (const reference of seed.turns) {
        expect(Object.keys(reference)).toEqual(['turnId']);
        expect(laterTurns.find(turn => turn.id === reference.turnId)?.role).toBe('user');
    }
    expect(laterTurns.find(turn => turn.id === 'seed-15')!.content).toContain('I now specify USD');
    expect(JSON.stringify(seed)).not.toContain('I now specify USD');
    seed.turns[0].turnId = 'missing-seed';
    expect(() => validateScenarioTurns(case25, autoScenario)).toThrow('unknown scenario turnId');
});

test('loading retains every constraint and private turn, preserves authorship and keeps future inputs outside projection', () => {
    const datasets = discoverDatasets(join(REPO_ROOT, 'agent-eval/src/datasets'));
    const hints = new Set<string>(); let userTurns = 0;
    for (const dataset of datasets) for (const task of dataset.cases) {
        const authored = flowmateAgentV1Dataset.cases.find(c => c.id === task.id)!;
        for (const [key, value] of Object.entries(authored.expected)) expect((task.expected as any)[key]).toEqual(value);
        expect(task.difficulty).toBe(authored.difficulty); expect(task.source).toBe(authored.source); expect(task.purpose).toBe(authored.purpose);
        expect(task.input.turns).toEqual('turns' in authored.input ? authored.input.turns : undefined);
        expect(reviewByCaseId[task.id].toolCallLimit.value).toBe(task.expected.maxToolCalls);
        expect(reviewByCaseId[task.id].toolCallLimit.calibration).toBe('not-run');
        hints.add(task.expected.expectedAnswerHint!); userTurns += task.input.turns?.length ?? 0;
        const projected = resolveCase(dataset, task).projected;
        expect(Object.keys(projected).sort()).toEqual(['materials', 'prompt']);
        for (const turn of task.input.turns ?? []) expect(JSON.stringify(projected)).not.toContain(turn.content);
        const parsed = caseV2Schema.parse(task);
        if (parsed.input.turns?.length && parsed.steps?.some(step => 'turnId' in step)) {
            const broken = structuredClone(parsed) as any;
            broken.steps.find((step: any) => step.turnId).turnId = 'unknown-turn';
            expect(() => caseV2Schema.parse(broken)).toThrow('Unknown user turn');
        }
    }
    expect(hints.size).toBe(62); expect(userTurns).toBe(52);
    for (const id of ['FM-002', 'FM-028']) {
        const task = datasets[0]!.cases.find(c => c.id === id)!;
        expect(task.expected.maxToolCalls).toBe(0); expect(task.expected.mustHaveEvidence).toBe(false);
        if (!('contract' in task)) throw Error('Current Case contract required');
        for (const metric of ['runtime-admission', 'tool-execution', 'result-delivery'])
            expect(task.expected.metrics.find(item => item.metricId === metric)?.notApplicable).toBeDefined();
    }
});

test('manual compaction submits distinct source-labelled user history before its correction and native compact step', () => {
    const declaration = flowmateAgentV1Dataset.cases.find(task => task.id === 'FM-024')!;
    const scenario = scenariosByName[declaration.input.fixture!.name];
    const compact = scenario.steps.findIndex((step: { action: string }) => step.action === 'compact-history');
    const seeds = declaration.input.turns!.filter(turn => turn.id.startsWith('history-'));
    expect(seeds).toHaveLength(3);
    expect(seeds.every(turn => Buffer.byteLength(turn.content) < 65000)).toBe(true);
    // Even the two most recent seed messages exceed the untouched native 20k-token retention window.
    expect(seeds.slice(1).reduce((size, turn) => size + turn.content.length, 0)).toBeGreaterThan(80000);
    const rows = seeds.flatMap(turn => [...turn.content.matchAll(/Record (\d+): synthetic item SKU-(\d+)/g)].map(match => match[1]));
    expect(rows).toHaveLength(1200);
    expect(new Set(rows).size).toBe(1200);
    expect(seeds.every(turn => turn.content.includes('user-supplied inventory') && turn.content.includes('not invoice evidence'))).toBe(true);
    expect(scenario.steps.slice(1, compact).map((step: { turnId: string }) => step.turnId)).toEqual([...seeds.map(turn => turn.id), 'correction']);
    expect(declaration.input.turns!.find(turn => turn.id === 'correction')!.content).toContain('CNY');
    expect(() => validateScenarioTurns(declaration, scenario)).not.toThrow();
});
