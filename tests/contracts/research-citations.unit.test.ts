import { expect, test } from 'bun:test';
import { CitedResearchReportBodySchema, projectCitedResearchReport, ResearchReportDocumentSchema } from '@flowmate/contracts';

const body = { formatVersion: 2, answer: [{ text: '此项限制只适用于测试。', citations: [{ claimId: 3, evidenceIndex: 0 }] }],
  sections: [{ title: 'Scope', sentences: [{ text: 'Version 1.2 applies to tests.', citations: [{ claimId: 3, evidenceIndex: 0 }] }] }],
  completeness: 'full', conflicts: [], limitations: [], unresolvedQuestions: [],
  coverage: [{ questionId: 'q', claimIds: [3], status: 'covered', reason: 'Source located.' }] };

test('requires a citation for every body sentence, including the answer', () => {
  expect(CitedResearchReportBodySchema.safeParse(body).success).toBe(true);
  for (const text of ['第一句。第二句。', 'First sentence. Second sentence.', 'One sentence.\nAnother sentence.',
    'First sentence. second sentence.', 'The total is final. 2 cases remain.']) {
    expect(CitedResearchReportBodySchema.safeParse({ ...body, answer: [{ ...body.answer[0], text }] }).success).toBe(false);
  }
  expect(CitedResearchReportBodySchema.safeParse({ ...body, answer: [{ text: 'Missing.', citations: [] }] }).success).toBe(false);
  expect(CitedResearchReportBodySchema.safeParse({ ...body, sections: [{ title: 'Scope',
    sentences: [...body.sections[0]!.sentences, { text: 'Second sentence.', citations: [] }] }] }).success).toBe(false);
  expect(CitedResearchReportBodySchema.safeParse({ ...body, answer: [], sections: [] }).success).toBe(false);
  expect(CitedResearchReportBodySchema.safeParse({ ...body, answer: [], sections: [], completeness: 'partial',
    coverage: [{ questionId: 'q', claimIds: [], status: 'gap', reason: 'No source.' }] }).success).toBe(true);
});

test('keeps abbreviations and decimals intact, and rejects repeated evidence indices', () => {
  const item = body.answer[0]!;
  for (const text of ['Dr. Chen measured 1.2 seconds.', 'The U.S. report cites Fig. 2.', '他说：“版本 1.2 仅用于测试。”']) {
    expect(CitedResearchReportBodySchema.safeParse({ ...body, answer: [{ ...item, text }] }).success).toBe(true);
  }
  for (const citations of [[item.citations[0], item.citations[0]], [{ claimId: 3, evidenceIndex: -1 }]]) {
    expect(CitedResearchReportBodySchema.safeParse({ ...body, answer: [{ ...item, citations }] }).success).toBe(false);
  }
});

test('rejects a report document if any numbered reference is missing', () => {
  const createdAt = '2026-10-10T00:00:00.000Z';
  const report = { ...projectCitedResearchReport(CitedResearchReportBodySchema.parse(body)),
    researchId: 1, reportId: 1, planId: 1, revision: 1, runId: 2, toolCallId: 4, createdAt };
  const reference = { number: 1, claimId: 3, evidenceIndex: 0, relation: 'supports',
    locator: { start: 0, end: 4, quote: 'test' }, source: { sourceSnapshotId: 1, researchId: 1, runId: 2, toolCallId: 2,
      kind: 'local', title: 'Source', address: 'local material', artifactId: 1, documentId: null,
      publishedAt: null, fetchedAt: createdAt, relativePath: 'artifacts/research/1/source-2.txt',
      bytes: 4, characters: 4, truncated: false, createdAt } };
  const document = { researchId: 1, reportId: 1, title: 'Report', report, references: [reference] };
  expect(ResearchReportDocumentSchema.safeParse(document).success).toBe(true);
  expect(ResearchReportDocumentSchema.safeParse({ ...document, references: [] }).success).toBe(false);
});

test('rejects a section whose derived Claim list exceeds the report contract', () => {
  const sentences = [0, 64, 128].map(offset => ({ text: 'A cited finding.',
    citations: Array.from({ length: offset === 128 ? 1 : 64 }, (_, index) => ({ claimId: offset + index + 1, evidenceIndex: 0 })) }));
  expect(CitedResearchReportBodySchema.safeParse({ ...body, sections: [{ title: 'Findings', sentences }] }).success).toBe(false);
});
