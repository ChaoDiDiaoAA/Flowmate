import { readDeclarationDatasets } from './declarations.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { decodeFile, type FlatDataset } from './flat.ts';
import {saveDeliveryLossControllerSchema,readExecutionFailureControllerSchema,saveCancelRaceControllerSchema} from './schema.ts';
import { ExtensionEvaluationProfileSchema } from '../../../packages/contracts/src/extensions.ts';
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const hash = (v: unknown): string => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
import { caseSchema, caseV2Schema, manifestSchema, steerControllerSchema, futureSteerInputSchema, autoCompactionControllerSchema, userHistorySeedSchema, parentCancelControllerSchema, saveReplayControllerSchema, type LocalCase } from './schema.ts';
export { caseSchema, caseV2Schema, checkSchema, manifestSchema, metricIds } from './schema.ts';
export type { LocalCase, Check } from './schema.ts';
export type LocalDataset = {
    root: string;
    manifest: z.infer<typeof manifestSchema>;
    cases: LocalCase[];
    hash: string;
    embedded?: FlatDataset;
};
export function inside(root: string, path: string) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..'))
        throw new Error('Path traversal or absolute path rejected');
    if (lstatSync(root).isSymbolicLink()) throw new Error('Material must be a file inside source; links are rejected');
    const base = realpathSync(root);
    let component = base;
    for (const name of path.split(/[\\/]/)) {
        component = resolve(component, name);
        if (lstatSync(component).isSymbolicLink()) throw new Error('Material must be a file inside source; links are rejected');
    }
    const target = realpathSync(component), rel = relative(base, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !lstatSync(target).isFile())
        throw new Error('Material must be a file inside source');
    return target;
}
export function loadDataset(directory: string, repo = REPO_ROOT, embedded?: FlatDataset): LocalDataset {
    if (!existsSync(directory))
        throw new Error(`Dataset 目录不存在：${resolve(directory)}。尚未制作，等待评测工程验收；依据 01/02 完成制作后再校验，不自动生成数据。`);
    if (!embedded && existsSync(join(directory, 'cases.ts'))) {
        const groups=readDeclarationDatasets(directory,repo);if(groups.length!==1)throw Error('Select a dataset with discoverDatasets');embedded=groups[0];
    }
    if (!embedded && !existsSync(join(directory, 'dataset.json')))
        throw new Error(`Dataset 清单不存在：${resolve(directory, 'dataset.json')}。请选择制作完成的 Dataset 目录。`);
    const root = realpathSync(directory), manifest = manifestSchema.parse(embedded?.manifest ?? JSON.parse(readFileSync(join(root, 'dataset.json'), 'utf8')));
    const virtualReviews: Record<string, Buffer> = {};
    const read = (path: string): Buffer => {
        if (virtualReviews[path]) return virtualReviews[path]!;
        if (embedded) { const file = embedded.files[path]; if (!file) throw new Error('Missing embedded material: ' + path); return decodeFile(file).bytes; }
        return readFileSync(inside(root, path));
    };
    const cases = manifest.members.map(member => {
        const schema = manifest.contract === 'flowmate-agent-dataset/v2' ? caseV2Schema : caseSchema;
        const task = schema.parse(embedded?.tasks[member] ?? JSON.parse(readFileSync(inside(root, member), 'utf8')));
        if (basename(member) !== task.id + '.json')
            throw new Error('Case filename must match identity');
        readInteractionControl(root,task,read);
        if (task.setup && 'extensionProfile' in task.setup && task.setup.controllerBinding) {
            const binding = task.setup.controllerBinding, bytes = read(binding.relativePath);
            if (bytesHash(bytes) !== binding.sha256) throw new Error('Controller binding changed');
            const controller = z.object({ contract: z.literal('flowmate-case-controller-spec/v1'), caseId: z.string(),
                extension: z.object({ profile: ExtensionEvaluationProfileSchema }).passthrough() }).passthrough().parse(JSON.parse(utf8(bytes)));
            if (controller.caseId !== task.id || hash(controller.extension.profile) !== hash(task.setup.extensionProfile))
                throw new Error('Controller profile differs from the declared Case');
        }
        if (task.expected.checks.some(c => c.metric === 'answer-relevance' || manifest.scoring.required.includes(c.metric)))
            throw new Error('Case cannot override common scoring or select Judge; configure Judges once in dataset.json');
        const keys = task.expected.checks.map(c => JSON.stringify([c.metric, c.evidence, c.path]));
        if (new Set(keys).size !== keys.length)
            throw new Error('Duplicate Case scoring requirement');
        const aliases = task.input.materials.map(m => m.sample + '/' + m.file);
        if (new Set(aliases).size !== aliases.length)
            throw new Error('Duplicate visible material identity');
        if (manifest.contract === 'flowmate-agent-dataset/v2' && manifest.environment.source !== 'mixed' &&
            task.input.materials.some(m => m.source !== (manifest.environment.source === 'local' ? 'local-text' : 'voxel51')))
            throw new Error('Material source differs from declared environment');
        return task;
    });
    if (new Set(cases.map(c => c.id)).size !== cases.length)
        throw new Error('Duplicate Case membership');
    if (new Set(manifest.smoke).size !== manifest.smoke.length || manifest.smoke.some(id => !cases.some(c => c.id === id)))
        throw new Error('Invalid smoke references');
    for (const judge of manifest.scoring.judges) {
        const required = judge.requiredFor ?? [];
        if (new Set(required).size !== required.length || required.some(id => !cases.some(c => c.id === id)))
            throw new Error('Invalid required Judge Case references');
    }
    assertSemanticSelection({ manifest, cases });
    const safeguards = ['task-result', 'input-isolation', 'environment-isolation', 'no-secret', 'closed'];
    if (manifest.scoring.required.length !== safeguards.length || !safeguards.every(k => manifest.scoring.required.some(v => v === k)))
        throw new Error('Common safeguards cannot be disabled');
    const groups = new Map<string, boolean>();
    for (const task of cases)
        for (const m of task.input.materials) {
            const smoke = manifest.smoke.includes(task.id);
            for (const key of ['source:' + m.source + ':' + m.sample, 'original:' + m.originalSha256, 'content:' + m.sha256]) {
                if (groups.has(key) && groups.get(key) !== smoke)
                    throw new Error('Source leakage between smoke and holdout');
                groups.set(key, smoke);
            }
        }
    const dataset: LocalDataset = { root, manifest, cases, hash: embedded?.hash ?? hash({ manifest, cases }), ...(embedded ? { embedded } : {}) };
    return dataset;
}
export function assertSemanticSelection(dataset: Pick<LocalDataset, 'manifest' | 'cases'>, requireJudge = false) {
    manifestSchema.parse(dataset.manifest);
    const batch = dataset.manifest.scoring.judges.find(j => j.id === 'semantic-batch');
    for (const task of dataset.cases) {
        const semantic = 'contract' in task ? task.expected.semantic : undefined;
        if (semantic && !batch) throw new Error('A compact Case plan requires the semantic-batch Judge selection');
        if (batch && (batch.required || requireJudge || batch.requiredFor?.includes(task.id)) && !semantic)
            throw new Error('Required semantic-batch Judge needs Case criteria before Agent preparation');
        if (semantic) caseV2Schema.parse(task);
    }
}
export function discoverDatasets(root: string, repo = REPO_ROOT): LocalDataset[] {
    if (existsSync(join(root,'cases.ts'))) return readDeclarationDatasets(root,repo).map(group=>loadDataset(root,repo,group));
    return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()).flatMap(e => {
        const dir = join(root, e.name);
        return readdirSync(dir).includes('dataset.json') ? [loadDataset(dir, repo)] : [];
    });
}
export function caseContentHash(d: LocalDataset, c: LocalCase) {
    const { review: _review, ...content } = c;
    return hash({ task: 'contract' in c ? content : c, environment: d.manifest.environment, scoring: d.manifest.scoring });
}
const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function utf8(bytes: Uint8Array) {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('Material must contain valid UTF-8'); }
}
function readInteractionControl(root:string,task:LocalCase,read:(path:string)=>Buffer=(path:string)=>readFileSync(inside(root,path))){
    if(!task.setup||!('interactionProfile'in task.setup))return undefined;
    const binding=task.setup.controllerBinding,bytes=read(binding.relativePath);
    if(bytesHash(bytes)!==binding.sha256)throw new Error('Controller binding changed');
    if(task.setup.interactionProfile.id==='invoice-parent-cancel'||task.setup.interactionProfile.id==='invoice-save-replay'||task.setup.interactionProfile.id==='invoice-save-delivery-loss'||task.setup.interactionProfile.id==='invoice-read-execution-failure'||task.setup.interactionProfile.id==='invoice-save-cancel-race'){
        const payload=utf8(bytes),control=(task.setup.interactionProfile.id==='invoice-save-replay'?saveReplayControllerSchema:task.setup.interactionProfile.id==='invoice-save-delivery-loss'?saveDeliveryLossControllerSchema:task.setup.interactionProfile.id==='invoice-read-execution-failure'?readExecutionFailureControllerSchema:task.setup.interactionProfile.id==='invoice-save-cancel-race'?saveCancelRaceControllerSchema:parentCancelControllerSchema).parse(JSON.parse(payload));
        if(control.caseId!==task.id||binding.relativePath!==`quality-controls/${task.id}/controller.json`)throw new Error('Parent cancellation controller must belong to the same Case');
        if('recoveryTurnId'in control&&control.recoveryTurnId){
            const turn=task.input.turns?.find(turn=>turn.id===control.recoveryTurnId);
            if(!turn||(turn.mode??'prompt')!=='prompt')throw Error('Save recovery requires its Case user turn');
        }
        return{profile:task.setup.interactionProfile,payload,sha256:binding.sha256};
    }
    if(task.setup.interactionProfile.id==='invoice-auto-compaction'){
        const control=autoCompactionControllerSchema.parse(JSON.parse(utf8(bytes)));
        if(control.caseId!==task.id||binding.relativePath!==`quality-controls/${task.id}/controller.json`||control.history.relativePath!==`quality-controls/${task.id}/history-seed.json`)
            throw new Error('Auto compaction controller and history must belong to the same Case');
        const future=read(control.history.relativePath);
        if(bytesHash(future)!==control.history.sha256)throw new Error('Future user history changed');
        const payload=utf8(future),seed=userHistorySeedSchema.parse(JSON.parse(payload));
        if(seed.caseId!==task.id)throw new Error('Future history belongs to another Case');
        const historyTurns=seed.turns.map(reference=>task.input.turns?.find(turn=>turn.id===reference.turnId));
        if(historyTurns.some(turn=>!turn||(turn.mode??'prompt')!=='prompt'||turn.content.length>16000)||
            new Set(historyTurns.map(turn=>turn?.content)).size!==16)
            throw Error('History requires distinct actual user turns from Case input, without duplicate padding');
        const turn=task.input.turns?.find(turn=>turn.id===seed.finalTurnId);
        if(!turn||(turn.mode??'prompt')!=='prompt'||turn.content.length>16000||turn.content.includes('USD'))
            throw Error('Auto compaction final user turn must be referenced without re-injecting currency');
        return{profile:task.setup.interactionProfile,payload,sha256:control.history.sha256};
    }
    const control=steerControllerSchema.parse(JSON.parse(utf8(bytes)));
    if(control.caseId!==task.id||binding.relativePath!==`quality-controls/${task.id}/controller.json`||control.steer.relativePath!==`quality-controls/${task.id}/future-steer.json`)
        throw new Error('Steer controller and future input must belong to the same Case');
    const future=read(control.steer.relativePath);
    if(bytesHash(future)!==control.steer.sha256)throw new Error('Future steer input changed');
    const payload=utf8(future),futureInput=futureSteerInputSchema.parse(JSON.parse(payload));
    const turn=task.input.turns?.find(turn=>turn.id===futureInput.turnId);
    if(!turn||turn.mode!==futureInput.mode||futureInput.mode!==control.steer.mode||turn.content.length>16000)
        throw Error('Live input must reference the matching Case user turn and mode');
    return {profile:task.setup.interactionProfile,payload,sha256:control.steer.sha256};
}
export function resolveCase(dataset: LocalDataset, task: LocalCase, repo = REPO_ROOT) {
    const embeddedRead = (path:string) => {
        const file=dataset.embedded!.files[path];if(!file)throw new Error('Missing embedded material: '+path);return decodeFile(file).bytes;
    };
    const controllerInput=readInteractionControl(dataset.root,task,dataset.embedded?embeddedRead:undefined);
    const materials = task.input.materials.map(m => {
        const source = m.source === 'local-text' ? dataset.root : dataset.embedded ? '' : realpathSync(join(repo, 'data/invoices/voxel51'));
        const prefix = (m.source === 'local-text' ? 'materials/' : '') + m.sample + '/';
        const read = (path:string) => dataset.embedded ? embeddedRead((m.source==='voxel51'?'voxel51/':'')+path) : readFileSync(inside(source,path));
        const bytes = read(prefix + m.file);
        if (bytesHash(bytes) !== m.sha256)
            throw new Error('Material hash mismatch: ' + m.sample + '/' + m.file);
        if (m.source === 'local-text') {
            const original = m.originalFile ? read(prefix + m.originalFile) : bytes;
            if (bytesHash(original) !== m.originalSha256) throw new Error('Original material hash mismatch');
        } else {
            const metadata = JSON.parse(utf8(read(m.sample + '/metadata.json')));
            if (metadata.originalSha256 !== undefined && metadata.originalSha256 !== m.originalSha256) throw new Error('Source identity mismatch');
            if ('contract' in task) {
                const originals = Array.isArray(metadata.files) ? metadata.files.filter((f: { path?: string }) => /^original\.(jpg|png)$/.test(f.path ?? '')) : [];
                if (originals.length !== 1 || bytesHash(read(m.sample + '/' + originals[0].path)) !== m.originalSha256)
                    throw new Error('Original material hash mismatch');
            }
        }
        return { sample: m.sample, file: m.file, text: utf8(bytes) };
    });
    if ('contract' in task && task.expected.research) {
        for (const claim of task.expected.research.claims) for (const evidence of claim.evidence) {
            const matches = task.input.materials.flatMap((m, index) => m.sample === evidence.sample && m.sha256 === evidence.sha256 ? [materials[index]!] : []);
            if (matches.length !== 1) throw new Error('Gold evidence must identify exactly one declared material');
            const text = matches[0]!.text;
            const splitsSurrogate = (at: number) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);
            if (splitsSurrogate(evidence.start) || splitsSurrogate(evidence.end)) throw new Error('Gold splits a UTF-16 surrogate pair');
            if (text.slice(evidence.start, evidence.end) !== evidence.quote) throw new Error('Gold quotation differs from declared source');
        }
    }
    return { task, projected: { prompt: task.input.prompt, materials }, hash: caseContentHash(dataset, task),...(controllerInput?{controllerInput}:{}) };
}
/** Restore only declared public inputs/resources; Gold and future controller inputs stay in the controller. */
export function restoreCaseInputs(dataset: LocalDataset, task: LocalCase, directory: string) {
    if (!dataset.embedded) return { invoiceRoot: undefined, localRoot: dataset.root,
        resourceRoot: existsSync(join(dataset.root, 'resources')) ? join(dataset.root, 'resources') : undefined };
    const root = join(dirname(directory), 'inputs', basename(directory));
    const parent = dirname(root);
    mkdirSync(parent, { recursive: true });
    if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('Trial input directory cannot be linked');
    mkdirSync(root);
    for (const raw of dataset.embedded.inputs[task.id]!) {
        const { file, bytes } = decodeFile(raw), target = join(root, file.path);
        mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' });
    }
    return { invoiceRoot: join(root, 'invoice-input'), localRoot: root,
        resourceRoot: existsSync(join(root, 'resources')) ? join(root, 'resources') : undefined };
}
export function selectCases(dataset: LocalDataset, selection: 'smoke' | 'holdout' | 'full' = 'full', caseId?: string) {
    if (!['smoke', 'holdout', 'full'].includes(selection)) throw new Error('Invalid selection');
    if (caseId) {
        const task = dataset.cases.find(c => c.id === caseId);
        if (!task)
            throw new Error('Unknown Case');
        if (selection !== 'full' && dataset.manifest.smoke.includes(task.id) !== (selection === 'smoke'))
            throw new Error('Case is outside selected partition');
        return [task];
    }
    return dataset.cases.filter(c => selection === 'full' || dataset.manifest.smoke.includes(c.id) === (selection === 'smoke'));
}
export function caseFiles(dataset:LocalDataset,task:LocalCase) {
    if(!dataset.embedded)return [];
    const sources=dataset.embedded.authored?.gold[task.id]?.sources??[];
    const files=[...(dataset.embedded.inputs[task.id]??[]),...sources.map((path:string)=>dataset.embedded!.files[path])];
    return [...new Map(files.map(file=>{const{sha256,...declaration}=decodeFile(file).file;return[file.path,declaration] as const;})).values()];
}
