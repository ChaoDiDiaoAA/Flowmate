import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { metricCatalog } from '../scoring/catalog.ts';
import { compileFormalSemanticPlan } from '../scoring/formal-rules.ts';
import { type EmbeddedFile } from './flat.ts';
import { extensionIdentity } from '../configuration.ts';
import { userTurnSchema, constraintShape } from './authoring.ts';

export function materialPath(repo:string,path:string) {
    if(isAbsolute(path)||path.includes('\\')||!path.startsWith('data/')||path.split('/').some(p=>!p||p==='.'||p==='..')) throw Error('Invalid evaluation material path: '+path);
    const base=realpathSync(repo);let target=base;
    for(const part of path.split('/')) { target=join(target,part);if(lstatSync(target).isSymbolicLink())throw Error('Linked evaluation material rejected'); }
    if(relative(base,realpathSync(target)).startsWith('..')||!lstatSync(target).isFile())throw Error('Material escapes data directory');
    return target;
}

const text=z.string().trim().min(1), reference=z.object({source:z.enum(['voxel51','local-text']),sample:text,file:text,originalFile:text.optional()}).strict();
const rawCaseSchema=z.object({contract:z.literal('flowmate-eval-case/v4'),id:z.string().regex(/^FM-\d{3}$/),version:z.number().int().positive(),
    name:text,category:z.enum(['task','tools','context','memory','compaction','skills','extensions','subagents','runtime','safety','research']),
    purpose:z.enum(['capability','regression']),source:z.object({type:z.enum(['product-workflow','controlled-workflow']),basis:text}).strict(),
    dataset:text,smoke:z.boolean(),tags:z.array(text).min(1),requires:z.array(text).min(1),input:z.object({prompt:userTurnSchema.shape.content,turns:z.array(userTurnSchema).min(1).optional(),materials:z.array(reference)}).strict(),
    environment:text,setup:z.record(z.unknown()).optional(),steps:z.array(z.record(z.unknown())).optional(),expected:z.record(z.unknown()),
    scoring:z.object({methods:z.array(z.enum(['deterministic','llm-judge','human-review'])).min(1),metrics:z.record(z.number().int().nonnegative().nullable()),humanReview:text}).strict(),
    risks:z.array(text).min(1)}).strict();

