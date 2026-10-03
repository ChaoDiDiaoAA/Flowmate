import { invoiceToolSchemas, MAX_INVOICE_DIFF_VALUE_CHARS } from '@flowmate/contracts';
import type { CandidateRepository, InvoiceToolOutput, InvoiceToolInput, ToolDefinition } from '@flowmate/contracts';
import { appError } from '@flowmate/contracts';
import { unwrap } from './definition.ts';
import { MAX_RESULT_BYTES } from './source.ts';

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

function flatten(value: unknown, path: string, target: Map<string, string>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${path}/${index}`, target));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value).sort(([left], [right]) => compareCodePoints(left, right))) {
      flatten(item, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, target);
    }
  } else target.set(path || '/', JSON.stringify(value) ?? 'null');
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
    if (leftValue !== undefined && leftValue.length > MAX_INVOICE_DIFF_VALUE_CHARS
      || rightValue !== undefined && rightValue.length > MAX_INVOICE_DIFF_VALUE_CHARS) {
      throw new RangeError('candidate_diff_value_too_large');
    }
    differences.push({ path, kind: leftValue === undefined ? 'added' : rightValue === undefined ? 'removed' : 'changed',
      left: leftValue ?? null, right: rightValue ?? null });
  }
  return differences;
}

export const compareInvoiceCandidates = (candidates: CandidateRepository) => ({
  name: 'compare_invoice_candidates',
  version: '1',
  label: 'Compare candidates',
  description: 'Compare two saved candidates in the current task using paginated JSON Pointer differences.',
  inputSchema: invoiceToolSchemas.compare_invoice_candidates.input,
  outputSchema: invoiceToolSchemas.compare_invoice_candidates.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, _call, context) => {
    const left = unwrap(candidates.readForRun({ runId: context.runId, candidateId: input.leftCandidateId }));
    const right = input.rightCandidateId === input.leftCandidateId ? left
      : unwrap(candidates.readForRun({ runId: context.runId, candidateId: input.rightCandidateId }));
    let differences: InvoiceToolOutput<'compare_invoice_candidates'>['differences'];
    try { differences = input.leftCandidateId === input.rightCandidateId ? [] : compareDrafts(left.candidate, right.candidate); }
    catch { throw appError('tool_result_too_large', 'runtime', 'A candidate difference exceeds the result limit.'); }
    const cursorIndex = input.afterPath === null ? -1 : differences.findIndex((item) => item.path === input.afterPath);
    if (input.afterPath !== null && cursorIndex < 0) throw appError('tool_invalid_input', 'tool', 'The difference cursor does not belong to this comparison.');
    const selected: typeof differences = [];
    for (const difference of differences.slice(cursorIndex + 1, cursorIndex + 1 + input.limit)) {
      const complete = cursorIndex + 2 + selected.length >= differences.length;
      const response = { jobId: left.jobId, leftCandidateId: input.leftCandidateId, rightCandidateId: input.rightCandidateId,
        differences: [...selected, difference], nextAfterPath: complete ? null : difference.path, complete };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESULT_BYTES) {
        if (selected.length === 0) throw appError('tool_result_too_large', 'runtime', 'Candidate differences exceed the result size limit.');
        break;
      }
      selected.push(difference);
    }
    const complete = cursorIndex + 1 + selected.length >= differences.length;
    return { jobId: left.jobId, leftCandidateId: input.leftCandidateId, rightCandidateId: input.rightCandidateId,
      differences: selected, nextAfterPath: complete ? null : selected.at(-1)?.path ?? input.afterPath, complete };
  },
} satisfies ToolDefinition<InvoiceToolInput<'compare_invoice_candidates'>, InvoiceToolOutput<'compare_invoice_candidates'>>);
