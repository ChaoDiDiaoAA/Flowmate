import { appError, fail, ok } from '@flowmate/contracts';
import type {
  CandidateRepository,
  InvoiceToolInput,
  InvoiceToolOutput,
  ProductToolContext,
  Result,
  SourceRef,
  ToolCallContext,
  ToolExecutionContext,
} from '@flowmate/contracts';
import type { DocumentService, EvidenceService } from '@flowmate/data';
import { evaluateCandidate } from './validation.ts';

export class CandidateService {
  public constructor(private readonly options: {
    repository: CandidateRepository;
    documents: DocumentService;
    evidence: EvidenceService;
    now: () => string;
  }) {}

  public async validate(input: InvoiceToolInput<'validate_invoice_candidate'>, call: ToolCallContext,
    context: ProductToolContext): Promise<Result<InvoiceToolOutput<'validate_invoice_candidate'>>> {
    const loaded = this.options.documents.readParsedForRun(input.documentId, context);
    if (!loaded.ok) return loaded;
    if (call.signal.aborted) return cancelled(context, call);
    const sources = candidateSources(input.candidate);
    let sourceResults: InvoiceToolOutput<'check_invoice_sources'>['results'] = [];
    if (sources.length > 0) {
      const checked = this.options.evidence.checkSources({ documentId: input.documentId, sources }, executionContext(call, context));
      if (!checked.ok) return checked;
      sourceResults = checked.data.results;
    }
    if (call.signal.aborted) return cancelled(context, call);
    const result = evaluateCandidate(input.candidate, sourceResults);
    return ok({ documentRef: loaded.data.document.documentRef, saveable: result.violations.length === 0,
      violations: result.violations, checks: result.checks, issues: result.issues });
  }

  public async save(input: InvoiceToolInput<'save_invoice_candidate'>, call: ToolCallContext,
    context: ProductToolContext): Promise<Result<InvoiceToolOutput<'save_invoice_candidate'>>> {
    const validation = await this.validate(input, call, context);
    if (!validation.ok) return validation;
    if (call.signal.aborted) return cancelled(context, call);
    if (!validation.data.saveable) {
      const sourceFailure = validation.data.violations.some((item) => item.code.startsWith('source_')
        || item.code === 'present_source_missing');
      return fail(appError(sourceFailure ? 'source_invalid' : 'tool_invalid_input', sourceFailure ? 'input' : 'tool',
        sourceFailure ? '候选来源未通过核验，未保存候选。' : '候选结构或规范值无效，未保存候选。', false,
        context.runId, context.sessionId, call.nativeToolCallId));
    }
    const saved = this.options.repository.save({ runId: context.runId, sessionId: context.sessionId,
      nativeToolCallId: call.nativeToolCallId, documentId: input.documentId, candidate: input.candidate,
      checks: validation.data.checks, issues: validation.data.issues, at: this.options.now() });
    return saved.ok ? ok(saved.data.receipt) : saved;
  }

  public listForRun(input: InvoiceToolInput<'list_invoice_candidates'>, context: ProductToolContext): Result<InvoiceToolOutput<'list_invoice_candidates'>> {
    return this.options.repository.listForRun({ runId: context.runId, beforeSequence: input.beforeSequence, limit: input.limit });
  }

  public readForRun(input: InvoiceToolInput<'get_invoice_candidate'>, context: ProductToolContext): Result<InvoiceToolOutput<'get_invoice_candidate'>> {
    return this.options.repository.readForRun({ runId: context.runId, candidateId: input.candidateId });
  }

