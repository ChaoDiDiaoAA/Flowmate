import { expect, test } from 'bun:test';
import { appError, fail, ok, type Claim, type ReviewedResearchReportBody, type SourceSnapshot } from '@flowmate/contracts';
import {
  evaluateResearchReviewSamples, runProductResearchReview,
  type ResearchReviewOutcome, type ResearchReviewSample,
} from '../../src/scoring/research-review-evaluation.ts';
import fixture from '../fixtures/research-semantic-review.json';

const report: ReviewedResearchReportBody = {
  formatVersion: 3, answer: [{ text: 'Revenue rose.', citations: [{ claimId: 1, evidenceIndex: 0 }] }], sections: [],
  completeness: 'partial', conflicts: [], limitations: [], unresolvedQuestions: [],
  coverage: [{ questionId: 'q', claimIds: [1], status: 'covered', reason: 'The report addresses the question.' }],
};
const input = {
  researchId: 1, planId: 1, revision: 1, runId: 2, toolCallId: 3, reviewedAt: '2026-11-19T00:00:00.000Z', report,
  sources: [], sourceBodies: new Map<number, string>(),
};
const claims: ResearchReviewSample['claims'] = new Map();
const negative = { status: 'verified', reviewedBy: 'test annotator', expected: 'reject' } as const;
const unsupported = { ...negative, unsupportedConclusion: true } as const;
const positive = { status: 'verified', reviewedBy: 'test annotator', expected: 'accept' } as const;

test('measures omitted human context witnesses separately from the final accept decision', async () => {
  const row = fixture.samples.find(item => item.id === 'late-correction')!;
  const target = fixtureSample(row);
  const start = row.source.indexOf('校准说明');
  const witness = { sourceSnapshotId: 1, sentenceIndex: 0, locator: { start, end: row.source.length, quote: row.source.slice(start) } };
  const annotated: ResearchReviewSample = { ...target, label: { ...unsupported, contextWitnesses: [witness] } };
  const receipt = await runProductResearchReview(target.input, target.claims, async request => {
    const data = JSON.parse(request.text);
    const sentence = data.report.answer[0];
    return ok({ model: { provider: 'test', model: 'test' }, responseId: null,
      usage: { version: 1, source: 'unknown', reason: null, sdkValues: null, attempts: 1, attemptsComplete: true, costSource: null, updatedAt: input.reviewedAt },
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      text: JSON.stringify({ sentences: [{ sentenceIndex: 0, complete: true,
        facts: [{ start: 0, end: sentence.text.length, text: sentence.text, citations: sentence.citations, verdict: 'supported', reason: 'Controlled wrong verdict.' }],
        citationReviews: sentence.citations.map((ref: { claimId: number; evidenceIndex: number }) => ({ ...ref, verdict: 'contributes', reason: 'Controlled verdict.',
          contributions: [{ factIndex: 0, role: 'direct_support', reason: 'Controlled contribution.' }] })),
      }] }),
    });
  });
  const measured = await evaluateResearchReviewSamples([annotated], async () => receipt);
  expect(measured.validation.contextFindingOmissions).toEqual({ count: 1, denominator: 1, rate: 1 });
  expect(measured.validation.unsupportedConclusionFalseAccepts.count).toBe(1);
  if (!('review' in receipt) || !receipt.review?.context) throw new Error('Expected a completed product review.');
  receipt.review.context.segments[0]!.findings.push({ sentenceIndex: 0, kind: 'correction', locator: witness.locator });
  const detected = await evaluateResearchReviewSamples([annotated], async () => receipt);
  expect(detected.validation.contextFindingOmissions).toEqual({ count: 0, denominator: 1, rate: 0 });
  expect(detected.validation.unsupportedConclusionFalseAccepts.count).toBe(1);
});

function sample(id: string, label: ResearchReviewSample['label'], partition: ResearchReviewSample['partition'] = 'validation'): ResearchReviewSample {
  return { id, partition, sourceGroup: id, input: { ...input, question: id }, claims, label };
}

