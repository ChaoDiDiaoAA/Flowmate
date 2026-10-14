import { expect, test } from 'bun:test';
import { scenariosByName } from '../../src/testing/scenarios.ts';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { loadDataset, resolveCase, caseContentHash, hash, selectCases } from '../../src/dataset-loader/local.ts';
import { metricCatalog } from '../../src/scoring/catalog.ts';
import { caseSchema, caseV2Schema, checkSchema } from '../../src/dataset-loader/schema.ts';
import { ExtensionManifestSchema,canonicalExtensionManifest } from '../../../packages/contracts/src/extensions.ts';
import { manifest, tasks } from '../fixtures/minimal-dataset.ts';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'eval-v2-'));
    const text = '地域甲使用版本2。😀地域乙使用版本3。';
    mkdirSync(join(root, 'cases')); mkdirSync(join(root, 'materials/source-a'), { recursive: true });
    writeFileSync(join(root, 'materials/source-a/policy.md'), text);
    const item = { ...structuredClone(tasks[0]!), contract: 'flowmate-agent-case/v2', id: 'local-research',
        input: { prompt: '比较两个地域的版本。', materials: [{ source: 'local-text', sample: 'source-a', file: 'policy.md', sha256: hash(text), originalSha256: hash(text) }] },
        expected: { success: ['忠实说明差异'], failure: ['编造版本'], checks: [{ metric: 'fact-check', required: true, evidence: 'research', path: ['reportCount'], equals: 1 }],
            metrics: metricCatalog.map(m => m.id === 'task-success'
                ? { metricId: m.id, version: m.version, unit: m.unit, denominator: 1 }
                : { metricId: m.id, version: m.version, unit: m.unit, notApplicable: '本受控契约夹具只验证任务终点' }),
            research: { status: 'pending', claims: [{ id: 'region-a', text: '地域甲使用版本2', required: true,
                acceptable: ['地域甲为v2'], conditions: ['当前冻结政策'], entities: ['地域甲'],
                evidence: [{ sample: 'source-a', sha256: hash(text), start: 0, end: 9, quote: '地域甲使用版本2。', relation: 'support' }] }], chains: [], forbidden: ['地域甲使用版本3'] } },
        review: { status: 'pending' } };
    const data = { ...structuredClone(manifest), contract: 'flowmate-agent-dataset/v2',
        id: 'local-facility', members: ['cases/local-research.json'], smoke: ['local-research'],
        environment: { profile: 'isolated-agent/v2', source: 'local', risks: ['synthetic'] },
        scoring: { ...manifest.scoring, judges: [] } };
    const save = () => {
        writeFileSync(join(root, 'cases/local-research.json'), JSON.stringify(item));
        writeFileSync(join(root, 'dataset.json'), JSON.stringify(data));
    };
    save(); return { root, text, item, data, save };
}
test('v2 resolves only declared local UTF-8 materials and keeps all Gold out of the visible projection', () => {
    const f = fixture(), d = loadDataset(f.root), c = d.cases[0]!;
    const resolved = resolveCase(d, c, '/no-voxel51');
    expect(resolved.projected).toEqual({ prompt: f.item.input.prompt, materials: [{ sample: 'source-a', file: 'policy.md', text: f.text }] });
    expect(JSON.stringify(resolved.projected)).not.toContain('forbidden');
    expect(resolved.projected).not.toHaveProperty('expected');
    expect(selectCases(d, 'holdout')).toEqual([]);
    f.item.input.materials[0]!.file = '../gold.json'; f.save();
    expect(() => loadDataset(f.root)).toThrow();
});
test('v1/v2 Case mixing, unknown versions and unregistered metrics are rejected', () => {
    const f = fixture();
    f.data.contract = 'flowmate-agent-dataset/v1'; f.save();
    expect(() => loadDataset(f.root)).toThrow();
    f.data.contract = 'flowmate-agent-dataset/v9'; f.save();
    expect(() => loadDataset(f.root)).toThrow();
    f.data.contract = 'flowmate-agent-dataset/v2'; f.item.expected.metrics[0]!.metricId = 'invented'; f.save();
    expect(() => loadDataset(f.root)).toThrow();
});

