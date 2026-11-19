import { expect, test } from 'bun:test';
import {
  CitedResearchReportBodySchema, projectCitedResearchReport, researchCitations, ResearchReportSchema,
  RESEARCH_SEMANTIC_POLICY_VERSION, researchReviewBindingsMatch, ResearchSemanticReviewSchema,
  researchSemanticReviewMatchesReport, ReviewedResearchReportBodySchema, ReviewedResearchReportRecordSchema, SourceSnapshotSchema,
  type Claim,
} from '@flowmate/contracts';

const at = '2026-11-19T00:00:00.000Z';
const identity = { researchId: 1, planId: 3, revision: 1, runId: 11, toolCallId: 19 };
const citation = { claimId: 5, evidenceIndex: 0 };
const text = 'Revenue rose.';
const body = { formatVersion: 3, answer: [{ text, citations: [citation] }], sections: [],
  completeness: 'partial', conflicts: [], limitations: [], unresolvedQuestions: [],
  coverage: [{ questionId: 'q', claimIds: [5], status: 'covered', reason: 'Revenue was reported.' }] };
const fact = { start: 0, end: 12, text: 'Revenue rose', citations: [citation], verdict: 'supported', reason: 'Explicit in earnings release.' };
const historicalReceipt = { policyVersion: 'research-semantic-v1', status: 'verified', ...identity, reviewedAt: at,
  reportContext: { completeness: 'partial', conflicts: [], limitations: [], unresolvedQuestions: [],
    coverage: body.coverage, answerSentenceCount: 1, sections: [] },
  model: { provider: 'provider', model: 'reviewer' }, responseId: null,
  usage: { version: 1, source: 'unknown', reason: null, sdkValues: null, attempts: 1,
    attemptsComplete: true, costSource: null, updatedAt: at },
  tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
  sentences: [{ sentenceIndex: 0, text, citations: [citation], complete: true, facts: [fact], verdict: 'supported' }] };
const source = SourceSnapshotSchema.parse({ sourceSnapshotId: 2, researchId: 1, runId: 9, toolCallId: 10, createdAt: at,
  kind: 'local', address: 'artifact:1', title: 'Earnings release', artifactId: 1, documentId: null,
  fetchedAt: at, publishedAt: null, relativePath: 'artifacts/research/1/source-10.txt',
  characters: text.length, bytes: Buffer.byteLength(text), truncated: false });
const ref = { researchId: identity.researchId, planId: identity.planId, revision: identity.revision, runId: source.runId,
  toolCallId: source.toolCallId, sourceSnapshotId: source.sourceSnapshotId, locator: { start: 0, end: text.length, quote: text } };
const binding = { ...citation, ref, source };
const segment = { sourceSnapshotId: source.sourceSnapshotId, start: 0, end: text.length,
  readStart: 0, readEnd: text.length, complete: true as const, findings: [] };
const { model, responseId, usage, tokens } = historicalReceipt;
const final = { stage: 'final', model, responseId, usage, tokens };
const citationReview = { ...citation, verdict: 'contributes', reason: 'The release reports higher revenue.',
  contributions: [{ factIndex: 0, role: 'direct_support', reason: 'The release names the metric and direction.' }] };
const receipt = { ...historicalReceipt, policyVersion: RESEARCH_SEMANTIC_POLICY_VERSION, evidenceBindings: [binding],
  context: { mode: 'full', segments: [segment] }, stages: [final],
  sentences: historicalReceipt.sentences.map(row => ({ ...row, citationReviews: [citationReview] })) };
const meta = { ...identity, reportId: 2, createdAt: at };

test('accepts historical v2 projections and separates v3 model input from the saved receipt', () => {
  const v2 = CitedResearchReportBodySchema.parse({ ...body, formatVersion: 2 });
  const history = ResearchReportSchema.parse({ ...projectCitedResearchReport(v2), ...meta });
  expect(history.cited?.formatVersion).toBe(2);
  expect(history.semanticReview).toBeUndefined();
  expect(ReviewedResearchReportBodySchema.safeParse(body).success).toBe(true);
  expect(ReviewedResearchReportBodySchema.safeParse({ ...body, semanticReview: receipt }).success).toBe(false);

  for (const semanticReview of [historicalReceipt, receipt]) {
    const saved = ReviewedResearchReportRecordSchema.parse({ ...body, semanticReview });
    const read = ResearchReportSchema.parse({ ...projectCitedResearchReport(saved), ...meta });
    expect(read.cited?.formatVersion).toBe(3);
    expect<unknown>(read.semanticReview).toEqual(semanticReview);
    expect([...researchCitations(read.cited!).values()]).toEqual([{ ...citation, number: 1 }]);
    expect(ResearchReportSchema.safeParse({ ...read, semanticReview: undefined }).success).toBe(false);
    expect(ResearchReportSchema.safeParse({ ...read, toolCallId: 20 }).success).toBe(false);
  }
});

