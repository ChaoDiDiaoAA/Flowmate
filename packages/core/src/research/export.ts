import { setImmediate } from 'node:timers/promises';
import { appError, fail, ok, ResearchReportRequestSchema, ResearchExportSchema, ResearchReportDocumentSchema,
  researchCitationKey, researchCitations, researchReviewBindingsMatch } from '@flowmate/contracts';
import type { Claim, ResearchExport, ResearchReportDocument, ResearchReference, ResearchSentence, Result, SourceSnapshot } from '@flowmate/contracts';
import { readResearchEvidence, type ResearchEvidenceOptions } from './synthesis-tools.ts';

async function loadReportProof(options: ResearchEvidenceOptions, raw: unknown) {
  const input = ResearchReportRequestSchema.safeParse(raw);
  if (!input.success) return fail(appError('input_invalid', 'input', 'Report export request is invalid.'));
  const loaded = await options.database.read(store => {
    const report = store.research.getReport(input.data); if (!report.ok) return report;
    const task = store.research.get(input.data.researchId); if (!task.ok) return task;
    const plan = store.research.getPlan({ researchId: input.data.researchId, planId: report.data.planId });
    return plan.ok ? ok({ report: report.data, task: task.data, policy: plan.data.body.sourcePolicy }) : plan;
  }).catch(() => fail(appError('research_read_failed', 'storage', 'Research storage is unavailable.', true)));
  if (!loaded.ok) return loaded;
  const { report, task, policy } = loaded.data, claims = new Map<number, Claim>(), passages: string[] = [];
  const review = report.semanticReview?.policyVersion === 'research-semantic-v2' ? report.semanticReview : undefined;
  const sources = new Map<number, SourceSnapshot>();
  const numbers = report.cited ? researchCitations(report.cited) : new Map<string, { claimId: number; evidenceIndex: number; number: number }>();
  const references: ResearchReference[] = [];
  const pending = [...numbers.values()].map(item => item.claimId)
    .concat(report.sections.flatMap(section => section.claimIds), report.coverage.flatMap(row => row.claimIds));
  while (pending.length) {
    const claimId = pending.pop()!; if (claims.has(claimId)) continue;
    if (claims.size >= 512) return fail(appError('research_evidence_limit', 'tool', 'The report evidence graph exceeds the export limit.'));
    const claim = await options.database.read(store => store.research.getClaim({ researchId: report.researchId, claimId }))
      .catch(() => fail(appError('research_read_failed', 'storage', 'Research storage is unavailable.', true)));
    if (!claim.ok) return claim;
    if (claim.data.planId !== report.planId || claim.data.revision !== report.revision) return fail(appError('research_identity_conflict', 'tool', 'Report evidence belongs to another plan.'));
    claims.set(claimId, claim.data); pending.push(...claim.data.dependencies);
    if (claims.size % 16 === 0) await setImmediate();
    for (const [evidenceIndex, { ref, relation }] of claim.data.evidence.entries()) {
      if (ref.researchId !== report.researchId || ref.planId !== report.planId || ref.revision !== report.revision)
        return fail(appError('research_identity_conflict', 'tool', 'Report evidence belongs to another plan.'));
      const evidence = await readResearchEvidence(options, { researchId: report.researchId, sourceSnapshotId: ref.sourceSnapshotId,
        offset: ref.locator.start, limit: Math.min(4000, ref.locator.end - ref.locator.start) }, policy, report.cited ? report.planId : undefined);
      if (!evidence.ok) return evidence;
      const source = evidence.data.source;
      const body = await options.files.readResearchSource(source); if (!body.ok) return body;
      if (source.runId !== ref.runId || source.toolCallId !== ref.toolCallId
        || body.data.slice(ref.locator.start, ref.locator.end) !== ref.locator.quote)
        return fail(appError('research_evidence_mismatch', 'tool', 'The report quote cannot be verified against saved evidence.'));
      if (review) sources.set(source.sourceSnapshotId, source);
      if (report.cited) {
        const selected = numbers.get(researchCitationKey({ claimId, evidenceIndex }));
        if (selected) references.push({ ...selected, relation, source, locator: ref.locator });
        continue;
      }
      const address = source.kind === 'web' ? `<${new URL(source.address).href}>` : source.address;
      const quotation = ref.locator.quote.split(source.kind === 'web' ? /\r\n?|\n/ : '\n').map(line => `${source.kind === 'web' ? '    ' : '> '}${line}`).join('\n');
      const title = source.kind === 'web' ? source.title.replace(/\s+/g, ' ').replace(/[\\`*_{}\[\]()#+\-.!<>|]/g, '\\$&') : source.title;
      passages.push(`### Claim ${claimId} / Source ${source.sourceSnapshotId} (${relation})\n\n${title}\n\n${address}\n\nFetched: ${source.fetchedAt}; ${source.kind === 'web' ? 'source date' : 'published'}: ${source.publishedAt ?? 'unknown'}\n\nRun ${source.runId} / ToolCall ${source.toolCallId}; offsets ${ref.locator.start}–${ref.locator.end}\n\n${quotation}`);
    }
  }
  if (references.length !== numbers.size)
    return fail(appError('research_evidence_incomplete', 'tool', 'A selected citation is missing.'));
  if (review) {
    const bySource = new Map<number, NonNullable<typeof review.context>['segments']>();
    for (const segment of review.context?.segments ?? []) {
      const segments = bySource.get(segment.sourceSnapshotId);
      if (segments) segments.push(segment);
      else bySource.set(segment.sourceSnapshotId, [segment]);
    }
    for (const [sourceSnapshotId, segments] of bySource) {
      let source = sources.get(sourceSnapshotId);
      if (!source) {
        const evidence = await readResearchEvidence(options, { researchId: report.researchId, sourceSnapshotId }, policy, report.planId);
        if (!evidence.ok) return evidence;
        source = evidence.data.source;
        sources.set(sourceSnapshotId, source);
      }
      if (!segments.some(segment => segment.findings.length)) continue;
      const body = await options.files.readResearchSource(source); if (!body.ok) return body;
      if (segments.some(segment => segment.findings.some(({ sentenceIndex, locator }) =>
        !review.sentences[sentenceIndex] || locator.start < segment.readStart || locator.end > segment.readEnd
        || body.data.slice(locator.start, locator.end) !== locator.quote)))
        return fail(appError('research_evidence_mismatch', 'tool', 'The review context quote cannot be verified against saved evidence.'));
    }
    if (!researchReviewBindingsMatch(review, claims, [...sources.values()]))
      return fail(appError('research_evidence_mismatch', 'tool', 'The review evidence bindings or source context do not match the saved report evidence.'));
  }
  references.sort((left, right) => left.number - right.number);
  return ok({ task, report, claims, passages, numbers, references });
}

export async function queryResearchReportDocument(options: ResearchEvidenceOptions, raw: unknown): Promise<Result<ResearchReportDocument>> {
  const proof = await loadReportProof(options, raw);
  if (!proof.ok) return proof;
  const { task, report, references } = proof.data;
  if (!report.cited)
    return fail(appError('research_pdf_legacy', 'input', 'Create a report with sentence citations to export PDF.'));
  const document = ResearchReportDocumentSchema.safeParse({ researchId: report.researchId, reportId: report.reportId,
    title: task.title, report, references });
  return document.success && Buffer.byteLength(JSON.stringify(document.data)) <= 2_000_000 ? ok(document.data)
    : fail(appError('research_export_too_large', 'storage', 'The report document exceeds the export limit.'));
}

const markdownText = (text: string) => text.replace(/[\\`*_{}\[\]()#+!<>|]/g, '\\$&').replace(/^(\d+)\.(?=\s)/, '$1\\.');
export async function exportResearchReport(options: ResearchEvidenceOptions, raw: unknown): Promise<Result<ResearchExport>> {
  const proof = await loadReportProof(options, raw);
  if (!proof.ok) return proof;
  const { task, report, claims, passages, numbers, references } = proof.data;
  const marker = (citation: ResearchSentence['citations'][number], review = false) => {
    const number = numbers.get(researchCitationKey(citation))?.number;
    if (number === undefined) return ` · Claim ${citation.claimId}, evidence index ${citation.evidenceIndex}`;
    return ` [${review ? `Reference ${number}` : `[${number}]`}](#reference-${number})`;
  };
  const citedText = (sentences: ResearchSentence[]) => sentences.map(sentence =>
    markdownText(sentence.text.trim()) + sentence.citations.map(citation => marker(citation)).join('')).join(' ');
  const answer = report.cited ? citedText(report.cited.answer) : report.answer;
  const sections = report.cited ? report.cited.sections.map(section =>
    `## ${markdownText(section.title)}\n\n${citedText(section.sentences)}`).join('\n\n')
    : report.sections.map(section => `## ${section.title}\n\n${section.text}\n\nClaims: ${section.claimIds.join(', ') || 'none'}`).join('\n\n');
  const referencesText = references.map(({ number, claimId, relation, source, locator }) =>
    `### Reference ${number}\n\nClaim ${claimId} (${relation}) · Source snapshot ${source.sourceSnapshotId}\n\n${markdownText(source.title)}\n\n${source.kind === 'web' ? '<' + new URL(source.address).href + '>' : markdownText(source.address)}\n\nFetched: ${source.fetchedAt} · Source date: ${source.publishedAt ?? 'unknown'}\n\nRun ${source.runId} / ToolCall ${source.toolCallId} · UTF-16 offsets [${locator.start}, ${locator.end})\n\n${locator.quote.split(/\r\n?|\n/).map(line => '    ' + line).join('\n')}`);
  const list = (items: string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : 'None recorded.';
  const review = report.semanticReview;
  const v2 = review?.policyVersion === 'research-semantic-v2' ? review : undefined;
  const legacyReviewNote = review?.policyVersion === 'research-semantic-v1'
    ? 'This v1 receipt does not include saved source context or citation contribution checks.\n\n' : '';
  const reviewDetails = v2 && v2.status !== 'no_findings' ? [
    ...v2.sentences.map(row => `### Sentence ${row.sentenceIndex + 1}\n\n${markdownText(row.text)} · ${row.verdict.replaceAll('_', ' ')} · ${row.complete ? 'complete' : 'incomplete'}\n\n${list(row.facts.map((fact, index) =>
      `Fact ${index + 1}: ${markdownText(fact.text)} · ${fact.verdict.replaceAll('_', ' ')} · UTF-16 offsets [${fact.start}, ${fact.end}): ${markdownText(fact.reason)}${fact.citations.map(citation => marker(citation, true)).join('')}`))}\n\n**Citation contributions**\n\n${list((row.citationReviews ?? []).map(check =>
      `Claim ${check.claimId}, evidence index ${check.evidenceIndex}${marker(check, true)} · ${check.verdict}: ${markdownText(check.reason)}`
      + check.contributions.map(item => `\n  - Fact ${item.factIndex + 1} · ${item.role.replaceAll('_', ' ')}: ${markdownText(item.reason)}`).join('')))}`),
    `### Source context · ${v2.context?.mode}\n\n${(v2.context?.segments ?? []).map(segment => {
      const { sourceSnapshotId, start, end, readStart, readEnd, findings } = segment;
      return `Source snapshot ${sourceSnapshotId} · segment [${start}, ${end}) · read [${readStart}, ${readEnd}) · complete\n\n`
        + (findings.length ? list(findings.map(({ sentenceIndex, kind, locator }) =>
          `[Sentence ${sentenceIndex + 1}](#sentence-${sentenceIndex + 1}) · ${kind} · UTF-16 offsets [${locator.start}, ${locator.end})\n\n`
          + locator.quote.split(/\r\n?|\n/).map(line => '      ' + line).join('\n'))) : 'No context findings recorded.');
    }).join('\n\n')}`,
    `### Reviewed evidence bindings\n\n${list((v2.evidenceBindings ?? []).map(({ claimId, evidenceIndex, ref, source }) =>
      `Claim ${claimId}, evidence index ${evidenceIndex} · ${markdownText(source.title)} · Source snapshot ${source.sourceSnapshotId} · Run ${source.runId} / ToolCall ${source.toolCallId} · UTF-16 offsets [${ref.locator.start}, ${ref.locator.end})`))}`,
    `### Review stages\n\n${list((v2.stages ?? []).map(({ stage, model, responseId, usage, tokens }) =>
      `${stage} · ${markdownText(model.provider)} / ${markdownText(model.model)} · Response ${markdownText(responseId ?? 'unknown')} · Usage ${usage.source} (${usage.attempts ?? 'unknown'} attempts) · Tokens (input / output / total) ${tokens.inputTokens ?? 'unknown'} / ${tokens.outputTokens ?? 'unknown'} / ${tokens.totalTokens ?? 'unknown'} · ${tokens.usageComplete ? 'complete' : 'incomplete'} · Cost ${markdownText(tokens.cost ?? 'unknown')}`))}`,
  ].join('\n\n') + '\n\n' : legacyReviewNote;
  let reviewSummary = 'This historical report has no independent sentence review.';
  if (review?.status === 'verified')
    reviewSummary = `All ${review.sentences.length} sentences passed independent factual review with ${markdownText(review.model.model)}.`;
  if (review?.status === 'no_findings') reviewSummary = 'No findings to review. No review model was called.';
  const reviewText = `## Semantic review\n\n${reviewSummary}\n\n` + (review
    ? `Policy ${review.policyVersion} · Run ${review.runId} / ToolCall ${review.toolCallId} · ${review.reviewedAt}\n\n` : '');
  const markdown = `# ${report.cited ? markdownText(task.title) : task.title}\n\nResearch ${report.researchId}; report ${report.reportId}; plan ${report.planId} revision ${report.revision}; saved ${report.createdAt}\n\nCompleteness: ${report.completeness}. Verification records show the Agent judgment and its evidence; they do not guarantee every conclusion is true.\n\n${answer}\n\n${sections}\n\n${reviewText}${reviewDetails}## Coverage\n\n${report.coverage.map(row => `- ${row.questionId}: ${row.status}; claims ${row.claimIds.join(', ') || 'none'}; ${row.reason}`).join('\n')}\n\n## Conflicts\n\n${list(report.conflicts)}\n\n## Limitations\n\n${list(report.limitations)}\n\n## Unresolved questions\n\n${list(report.unresolvedQuestions)}\n\n## Claim verification\n\n${[...claims.values()].map(claim => `### Claim ${claim.claimId}: ${claim.verification.status}\n\n${claim.text}\n\n${list(claim.verification.reasons)}\n\nDependencies: ${claim.dependencies.join(', ') || 'none'}`).join('\n\n')}\n\n## ${report.cited ? 'References' : 'Evidence'}\n\n${(report.cited ? referencesText : passages).join('\n\n')}\n`;
  const value = ResearchExportSchema.safeParse({ researchId: report.researchId, reportId: report.reportId,
    filename: `research-${report.researchId}-report-${report.reportId}.md`, markdown, bytes: Buffer.byteLength(markdown) });
  return value.success ? ok(value.data) : fail(appError('research_export_too_large', 'storage', 'The report exceeds the Markdown export limit.'));
}