test('v2 compact selection requires criteria only for applicable semantic opportunities', () => {
    const f = fixture();
    const item = { ...f.item, expected: { ...f.item.expected, semantic: { contract: 'flowmate-semantic-plan/v1', criteria: [
        { metricId: 'tool-selection', version: 1, unit: '决策点', denominator: 3, required: true, rule: 'Three synthetic decisions.',
            evidence: ['research'], trigger: 'started' }
    ] }, metrics: f.item.expected.metrics.map(m => m.metricId === 'tool-selection'
        ? { metricId: m.metricId, version: m.version, unit: m.unit, denominator: 3 } : m) } };
    writeFileSync(join(f.root, 'cases/local-research.json'), JSON.stringify(item));
    expect(() => loadDataset(f.root)).toThrow('semantic-batch');
    const data = { ...f.data, scoring: { ...f.data.scoring, judges: [{ id: 'semantic-batch', required: true }] } };
    writeFileSync(join(f.root, 'dataset.json'), JSON.stringify(data));
    expect(loadDataset(f.root).cases[0]).toHaveProperty('expected.semantic');
    writeFileSync(join(f.root, 'cases/local-research.json'), JSON.stringify(f.item));
    expect(loadDataset(f.root).cases[0]).not.toHaveProperty('expected.semantic');
    const {semantic,...expected}=item.expected;
    writeFileSync(join(f.root, 'cases/local-research.json'), JSON.stringify({...item,expected}));
    expect(() => loadDataset(f.root)).toThrow('criteria');
});

test('invoice steps require an authorized source, Workspace and an earlier original candidate-producing message', () => {
    const f = fixture();
    const item = { ...f.item, requires: ['agent', 'invoice', 'workspace'], input: { prompt: 'Read the selected invoice.', materials: [
        { source: 'voxel51', sample: '000001', file: 'content.json', sha256: 'a'.repeat(64), originalSha256: 'b'.repeat(64) },
        { source: 'voxel51', sample: '000001', file: 'pages.json', sha256: 'c'.repeat(64), originalSha256: 'b'.repeat(64) }
    ] }, steps: [
        { id: 'message', action: 'invoice-message', instruction: 'Read the selected invoice.', sample: '000001', goalMode: 'save-candidate' },
        { id: 'select', action: 'select-candidate', fromStep: 'message', ordinal: 1 },
        { id: 'replay', action: 'input-replay', fromStep: 'message' }
    ] };
    expect(caseV2Schema.safeParse(item).success).toBe(true);
    const profiled = { ...item, requires: [...item.requires, 'extension'], setup: { extensionProfile: { id: 'source-quote-trim', version: 1 } } };
    expect(caseV2Schema.safeParse(profiled).success).toBe(true);
    for (const requires of [item.requires, ['agent', 'extension']])
        expect(caseV2Schema.safeParse({ ...profiled, requires }).success).toBe(false);
    for (const extensionProfile of [{ id: 'unknown', version: 1 }, { id: 'source-quote-trim', version: 2 },
        { id: 'source-quote-trim', version: 1, script: 'untrusted' }])
        expect(caseV2Schema.safeParse({ ...profiled, setup: { extensionProfile } }).success).toBe(false);
    for (const workspaceMode of ['selected-document', 'new-session']) {
        const message = { ...item.steps[0], workspaceMode };
        expect(caseV2Schema.safeParse({ ...item, steps: [{ ...message, goalMode: 'answer' }] }).success).toBe(true);
        expect(caseV2Schema.safeParse({ ...item, steps: [message] }).success).toBe(false);
    }
    expect(caseV2Schema.safeParse({ ...item, steps: [{ ...item.steps[0], workspaceMode: 'invented' }] }).success).toBe(false);
    expect(caseV2Schema.safeParse({ ...item, steps: undefined }).success).toBe(false);
    expect(caseV2Schema.safeParse({ ...item, requires: ['agent', 'invoice'] }).success).toBe(false);
    for (const sample of ['000003', '../gold']) expect(caseV2Schema.safeParse({ ...item, steps: [{ ...item.steps[0], sample }] }).success).toBe(false);
    for (const selection of [{ ordinal: 0 }, { fromStep: 'future' }, { fromStep: 'replay' }, { candidateId: 1 }])
        expect(caseV2Schema.safeParse({ ...item, steps: [item.steps[0], { ...item.steps[1], ...selection }] }).success).toBe(false);
    const edit = { id: 'edit', action: 'edit-candidate', patch: { fields: { totalAmount: '250.00' } } };
    expect(caseV2Schema.safeParse({ ...item, steps: [...item.steps, edit,
        { id: 'reject', action: 'reject-candidate', reason: 'User rejects this version.' },
        { id: 'select-edited', action: 'select-candidate', fromStep: 'edit', ordinal: 1 },
        { id: 'accept', action: 'accept-candidate' }, { id: 'export', action: 'export', format: 'json' }
    ] }).success).toBe(true);
    for (const step of [
        { ...edit, patch: {} }, { ...edit, patch: { fields: {} } }, { ...edit, patch: { fields: { invented: 'value' } } },
        { ...edit, lineOrigins: [] }, { ...edit, patch: { lines: [] } }, { ...edit, patch: { lines: [] }, lineOrigins: [0] },
        { id: 'accept', action: 'accept-candidate', candidateId: 1 },
        { id: 'reject', action: 'reject-candidate', reason: ' ' }, { id: 'export', action: 'export', format: 'json', path: '../gold.json' }
    ]) expect(caseV2Schema.safeParse({ ...item, steps: [...item.steps, step] }).success).toBe(false);
    expect(caseV2Schema.safeParse({ ...item, steps: [...item.steps, edit, { id: 'invalid-edited', action: 'select-candidate', fromStep: 'edit', ordinal: 2 }] }).success).toBe(false);
});