test('scores only completed human-verified decisions, separately for each partition', async () => {
  const irrelevant = { ...negative, irrelevantCitations: [{ sentenceIndex: 0, claimId: 1, evidenceIndex: 0 }] };
  const cases: [ResearchReviewSample, ResearchReviewOutcome][] = [
    [sample('irrelevant', irrelevant), { kind: 'accepted' }],
    [sample('detected', irrelevant), { kind: 'rejected' }],
    [sample('unsupported', unsupported), { kind: 'rejected' }],
    [sample('missed-correction', { ...unsupported, requiresFullContext: true }), { kind: 'accepted' }],
    [sample('caught-correction', { ...unsupported, requiresFullContext: true }), { kind: 'rejected' }],
    [sample('missed-definition', { ...positive, requiresFullContext: true }), { kind: 'rejected' }],
    [sample('good', positive), { kind: 'accepted' }],
    [sample('pending', { status: 'pending' }), { kind: 'accepted' }],
    [sample('invalid', unsupported), { kind: 'technical_error', code: 'research_semantic_review_invalid' }],
    [sample('timeout', unsupported), { kind: 'timeout', code: 'tool_timeout' }],
    [sample('capacity', unsupported), { kind: 'capacity', code: 'research_semantic_review_too_large' }],
    [sample('empty', positive), { kind: 'no_findings' }],
    [sample('tune', unsupported, 'tune'), { kind: 'accepted' }],
  ];
  const run = async (...args: [ResearchReviewSample['input'], ResearchReviewSample['claims']]) => {
    const [reviewInput, reviewClaims] = args;
    expect(args).toHaveLength(2);
    expect(reviewInput).not.toHaveProperty('label');
    expect(reviewClaims).toBe(claims);
    return cases.find(([row]) => row.id === reviewInput.question)![1];
  };
  const modelConfig = { provider: 'test', model: 'test-model', maxTokens: 1000, apiKey: 'must-not-be-reported' };
  const result = await evaluateResearchReviewSamples(cases.map(([row]) => row), run, { modelConfig });
  expect(result.policyVersion).toBe('research-semantic-v2');
  expect(result.modelConfig).toEqual({ provider: 'test', model: 'test-model', maxTokens: 1000 });
  expect(result.validation).toMatchObject({
    total: 12, completed: 8,
    pending: 1, technicalErrors: 1, timeouts: 1, capacityFailures: 1, noFindings: 1,
    gateFalseAccepts: { count: 2, denominator: 5, rate: 0.4 },
    unsupportedConclusionFalseAccepts: { count: 1, denominator: 3, rate: 1 / 3 },
    irrelevantCitationReportFalseAccepts: { count: 1, denominator: 2, rate: 0.5 },
    irrelevantCitationFalseAccepts: { count: 0, denominator: 0, rate: null },
    falseRejects: { count: 1, denominator: 2, rate: 0.5 },
    contextNegativeFalseAccepts: { count: 1, denominator: 2, rate: 0.5 },
  });
  expect(result.tune).toMatchObject({ total: 1, completed: 1 });
  expect(result.tune.unsupportedConclusionFalseAccepts).toEqual({ count: 1, denominator: 1, rate: 1 });
  expect(result.tune.falseRejects).toEqual({ count: 0, denominator: 0, rate: null });
});

test('rejects source-group overlap before the first reviewer call, even for pending samples', async () => {
  const tune = sample('same-source', { status: 'pending' }, 'tune');
  const validation = { ...tune, id: 'source-rewrite', partition: 'validation' as const };
  let calls = 0;
  await expect(evaluateResearchReviewSamples([tune, validation], async () => {
    calls++;
    return { kind: 'accepted' };
  })).rejects.toThrow(/source group.*tune.*validation/i);
  expect(calls).toBe(0);
});

