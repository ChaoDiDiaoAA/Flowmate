import { TraceBundleSchema, type TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';
import type { LocalReport } from '../reports/store.ts';
import { scanEvidence } from './evidence-safety.ts';
import { decodeFile, type EmbeddedFile } from '../dataset-loader/flat.ts';
import { z } from 'zod';
import { caseMaterialSchema } from '../dataset-loader/schema.ts';

export function reportTraces(report: LocalReport, visibleFiles: Record<string, EmbeddedFile[]> = {}): TraceBundle[] {
  return report.trials.map(trial => {
    const execution = trial.execution, gaps: string[] = [];
    if (!execution?.started || !execution.endedAt) gaps.push('execution-incomplete');
    const cleanup = execution?.evidence.cleanup;
    const stopped = cleanup?.actual as { stopped?: boolean; closed?: boolean } | null;
    if (!cleanup?.present || !stopped?.stopped || !stopped.closed) gaps.push('run-stop-unconfirmed');
    for (const observation of execution?.observations ?? []) if (!observation.endedAt) gaps.push('observation-unfinished:' + observation.id);
    if (report.sourceInvalidation) gaps.push('execution-source-changed');
    if (report.executionKind === 'model' && execution?.evidence['trace-capture']?.present !== true) gaps.push('raw-model-capture-incomplete');
    const id = trial.traceId.includes('-') ? trial.traceId : trial.traceId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const input = execution?.input ?? { prompt: trial.caseName, materials: [] };
    const declared = z.object({ task: z.object({ id: z.literal(trial.caseId), version: z.literal(trial.caseVersion),
      input: z.object({ materials: z.array(caseMaterialSchema) }) }) }).safeParse(trial.caseConditions);
    const invoiceSamples = new Set(declared.success ? declared.data.task.input.materials.filter(material => material.source === 'voxel51').map(material => material.sample) : []);
    const rawInputs = execution?.evidence.inputs?.actual;
    const turns = Array.isArray(rawInputs) ? rawInputs.filter(value => value.status === 'consumed' && typeof value.content?.text === 'string')
      .sort((a, b) => String(a.dispatchedAt ?? a.createdAt).localeCompare(String(b.dispatchedAt ?? b.createdAt)) || a.inputId - b.inputId).slice(1)
      .map(value => ({ id: 'input-' + value.inputId, role: 'user' as const, content: value.content.text,
        ...(['prompt', 'followUp', 'steer'].includes(value.mode) ? { mode: value.mode } : {}) })) : undefined;
    const value = scanEvidence({ id, revision: 1, source: { kind: 'evaluation', executionId: report.executionId, trialId: trial.trialId,
      ...(report.runId ? { runId: report.runId } : {}), ...(trial.sessionId ? { sessionId: trial.sessionId } : {}), ...(report.userId ? { userId: report.userId } : {}) },
      entry: 'evaluation', startedAt: execution?.startedAt ?? report.startedAt, endedAt: execution?.endedAt ?? null,
      input: { prompt: input.prompt, ...(turns?.length ? { turns } : {}), materials: input.materials },
      output: { answer: execution?.answer ?? null, artifacts: execution?.artifacts ?? [], endpointReached: execution?.endpointReached ?? false },
      status: trial.status, complete: gaps.length === 0, gaps,
      configuration: { agent: execution?.configuration ?? {}, ...(report.code ? { code: report.code } : {}), scoring: report.scoringConfiguration },
      events: execution?.observations ?? [], facts: { caseId: trial.caseId, caseVersion: trial.caseVersion, executionKind: report.executionKind,
        evidence: execution?.evidence ?? {}, scores: trial.scores, judgeErrors: trial.judgeCalls.map(call => ({ error: call.error, configuration: call.configuration })) },
      materials: [...input.materials.map((material, index) => ({ id: 'material-' + (index + 1),
        path: 'materials/' + material.sample + '/' + material.file, text: material.text })),
        ...(visibleFiles[trial.caseId] ?? []).map((value, index) => { const { file } = decodeFile(value);
          const invoice = file.path.match(/^invoice-input\/(\d{6})\/(content\.json|pages\.json|metadata\.json|original\.(?:jpg|png))$/);
          const path = invoice && invoiceSamples.has(invoice[1]!) ? 'voxel51/' + invoice[1] + '/' + invoice[2] : file.path;
          return { id: 'source-' + (index + 1), path, encoding: file.encoding, content: file.content }; })] }).value;
    return TraceBundleSchema.parse(JSON.parse(JSON.stringify(value)));
  });
}