test('an evaluation Hook Case records its quality-side controller and rejects stale or mismatched bytes', () => {
    const f = fixture(), relativePath = 'quality-controls/local-research/controller.json';
    const extensionProfile = { id: 'source-quote-trim', version: 1 };
    const controller = JSON.stringify({ contract: 'flowmate-case-controller-spec/v1', caseId: f.item.id,
        extension: { profile: extensionProfile }, privateMarker: 'PRIVATE-HOOK-CONTROL' });
    mkdirSync(join(f.root, 'quality-controls/local-research'), { recursive: true });
    writeFileSync(join(f.root, relativePath), controller);
    const controllerBinding = { relativePath, sha256: createHash('sha256').update(controller).digest('hex') };
    Object.assign(f.item, { requires: ['agent', 'invoice', 'workspace', 'extension'],
        input: { prompt: 'Read the selected invoice.', materials: [{ source: 'voxel51', sample: '000001', file: 'pages.json',
            sha256: 'a'.repeat(64), originalSha256: 'b'.repeat(64) }] },
        steps: [{ id: 'request', action: 'invoice-message', instruction: 'Read the selected invoice.', sample: '000001', goalMode: 'answer', workspaceMode: 'selected-document' }],
        setup: { extensionProfile, controllerBinding } });
    Object.assign(f.data.environment, { source: 'voxel51' }); f.save();
    expect(loadDataset(f.root).cases[0]!.setup).toEqual(f.item.setup);
    writeFileSync(join(f.root, relativePath), controller + ' ');
    expect(() => loadDataset(f.root)).toThrow('Controller binding changed');
    const mismatched = JSON.stringify({ contract: 'flowmate-case-controller-spec/v1', caseId: f.item.id,
        extension: { profile: { id: 'source-check-denial', version: 1 } } });
    writeFileSync(join(f.root, relativePath), mismatched);
    controllerBinding.sha256 = createHash('sha256').update(mismatched).digest('hex'); f.save();
    expect(() => loadDataset(f.root)).toThrow('Controller profile differs');
});