  public async compareForRun(input: InvoiceToolInput<'compare_invoice_candidates'>, context: ProductToolContext): Promise<Result<InvoiceToolOutput<'compare_invoice_candidates'>>> {
    const left = await this.readForRun({ candidateId: input.leftCandidateId }, context);
    if (!left.ok) return left;
    const right = input.rightCandidateId === input.leftCandidateId ? left
      : await this.readForRun({ candidateId: input.rightCandidateId }, context);
    if (!right.ok) return right;
    let differences: InvoiceToolOutput<'compare_invoice_candidates'>['differences'];
    try { differences = input.leftCandidateId === input.rightCandidateId ? [] : compareDrafts(left.data.candidate, right.data.candidate); }
    catch { return fail(appError('tool_result_too_large', 'runtime', '单个候选差异值超过结果限制。')); }
    const cursorIndex = input.afterPath === null ? -1 : differences.findIndex((item) => item.path === input.afterPath);
    if (input.afterPath !== null && cursorIndex < 0) return fail(appError('tool_invalid_input', 'tool', '差异游标不属于当前候选比较。'));
    const remaining = differences.slice(cursorIndex + 1);
    const selected: typeof differences = [];
    for (const difference of remaining.slice(0, input.limit)) {
      const trial = [...selected, difference];
      const response = { jobId: left.data.jobId, leftCandidateId: input.leftCandidateId, rightCandidateId: input.rightCandidateId,
        differences: trial, nextAfterPath: null, complete: false };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 128 * 1024) {
        if (selected.length === 0) return fail(appError('tool_result_too_large', 'runtime', '候选差异超过结果大小限制。'));
        break;
      }
      selected.push(difference);
    }
    const complete = cursorIndex + 1 + selected.length >= differences.length;
    return ok({ jobId: left.data.jobId, leftCandidateId: input.leftCandidateId, rightCandidateId: input.rightCandidateId,
      differences: selected, nextAfterPath: complete ? null : selected.at(-1)?.path ?? input.afterPath, complete });
  }
}

function candidateSources(candidate: InvoiceToolInput<'validate_invoice_candidate'>['candidate']): SourceRef[] {
  return [...Object.values(candidate.fields), ...candidate.lines.flatMap((line) => Object.values(line))]
    .flatMap((field) => field.sources);
}

function executionContext(call: ToolCallContext, context: ProductToolContext): ToolExecutionContext {
  return { ...context, ...call };
}

function cancelled(context: ProductToolContext, call: ToolCallContext): Result<never> {
  return fail(appError('agent_cancelled', 'runtime', 'Run 已取消，未保存候选。', false,
    context.runId, context.sessionId, call.nativeToolCallId));
}

function compareDrafts(left: unknown, right: unknown): InvoiceToolOutput<'compare_invoice_candidates'>['differences'] {
  const leftLeaves = new Map<string, string>();
  const rightLeaves = new Map<string, string>();
  flatten(left, '', leftLeaves);
  flatten(right, '', rightLeaves);
  const paths = [...new Set([...leftLeaves.keys(), ...rightLeaves.keys()])].sort(compareCodePoints);
  const differences: InvoiceToolOutput<'compare_invoice_candidates'>['differences'] = [];
  for (const path of paths) {
    const leftValue = leftLeaves.get(path);
    const rightValue = rightLeaves.get(path);
    if (leftValue === rightValue) continue;
    if (leftValue !== undefined && leftValue.length > 1024 || rightValue !== undefined && rightValue.length > 1024) {
      throw new RangeError('candidate_diff_value_too_large');
    }
    differences.push({ path, kind: leftValue === undefined ? 'added' : rightValue === undefined ? 'removed' : 'changed',
      left: leftValue ?? null, right: rightValue ?? null });
  }
  return differences;
}

function flatten(value: unknown, path: string, target: Map<string, string>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${path}/${index}`, target));
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => compareCodePoints(left, right));
    for (const [key, item] of entries) flatten(item, `${path}/${escapePointer(key)}`, target);
    return;
  }
  target.set(path || '/', JSON.stringify(value) ?? 'null');
}

function escapePointer(value: string): string { return value.replaceAll('~', '~0').replaceAll('/', '~1'); }

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}
