import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { atomicText } from './files.ts';
import { readReport, reportPath, safeId, type LocalReport, type TrialReport } from './store.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
import { regressionOriginSchema, type RegressionOrigin } from '../dataset-loader/regression-origin.ts';
import { authorDatasetSchema } from '../dataset-loader/authoring.ts';

const state = z.enum(['PASS', 'FAIL', 'ERROR', 'UNJUDGEABLE', 'NOT_RUN']);
const rowSchema = z.object({ at: z.string().datetime(), batch: z.string(), issueId: z.string(), sourceExecutionId: z.string(), sourceTrialId: z.string(),
    sourceCaseId: z.string(), sourceCaseVersion: z.number().int().positive(), datasetId: z.string(), executionId: z.string(), caseId: z.string(), trialId: z.string(),
    repetition: z.number().int().min(1).max(20), repeat: z.number().int().min(1).max(20), status: state, targetStatus: state,
    executionKind: z.enum(['controlled', 'model']), report: z.string(), usage: z.record(z.number().finite().nonnegative().nullable()) }).strict();
type Rerun = z.infer<typeof rowSchema>;
const columns = Object.keys(rowSchema.shape) as Array<keyof Rerun>;
const key = (row: Pick<Rerun, 'executionId' | 'trialId' | 'issueId' | 'sourceExecutionId' | 'sourceTrialId'>) =>
    JSON.stringify([row.executionId, row.trialId, row.issueId, row.sourceExecutionId, row.sourceTrialId]);
const originTarget = ({ verification, ...value }: RegressionOrigin) => ({ ...value, metricIds: [...value.metricIds].sort() });
const short = (error: unknown) => scanEvidence(error instanceof Error ? error.message : String(error)).value.replace(/[\r\n]/g, ' ').slice(0, 240);
function batchDirectory(repo: string, batch: string, create = false) {
    safeId(batch); let path = realpathSync(repo);
    for (const part of ['agent-eval', 'records', batch]) {
        path = join(path, part); const stat = lstatSync(path, { throwIfNoEntry: false });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('Linked or invalid regression record directory');
        if (!stat) { if (!create) return undefined; mkdirSync(path); }
        if (realpathSync(path).toLowerCase() !== resolve(path).toLowerCase()) throw Error('Regression record directory escapes repository');
    }
    return path;
}
function csv(text: string): string[][] {
    const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closed = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (quoted) { if (c !== '"') value += c; else if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } }
        else if (c === ',' || c === '\n' || c === '\r') {
            row.push(value); value = ''; closed = false;
            if (c !== ',') { if (row.some(cell => cell.length)) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
        } else if (closed) throw Error('Malformed rerun CSV');
        else if (c === '"') { if (value.length) throw Error('Malformed rerun CSV'); quoted = true; }
        else value += c;
    }
    if (quoted) throw Error('Incomplete rerun CSV');
    if (row.length || value.length || closed) { row.push(value); rows.push(row); }
    return rows;
}
function readRows(repo: string, batch: string): Rerun[] {
    const directory = batchDirectory(repo, batch), file = directory && join(directory, 'reruns.csv');
    if (!file || !existsSync(file)) return [];
    if (lstatSync(file).isSymbolicLink()) throw Error('Linked rerun file rejected');
    const [header, ...rows] = csv(readFileSync(file, 'utf8'));
    if (!isDeepStrictEqual(header, columns)) throw Error('Unsupported rerun CSV header; original file preserved');
    const parsed = rows.map(cells => {
        if (cells.length !== columns.length) throw Error('Invalid rerun CSV row');
        return rowSchema.parse(Object.fromEntries(columns.map((column, i) => [column,
            ['sourceCaseVersion', 'repetition', 'repeat'].includes(column) ? Number(cells[i]) : column === 'usage' ? JSON.parse(cells[i]!) : cells[i]])));
    });
    if (new Set(parsed.map(key)).size !== parsed.length) throw Error('Duplicate rerun identities');
    return parsed;
}
function targetStatus(report: LocalReport, trial: TrialReport, origin: RegressionOrigin): Rerun['targetStatus'] {
    if (report.sourceInvalidation) return 'ERROR';
    if (trial.status !== 'PASS') return trial.status;
    const targets = origin.metricIds.map(id => trial.scores.find(s => s.metricId === id));
    if (targets.some(score => score?.status === 'FAIL')) return 'FAIL';
    if (trial.judgeCalls.some(call => call.error) || trial.scores.some(score => score.status === 'ERROR')) return 'ERROR';
    if (targets.some(score => !score || !['PASS', 'NOT_APPLICABLE'].includes(score.status))) return 'UNJUDGEABLE';
    return targets.some(score => score?.status === 'NOT_APPLICABLE') ? 'UNJUDGEABLE' : 'PASS';
}
function reportRows(repo: string, report: LocalReport): Rerun[] {
    if (!report.endedAt || report.scoring !== 'complete') return [];
    const rows: Rerun[] = [];
    for (const trial of report.trials) if (trial.execution?.started) for (const origin of trial.regressionOrigins ?? []) {
        if (!report.executionKind) throw Error('Regression report lacks its actual execution kind');
        rows.push(rowSchema.parse({ at: report.endedAt, batch: origin.batch, issueId: origin.issueId, sourceExecutionId: origin.sourceExecutionId,
            sourceTrialId: origin.sourceTrialId, sourceCaseId: origin.sourceCaseId, sourceCaseVersion: origin.sourceCaseVersion,
            datasetId: report.dataset.id, executionId: report.executionId, caseId: trial.caseId, trialId: trial.trialId, repetition: trial.repetition,
            repeat: report.repeat, status: trial.status, targetStatus: targetStatus(report, trial, origin), executionKind: report.executionKind,
            report: relative(realpathSync(repo), reportPath(repo, report.executionId)).replaceAll('\\', '/'), usage: trial.execution.usage }));
    }
    return rows;
}
/** Only persisted, finalized attempts are recorded; record failure never changes a score. */
export function recordRegressions(repo: string, file: string): { saved: true; count: number } | { saved: false; error: string } {
    try {
        const report = readReport(file);
        if (resolve(reportPath(repo, report.executionId)) !== resolve(file)) throw Error('Regression report path is not its owned Execution');
        const rows = reportRows(repo, report); let count = 0;
        for (const batch of new Set(rows.map(row => row.batch))) {
            const directory = batchDirectory(repo, batch, true)!, target = join(directory, 'reruns.csv'), writing = target + '.writing';
            const fd = openSync(writing, 'wx', 0o600);
            try {
                const previous = readRows(repo, batch), known = new Map(previous.map(row => [key(row), row]));
                for (const row of rows.filter(row => row.batch === batch)) {
                    const old = known.get(key(row));
                    if (old && !isDeepStrictEqual(old, row)) throw Error('Conflicting rerun identity; original record preserved');
                    if (!old) { previous.push(row); known.set(key(row), row); count++; }
                }
                const lines = previous.map(row => columns.map(column => '"' + (column === 'usage' ? JSON.stringify(row[column]) : String(row[column])).replaceAll('"', '""') + '"').join(','));
                atomicText(target, [columns.join(','), ...lines].join('\n') + '\n');
            } finally { closeSync(fd); unlinkSync(writing); }
        }
        return { saved: true, count };
    } catch (error) { return { saved: false, error: short(error) }; }
}