test('a live steer Case records its later user input separately from the model projection', () => {
    const f=fixture(),relativePath='quality-controls/local-research/controller.json',futurePath='quality-controls/local-research/future-steer.json';
    const future={contract:'flowmate-future-user-input/v1',mode:'steer',currency:'USD',origin:'explicit-user-declaration',turnId:'correct-currency',delivery:'only-after-observed-live-run-before-save',actualDelivery:'not-run'};
    const futureBytes=JSON.stringify(future),profile={id:'invoice-currency-steer',version:1};
    const control={contract:'flowmate-case-controller-spec/v1',version:1,caseId:f.item.id,handlerStatus:'implemented-controlled-host',
        trigger:{phase:'active-root-run-before-first-save',requireObservedActualRead:true,rootStatus:'running',maxWaitMs:30000},
        steer:{command:'submit_input',mode:'steer',relativePath:futurePath,sha256:hash(futureBytes),maxDeliveries:1,requireAcceptedAndConsumed:true,preserveOriginalInputIdentity:true}};
    mkdirSync(join(f.root,'quality-controls/local-research'),{recursive:true});writeFileSync(join(f.root,futurePath),futureBytes);
    const saveControl=()=>{const bytes=JSON.stringify(control);writeFileSync(join(f.root,relativePath),bytes);Object.assign(f.item,{setup:{interactionProfile:profile,controllerBinding:{relativePath,sha256:hash(bytes)}}});f.save();};
    const source=join(f.root,'data/invoices/voxel51/000001');mkdirSync(source,{recursive:true});
    writeFileSync(join(source,'pages.json'),'[]');writeFileSync(join(source,'original.jpg'),'synthetic image');
    writeFileSync(join(source,'metadata.json'),JSON.stringify({originalSha256:hash('synthetic image'),files:[{path:'original.jpg'}]}));
    Object.assign(f.item,{requires:['agent','invoice','workspace'],input:{prompt:'Read the selected invoice.',turns:[{id:'correct-currency',role:'user',mode:'steer',content:'The currency is USD, supplied by me.'}],materials:[{source:'voxel51',sample:'000001',file:'pages.json',sha256:hash('[]'),originalSha256:hash('synthetic image')}]},
        steps:[{id:'request',action:'invoice-message',instruction:'Read the selected invoice.',sample:'000001',goalMode:'save-candidate'}]});
    delete (f.item.expected as {research?:unknown}).research;Object.assign(f.data.environment,{source:'voxel51'});saveControl();
    const dataset=loadDataset(f.root),resolved=resolveCase(dataset,dataset.cases[0]!,f.root);
    expect(resolved).toMatchObject({controllerInput:{profile,payload:futureBytes,sha256:hash(futureBytes)}});
    expect(JSON.stringify(resolved.projected)).not.toContain('USD');expect(JSON.stringify(resolved.projected)).not.toContain('quality-controls');
    writeFileSync(join(f.root,futurePath),futureBytes+' ');expect(()=>loadDataset(f.root)).toThrow('Future steer input changed');
    expect(()=>resolveCase(dataset,dataset.cases[0]!,f.root)).toThrow('Future steer input changed');
    writeFileSync(join(f.root,futurePath),futureBytes);control.steer.relativePath='quality-controls/other/future-steer.json';saveControl();
    expect(()=>loadDataset(f.root)).toThrow('same Case');
    control.steer.relativePath=futurePath;control.trigger.requireObservedActualRead=false;saveControl();expect(()=>loadDataset(f.root)).toThrow();
});
test('auto compaction history stays declared and outside the initial model projection',()=>{
    const f=fixture(),relativePath='quality-controls/local-research/controller.json',historyPath='quality-controls/local-research/history-seed.json';
    const profile={id:'invoice-auto-compaction',version:1,reserveTokens:16384,keepRecentTokens:20000} as const;
    const userTurns=Array.from({length:16},(_,index)=>({id:'seed-'+index,role:'user',mode:'prompt',content:'Read-only question '+index}));
    const seed={contract:'flowmate-user-history-seed/v1',caseId:f.item.id,syntheticUserHistory:true,historyConstruction:'public-inputs-only;actual-agent-responses-and-tool-results-required',
        turns:userTurns.map(turn=>({turnId:turn.id})),
        finalTurnId:'save-after-compaction',actualHistoryBuilt:false,actualAutoCompaction:'not-run'};
    userTurns[14]!.content='The transaction currency is USD, supplied by the user.';
    const control={contract:'flowmate-case-controller-spec/v1',version:1,caseId:f.item.id,handlerStatus:'implemented-controlled-host',
        history:{relativePath:historyPath,maxUserTurns:16,injectAssistantHistory:false,duplicatePaddingAllowed:false,manualCompactFallback:false,finalRequestAfterActualAutoCompactionOnly:true,sha256:''},
        compaction:{kind:'native-auto',capacitySource:'native-model-capabilities',thresholdSource:'native-effective-context-window-minus-reserveTokens',effectiveReserveTokens:16384,effectiveKeepRecentTokens:20000,requireActualCapacityAndTriggerAndSavedSummary:true,preserveOriginalSummaryUsage:true},
        trigger:{phase:'native-capacity-threshold',maxSeedTurns:16,failureIfThresholdNotReached:'no-exposure;UNJUDGEABLE'}};
    mkdirSync(join(f.root,'quality-controls/local-research'),{recursive:true});
    const source=join(f.root,'data/invoices/voxel51/000001');mkdirSync(source,{recursive:true});
    writeFileSync(join(source,'pages.json'),'[]');writeFileSync(join(source,'original.jpg'),'synthetic image');
    writeFileSync(join(source,'metadata.json'),JSON.stringify({originalSha256:hash('synthetic image'),files:[{path:'original.jpg'}]}));
    const finalTurn={id:'save-after-compaction',role:'user',content:'Save using the earlier user declaration.'};
    Object.assign(f.item,{requires:['agent','invoice','workspace','history','compaction'],input:{prompt:f.item.input.prompt,turns:[...userTurns,finalTurn],materials:[{source:'voxel51',sample:'000001',file:'pages.json',sha256:hash('[]'),originalSha256:hash('synthetic image')}]},
        steps:[{id:'request',action:'invoice-message',instruction:f.item.input.prompt,sample:'000001',goalMode:'answer'}]});
    delete (f.item.expected as {research?:unknown}).research;Object.assign(f.data.environment,{source:'voxel51'});
    const save=()=>{const payload=JSON.stringify(seed);writeFileSync(join(f.root,historyPath),payload);control.history.sha256=hash(payload);
        const bytes=JSON.stringify(control);writeFileSync(join(f.root,relativePath),bytes);Object.assign(f.item,{setup:{interactionProfile:profile,controllerBinding:{relativePath,sha256:hash(bytes)}}});f.save();return payload;};
    const payload=save(),dataset=loadDataset(f.root),resolved=resolveCase(dataset,dataset.cases[0]!,f.root);
    expect(resolved.controllerInput).toEqual({profile,payload,sha256:hash(payload)});expect(JSON.stringify(resolved.projected)).not.toContain('USD');
    writeFileSync(join(f.root,historyPath),payload+' ');expect(()=>loadDataset(f.root)).toThrow('Future user history changed');
    expect(()=>resolveCase(dataset,dataset.cases[0]!,f.root)).toThrow('Future user history changed');
    userTurns[1]!.content=userTurns[0]!.content;save();expect(()=>loadDataset(f.root)).toThrow('distinct actual user turns');
    userTurns[1]!.content='Different question';userTurns[1]!.role='assistant';save();expect(()=>loadDataset(f.root)).toThrow();
    userTurns[1]!.role='user';finalTurn.content='Save as USD';save();expect(()=>loadDataset(f.root)).toThrow('re-inject');
    finalTurn.content='Save using the earlier user declaration.';Object.assign(control.compaction,{contextWindow:8192});save();expect(()=>loadDataset(f.root)).toThrow();
});

