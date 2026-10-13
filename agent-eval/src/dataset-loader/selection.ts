import type { LocalDataset, LocalCase } from './local.ts';
import { hash } from './local.ts';
import { decodeFile } from './flat.ts';
import { extensionIdentity } from '../configuration.ts';
import { canonicalResourceManifest } from '../../../packages/contracts/src/resources.ts';

export function fixtureSelection(dataset:LocalDataset, task:LocalCase, repo:string) {
    const authored=dataset.embedded?.authored;if(!authored)return {};
    const c=authored.cases.find(c=>c.id===task.id);
    if(!c)throw Error('Missing authored Case: '+task.id);
    const selection=c.input.fixture ? authored.fixtures[c.input.fixture.name].selection : {enabledSkills:[],enabledExtensions:[]};
    return {resources:{prompt:null,enabledSkills:selection.enabledSkills.map((id:string)=>{
        const file=dataset.embedded!.files[`resources/${id}/resource.json`];if(!file)throw Error('Missing selected Skill: '+id);
        const manifest=JSON.parse(decodeFile(file).bytes.toString('utf8'));
        manifest.files=manifest.files.map((entry:any)=>{
            const source=dataset.embedded!.files[`resources/${id}/${entry.path}`];
            if(!source)throw Error('Missing selected Skill file: '+entry.path);
            const {file}=decodeFile(source);
            if(file.bytes!==entry.bytes)throw Error('Selected Skill file size differs: '+entry.path);
            return {...entry,sha256:file.sha256};
        });
        return {kind:manifest.kind,id:manifest.id,version:manifest.version,contentHash:hash(canonicalResourceManifest(manifest))};
    })},extensions:{enabledExtensions:selection.enabledExtensions.map((id:string)=>extensionIdentity({id,version:'v1'},repo))}};
}
