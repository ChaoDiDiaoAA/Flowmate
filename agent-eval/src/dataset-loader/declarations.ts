import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { inside } from './local.ts';
import { expandHarness, assertNoHashes } from './harness.ts';
import { byteHash, type FlatDataset } from './flat.ts';
import { assertSafeFixtureName, loadFixture } from '../testing/load-fixture.ts';
import { authorDatasetSchema, type AuthorCase } from './authoring.ts';
import { isDeepStrictEqual } from 'node:util';

export function validateScenarioTurns(task: AuthorCase, scenario: any) {
    const turns = new Map(task.input.turns?.map(turn => [turn.id, turn])), used = new Set<string>();
    const requireTurn = (id: unknown, mode = 'prompt') => {
        if (typeof id !== 'string' || !turns.has(id)) throw Error(task.id + ': unknown scenario turnId: ' + String(id));
        if ((turns.get(id)!.mode ?? 'prompt') !== mode) throw Error(task.id + ': scenario turn mode differs: ' + id);
        used.add(id);
    };
    for (const step of scenario.steps ?? []) {
        if (step.turnId) requireTurn(step.turnId);
        else if (typeof step.instruction === 'string' && step.instruction !== '$input')
            throw Error(task.id + ': later user text belongs in input.turns');
    }
    for (const file of Object.values(scenario.files ?? {}) as any[]) {
        if (file.json?.contract === 'flowmate-user-history-seed/v1')
            for (const turn of file.json.turns ?? []) requireTurn(turn.turnId);
        if (file.json?.turnId) requireTurn(file.json.turnId, file.json.mode ?? 'prompt');
        if (file.json?.finalTurnId) requireTurn(file.json.finalTurnId);
        if (file.json?.recoveryTurnId) requireTurn(file.json.recoveryTurnId);
    }
    if ([...turns.keys()].some(id => !used.has(id))) throw Error(task.id + ': user turn has no scenario trigger');
    for (const skill of task.expected.requiredSkills ?? []) if (!scenario.selection.enabledSkills.includes(skill))
        throw Error(task.id + ': required Skill is not assembled: ' + skill);
    if (task.expected.requiredSubagentRoles?.length && !scenario.requires.includes('subagent'))
        throw Error(task.id + ': required subagent role is not assembled');
    if (task.expected.requiredResearchDimensions?.length && !scenario.requires.includes('research'))
        throw Error(task.id + ': research dimensions need a research scenario');
}