test('started process checks require v2 and cannot turn a Judge or business result into a process grader',()=>{
    const check={metric:'fact-check',required:true,evidence:'case-controller',path:['stopping','confirmed'],equals:true,trigger:'started'};
    const legacy={...structuredClone(tasks[0]!),expected:{...structuredClone(tasks[0]!.expected),checks:[check]}};
    expect(caseSchema.safeParse(legacy).success).toBe(false);
    const f=fixture();Object.assign(f.item.expected,{checks:[check]});expect(caseV2Schema.safeParse(f.item).success).toBe(true);
    expect(checkSchema.safeParse({metric:'answer-relevance',required:true,trigger:'started'}).success).toBe(false);
    expect(checkSchema.safeParse({metric:'task-result',required:true,trigger:'started'}).success).toBe(false);
});

test('parent cancellation controller is declared to its Case and cannot claim that receipt alone proves stopping',()=>{
    const f=fixture(),relativePath='quality-controls/local-research/controller.json',profile={id:'invoice-parent-cancel',version:1} as const;
    const controller=structuredClone(scenariosByName['subagent-cancel-preserve-commits'].files['quality-controls/FM-038/controller.json'].json);
    Object.assign(controller,{handlerStatus:'implemented-controlled-host',caseId:f.item.id,profile});
    const extension=ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(import.meta.dir,'../../../resources/extensions/subagents-v1.json'),'utf8')));
    controller.extensionRef={id:extension.id,version:extension.version,manifestHash:hash(canonicalExtensionManifest(extension))};
    mkdirSync(join(f.root,'quality-controls/local-research'),{recursive:true});
    const source=join(f.root,'data/invoices/voxel51/000001');mkdirSync(source,{recursive:true});
    writeFileSync(join(source,'pages.json'),'[]');writeFileSync(join(source,'original.jpg'),'synthetic image');
    writeFileSync(join(source,'metadata.json'),JSON.stringify({originalSha256:hash('synthetic image'),files:[{path:'original.jpg'}]}));
    Object.assign(f.item,{requires:['agent','invoice','workspace','subagent'],input:{prompt:'Read only; I may stop.',materials:[{source:'voxel51',sample:'000001',file:'pages.json',sha256:hash('[]'),originalSha256:hash('synthetic image')}]},
        steps:[{id:'request',action:'invoice-message',instruction:'Read only; I may stop.',sample:'000001',goalMode:'answer',workspaceMode:'selected-document'}]});
    delete (f.item.expected as {research?:unknown}).research;Object.assign(f.data.environment,{source:'voxel51'});
    const save=()=>{const payload=JSON.stringify(controller);writeFileSync(join(f.root,relativePath),payload);Object.assign(f.item,{setup:{interactionProfile:profile,controllerBinding:{relativePath,sha256:hash(payload)}}});f.save();return payload;};
    const payload=save(),dataset=loadDataset(f.root),resolved=resolveCase(dataset,dataset.cases[0]!,f.root);
    expect(resolved.controllerInput).toEqual({profile,payload,sha256:hash(payload)});expect(JSON.stringify(resolved.projected)).not.toContain('CASE-CONTROL');
    writeFileSync(join(f.root,relativePath),payload+' ');expect(()=>loadDataset(f.root)).toThrow('Controller binding changed');expect(()=>resolveCase(dataset,dataset.cases[0]!,f.root)).toThrow('Controller binding changed');
    controller.caseId='other-case';save();expect(()=>loadDataset(f.root)).toThrow('same Case');
    controller.caseId=f.item.id;controller.cancel.receiptAloneProvesStopped=true;save();expect(()=>loadDataset(f.root)).toThrow();
    controller.cancel.receiptAloneProvesStopped=false;save();Object.assign(f.item.steps![0]!,{workspaceMode:'start-task'});f.save();expect(()=>loadDataset(f.root)).toThrow();
});

