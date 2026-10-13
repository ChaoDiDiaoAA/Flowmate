import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalResourceManifest, ResourceManifestSchema, type ResourceRef, type ResourceSelection } from '../../../packages/contracts/src/resources.ts';
import { inside, hash } from '../dataset-loader/local.ts';

export type SelectedResource = { ref: ResourceRef; files: Array<{ path: string; bytes: Buffer; sha256: string }> };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function readSelectedResources(root: string | undefined, selection: ResourceSelection): SelectedResource[] {
    if (!root) return [];
    return [...(selection.prompt ? [selection.prompt] : []), ...selection.enabledSkills].flatMap(ref => {
        const manifestPath = join(ref.id, 'resource.json');
        if (!existsSync(join(root, manifestPath))) return [];
        const manifestBytes = readFileSync(inside(root, manifestPath));
        const value=JSON.parse(manifestBytes.toString('utf8'));
        if(value.files.some((file:any)=>!file.sha256))value.files=value.files.map((file:any)=>{
            const bytes=readFileSync(inside(root,join(ref.id,file.path)));return{...file,bytes:bytes.length,sha256:digest(bytes)};
        });
        const manifest = ResourceManifestSchema.parse(value);
        if (manifest.id !== ref.id || manifest.kind !== ref.kind || manifest.version !== ref.version || hash(canonicalResourceManifest(manifest)) !== ref.contentHash)
            throw new Error('Declared selected resource identity mismatch');
        const productBytes=Buffer.from(JSON.stringify(manifest));
        const files = [{ path: 'resource.json', bytes: productBytes, sha256: digest(productBytes) }, ...manifest.files.map(file => {
            const bytes = readFileSync(inside(root, join(ref.id, file.path)));
            if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('Declared resource bytes changed');
            return { path: file.path, bytes, sha256: file.sha256 };
        })];
        return [{ ref, files }];
    });
}