test('the product adapter invokes the real reviewer and separates an invalid claim from an empty report', async () => {
  const verify = async () => { throw new Error('These reports must not invoke the model'); };
  expect(await runProductResearchReview(input, claims, verify)).toMatchObject({ kind: 'technical_error' });
  const empty = { ...input, report: { ...report, answer: [],
    coverage: [{ questionId: 'q', claimIds: [], status: 'gap' as const, reason: 'No evidence was found.' }] } };
  expect(await runProductResearchReview(empty, claims, async () => fail(appError('tool_timeout', 'tool', 'Unexpected call'))))
    .toMatchObject({ kind: 'no_findings' });
});

function fixtureSample(row: typeof fixture.samples[number]): ResearchReviewSample {
  if (row.partition !== 'tune' && row.partition !== 'validation') throw new Error('Invalid fixture partition');
  const source: SourceSnapshot = { sourceSnapshotId: 1, researchId: input.researchId, runId: 1, toolCallId: 1,
    createdAt: input.reviewedAt, fetchedAt: input.reviewedAt, publishedAt: null, kind: 'local', address: 'fixture',
    title: 'Sample source', artifactId: 1, documentId: null, relativePath: 'artifacts/research/1/source-1.txt',
    bytes: Buffer.byteLength(row.source), characters: row.source.length, truncated: false };
  const evidence: Claim['evidence'] = (row.selectedQuotes ?? [row.source]).map(quote => {
    const start = row.source.indexOf(quote);
    if (start < 0) throw new Error(`Missing selected quote in fixture ${row.id}`);
    return { relation: 'supports', ref: { researchId: source.researchId, runId: source.runId, toolCallId: source.toolCallId,
      sourceSnapshotId: source.sourceSnapshotId, planId: input.planId, revision: input.revision,
      locator: { start, end: start + quote.length, quote } } };
  });
  const claim: Claim = { claimId: 1, researchId: input.researchId, planId: input.planId, revision: input.revision, runId: 1,
    toolCallId: 2, createdAt: input.reviewedAt, questionId: 'q', text: row.sentence, dependencies: [],
    verification: { status: 'unverified', reasons: ['Fixture'] }, evidence };
  const answer = [{ text: row.sentence, citations: evidence.map((_, evidenceIndex) => ({ claimId: 1, evidenceIndex })) }];
  return { id: row.id, partition: row.partition, sourceGroup: row.sourceGroup, label: { status: 'pending' },
    claims: new Map([[claim.claimId, claim]]), input: { ...input, report: { ...report, answer }, sources: [source],
      sourceBodies: new Map([[source.sourceSnapshotId, row.source]]) } };
}

test('pending fixtures send exact saved source text and omit proposed answers from the product request', async () => {
  const samples = fixture.samples.map(fixtureSample);
  const requests: unknown[] = [];
  const result = await evaluateResearchReviewSamples(samples, (reviewInput, reviewClaims) =>
    runProductResearchReview(reviewInput, reviewClaims, async ({ text }) => {
      requests.push(JSON.parse(text));
      return fail(appError('provider_timeout', 'provider', 'Fake timeout'));
    }));
  expect(fixture.status).toBe('pending');
  expect(result.tune).toMatchObject({ pending: 8, timeouts: 8, gateFalseAccepts: { denominator: 0 } });
  expect(result.validation).toMatchObject({ pending: 8, timeouts: 8, falseRejects: { denominator: 0 } });
  expect(requests).toHaveLength(fixture.samples.length);
  for (const [index, row] of fixture.samples.entries()) {
    const request = requests[index];
    expect(request).toHaveProperty('sourceContexts', [{ sourceSnapshotId: 1, text: row.source }]);
    for (const key of ['label', 'sourceGroup', 'partition', 'proposedVerdict', 'proposedFacts', 'proposedCitationVerdicts'])
      expect(request).not.toHaveProperty(key);
  }
});

