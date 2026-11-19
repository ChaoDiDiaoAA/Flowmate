import {
  RESEARCH_SEMANTIC_POLICY_VERSION, ResearchSemanticReviewSchema, researchCitationKey, researchSentences,
  ToolExecutionFailure, type ModelRef, type ProviderConfig, type ResearchSemanticReview, type ResearchSentence,
} from '@flowmate/contracts';
import { reviewResearchReport } from '../../../packages/core/src/research/semantic-review.ts';

type ReviewInput = Parameters<typeof reviewResearchReport>[0];
type Claims = Parameters<typeof reviewResearchReport>[1];
type Verify = Parameters<typeof reviewResearchReport>[2];
type Partition = 'tune' | 'validation';
type CitationAt = ResearchSentence['citations'][number] & { sentenceIndex: number };
type ContextWitness = { sourceSnapshotId: number; sentenceIndex: number; locator: { start: number; end: number; quote: string } };
type ModelConfig = ModelRef & Pick<NonNullable<ProviderConfig['connection']>, 'contextWindow' | 'maxTokens' | 'reasoning'>
  & { api?: string; timeoutMs?: number };
type HumanLabel = { status: 'pending' } | ({ status: 'verified'; reviewedBy: string; requiresFullContext?: true; contextWitnesses?: readonly ContextWitness[] } & (
  { expected: 'accept'; irrelevantCitations?: never; unsupportedConclusion?: never }
  | { expected: 'reject'; irrelevantCitations?: readonly CitationAt[]; unsupportedConclusion?: true }
));

export type ResearchReviewSample = {
  id: string;
  partition: Partition;
  sourceGroup: string;
  input: ReviewInput;
  claims: Claims;
  label: HumanLabel;
};

export type ResearchReviewOutcome =
  | { kind: 'accepted' | 'rejected' | 'no_findings'; review?: ResearchSemanticReview }
  | { kind: 'technical_error' | 'timeout' | 'capacity'; code: string };

function failureOutcome(error: unknown): ResearchReviewOutcome {
  const code = error instanceof ToolExecutionFailure ? error.error.code : 'research_review_runner_failed';
  if (code === 'tool_timeout' || code === 'provider_timeout' || code === 'agent_timeout') return { kind: 'timeout', code };
  if (code === 'research_semantic_review_too_large' || code === 'agent_context_limit' || code === 'agent_model_call_budget')
    return { kind: 'capacity', code };
  return { kind: 'technical_error', code };
}

export async function runProductResearchReview(input: ReviewInput, claims: Claims, verify: Verify): Promise<ResearchReviewOutcome> {
  try {
    const review = await reviewResearchReport(input, claims, verify);
    return { kind: review.status === 'verified' ? 'accepted' : review.status, review };
  } catch (error) {
    if (error instanceof ToolExecutionFailure && error.error.code === 'research_semantic_rejected') {
      const receipt = ResearchSemanticReviewSchema.safeParse((error.data as { semanticReview?: unknown } | undefined)?.semanticReview);
      if (receipt.success && receipt.data.status === 'rejected' && receipt.data.policyVersion === RESEARCH_SEMANTIC_POLICY_VERSION)
        return { kind: 'rejected', review: receipt.data };
    }
    return failureOutcome(error);
  }
}

function rate() { return { count: 0, denominator: 0, rate: null as number | null }; }

function tally(metric: ReturnType<typeof rate>, missed: boolean) {
  metric.denominator++;
  if (missed) metric.count++;
  metric.rate = metric.count / metric.denominator;
}

function summary() {
  return { total: 0, completed: 0, pending: 0, technicalErrors: 0, timeouts: 0, capacityFailures: 0, noFindings: 0,
    gateFalseAccepts: rate(), unsupportedConclusionFalseAccepts: rate(), falseRejects: rate(), contextNegativeFalseAccepts: rate(), contextFindingOmissions: rate(),
    irrelevantCitationReportFalseAccepts: rate(), irrelevantCitationFalseAccepts: rate(), irrelevantCitationsDetected: rate() };
}