/** Trusted authored TS is loaded only by the evaluator, never mounted for the Agent. */
export function readDeclarationDatasets(root: string, repo: string): FlatDataset[] {
    const require = createRequire(import.meta.url);
    for(const name of ['cases.ts','gold.ts','review.ts'])delete require.cache[require.resolve(inside(root,name))];
    const declarations = require(inside(root, 'cases.ts'));
    const declaration = declarations.flowmateBadcaseDataset ?? declarations.flowmateAgentV1Dataset;
    const dataset = authorDatasetSchema.parse(declaration);
    const { goldByCaseId: gold } = require(inside(root, 'gold.ts'));
    const { reviewByCaseId: reviews } = require(inside(root, 'review.ts'));
    const supplemental = dataset.suite === 'badcase';
    if (supplemental) {
        const base = join(repo, 'agent-eval/src/datasets');
        const canonical = require(inside(base, 'cases.ts')).flowmateAgentV1Dataset.cases as AuthorCase[];
        const originalGold = require(inside(base, 'gold.ts')).goldByCaseId, originalReviews = require(inside(base, 'review.ts')).reviewByCaseId;
        const added: number[] = [];
        for (const c of dataset.cases) {
            const prior = canonical.find(old => old.id === c.id);
            if (prior && (!isDeepStrictEqual(prior, c) || !isDeepStrictEqual(originalGold[c.id], gold[c.id]) || !isDeepStrictEqual(originalReviews[c.id], reviews[c.id])))
                throw Error('Referenced Case/Gold/Review changed: ' + c.id);
            if (!prior) added.push(Number(c.id.slice(3)));
        }
        const next = Math.max(...canonical.map(c => Number(c.id.slice(3)))) + 1;
        if (added.sort((a,b) => a-b).some((id, index) => id !== next + index)) throw Error('Independent Case identities must be consecutive from FM-' + next);
    }
    const testingRoot = supplemental ? join(repo, 'agent-eval/src/testing') : join(root, '../testing'), fixtureRoot = join(testingRoot, 'fixtures');
    const scenarioPath = inside(testingRoot, 'scenarios.ts');
    delete require.cache[require.resolve(scenarioPath)];
    const { scenariosByName } = require(scenarioPath);
    [dataset, gold, reviews].forEach(assertNoHashes);
    if (dataset.version !== 'v1' || new Set(dataset.cases.map((c:any)=>c.id)).size !== dataset.cases.length ||
        dataset.cases.some(c => !gold[c.id] || !reviews[c.id]) ||
        JSON.stringify(Object.keys(gold).sort()) !== JSON.stringify(dataset.cases.map((c:any)=>c.id).sort()) ||
        JSON.stringify(Object.keys(reviews).sort()) !== JSON.stringify(Object.keys(gold).sort())) throw Error('Invalid Case/Gold/Review pairing');
    const sampleName = (virtual:string) => {
        if(virtual.includes('\\') || virtual.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Invalid material path: '+virtual);
        return assertSafeFixtureName(virtual.replaceAll('/','--'));
    };
    const groups = new Map<string, FlatDataset>();
    for (const c of [...dataset.cases].sort((a:any,b:any)=>a.id.localeCompare(b.id))) {
        if (!/^FM-\d{3}$/.test(c.id) || !/^[a-z0-9]+(?:_[a-z0-9]+){2,}$/.test(c.name) || /\p{Script=Han}/u.test(JSON.stringify(c)) ||
            !c.input.prompt || !c.expected.success.length || !c.expected.failure.length || !c.risks.length || !['capability','regression'].includes(c.purpose)) throw Error('Invalid English Case: '+c.id);
        const fixtureName = c.input.fixture?.name;
        const fixture = fixtureName ? scenariosByName[fixtureName] : { requires:['agent'], materials:[],
            steps:[{id:'request',action:'user-message',instruction:'$input'}], selection:{enabledSkills:[],enabledExtensions:[]} };
        if(!fixture)throw Error('Missing fixture scenario: '+fixtureName);
        assertNoHashes(fixture);
        validateScenarioTurns(c,fixture);
        if(gold[c.id].checks.some((check:any)=>!c.scoring.deterministic.includes(check.metric)))throw Error('Unselected deterministic check: '+c.id);
        if (dataset.regressionOrigins?.[c.id]?.some(origin => origin.metricIds.some(metric => ![...c.scoring.deterministic, ...c.scoring.judge].includes(metric))))
            throw Error('Unselected regression metric: ' + c.id);
        const tag = c.tags.includes('business') ? 'agent' : c.tags.includes('research') ? 'research' : undefined;
        if(!tag)throw Error('Unknown dataset membership: '+c.id);
        const id = supplemental ? `flowmate-badcase-${tag === 'agent' ? 'business' : 'research'}-v1` : `flowmate-${tag}-v1`;
        const metadata = {contract:'flowmate-agent-dataset/v2',id,version:1,name:id,
            ...(supplemental ? { suite: 'badcase' } : {}),
            environment:{profile:'isolated-agent/v2',source:tag==='research'?'local':'mixed',risks:['Independent human review and real evaluation are pending.']},
            scoring:{version:1,required:['task-result','input-isolation','environment-isolation','no-secret','closed'],judges:[{id:'semantic-batch',required:false,requiredFor:[] as string[]}]}};
        const resources = fixture.selection.enabledSkills.flatMap((skill:string)=>{
            const prefix=`resources/${assertSafeFixtureName(skill)}/`;
            const manifest=loadFixture<{files:{path:string}[]}>(sampleName(prefix+'resource'),fixtureRoot);
            return [prefix+'resource.json',...manifest.files.map(file=>prefix+file.path)];
        });
        const paths = new Set<string>([...Object.keys(fixture.files??{}),...gold[c.id].sources,...resources,
            ...fixture.materials.flatMap((m:any)=>m.source==='voxel51' ?
                ['content.json','content.md','metadata.json','pages.json','original.jpg'].map(file=>`voxel51/${m.sample}/${file}`):
                [m.file,...(m.originalFile?[m.originalFile]:[])].map(file=>`materials/${m.sample}/${file}`))]);
        const read = (virtual:string):Buffer => {
            if (!paths.has(virtual)) throw Error('Missing material: '+virtual);
            if (virtual.startsWith('voxel51/')) {
                const bytes=readFileSync(inside(join(repo,'data/invoices'),virtual));
                if(virtual.endsWith('/metadata.json')) {
                    const value=JSON.parse(bytes.toString('utf8'));
                    const keys=['schemaVersion','sampleId','sourceRecordId','datasetId','datasetRevision','allowedUsesClaim','licenseVerification','qualityStatus'];
                    return Buffer.from(JSON.stringify({...Object.fromEntries(keys.map(k=>[k,value[k]])),
                        files:value.files.filter((f:any)=>/^(original\.(jpg|png)|content\.json|pages\.json)$/.test(f.path)).map((f:any)=>({path:f.path,bytes:f.bytes}))}));
                }
                return bytes;
            }
            const p=fixture.files?.[virtual];
            return p ? Buffer.from(p.text ?? JSON.stringify(p.json)) : readFileSync(inside(fixtureRoot,sampleName(virtual)));
        };
        for(const key of Object.keys(c.expected))if(Object.hasOwn(gold[c.id].values,key))throw Error('Gold must not overwrite Case constraint: '+c.id+'/'+key);
        const raw={contract:'flowmate-eval-case/v4',version:1,id:c.id,name:c.name,category:c.category,purpose:c.purpose,
            source:{type:'controlled-workflow',basis:'Reviewed product workflows; controlled setup, not a real evaluation result.'},dataset:id,smoke:!supplemental && c.tags.includes('smoke'),tags:c.tags,
            requires:fixture.requires,input:{prompt:c.input.prompt,...(c.input.turns?{turns:c.input.turns}:{}),materials:fixture.materials},environment:'isolated',setup:fixture.setup,steps:fixture.steps,
            expected:{...c.expected,checks:gold[c.id].checks},scoring:{methods:['deterministic','llm-judge','human-review'],metrics:Object.fromEntries(Object.entries(gold[c.id].opportunities).filter(([id])=>id==='task-success'||c.scoring.judge.includes(id)||c.scoring.deterministic.includes(id))),humanReview:c.scoring.manual},risks:c.risks};
        const expanded=expandHarness(raw,{contract:'flowmate-eval-gold/v4',caseId:c.id,version:1,...gold[c.id]},
            {contract:'flowmate-eval-review/v4',caseId:c.id,version:1,status:'agent-reviewed',...reviews[c.id]},
            {datasets:{[id]:metadata},files:Object.fromEntries([...paths].map(p=>[p,p])),resources},repo,read);
        let group=groups.get(id);
        if(!group){group={manifest:{...metadata,members:[],smoke:[]},tasks:{},files:{},inputs:{},reviews:{},hash:'',authored:{version:'v1',cases:[],gold:{},reviews:{},fixtures:{}}};groups.set(id,group);}
        const task=expanded.task, member=`cases/${c.id}.json`;
        const {files:visible,...input}=task.input;
        group.tasks[member]={contract:'flowmate-agent-case/v2',id:c.id,version:1,name:c.name,category:c.category,difficulty:c.difficulty,purpose:c.purpose,source:c.source,tags:c.tags,requires:task.requires,input,
            ...(task.setup?{setup:task.setup}:{}),...(task.steps?{steps:task.steps}:{}),expected:{...task.expected,...expanded.gold.values},review:{status:'pending'}};
        group.inputs[c.id]=[...visible,...task.resourceFiles];
        group.manifest.members.push(member);if(!supplemental && c.tags.includes('smoke'))group.manifest.smoke.push(c.id);
        if(c.scoring.judge.length)group.manifest.scoring.judges[0]!.requiredFor!.push(c.id);
        if (supplemental) (group.regressionOrigins ??= {})[c.id] = dataset.regressionOrigins![c.id]!;
        for(const file of [...visible,...task.resourceFiles,...task.controllerFiles,...expanded.gold.sources]) {
            if(group.files[file.path]&&group.files[file.path]!.sha256!==file.sha256)throw Error('Conflicting source: '+file.path);
            group.files[file.path]=file;
        }
        const authored=group.authored!;authored.cases.push(c);authored.gold[c.id]=gold[c.id];authored.reviews[c.id]=reviews[c.id];
        if(fixtureName)authored.fixtures[fixtureName]=fixture;
    }
    return [...groups.values()].map(group=>({...group,hash:byteHash(JSON.stringify(group.authored))}));
}
