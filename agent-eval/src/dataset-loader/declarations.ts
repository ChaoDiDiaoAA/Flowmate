import { readFileSync, existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { inside, readLocalMaterial, visitLocalCaseFiles } from './local.ts';
import { expandHarness } from './harness.ts';
import { type FlatDataset } from './flat.ts';
import { assertSafeFixtureName, loadFixture } from '../testing/load-fixture.ts';
import { authorDatasetSchema, type AuthorCase } from './authoring.ts';
import { isDeepStrictEqual } from 'node:util';
import { caseSchema, caseV2Schema, manifestSchema, type LocalCase } from './schema.ts';

export const supplementalDatasetIds: readonly string[] = ['flowmate-badcase-business-v1', 'flowmate-badcase-research-v1'];
function sampleName(virtual: string) {
    if (virtual.includes('\\') || virtual.split('/').some(part => !part || part === '.' || part === '..'))
        throw Error('Invalid material path: ' + virtual);
    return assertSafeFixtureName(virtual.replaceAll('/', '--'));
}
type DeclaredFixture = {
    materials: LocalCase['input']['materials']; files?: Record<string, { text?: string; json?: unknown }>;
    selection: { enabledSkills: string[] };
};
function readDeclaredMaterial(repo: string, fixtureRoot: string, fixture: DeclaredFixture, virtual: string) {
    sampleName(virtual);
    if (virtual.startsWith('voxel51/'))
        return readLocalMaterial(repo, join(repo, 'data/invoices/voxel51'), virtual.slice('voxel51/'.length));
    const inline = fixture.files?.[virtual];
    return inline ? Buffer.from(inline.text ?? JSON.stringify(inline.json)) : readFileSync(inside(fixtureRoot, sampleName(virtual)));
}
function membership(task: AuthorCase, supplemental: boolean) {
    const tag = task.tags.includes('business') ? 'agent' : task.tags.includes('research') ? 'research' : undefined;
    if (!tag) throw Error('Unknown dataset membership: ' + task.id);
    return { tag, id: supplemental ? `flowmate-badcase-${tag === 'agent' ? 'business' : 'research'}-v1` : `flowmate-${tag}-v1` };
}
function scenario(task: AuthorCase, scenariosByName: Record<string, any>) {
    const name = task.input.fixture?.name;
    const fixture = name ? scenariosByName[name] : { requires: ['agent'], materials: [],
        steps: [{ id: 'request', action: 'user-message', instruction: '$input' }], selection: { enabledSkills: [], enabledExtensions: [] } };
    if (!fixture) throw Error('Missing fixture scenario: ' + name);
    validateScenarioTurns(task, fixture); return fixture;
}

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

/** Registration is readable before material expansion; execution still uses the strict loader below. */
export function readDeclarationSource(root: string, repo: string) {
    const require = createRequire(import.meta.url);
    // Imported declaration JSON must follow the same fresh-read rule as its TS parent.
    for (const file of Object.keys(require.cache)) {
        if (!file.endsWith('.json')) continue;
        for (const fixtures of [join(root, '../testing/fixtures'), join(repo, 'agent-eval/src/testing/fixtures')]) {
            const path = relative(resolve(fixtures), file);
            if (path && !path.startsWith('..') && !isAbsolute(path)) {
                inside(fixtures, path); delete require.cache[file]; break;
            }
        }
    }
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
    if (dataset.version !== 'v1' || new Set(dataset.cases.map((c:any)=>c.id)).size !== dataset.cases.length ||
        dataset.cases.some(c => !gold[c.id] || !reviews[c.id]) ||
        JSON.stringify(Object.keys(gold).sort()) !== JSON.stringify(dataset.cases.map((c:any)=>c.id).sort()) ||
        JSON.stringify(Object.keys(reviews).sort()) !== JSON.stringify(Object.keys(gold).sort())) throw Error('Invalid Case/Gold/Review pairing');
    return { dataset, gold, reviews, scenariosByName, fixtureRoot };
}

/** Trusted authored TS is loaded only by the evaluator, never mounted for the Agent. */
export function readDeclarationDatasets(root: string, repo: string, resourceRepository = repo): FlatDataset[] {
    const { dataset, gold, reviews, scenariosByName, fixtureRoot } = readDeclarationSource(root, repo);
    const supplemental = dataset.suite === 'badcase';
    const groups = new Map<string, FlatDataset>();
    for (const c of [...dataset.cases].sort((a:any,b:any)=>a.id.localeCompare(b.id))) {
        if (!/^FM-\d{3}$/.test(c.id) || !/^[a-z0-9]+(?:_[a-z0-9]+){2,}$/.test(c.name) || /\p{Script=Han}/u.test(JSON.stringify(c)) ||
            !c.input.prompt || !c.expected.success.length || !c.expected.failure.length || !c.risks.length || !['capability','regression'].includes(c.purpose)) throw Error('Invalid English Case: '+c.id);
        const fixtureName = c.input.fixture?.name;
        const fixture = scenario(c, scenariosByName);
        if(gold[c.id].checks.some((check:any)=>!c.scoring.deterministic.includes(check.metric)))throw Error('Unselected deterministic check: '+c.id);
        if (dataset.regressionOrigins?.[c.id]?.some(origin => origin.metricIds.some(metric => ![...c.scoring.deterministic, ...c.scoring.judge].includes(metric))))
            throw Error('Unselected regression metric: ' + c.id);
        const { tag, id } = membership(c, supplemental);
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
            const bytes = readDeclaredMaterial(repo, fixtureRoot, fixture, virtual);
            if (virtual.startsWith('voxel51/')) {
                if(virtual.endsWith('/metadata.json')) {
                    const value=JSON.parse(bytes.toString('utf8'));
                    const keys=['schemaVersion','sampleId','sourceRecordId','datasetId','datasetRevision','allowedUsesClaim','licenseVerification','qualityStatus'];
                    return Buffer.from(JSON.stringify({...Object.fromEntries(keys.map(k=>[k,value[k]])),
                        files:value.files.filter((f:any)=>/^(original\.(jpg|png)|content\.json|pages\.json)$/.test(f.path)).map((f:any)=>({path:f.path,bytes:f.bytes}))}));
                }
                return bytes;
            }
            return bytes;
        };
        for(const key of Object.keys(c.expected))if(Object.hasOwn(gold[c.id].values,key))throw Error('Gold must not overwrite Case constraint: '+c.id+'/'+key);
        const raw={contract:'flowmate-eval-case/v4',version:1,id:c.id,name:c.name,category:c.category,purpose:c.purpose,
            source:{type:'controlled-workflow',basis:'Reviewed product workflows; controlled setup, not a real evaluation result.'},dataset:id,smoke:!supplemental && c.tags.includes('smoke'),tags:c.tags,
            requires:fixture.requires,input:{prompt:c.input.prompt,...(c.input.turns?{turns:c.input.turns}:{}),materials:fixture.materials},environment:'isolated',setup:fixture.setup,steps:fixture.steps,
            expected:{...c.expected,checks:gold[c.id].checks},scoring:{methods:['deterministic','llm-judge','human-review'],metrics:Object.fromEntries(Object.entries(gold[c.id].opportunities).filter(([id])=>id==='task-success'||c.scoring.judge.includes(id)||c.scoring.deterministic.includes(id))),humanReview:c.scoring.manual},risks:c.risks};
        const expanded=expandHarness(raw,{contract:'flowmate-eval-gold/v4',caseId:c.id,version:1,...gold[c.id]},
            {contract:'flowmate-eval-review/v4',caseId:c.id,version:1,status:'agent-reviewed',...reviews[c.id]},
            {datasets:{[id]:metadata},files:Object.fromEntries([...paths].map(p=>[p,p])),resources},resourceRepository,read);
        let group=groups.get(id);
        if(!group){group={manifest:{...metadata,members:[],smoke:[]},tasks:{},files:{},inputs:{},reviews:{},authored:{version:'v1',cases:[],gold:{},reviews:{},fixtures:{}}};groups.set(id,group);}
        const task=expanded.task, member=`cases/${c.id}.json`;
        const {files:visible,...input}=task.input;
        group.tasks[member]={contract:'flowmate-agent-case/v2',id:c.id,version:1,name:c.name,category:c.category,difficulty:c.difficulty,purpose:c.purpose,source:c.source,tags:c.tags,requires:task.requires,input,
            ...(task.setup?{setup:task.setup}:{}),...(task.steps?{steps:task.steps}:{}),expected:{...task.expected,...expanded.gold.values},review:{status:'pending'}};
        group.inputs[c.id]=[...visible,...task.resourceFiles];
        group.manifest.members.push(member);if(!supplemental && c.tags.includes('smoke'))group.manifest.smoke.push(c.id);
        if(c.scoring.judge.length)group.manifest.scoring.judges[0]!.requiredFor!.push(c.id);
        if (supplemental) (group.regressionOrigins ??= {})[c.id] = dataset.regressionOrigins![c.id]!;
        for(const file of [...visible,...task.resourceFiles,...task.controllerFiles,...expanded.gold.sources]) {
            if(group.files[file.path]&&!isDeepStrictEqual(group.files[file.path],file))throw Error('Conflicting source: '+file.path);
            group.files[file.path]=file;
        }
        const authored=group.authored!;authored.cases.push(c);authored.gold[c.id]=gold[c.id];authored.reviews[c.id]=reviews[c.id];
        if(fixtureName)authored.fixtures[fixtureName]=fixture;
    }
    return [...groups.values()];
}