/** Pending samples can exercise the reviewer; only completed decisions on human labels measure quality. */
export async function evaluateResearchReviewSamples(samples: readonly ResearchReviewSample[],
  run: (input: ReviewInput, claims: Claims) => Promise<ResearchReviewOutcome>, metadata?: { modelConfig?: ModelConfig }) {
  const ids = new Set<string>();
  const groups = new Map<string, Partition>();
  for (const { id, partition, sourceGroup, label, input } of samples) {
    if (!id.trim() || ids.has(id)) throw new Error(`Missing or duplicate research review sample ID: ${id}`);
    ids.add(id);
    if (!sourceGroup.trim() || (partition !== 'tune' && partition !== 'validation'))
      throw new Error(`Research review sample ${id} requires a source group and partition`);
    const group = sourceGroup.trim();
    const previous = groups.get(group);
    if (previous && previous !== partition) throw new Error(`Source group ${group} crosses tune and validation`);
    groups.set(group, partition);
    if (label.status === 'verified') for (const witness of label.contextWitnesses ?? []) {
      const { start, end, quote } = witness.locator;
      if (!researchSentences(input.report)[witness.sentenceIndex] || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end <= start || !quote.trim() || input.sourceBodies?.get(witness.sourceSnapshotId)?.slice(start, end) !== quote)
        throw new Error(`Invalid human context witness for research review sample ${id}`);
    }
    if (label.status !== 'pending' && (label.status !== 'verified' || !label.reviewedBy?.trim()
      || (label.expected !== 'accept' && label.expected !== 'reject')
      || (label.expected === 'accept' && (label.irrelevantCitations !== undefined || label.unsupportedConclusion !== undefined))))
      throw new Error(`Invalid human label for research review sample ${id}`);
    if (label.status === 'verified' && label.irrelevantCitations?.length) {
      const sentences = researchSentences(input.report);
      const labeled = new Set<string>();
      for (const citation of label.irrelevantCitations) {
        const key = researchCitationKey(citation);
        const location = `${citation.sentenceIndex}:${key}`;
        if (labeled.has(location) || !sentences[citation.sentenceIndex]?.citations.some(ref => researchCitationKey(ref) === key))
          throw new Error(`Invalid or repeated irrelevant citation in research review sample ${id}: ${location}`);
        labeled.add(location);
      }
    }
  }

  const summaries = { tune: summary(), validation: summary() };
  const outcomes: { id: string; partition: Partition; outcome: ResearchReviewOutcome }[] = [];
  for (const { id, partition, input, claims, label } of samples) {
    const row = summaries[partition];
    row.total++;
    let outcome: ResearchReviewOutcome;
    try { outcome = await run(input, claims); }
    catch (error) { outcome = failureOutcome(error); }
    outcomes.push({ id, partition, outcome });
    if (label.status === 'pending') row.pending++;
    if (outcome.kind === 'technical_error') row.technicalErrors++;
    if (outcome.kind === 'timeout') row.timeouts++;
    if (outcome.kind === 'capacity') row.capacityFailures++;
    if (outcome.kind === 'no_findings') row.noFindings++;
    if (outcome.kind !== 'accepted' && outcome.kind !== 'rejected') continue;
    row.completed++;
    if (label.status !== 'verified') continue;
    if (outcome.review) for (const witness of label.contextWitnesses ?? []) {
      const found = outcome.review.context?.segments.some(segment => segment.sourceSnapshotId === witness.sourceSnapshotId
        && segment.findings.some(finding => finding.sentenceIndex === witness.sentenceIndex
          && finding.locator.start <= witness.locator.start && finding.locator.end >= witness.locator.end));
      tally(row.contextFindingOmissions, !found);
    }
    const accepted = outcome.kind === 'accepted';
    if (label.expected === 'reject') {
      tally(row.gateFalseAccepts, accepted);
      if (label.unsupportedConclusion === true) tally(row.unsupportedConclusionFalseAccepts, accepted);
      if (label.requiresFullContext) tally(row.contextNegativeFalseAccepts, accepted);
      if (label.irrelevantCitations?.length) {
        tally(row.irrelevantCitationReportFalseAccepts, accepted);
        for (const citation of label.irrelevantCitations) {
          const sentence = outcome.review?.sentences[citation.sentenceIndex];
          const decision = sentence?.citationReviews?.find(ref => researchCitationKey(ref) === researchCitationKey(citation));
          if (!decision) continue;
          tally(row.irrelevantCitationFalseAccepts, decision.verdict === 'contributes');
          tally(row.irrelevantCitationsDetected, decision.verdict === 'irrelevant');
        }
      }
    } else tally(row.falseRejects, !accepted);
  }
  const config = metadata?.modelConfig;
  const modelConfig: ModelConfig | null = config ? { provider: config.provider, model: config.model, api: config.api,
    contextWindow: config.contextWindow, maxTokens: config.maxTokens, reasoning: config.reasoning, timeoutMs: config.timeoutMs } : null;
  return { policyVersion: RESEARCH_SEMANTIC_POLICY_VERSION, modelConfig, ...summaries, outcomes };
}
