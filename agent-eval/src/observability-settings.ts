import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ObservabilitySettingsSchema, type ObservabilitySettings } from '../../packages/contracts/src/evaluation-workflow.ts';

/** Host reads only the opt-in flags; controller workflow and quality data stay outside its dependency graph. */
export function readObservabilitySettings(repo: string): ObservabilitySettings {
    let root = realpathSync(repo);
    for (const part of ['agent-eval', 'configs']) {
        root = join(root, part); const stat = lstatSync(root, { throwIfNoEntry: false });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('Linked or invalid curation directory');
        if (stat && realpathSync(root).toLowerCase() !== resolve(root).toLowerCase()) throw Error('Curation path escapes repository');
    }
    const file = join(root, 'observability.json');
    if (!existsSync(file)) return { capture: false, upload: false, mining: false };
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Linked or invalid curation file');
    return ObservabilitySettingsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