test('Gold location/hash and UTF-16 boundaries are checked independently of product claims', () => {
    const f = fixture();
    f.item.expected.research.claims[0]!.evidence[0]!.quote = '地域甲使用版本3。'; f.save();
    expect(() => resolveCase(loadDataset(f.root), loadDataset(f.root).cases[0]!, '/no-voxel51')).toThrow('Gold');
    f.item.expected.research.claims[0]!.evidence[0]!.quote = '地域甲使用版本2。';
    f.item.expected.research.claims[0]!.evidence[0]!.sha256 = 'a'.repeat(64); f.save();
    expect(() => resolveCase(loadDataset(f.root), loadDataset(f.root).cases[0]!, '/no-voxel51')).toThrow('Gold');
    const fragment = f.item.expected.research.claims[0]!.evidence[0]!;
    Object.assign(fragment, { sha256: hash(f.text), start: 9, end: 10, quote: f.text.slice(9, 10) }); f.save();
    expect(() => resolveCase(loadDataset(f.root), loadDataset(f.root).cases[0]!, '/no-voxel51')).toThrow('UTF-16');
});
test('malformed UTF-8 and changed bytes cannot become replacement characters or stale sources', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'materials/source-a/policy.md'), Buffer.from([0xc3, 0x28]));
    const rawHash = createHash('sha256').update(readFileSync(join(f.root, 'materials/source-a/policy.md'))).digest('hex');
    Object.assign(f.item.input.materials[0]!, { sha256: rawHash, originalSha256: rawHash }); f.save();
    expect(() => resolveCase(loadDataset(f.root), loadDataset(f.root).cases[0]!, '/no-voxel51')).toThrow('UTF-8');
    writeFileSync(join(f.root, 'materials/source-a/policy.md'), 'changed'); f.save();
    expect(() => resolveCase(loadDataset(f.root), loadDataset(f.root).cases[0]!, '/no-voxel51')).toThrow('hash');
});
test('material junctions cannot move the visible root outside the Dataset', () => {
    const f = fixture();
    renameSync(join(f.root, 'materials'), join(f.root, 'saved-materials'));
    const outside = mkdtempSync(join(tmpdir(), 'eval-v2-outside-'));
    mkdirSync(join(outside, 'source-a')); writeFileSync(join(outside, 'source-a/policy.md'), f.text);
    symlinkSync(outside, join(f.root, 'materials'), 'junction');
    expect(() => resolveCase(loadDataset(f.root), loadDataset(f.root).cases[0]!)).toThrow('inside source');
});

