import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResourceManifestSchema, type ResourceRef, type ResourceSelection } from '../../../packages/contracts/src/resources.ts';
import { inside } from '../dataset-loader/local.ts';

export type SelectedResource = { ref: ResourceRef; files: Array<{ path: string; bytes: Buffer }> };
export function readSelectedResources(root: string | undefined, selection: ResourceSelection): SelectedResource[] {
    if (!root) return [];
    return [...(selection.prompt ? [selection.prompt] : []), ...selection.enabledSkills].flatMap(ref => {
        const manifestPath = join(ref.id, 'resource.json');
        if (!existsSync(join(root, manifestPath))) return [];
        const manifestBytes = readFileSync(inside(root, manifestPath));
        const value=JSON.parse(manifestBytes.toString('utf8'));
        const manifest = ResourceManifestSchema.parse(value);
        if (manifest.id !== ref.id || manifest.kind !== ref.kind || manifest.version !== ref.version)
            throw new Error('Declared selected resource identity mismatch');
        const productBytes=Buffer.from(JSON.stringify(manifest));
        const files = [{ path: 'resource.json', bytes: productBytes }, ...manifest.files.map(file => {
            const bytes = readFileSync(inside(root, join(ref.id, file.path)));
            if (bytes.length !== file.bytes) throw new Error('Declared resource bytes changed');
            return { path: file.path, bytes };
        })];
        return [{ ref, files }];
    });
}