export type CaseDeclaration = {
    datasetId: string; datasetVersion: number; caseId: string; caseVersion: number; name: string; category: string; smoke: boolean;
    root: string; task: AuthorCase | LocalCase; gold: unknown; review: unknown; fixture: unknown; fixtureRoot: string | null;
    manifest?: import('./local.ts').LocalDataset['manifest'];
};
export function discoverCaseDeclarations(repo: string): CaseDeclaration[] {
    const base = join(repo, 'agent-eval/src/datasets'), declarations: CaseDeclaration[] = [];
    for (const root of [base, join(base, 'badcase')]) {
        if (!existsSync(root)) continue;
        if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() || realpathSync(root).toLowerCase() !== resolve(root).toLowerCase())
            throw Error('Linked or invalid Dataset collection rejected');
        const supplementalRoot = root !== base;
        if (existsSync(join(root, 'cases.ts'))) {
            const source = readDeclarationSource(root, repo), supplemental = source.dataset.suite === 'badcase';
            for (const task of source.dataset.cases) {
                const { id } = membership(task, supplemental);
                if (supplementalDatasetIds.includes(id) !== supplementalRoot) continue;
                declarations.push({ datasetId: id, datasetVersion: 1, caseId: task.id, caseVersion: 1, name: task.name,
                    category: task.category, smoke: !supplemental && task.tags.includes('smoke'), root, task,
                    gold: source.gold[task.id], review: source.reviews[task.id], fixture: scenario(task, source.scenariosByName), fixtureRoot: source.fixtureRoot });
            }
        } else for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const directory = join(root, entry.name);
            if (!existsSync(join(directory, 'dataset.json'))) continue;
            const manifest = manifestSchema.parse(JSON.parse(readFileSync(inside(root, entry.name + '/dataset.json'), 'utf8')));
            if (supplementalDatasetIds.includes(manifest.id) !== supplementalRoot) continue;
            const schema = manifest.contract === 'flowmate-agent-dataset/v2' ? caseV2Schema : caseSchema, ids = new Set<string>();
            for (const member of manifest.members) {
                const task = schema.parse(JSON.parse(readFileSync(inside(directory, member), 'utf8')));
                if (ids.has(task.id)) throw Error('Duplicate Case identity'); ids.add(task.id);
                declarations.push({ datasetId: manifest.id, datasetVersion: manifest.version, caseId: task.id, caseVersion: task.version,
                    name: task.name, category: task.category, smoke: manifest.smoke.includes(task.id), root: directory, task,
                    gold: 'reference' in task.expected ? task.expected.reference ?? null : null, review: task.review,
                    fixture: { requires: task.requires, materials: task.input.materials, ...(task.setup ? { setup: task.setup } : {}), ...(task.steps ? { steps: task.steps } : {}) },
                    fixtureRoot: null, manifest });
            }
        }
    }
    const identities = declarations.map(item => JSON.stringify([item.datasetId, item.caseId]));
    if (new Set(identities).size !== identities.length) throw Error('Duplicate Dataset/Case identity');
    return declarations.sort((a, b) => a.datasetId.localeCompare(b.datasetId) || a.caseId.localeCompare(b.caseId));
}