export function regressionView(repo: string, report: LocalReport) {
    const enrolled: Array<{ caseId: string; datasetId: string; origin: RegressionOrigin }> = [];
    const declarationWarnings: string[] = [];
    const directory = join(repo, 'agent-eval/src/datasets/badcase'), declaration = join(directory, 'cases.ts');
    try { if (existsSync(declaration)) {
        const require = createRequire(import.meta.url); delete require.cache[require.resolve(declaration)];
        const data = authorDatasetSchema.parse(require(declaration).flowmateBadcaseDataset);
        for (const task of data.cases) for (const input of data.regressionOrigins?.[task.id] ?? []) {
            const origin = regressionOriginSchema.parse(input);
            if (origin.sourceExecutionId === report.executionId && report.trials.some(trial => trial.trialId === origin.sourceTrialId && trial.caseId === origin.sourceCaseId && trial.caseVersion === origin.sourceCaseVersion))
                enrolled.push({ caseId: task.id, datasetId: task.tags.includes('research') ? 'flowmate-badcase-research-v1' : 'flowmate-badcase-business-v1', origin });
        }
    } } catch { declarationWarnings.push('专项声明无法读取或校验；原报告仍可查看，收录状态需核验'); }
    for (const trial of report.trials) for (const origin of trial.regressionOrigins ?? []) enrolled.push({ caseId: trial.caseId, datasetId: report.dataset.id, origin });
    const entries = [...new Map(enrolled.map(entry => [JSON.stringify([entry.caseId, entry.datasetId, entry.origin]), entry])).values()].map(entry => {
        const { origin } = entry; const warnings: string[] = [], attempts: Array<Rerun & { metricIds: string[]; matchesCurrentTarget: boolean }> = [];
        try {
            const cache = new Map<string, { report: LocalReport; rows: Rerun[] }>();
            for (const row of readRows(repo, origin.batch).filter(row => row.sourceExecutionId === origin.sourceExecutionId && row.sourceTrialId === origin.sourceTrialId &&
                row.issueId === origin.issueId && row.caseId === entry.caseId && row.datasetId === entry.datasetId)) {
                try {
                    if (!cache.has(row.executionId)) {
                        const saved = readReport(reportPath(repo, row.executionId)); cache.set(row.executionId, { report: saved, rows: reportRows(repo, saved) });
                    }
                    const saved = cache.get(row.executionId)!;
                    if (!saved.rows.some(actual => key(actual) === key(row) && isDeepStrictEqual(actual, row))) throw Error('Rerun row differs from its original report');
                    const target = saved.report.trials.find(trial => trial.trialId === row.trialId)?.regressionOrigins?.find(previous =>
                        previous.batch === row.batch && previous.issueId === row.issueId && previous.sourceExecutionId === row.sourceExecutionId && previous.sourceTrialId === row.sourceTrialId);
                    if (!target) throw Error('Rerun lacks its saved regression origin');
                    attempts.push({ ...row, metricIds: target.metricIds, matchesCurrentTarget: isDeepStrictEqual(originTarget(target), originTarget(origin)) });
                } catch (error) { warnings.push(short(error)); }
            }
        } catch (error) { warnings.push(short(error)); }
        const matching = attempts.filter(row => row.matchesCurrentTarget);
        const stable = !warnings.length && !declarationWarnings.length && [...new Set(matching.map(row => row.executionId))].some(id => {
            const group = matching.filter(row => row.executionId === id), planned = group[0]!.repeat;
            return planned >= 3 && group.length === planned && new Set(group.map(row => row.repetition)).size === planned &&
                group.every(row => row.executionKind === 'model' && row.targetStatus === 'PASS' && row.status === 'PASS');
        });
        return { ...entry, enrolled: true, stable, reruns: attempts, warnings };
    });
    return { entries, warnings: declarationWarnings };
}