test('binds the saved decision to ordered sentence text, citations, completeness and writer identity', () => {
  const parsed = ReviewedResearchReportBodySchema.parse(body);
  const saved = ReviewedResearchReportRecordSchema.parse({ ...parsed, semanticReview: receipt });
  expect(researchSemanticReviewMatchesReport(parsed, saved.semanticReview, identity)).toBe(true);
  expect(researchSemanticReviewMatchesReport(parsed, saved.semanticReview, { ...identity, runId: 12 })).toBe(false);
  expect(researchSemanticReviewMatchesReport(parsed, saved.semanticReview, { ...identity, revision: 2 })).toBe(false);
  expect(ReviewedResearchReportRecordSchema.safeParse({ ...saved, answer: [{ text: 'Revenue rose 12%.', citations: [citation] }] }).success).toBe(false);
  expect(ReviewedResearchReportRecordSchema.safeParse({ ...saved, coverage: [{ ...body.coverage[0], reason: 'Changed coverage.' }] }).success).toBe(false);
  for (const semanticReview of [
    { ...receipt, sentences: [{ ...receipt.sentences[0], sentenceIndex: 1 }] },
    { ...receipt, sentences: [{ ...receipt.sentences[0], complete: false }] },
    { ...receipt, sentences: [{ ...receipt.sentences[0], facts: [{ ...fact, text: 'Profits went' }] }] },
    { ...receipt, sentences: [{ ...receipt.sentences[0], facts: [{ ...fact, citations: [{ claimId: 5, evidenceIndex: 1 }] }] }] },
    { ...receipt, status: 'rejected', sentences: [{ ...receipt.sentences[0], verdict: 'contradicted', facts: [{ ...fact, verdict: 'contradicted' }] }] },
    { ...receipt, model: { provider: '', model: 'reviewer' } },
  ]) expect(ReviewedResearchReportRecordSchema.safeParse({ ...body, semanticReview }).success).toBe(false);
  expect(ResearchReportSchema.safeParse({ ...projectCitedResearchReport(saved), ...meta, answer: 'Profit rose.' }).success).toBe(false);
});

test('rejects a changed section title even when its sentence and evidence remain identical', () => {
  const report = ReviewedResearchReportBodySchema.parse({ ...body, answer: [], sections: [{ title: 'Revenue', sentences: body.answer }] });
  const saved = ReviewedResearchReportRecordSchema.parse({ ...report, semanticReview: { ...receipt,
    reportContext: { ...receipt.reportContext, answerSentenceCount: 0, sections: [{ title: 'Revenue', sentenceCount: 1 }] } } });
  expect(ReviewedResearchReportRecordSchema.safeParse({ ...saved,
    sections: [{ title: 'Profit', sentences: report.sections[0]!.sentences }] }).success).toBe(false);
});

test('requires a v2 receipt to bind the report citations and account for every review stage', () => {
  const contextual = { ...final, stage: 'context' };
  const segmented = { ...receipt, context: { mode: 'segmented', segments: [segment] }, stages: [contextual, final] };
  expect(ReviewedResearchReportRecordSchema.safeParse({ ...body, semanticReview: segmented }).success).toBe(true);
  for (const semanticReview of [
    { ...receipt, evidenceBindings: undefined },
    { ...receipt, evidenceBindings: [{ ...binding, evidenceIndex: 1 }] },
    { ...receipt, evidenceBindings: [binding, binding] },
    { ...receipt, context: undefined },
    { ...receipt, stages: [contextual, final] },
    { ...segmented, stages: [final] },
    { ...segmented, stages: [final, contextual] },
    { ...receipt, sentences: [{ ...receipt.sentences[0], citationReviews: undefined }] },
    { ...receipt, sentences: [{ ...receipt.sentences[0], citationReviews: [{ ...citationReview,
      contributions: [{ ...citationReview.contributions[0], factIndex: 1 }] }] }] },
  ]) expect(ReviewedResearchReportRecordSchema.safeParse({ ...body, semanticReview }).success).toBe(false);
});

test('requires contiguous owned context even when read windows overlap', () => {
  const claim: Claim = { claimId: citation.claimId, researchId: identity.researchId, planId: identity.planId,
    revision: identity.revision, runId: 10, toolCallId: 12, createdAt: at, questionId: 'q', text,
    dependencies: [], verification: { status: 'supported', reasons: ['Reported revenue.'] }, evidence: [{ relation: 'supports', ref }] };
  const claims = new Map([[claim.claimId, claim]]);
  const segments = [{ ...segment, end: 7, readEnd: 9 }, { ...segment, start: 7, readStart: 5 }];
  const segmented = { ...receipt, context: { mode: 'segmented', segments },
    stages: [{ ...final, stage: 'context' }, { ...final, stage: 'context' }, final] };
  expect(researchReviewBindingsMatch(ResearchSemanticReviewSchema.parse(segmented), claims, [source])).toBe(true);
  for (const start of [6, 8]) {
    const review = ResearchSemanticReviewSchema.parse({ ...segmented,
      context: { ...segmented.context, segments: [segments[0], { ...segments[1], start }] } });
    expect(researchReviewBindingsMatch(review, claims, [source])).toBe(false);
  }
});