export function inspectCaseDeclaration(repo: string, datasetId: string, caseId: string) {
    const declaration = discoverCaseDeclarations(repo).find(item => item.datasetId === datasetId && item.caseId === caseId);
    if (!declaration) throw Error('Unknown registered Case');
    const files = new Map<string, { path: string; encoding: 'base64'; content: string; bytes: number }>();
    const gaps = new Map<string, { path: string; reason: 'missing' | 'invalid' }>();
    const invalid = (path: string) => { gaps.set(path, { path, reason: 'invalid' }); };
    const read = (path: string, source: () => Buffer): Buffer | null => {
        try {
            const bytes = source();
            files.set(path, { path, encoding: 'base64', content: bytes.toString('base64'), bytes: bytes.length }); return bytes;
        } catch (error) {
            const missing = error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
            gaps.set(path, { path, reason: missing ? 'missing' : 'invalid' }); return null;
        }
    };
    if (declaration.fixtureRoot) {
        const fixture = declaration.fixture as DeclaredFixture, gold = declaration.gold as { sources: string[] };
        if (!Array.isArray(gold.sources) || gold.sources.some(path => typeof path !== 'string')) throw Error('Invalid Gold sources');
        const readMaterial = (path: string) => read(path, () => readDeclaredMaterial(repo, declaration.fixtureRoot!, fixture, path));
        const paths = new Set([...Object.keys(fixture.files ?? {}), ...gold.sources,
            ...fixture.materials.flatMap(material => material.source === 'voxel51'
                ? ['content.json', 'content.md', 'metadata.json', 'pages.json', 'original.jpg'].map(file => `voxel51/${material.sample}/${file}`)
                : [material.file, ...(material.originalFile ? [material.originalFile] : [])].map(file => `materials/${material.sample}/${file}`))]);
        for (const skill of fixture.selection.enabledSkills) {
            const prefix = `resources/${assertSafeFixtureName(skill)}/`, path = prefix + 'resource.json', bytes = readMaterial(path);
            if (bytes) try {
                const resource = JSON.parse(bytes.toString('utf8'));
                if (!Array.isArray(resource.files) || resource.files.some((file: { path?: unknown }) => typeof file?.path !== 'string'))
                    throw Error('Invalid resource files');
                for (const file of resource.files) paths.add(prefix + file.path);
            } catch { invalid(path); }
        }
        for (const path of paths) {
            const bytes = readMaterial(path);
            if (bytes && path.startsWith('voxel51/') && path.endsWith('/metadata.json'))
                try { JSON.parse(bytes.toString('utf8')); } catch { invalid(path); }
        }
    } else visitLocalCaseFiles(repo, declaration.root, declaration.task as LocalCase,
        (root, path, publicPath) => read(publicPath, () => readLocalMaterial(repo, root, path)), invalid);
    const actualFiles = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    const actualGaps = [...gaps.values()].sort((a, b) => a.path.localeCompare(b.path));
    const conditions = { contract: 'flowmate-case-inspection/v1', dataset: { id: declaration.datasetId, version: declaration.datasetVersion },
        task: declaration.task, gold: declaration.gold, fixture: declaration.fixture,
        manifest: declaration.manifest ? { environment: declaration.manifest.environment, scoring: declaration.manifest.scoring } : null,
        files: actualFiles, gaps: actualGaps };
    return { declaration, files: actualFiles, gaps: actualGaps, conditions };
}
