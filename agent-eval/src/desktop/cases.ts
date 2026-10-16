import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, evaluationRequests, EvaluationCatalogSchema, EvaluationFeedbackRecordSchema,
  EvaluationFeedbackSavedSchema, EvaluationFeedbackListSchema, type EvaluationFeedbackList } from '@flowmate/contracts';
import { discoverCaseDeclarations, inspectCaseDeclaration } from '../dataset-loader/declarations.ts';
import { addFeedback, feedbackStatus, readFeedbackRecords, type Feedback } from '../review/local.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
import { page } from './results.ts';

const safe = (value: string) => scanEvidence(value).value;
const failure = (code: string, error: unknown) => fail(appError(code, 'runtime', safe(String(error)).slice(0, 2000), true));
function recordView(record: Feedback) {
  const dataset = record.conditions?.dataset as { id?: unknown } | undefined;
  return EvaluationFeedbackRecordSchema.parse(scanEvidence({ id: record.id, kind: record.kind,
    datasetId: typeof dataset?.id === 'string' ? dataset.id : null, caseId: record.caseId, caseVersion: record.caseVersion,
    executionId: record.executionId ?? null, trialId: record.trialId ?? null,
    reviewer: record.reviewer.slice(0, 128), reviewerTruncated: record.reviewer.length > 128,
    at: record.at, verdict: record.verdict, note: record.note.slice(0, 16_000), noteTruncated: record.note.length > 16_000,
    source: record.source.slice(0, 2000), sourceTruncated: record.source.length > 2000 }).value);
}
function caseText(inspection: ReturnType<typeof inspectCaseDeclaration>) {
  const task = inspection.declaration.task;
  const summary = safe(JSON.stringify({ id: task.id, prompt: task.input.prompt, expected: task.expected,
    scoring: 'scoring' in task ? task.scoring : inspection.declaration.manifest?.scoring }, null, 2));
  const materials = inspection.files.map(file => {
    const bytes = Buffer.from(file.content, 'base64');
    return `\n${file.path} (${file.bytes} bytes)\n` + (isUtf8(bytes) && !bytes.includes(0) ? bytes.toString('utf8') : '[Binary material; text preview unavailable.]');
  });
  const text = safe(['Task declaration', JSON.stringify(task, null, 2), 'Gold', JSON.stringify(inspection.declaration.gold, null, 2),
    'Scenario', JSON.stringify(inspection.declaration.fixture, null, 2), 'Available materials', ...materials].join('\n\n'));
  return { summary: summary.slice(0, 32_000), summaryTruncated: summary.length > 32_000, text };
}
export function createEvaluationCases(repo: string, sessionId: string) {
  let catalogView: { id: string; declarations: ReturnType<typeof discoverCaseDeclarations> } | null = null;
  let caseView: { id: string; inspection: ReturnType<typeof inspectCaseDeclaration>; summary: string; summaryTruncated: boolean; text: string } | null = null;
  let feedbackView: { id: string; identity: string; records: Feedback[]; rows: EvaluationFeedbackList['records']; issues: string[] } | null = null;
  return {
    catalog(input: unknown) {
      try {
        const request = evaluationRequests.query_evaluation_catalog.parse(input);
        if (request.view === 'list') {
          const declarations = discoverCaseDeclarations(repo);
          if (request.viewId && (!catalogView || request.viewId !== catalogView.id || !isDeepStrictEqual(catalogView.declarations, declarations)))
            throw Error('Catalog changed; refresh its first page');
          if (!request.viewId) catalogView = { id: randomUUID(), declarations };
          const current = catalogView!, paging = page(declarations.length, request.offset, request.limit, 'rows');
          return ok(EvaluationCatalogSchema.parse({ version: 1, sessionId, view: 'list', viewId: current.id, page: paging,
            items: current.declarations.slice(request.offset, request.offset + request.limit).map(item => ({ datasetId: item.datasetId,
              datasetVersion: item.datasetVersion, caseId: item.caseId, caseVersion: item.caseVersion, name: item.name.slice(0, 2000),
              category: item.category.slice(0, 200), smoke: item.smoke })) }));
        }
        const inspection = inspectCaseDeclaration(repo, request.datasetId, request.caseId);
        if (request.caseViewId && (!caseView || request.caseViewId !== caseView.id || !isDeepStrictEqual(caseView.inspection.conditions, inspection.conditions)))
          throw Error('Case inspection changed or expired; refresh the Case view');
        if (!request.caseViewId) caseView = { id: randomUUID(), inspection, ...caseText(inspection) };
        const current = caseView!, declaration = current.inspection.declaration;
        return ok(EvaluationCatalogSchema.parse({ version: 1, sessionId, view: 'case', caseViewId: current.id,
          datasetId: declaration.datasetId, caseId: declaration.caseId, caseVersion: declaration.caseVersion,
          name: declaration.name.slice(0, 2000), category: declaration.category.slice(0, 200), summary: current.summary,
          summaryTruncated: current.summaryTruncated, page: page(current.text.length, request.offset, request.limit, 'characters'),
          text: current.text.slice(request.offset, request.offset + request.limit), fileCount: current.inspection.files.length, gaps: current.inspection.gaps }));
      } catch (error) { return failure('evaluation_catalog_invalid', error); }
    },
    addFeedback(input: unknown) {
      try {
        const request = evaluationRequests.add_evaluation_feedback.parse(input), target = request.target;
        const existing = readFeedbackRecords(repo, target.kind === 'run-feedback' ? target.executionId : undefined)
          .some(record => record.id === request.operationId);
        if (target.kind === 'case-quality' && !existing && (!caseView || caseView.id !== target.caseViewId
          || caseView.inspection.declaration.datasetId !== target.datasetId || caseView.inspection.declaration.caseId !== target.caseId))
          throw Error('Case view expired; refresh before submitting new feedback');
        const record = addFeedback(repo, { id: request.operationId, caseId: target.caseId, reviewer: request.reviewer,
          verdict: request.verdict, note: request.note, ...(target.kind === 'case-quality' ? { datasetId: target.datasetId }
            : { executionId: target.executionId, trialId: target.trialId }) },
          target.kind === 'case-quality' && !existing ? caseView!.inspection.conditions : undefined);
        return ok(EvaluationFeedbackSavedSchema.parse({ version: 1, sessionId, operationId: request.operationId, record: recordView(record) }));
      } catch (error) { return failure('evaluation_feedback_failed', error); }
    },
    feedback(input: unknown) {
      try {
        const request = evaluationRequests.query_evaluation_feedback.parse(input), target = request.target;
        if (target.kind === 'case-quality' && !request.operationId && !discoverCaseDeclarations(repo)
          .some(item => item.datasetId === target.datasetId && item.caseId === target.caseId)) throw Error('Unknown registered Case');
        const records = readFeedbackRecords(repo, target.kind === 'run-feedback' ? target.executionId : undefined).filter(record => {
          const dataset = record.conditions?.dataset as { id?: unknown } | undefined;
          return target.kind === 'run-feedback' ? record.executionId === target.executionId
            : record.kind === 'case-quality' && record.caseId === target.caseId && (dataset?.id === undefined || dataset.id === target.datasetId);
        });
        const identity = JSON.stringify([target, request.operationId ?? null]);
        if (request.viewId && (!feedbackView || feedbackView.id !== request.viewId || feedbackView.identity !== identity || !isDeepStrictEqual(feedbackView.records, records)))
          throw Error('Feedback changed; refresh its first page');
        const issues: string[] = [], current = new Set<string>(), unverified = new Set(records.filter(record => !record.conditions).map(record => record.id));
        try {
          const status = feedbackStatus(repo, target.kind === 'run-feedback' ? target.executionId : undefined,
            target.kind === 'case-quality' ? target.datasetId : undefined);
          status.records.forEach(record => current.add(record.id)); status.unverified.forEach(record => unverified.add(record.id));
        } catch (error) { records.forEach(record => unverified.add(record.id)); issues.push(safe(String(error)).slice(0, 2000)); }
        const rows: EvaluationFeedbackList['records'] = records.map(record => ({ ...recordView(record),
          validity: unverified.has(record.id) ? 'unverified' : current.has(record.id) ? 'current' : 'stale' }));
        if (request.viewId && (!isDeepStrictEqual(feedbackView!.rows, rows) || !isDeepStrictEqual(feedbackView!.issues, issues)))
          throw Error('Feedback conditions changed; refresh its first page');
        if (!request.viewId) feedbackView = { id: randomUUID(), identity, records, rows, issues };
        return ok(EvaluationFeedbackListSchema.parse({ version: 1, sessionId, viewId: feedbackView!.id, target,
          operationId: request.operationId ?? null, page: page(rows.length, request.offset, request.limit, 'rows'),
          records: rows.slice(request.offset, request.offset + request.limit), operation: rows.find(record => record.id === request.operationId) ?? null,
          stale: rows.filter(record => record.validity === 'stale').length, unverified: rows.filter(record => record.validity === 'unverified').length,
          formalAcceptance: 'pending', issues }));
      } catch (error) { return failure('evaluation_feedback_invalid', error); }
    },
  };
}