test('duplicate visible aliases, wrong source policy and disconnected Gold chains are refused', () => {
    const f = fixture();
    f.item.input.materials.push(structuredClone(f.item.input.materials[0]!)); f.save();
    expect(() => loadDataset(f.root)).toThrow('Duplicate visible material');
    f.item.input.materials.pop(); f.data.environment.source = 'voxel51'; f.save();
    expect(() => loadDataset(f.root)).toThrow('source differs');
    f.data.environment.source = 'local';
    const other = structuredClone(f.item.expected.research.claims[0]!); other.id = 'region-b'; other.entities = ['地域乙'];
    f.item.expected.research.claims.push(other);
    Object.assign(f.item.expected.research, { chains: [{ id: 'disconnected', claims: ['region-a', 'region-b'], links: [{ from: 'region-a', to: 'region-b', entity: '地域甲' }] }] }); f.save();
    expect(() => loadDataset(f.root)).toThrow('shared intermediate entities');
});

test('research steps bind only earlier actual Plan/confirmation steps and reject fabricated product IDs', () => {
    const f = fixture();
    Object.assign(f.item, { requires: ['agent', 'research'], steps: [
        { id: 'plan', action: 'research-plan', instruction: f.item.input.prompt },
        { id: 'stale', action: 'research-confirm', instruction: '确认旧版', planFromStep: 'plan', revisionOffset: 1, expected: 'research_plan_stale' },
        { id: 'confirm', action: 'research-confirm', instruction: '确认保存的版本', planFromStep: 'plan', expected: 'accepted' },
        { id: 'replay', action: 'research-replay', fromStep: 'confirm' }
    ] }); f.save();
    expect(loadDataset(f.root).cases[0]!.steps).toHaveLength(4);
    Object.assign(f.item, { steps: [{ id: 'confirm', action: 'research-confirm', instruction: '确认', planFromStep: 'future-plan' }] }); f.save();
    expect(() => loadDataset(f.root)).toThrow('earlier Plan');
    Object.assign(f.item, { steps: [{ id: 'plan', action: 'research-plan', instruction: '规划', planId: 7 }] }); f.save();
    expect(() => loadDataset(f.root)).toThrow();
    Object.assign(f.item, { steps: undefined }); f.save();
    expect(() => loadDataset(f.root)).toThrow('explicit initial research-plan');
});