/** Expand compact authoring into the existing execution DTO, exclusively in memory. */
export function expandHarness(raw:any,gold:any,review:any,registry:any,repo:string, readMaterial?: (path:string)=>Buffer) {
    const task=rawCaseSchema.parse(raw);
    if(gold.contract!=='flowmate-eval-gold/v4'||review.contract!=='flowmate-eval-review/v4'||gold.caseId!==task.id||review.caseId!==task.id||
        gold.version!==task.version||review.version!==task.version||review.status!=='agent-reviewed'||review.humanReview!=='pending')throw Error('Case/Gold/Review contract or identity differs');
    const metadata=registry.datasets[task.dataset];if(!metadata)throw Error('Unknown dataset: '+task.dataset);
    if(Object.keys(task.scoring.metrics).some(id=>!metricCatalog.some(m=>m.id===id)))throw Error('Unknown scoring metric');
    const files:Record<string,EmbeddedFile>={};
    const load=(path:string):EmbeddedFile=>{
        if(files[path])return files[path]!;
        const location=registry.files[path];if(typeof location!=='string')throw Error('Unregistered material: '+path);
        const bytes=readMaterial ? readMaterial(path) : readFileSync(materialPath(repo,location));
        const file={path,encoding:'base64' as const,content:bytes.toString('base64'),bytes:bytes.length};
        files[path]=file;return file;
    };
    const publicFiles:EmbeddedFile[]=[], sources:EmbeddedFile[]=[];
    const materials=task.input.materials.map(ref=>{
        if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(ref.sample)||!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(ref.file)||ref.originalFile&&!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(ref.originalFile))throw Error('Invalid material identity');
        const prefix=(ref.source==='voxel51'?'voxel51/':'materials/')+ref.sample+'/';
        const source=load(prefix+ref.file);sources.push(source);
        let originalFile=ref.originalFile;
        if(ref.source==='voxel51') {
            const meta=JSON.parse(Buffer.from(load(prefix+'metadata.json').content,'base64').toString('utf8'));
            const originals=meta.files.filter((f:any)=>/^original\.(jpg|png)$/.test(f.path));
            if(originals.length!==1)throw Error('Invoice requires exactly one original image');originalFile=originals[0].path;
            for(const filename of ['content.json','pages.json','metadata.json',originalFile!]) {
                const file=load(prefix+filename);publicFiles.push({...file,path:'invoice-input/'+ref.sample+'/'+filename});
            }
        } else {
            publicFiles.push(source);
            if(task.requires.includes('invoice')&&originalFile)publicFiles.push(load(prefix+originalFile));
        }
        load(prefix+(originalFile??ref.file));return ref;
    });
    for(const path of gold.sources) sources.push(load(path));
    const controllers=Object.keys(registry.files).filter(path=>path.startsWith(`quality-controls/${task.id}/`)).map(load);
    for(const file of controllers)if(file.path.endsWith('/controller.json')) {
        const value=JSON.parse(Buffer.from(file.content,'base64').toString('utf8'));
        if(value.extensionRef)value.extensionRef=extensionIdentity(value.extensionRef,repo);
        for(const key of ['history','steer'])if(value[key]?.relativePath)load(value[key].relativePath);
        const bytes=Buffer.from(JSON.stringify(value));Object.assign(file,{content:bytes.toString('base64'),bytes:bytes.length});
    }
    const setup=structuredClone(task.setup);
    if(setup?.controllerBinding) {
        const binding=setup.controllerBinding as any;load(binding.relativePath);
    }
    const values=structuredClone(gold.values);
    for(const key of Object.keys(constraintShape))if(Object.hasOwn(values,key))throw Error('Gold must not overwrite Case constraint: '+key);
    for(const claim of values.research?.claims??[])for(const evidence of claim.evidence) {
        const matches=materials.filter(m=>m.sample===evidence.sample);if(matches.length!==1)throw Error('Gold source must identify one material');
    }
    const metrics=metricCatalog.map(m=>({metricId:m.id,version:m.version,unit:m.unit,...(Object.hasOwn(task.scoring.metrics,m.id)?
        {denominator:task.scoring.metrics[m.id]}:{notApplicable:'本题未设计该能力机会；已选指标缺证据仍计未知。'})}));
    const expected={...task.expected,...values,metrics};
    const semantic=compileFormalSemanticPlan({contract:'flowmate-agent-case/v2',id:task.id,expected} as any);
    if(semantic)expected.semantic=semantic;
    const resourceFiles=task.requires.includes('skill')||task.requires.includes('invoice')&&Number(task.id.slice(3))<=50?(registry.resources as string[]).map(load):[];
    const unique=(list:EmbeddedFile[])=>[...new Map(list.map(f=>[f.path,f])).values()];
    return {task:{contract:'flowmate-eval-case/v3',id:task.id,version:task.version,name:task.name,category:task.category,tags:task.tags,requires:task.requires,
            dataset:{...metadata,smoke:task.smoke},input:{prompt:task.input.prompt,...(task.input.turns?{turns:task.input.turns}:{}),materials,files:unique(publicFiles)},
            ...(setup?{setup}:{}),...(task.steps?{steps:task.steps.map(s=>({...s,...(s.instruction==='$input'?{instruction:task.input.prompt}:{})}))}:{}),
            expected:{...task.expected,metrics},controllerFiles:controllers,resourceFiles},
        gold:{contract:'flowmate-eval-gold/v3',caseId:task.id,version:task.version,values:expected.semantic?{...values,semantic:expected.semantic}:values,
            sources:unique(sources),provenance:gold.basis},review:{...review,migration:{migratedAt:review.reviewedAt}}};
}
