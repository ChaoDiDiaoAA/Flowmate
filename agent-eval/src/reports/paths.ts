import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LocalDataset } from '../dataset-loader/local.ts';

export type RunScope = 'business' | 'research' | 'mixed' | 'calibration';
const scopes: RunScope[] = ['business', 'research', 'mixed', 'calibration'];
export function safeId(value: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw Error('Invalid execution ID');
    return value;
}
function realDirectory(path: string, create = false) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('Evaluation result root must be a real directory; links rejected');
    if (!stat && create) mkdirSync(path);
    if ((stat || create) && realpathSync(path).toLowerCase() !== resolve(path).toLowerCase()) throw Error('Evaluation result root escapes repository');
    return !!stat || create;
}
function locations(repo: string, id: string) {
    safeId(id);
    const base = realpathSync(repo), evaluation = join(base, 'agent-eval');
    if (!realDirectory(evaluation)) return [];
    const runs = join(evaluation, 'runs'), legacy = join(evaluation, 'calibration-runs'), parents: string[] = [];
    if (realDirectory(runs)) {
        parents.push(runs);
        for (const scope of scopes) if (realDirectory(join(runs, scope))) parents.push(join(runs, scope));
    }
    if (realDirectory(legacy)) parents.push(legacy);
    return parents.flatMap(parent => {
        const directory = join(parent, id);
        return realDirectory(directory) ? [directory] : [];
    });
}
export function reportPath(repo: string, id: string) {
    const found = locations(repo, id).flatMap(directory => ['report.json', 'summary.json'].filter(name => existsSync(join(directory, name))).map(name => join(directory, name)));
    if (found.length > 1) throw Error(`Conflicting duplicate execution ID: ${id}`);
    if (!found.length) throw Error(`Saved execution not found: ${id}`);
    if (lstatSync(found[0]!).isSymbolicLink()) throw Error('Linked report rejected');
    return found[0]!;
}
export function datasetScope(dataset: Pick<LocalDataset, 'cases'>): Exclude<RunScope, 'calibration'> {
    const research = dataset.cases.filter(task => task.requires.includes('research')).length;
    return research === dataset.cases.length && research > 0 ? 'research' : research > 0 ? 'mixed' : 'business';
}
export function createRunDirectory(repo: string, id: string, scope: RunScope) {
    if (locations(repo, id).length) throw Error(`Conflicting duplicate execution ID: ${id}`);
    if ([...scopes, 'case-reviews'].includes(id)) throw Error('Execution ID conflicts with a result directory');
    let directory = realpathSync(repo);
    for (const component of ['agent-eval', 'runs', scope]) {
        directory = join(directory, component); realDirectory(directory, true);
    }
    directory = join(directory, id); mkdirSync(directory);
    return directory;
}
export function caseReviewDirectory(repo: string, create = false) {
    let directory = realpathSync(repo);
    for (const component of ['agent-eval', 'runs', 'case-reviews']) {
        directory = join(directory, component); realDirectory(directory, create);
    }
    return directory;
}