test('versioned history steps refer to earlier accepted messages rather than fabricated product entries', () => {
    const f = fixture();
    Object.assign(f.item, { requires: ['agent', 'history', 'compaction'], steps: [
        { id: 'first', action: 'user-message', instruction: f.item.input.prompt },
        { id: 'fork', action: 'fork-history', fromStep: 'first', target: 'result', title: 'Independent continuation' },
        { id: 'answer', action: 'user-message', instruction: 'Continue from the selected original answer.' },
        { id: 'restart', action: 'restart-host' },
        { id: 'branch', action: 'branch-history', fromStep: 'answer', target: 'user' },
        { id: 'compact', action: 'compact-history' },
        { id: 'again', action: 'input-replay', fromStep: 'answer' }
    ] }); f.save();
    expect(loadDataset(f.root).cases[0]!.steps).toHaveLength(7);
    for (const steps of [
        [{ id: 'restart', action: 'restart-host' }],
        [{ id: 'first', action: 'user-message', instruction: 'One' }, { id: 'restart', action: 'restart-host', productRoot: 'unowned' }],
        [{ id: 'fork', action: 'fork-history', fromStep: 'future', target: 'result', title: 'Invalid' }],
        [{ id: 'first', action: 'user-message', instruction: 'One' }, { id: 'first', action: 'compact-history' }],
        [{ id: 'compact', action: 'compact-history', operationId: '00000000-0000-4000-8000-000000000000' }],
        [{ id: 'first', action: 'user-message', instruction: 'One' }, { id: 'fork', action: 'fork-history', fromStep: 'first', target: 'result', title: 'Invalid', entryId: 'invented' }],
        [{ id: 'first', action: 'user-message', instruction: 'One' }, { id: 'replay', action: 'input-replay', fromStep: 'first' }, { id: 'fork', action: 'fork-history', fromStep: 'replay', target: 'result', title: 'Invalid' }]
    ]) {
        Object.assign(f.item, { steps }); f.save();
        expect(() => loadDataset(f.root)).toThrow();
    }
    Object.assign(f.item, { requires: ['agent'], steps: [{ id: 'compact', action: 'compact-history' }] }); f.save();
    expect(() => loadDataset(f.root)).toThrow();
    Object.assign(f.item, { steps: [{ id: 'first', action: 'user-message', instruction: f.item.input.prompt }, { id: 'restart', action: 'restart-host' }] }); f.save();
    expect(() => loadDataset(f.root)).toThrow('history capability');
});

test('versioned user and research steps retain the exact authorized input whitespace', () => {
    const f = fixture(), original = ' \n  Keep this authorized input exactly.\n ';
    f.item.input.prompt = original;
    for (const action of ['user-message', 'research-plan'] as const) {
        Object.assign(f.item, { requires: action === 'research-plan' ? ['agent', 'research'] : ['agent'], steps: [{ id: 'first', action, instruction: original }] }); f.save();
        const step = loadDataset(f.root).cases[0]!.steps![0]!;
        expect('instruction' in step && step.instruction).toBe(original);
    }
});
