import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const hash = (v: unknown): string => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const metricIds = ['task-result', 'input-isolation', 'environment-isolation', 'no-secret', 'closed', 'fact-check', 'reference-fields', 'line-items', 'answer-relevance'] as const;
export const checkSchema = z.object({
    metric: z.enum(metricIds), required: z.boolean(), evidence: z.string().min(1).optional(),
    path: z.array(z.union([z.string().min(1), z.number().int().nonnegative()])).optional(), equals: z.unknown().optional(),
    description: z.string().min(1).optional(), operator: z.enum(['equals', 'includes']).optional(),
    compareTo: z.object({ evidence: z.string().min(1), path: z.array(z.union([z.string().min(1), z.number().int().nonnegative()])) }).strict().optional()
}).strict().superRefine((v, c) => {
    if (v.metric === 'fact-check' && (!v.evidence || !v.path || (('equals' in v) === !!v.compareTo)))
        c.addIssue({ code: z.ZodIssueCode.custom, message: 'fact-check needs evidence/path and exactly one of equals or compareTo' });
    if (v.metric !== 'fact-check' && (v.compareTo || v.operator || v.path || 'equals' in v))
        c.addIssue({ code: z.ZodIssueCode.custom, message: 'Comparison options only apply to fact-check' });
});
const materialSchema = z.object({ source: z.literal('voxel51'), sample: z.string().regex(/^\d{6}$/), file: z.enum(['content.md', 'content.json', 'pages.json']), sha256: sha, originalSha256: sha }).strict();
export const caseSchema = z.object({
    id, version: z.number().int().positive(), name: z.string().min(1), category: id, tags: z.array(id).min(1), requires: z.array(id).min(1),
    input: z.object({ prompt: z.string().min(1), materials: z.array(materialSchema).default([]) }).strict(),
    setup: z.object({ scenario: id, description: z.string().min(1), resources: z.array(z.object({ id, version: z.number().int().positive(), content: z.string().min(1) }).strict()).min(1).optional() }).strict().optional(),
    steps: z.array(z.object({ action: z.enum(['user-message', 'restart', 'compact', 'restore-tool', 'edit-candidate', 'accept-candidate', 'export']), instruction: z.string().min(1) }).strict()).min(1).optional(),
    expected: z.object({
        success: z.array(z.string().min(1)).min(1), failure: z.array(z.string().min(1)).min(1), checks: z.array(checkSchema).min(1),
        reference: z.object({ status: z.enum(['pending', 'verified']), fields: z.record(z.string(), z.string()).refine(v => Object.keys(v).length > 0), lineItems: z.array(z.record(z.string(), z.string())).min(1).optional(), excerpt: z.string().min(1), basis: z.literal('visible-parsed-material') }).strict().optional()
    }).strict(), review: z.object({ status: z.literal('pending') }).strict()
}).strict().superRefine((v, c) => {
    if (v.expected.checks.some(k => k.metric === 'reference-fields' || k.metric === 'line-items') && !v.expected.reference)
        c.addIssue({ code: z.ZodIssueCode.custom, message: 'Selected reference grader requires reference facts' });
    if (v.expected.checks.some(k => k.metric === 'line-items') && !v.expected.reference?.lineItems?.length)
        c.addIssue({ code: z.ZodIssueCode.custom, message: 'Line grading requires reference lineItems' });
});
export const manifestSchema = z.object({
    contract: z.literal('flowmate-agent-dataset/v1'), id, version: z.number().int().positive(), name: z.string().min(1), readiness: z.literal('draft'),
    members: z.array(z.string().min(1)).min(1), smoke: z.array(id).min(1),
    environment: z.object({ profile: z.literal('isolated-agent/v1'), source: z.literal('voxel51'), risks: z.array(z.string().min(1)).min(1) }).strict(),
    scoring: z.object({ version: z.number().int().positive(), required: z.array(z.enum(metricIds)), judges: z.array(z.object({ id: z.literal('answer-relevance'), required: z.boolean(), requiredFor: z.array(id).optional() }).strict()).max(1) }).strict()
}).strict();
export type LocalCase = z.infer<typeof caseSchema>;
export type Check = z.infer<typeof checkSchema>;
export type LocalDataset = {
    root: string;
    manifest: z.infer<typeof manifestSchema>;
    cases: LocalCase[];
    hash: string;
};
export function inside(root: string, path: string) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..'))
        throw new Error('Path traversal or absolute path rejected');
    const base = realpathSync(root), target = realpathSync(resolve(base, path)), rel = relative(base, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !lstatSync(target).isFile())
        throw new Error('Material must be a file inside source');
    return target;
}
export function loadDataset(directory: string): LocalDataset {
    if (!existsSync(directory))
        throw new Error(`Dataset 目录不存在：${resolve(directory)}。尚未制作，等待完整 Agent；依据 01/02 完成制作后再校验，不自动生成数据。`);
    if (!existsSync(join(directory, 'dataset.json')))
        throw new Error(`Dataset 清单不存在：${resolve(directory, 'dataset.json')}。请选择制作完成的 Dataset 目录。`);
    const root = realpathSync(directory), manifest = manifestSchema.parse(JSON.parse(readFileSync(join(root, 'dataset.json'), 'utf8')));
    const cases = manifest.members.map(member => {
        const task = caseSchema.parse(JSON.parse(readFileSync(inside(root, member), 'utf8')));
        if (basename(member) !== task.id + '.json')
            throw new Error('Case filename must match identity');
        if (task.expected.checks.some(c => c.metric === 'answer-relevance' || manifest.scoring.required.includes(c.metric)))
            throw new Error('Case cannot override common scoring or select Judge; configure Judges once in dataset.json');
        const keys = task.expected.checks.map(c => JSON.stringify([c.metric, c.evidence, c.path]));
        if (new Set(keys).size !== keys.length)
            throw new Error('Duplicate Case scoring requirement');
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
    const safeguards = ['task-result', 'input-isolation', 'environment-isolation', 'no-secret', 'closed'];
    if (manifest.scoring.required.length !== safeguards.length || !safeguards.every(k => manifest.scoring.required.some(v => v === k)))
        throw new Error('Common safeguards cannot be disabled');
    const groups = new Map<string, boolean>();
    for (const task of cases)
        for (const m of task.input.materials) {
            const smoke = manifest.smoke.includes(task.id);
            for (const key of ['source:' + m.sample, 'original:' + m.originalSha256, 'content:' + m.sha256]) {
                if (groups.has(key) && groups.get(key) !== smoke)
                    throw new Error('Source leakage between smoke and holdout');
                groups.set(key, smoke);
            }
        }
    return { root, manifest, cases, hash: hash({ manifest, cases }) };
}
export function discoverDatasets(root: string): LocalDataset[] {
    return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()).flatMap(e => {
        const dir = join(root, e.name);
        return readdirSync(dir).includes('dataset.json') ? [loadDataset(dir)] : [];
    });
}
export function caseContentHash(d: LocalDataset, c: LocalCase) { return hash({ task: c, environment: d.manifest.environment, scoring: d.manifest.scoring }); }
export function resolveCase(dataset: LocalDataset, task: LocalCase, repo = REPO_ROOT) {
    const materials = task.input.materials.map(m => {
        const source = realpathSync(join(repo, 'data/invoices/voxel51'));
        const bytes = readFileSync(inside(source, m.sample + '/' + m.file));
        if (createHash('sha256').update(bytes).digest('hex') !== m.sha256)
            throw new Error('Material hash mismatch: ' + m.sample + '/' + m.file);
        const metadata = JSON.parse(readFileSync(inside(source, m.sample + '/metadata.json'), 'utf8'));
        if (metadata.originalSha256 !== m.originalSha256)
            throw new Error('Source identity mismatch');
        return { sample: m.sample, file: m.file, text: bytes.toString('utf8') };
    });
    return { task, projected: { prompt: task.input.prompt, materials }, hash: caseContentHash(dataset, task) };
}
export function selectCases(dataset: LocalDataset, selection: 'smoke' | 'full' = 'full', caseId?: string) {
    if (caseId) {
        const task = dataset.cases.find(c => c.id === caseId);
        if (!task)
            throw new Error('Unknown Case');
        return [task];
    }
    return dataset.cases.filter(c => selection === 'full' || dataset.manifest.smoke.includes(c.id));
}
