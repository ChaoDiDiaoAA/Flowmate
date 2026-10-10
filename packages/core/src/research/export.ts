import { createHash } from 'node:crypto';
import { appError, fail, ok, ResearchReportRequestSchema, ResearchExportSchema } from '@flowmate/contracts';
import type { Claim, ResearchExport, Result } from '@flowmate/contracts';
import type { ResearchRepository } from './repository.ts';
import type { FileStore } from '../storage/file-store.ts';
import type { ToolCallRepository } from '../storage/repositories.ts';
import { readResearchEvidence } from './synthesis-tools.ts';

export function exportResearchReport(options: { research: ResearchRepository; files: FileStore; calls: ToolCallRepository }, raw: unknown): Result<ResearchExport> {
  const input = ResearchReportRequestSchema.safeParse(raw);
  if (!input.success) return fail(appError('input_invalid', 'input', 'Report export request is invalid.'));
  const loaded = options.research.getReport(input.data); if (!loaded.ok) return loaded;
  const task = options.research.get(input.data.researchId); if (!task.ok) return task;
  const report = loaded.data, claims = new Map<number, Claim>(), passages: string[] = [];
  const pending = report.sections.flatMap(section => section.claimIds).concat(report.coverage.flatMap(row => row.claimIds));
  while (pending.length) {
    const claimId = pending.pop()!; if (claims.has(claimId)) continue;
    if (claims.size >= 512) return fail(appError('research_evidence_limit', 'tool', 'The report evidence graph exceeds the export limit.'));
    const claim = options.research.getClaim({ researchId: report.researchId, claimId }); if (!claim.ok) return claim;
    if (claim.data.planId !== report.planId) return fail(appError('research_identity_conflict', 'tool', 'Report evidence belongs to another plan.'));
    claims.set(claimId, claim.data); pending.push(...claim.data.dependencies);
    for (const { ref, relation } of claim.data.evidence) {
      const evidence = readResearchEvidence(options, { researchId: report.researchId, sourceSnapshotId: ref.sourceSnapshotId,
        offset: ref.locator.start, limit: Math.min(4000, ref.locator.end - ref.locator.start) }, task.data.sourcePolicy);
      if (!evidence.ok) return evidence;
      const source = evidence.data.source;
      const body = options.files.readResearchSource(source); if (!body.ok) return body;
      if (source.runId !== ref.runId || source.toolCallId !== ref.toolCallId
        || body.data.slice(ref.locator.start, ref.locator.end) !== ref.locator.quote)
        return fail(appError('research_evidence_mismatch', 'tool', 'The report quote cannot be verified against saved evidence.'));
      passages.push(`### Claim ${claimId} / Source ${source.sourceSnapshotId} (${relation})\n\n${source.title}\n\n${source.address}\n\nFetched: ${source.fetchedAt}; published: ${source.publishedAt ?? 'unknown'}; SHA-256: ${source.contentHash}\n\nRun ${source.runId} / ToolCall ${source.toolCallId}; offsets ${ref.locator.start}–${ref.locator.end}\n\n${ref.locator.quote.split('\n').map(line => `> ${line}`).join('\n')}`);
    }
  }
  const list = (items: string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : 'None recorded.';
  const markdown = `# ${task.data.title}\n\nResearch ${report.researchId}; report ${report.reportId}; plan ${report.planId} revision ${report.revision}; saved ${report.createdAt}\n\nCompleteness: ${report.completeness}. Verification records show the Agent judgment and its evidence; they do not guarantee every conclusion is true.\n\n${report.answer}\n\n${report.sections.map(section => `## ${section.title}\n\n${section.text}\n\nClaims: ${section.claimIds.join(', ') || 'none'}`).join('\n\n')}\n\n## Coverage\n\n${report.coverage.map(row => `- ${row.questionId}: ${row.status}; claims ${row.claimIds.join(', ') || 'none'}; ${row.reason}`).join('\n')}\n\n## Conflicts\n\n${list(report.conflicts)}\n\n## Limitations\n\n${list(report.limitations)}\n\n## Unresolved questions\n\n${list(report.unresolvedQuestions)}\n\n## Claim verification\n\n${[...claims.values()].map(claim => `### Claim ${claim.claimId}: ${claim.verification.status}\n\n${claim.text}\n\n${list(claim.verification.reasons)}\n\nDependencies: ${claim.dependencies.join(', ') || 'none'}`).join('\n\n')}\n\n## Evidence\n\n${passages.join('\n\n')}\n`;
  const value = ResearchExportSchema.safeParse({ researchId: report.researchId, reportId: report.reportId,
    filename: `research-${report.researchId}-report-${report.reportId}.md`, markdown, sha256: createHash('sha256').update(markdown).digest('hex') });
  return value.success ? ok(value.data) : fail(appError('research_export_too_large', 'storage', 'The report exceeds the Markdown export limit.'));
}