test('uses actual v2 citation decisions to score each labeled reference independently of report status', async () => {
  const row = fixture.samples.find(item => item.id === 'irrelevant-extra-citation')!;
  const extraQuote = '展厅每周一清洁。';
  const target = fixtureSample({ ...row, source: row.source + extraQuote, selectedQuotes: [...row.selectedQuotes!, extraQuote] });
  const first = { claimId: 1, evidenceIndex: 0 };
  const second = { claimId: 1, evidenceIndex: 1 };
  const third = { claimId: 1, evidenceIndex: 2 };
  const annotated: ResearchReviewSample = { ...target,
    label: { ...negative, irrelevantCitations: [{ sentenceIndex: 0, ...second }, { sentenceIndex: 0, ...third }] } };
  for (const scenario of ['irrelevant', 'contradicted', 'mixed', 'contributes', 'malformed'] as const) {
    const accepted = scenario === 'contributes';
    const secondVerdict = scenario === 'mixed' ? 'contributes' : scenario;
    const thirdVerdict = accepted ? 'contributes' : 'irrelevant';
    const factCitations = accepted ? [first, second, third] : scenario === 'mixed' ? [first, second] : [first];
    const contribution = { factIndex: 0, role: 'direct_support', reason: 'States the count.' };
    const result = await evaluateResearchReviewSamples([annotated], (reviewInput, reviewClaims) =>
      runProductResearchReview(reviewInput, reviewClaims, async () => ok({
        model: { provider: 'fixture', model: 'fixture' }, responseId: 'fixture-response',
        usage: { version: 1, source: 'unknown', reason: null, sdkValues: null, attempts: 1, attemptsComplete: true,
          costSource: null, updatedAt: input.reviewedAt },
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        text: scenario === 'malformed' ? '{' : JSON.stringify({ sentences: [{ sentenceIndex: 0, complete: true,
          facts: [{ start: 0, end: row.sentence.length, text: row.sentence, citations: factCitations,
            verdict: 'supported', reason: 'Works count.' }],
          citationReviews: [{ ...first, verdict: 'contributes', reason: 'States the count.', contributions: [contribution] },
            { ...second, verdict: secondVerdict, reason: 'Second quote verdict.',
              contributions: secondVerdict === 'contributes' ? [contribution] : [] },
            { ...third, verdict: thirdVerdict, reason: 'Third quote verdict.', contributions: accepted ? [contribution] : [] }],
        }] }),
      })));
    if (scenario === 'malformed') {
      expect(result.outcomes[0]?.outcome).toEqual({ kind: 'technical_error', code: 'research_semantic_review_invalid' });
      expect(result.validation.gateFalseAccepts.denominator).toBe(0);
      expect(result.validation.irrelevantCitationFalseAccepts.denominator).toBe(0);
      continue;
    }
    expect(result.outcomes[0]?.outcome).toMatchObject({
      kind: accepted ? 'accepted' : 'rejected', review: { policyVersion: 'research-semantic-v2' },
    });
    expect(result.validation.gateFalseAccepts).toEqual({ count: Number(accepted), denominator: 1, rate: Number(accepted) });
    expect(result.validation.unsupportedConclusionFalseAccepts).toEqual({ count: 0, denominator: 0, rate: null });
    expect(result.validation.irrelevantCitationReportFalseAccepts).toEqual({ count: Number(accepted), denominator: 1, rate: Number(accepted) });
    const falseAccepts = accepted ? 2 : scenario === 'mixed' ? 1 : 0;
    const detected = scenario === 'irrelevant' ? 2 : accepted ? 0 : 1;
    expect(result.validation.irrelevantCitationFalseAccepts).toEqual({ count: falseAccepts, denominator: 2, rate: falseAccepts / 2 });
    expect(result.validation.irrelevantCitationsDetected).toEqual({ count: detected, denominator: 2, rate: detected / 2 });
  }
});
