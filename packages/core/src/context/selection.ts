import { appError, fail, ok, ContextProjectionSchema, SourceRefSchema, WorkspaceContextSchema,
  invoiceHeaderFields, invoiceLineFields, MAX_INVOICE_LINES } from '@flowmate/contracts';
import type { AppError, CandidateSnapshot, ContextCandidateValue, ContextFragment, ContextGap, ContextParsedMaterial,
  ContextProjection, GoalMode, ParsedBlock, Result, SourceRef, WorkspaceContext } from '@flowmate/contracts';
import { CONTEXT_POLICY, contextJsonBytes, contextTextBytes } from './policy.ts';

export type ContextSelectionInput = { taskGoal: string; goalMode: GoalMode; workspaceContext: WorkspaceContext | null;
  candidate: CandidateSnapshot | null; material: ContextParsedMaterial | null };
type BlockPlan = { page: number; block: ParsedBlock; reasons: ContextFragment['reasons'][number][]; sources: SourceRef[] };
type Window = ContextFragment['windows'][number];
class SelectionFault extends Error {
  constructor(readonly code: string, readonly category: AppError['category'] = 'input') { super(code); }
}
function invalid(code = 'source_invalid'): never { throw new SelectionFault(code); }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const blockKey = (plan: BlockPlan) => `${plan.page}:${plan.block.id}`;
const fits = (projection: ContextProjection) => contextJsonBytes(projection) <= CONTEXT_POLICY.budgets.projectionBytes;
function pathOrder(path: string): number {
  const header = /^fields\.([A-Za-z]+)$/.exec(path);
  if (header) return invoiceHeaderFields.findIndex(name => name === header[1]);
  const line = /^lines\.(\d+)\.([A-Za-z]+)$/.exec(path);
  return line ? invoiceHeaderFields.length + Number(line[1]) * invoiceLineFields.length + invoiceLineFields.findIndex(name => name === line[2]) : -1;
}
function issuePath(path: string): string | null {
  if (!path.startsWith('/')) return path;
  const header = /^\/fields\/([A-Za-z]+)$/.exec(path);
  if (header && invoiceHeaderFields.some(name => name === header[1])) return `fields.${header[1]}`;
  const line = /^\/lines\/(0|[1-9]\d*)\/([A-Za-z]+)$/.exec(path);
  return line && Number(line[1]) < MAX_INVOICE_LINES && invoiceLineFields.some(name => name === line[2]) ? `lines.${line[1]}.${line[2]}` : null;
}
function mergeGaps(gaps: readonly ContextGap[]): ContextGap[] {
  const merged: ContextGap[] = [];
  for (const gap of gaps) {
    const index = merged.findIndex(saved => saved.code === gap.code && same(saved.source, gap.source));
    const before = merged[index];
    if (!before) merged.push(gap);
    else merged[index] = { ...before, omittedCount: before.omittedCount + gap.omittedCount,
      fieldPaths: [...new Set([...before.fieldPaths, ...gap.fieldPaths])].sort((a, b) => pathOrder(a) - pathOrder(b)) };
  }
  return merged;
}
function boundary(text: string, offset: number): boolean {
  return offset <= 0 || offset >= text.length || !(text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff);
}
function extend(text: string, offset: number, direction: -1 | 1, count: number): number {
  let position = offset;
  for (let i = 0; i < count && (direction < 0 ? position > 0 : position < text.length); i++) {
    position += direction;
    if (!boundary(text, position)) position += direction;
  }
  return position;
}
function joinedWindows(text: string, windows: readonly Window[]): Window[] {
  const result: Window[] = [];
  for (const window of [...windows].sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && window.start <= last.end) result[result.length - 1] = { start: last.start, end: Math.max(last.end, window.end), text: text.slice(last.start, Math.max(last.end, window.end)) };
    else result.push(window);
  }
  return result;
}
function windowsFor(plan: BlockPlan): { windows: Window[]; omitted: SourceRef[] } {
  const text = plan.block.text;
  if (!plan.sources.length) {
    let end = 0, total = 0;
    for (const character of text) {
      const next = contextTextBytes(character);
      if (total + next > CONTEXT_POLICY.budgets.fragmentBytes) break;
      end += character.length; total += next;
    }
    return { windows: end ? [{ start: 0, end, text: text.slice(0, end) }] : [], omitted: [] };
  }
  let windows: Window[] = [];
  const omitted: SourceRef[] = [];
  for (const source of plan.sources) {
    const found = text.indexOf(source.quote!);
    let start = found, end = found + source.quote!.length;
    if (!boundary(text, start)) start--;
    if (!boundary(text, end)) end++;
    const merge = (left: number, right: number) => joinedWindows(text, [...windows, { start: left, end: right, text: text.slice(left, right) }]);
    const within = (value: readonly Window[]) => value.reduce((sum, window) => sum + contextTextBytes(window.text), 0) <= CONTEXT_POLICY.budgets.fragmentBytes;
    if (!within(merge(start, end))) { omitted.push(source); continue; }
    for (const direction of [-1, 1] as const) {
      for (let point = 0; point < CONTEXT_POLICY.quoteMarginCodePoints; point++) {
        const next = extend(text, direction < 0 ? start : end, direction, 1);
        if (next === (direction < 0 ? start : end)) break;
        if (!within(merge(direction < 0 ? next : start, direction > 0 ? next : end))) break;
        if (direction < 0) start = next; else end = next;
      }
    }
    windows = merge(start, end);
  }
  return { windows, omitted };
}

/** Pure deterministic selection; material and candidate facts are supplied by the trusted build boundary. */
export function selectContextProjection(input: ContextSelectionInput): Result<ContextProjection> {
  try {
    const { candidate, material } = input;
    const workspace = input.workspaceContext === null ? null : WorkspaceContextSchema.parse(input.workspaceContext);
    const selection = workspace?.selection ?? null;
    if (selection && (selection.target === 'candidate' ? !candidate || selection.targetId !== candidate.candidateId || selection.targetVersion !== candidate.sequence
      : !material || selection.targetId !== material.document.documentRef.id || selection.targetVersion !== material.document.documentRef.version)) invalid('selection_invalid');
    if (selection?.kind === 'field' && selection.target === 'document') invalid('selection_invalid');
    if (material && (new Set(material.parsed.pages.map(page => page.page)).size !== material.parsed.pages.length
      || material.parsed.pages.some(page => new Set(page.blocks.map(block => block.id)).size !== page.blocks.length))) invalid();
    if (input.goalMode === 'fill-form' && !candidate) invalid('selection_invalid');
    const identity = candidate ? { id: candidate.candidateId, sequence: candidate.sequence, origin: candidate.origin ?? 'model', statusAtSelection: candidate.status } : null;
    if (input.goalMode === 'fill-form') return finish({ taskGoal: input.taskGoal, candidate: identity ? { ...identity, values: [] } : null, fragments: [], issues: [], gaps: [] });

    const required: ContextCandidateValue[] = [];
    if (candidate && selection?.target === 'candidate') {
      if (selection.kind === 'line') {
        const line = candidate.lines[selection.lineIndex]; if (!line) invalid('selection_invalid');
        for (const name of invoiceLineFields) required.push({ fieldPath: `lines.${selection.lineIndex}.${name}`, value: line[name] });
      } else if (selection.kind === 'field') {
        const header = /^fields\.([A-Za-z]+)$/.exec(selection.fieldPath);
        const name = invoiceHeaderFields.find(name => name === header?.[1]);
        if (name) required.push({ fieldPath: selection.fieldPath, value: candidate.fields[name] });
        else {
          const line = /^lines\.(\d+)\.([A-Za-z]+)$/.exec(selection.fieldPath);
          const field = invoiceLineFields.find(name => name === line?.[2]);
          const value = line && field ? candidate.lines[Number(line[1])]?.[field] : undefined;
          if (!value) invalid('selection_invalid');
          required.push({ fieldPath: selection.fieldPath, value });
        }
      }
    }
    const optional = candidate ? invoiceHeaderFields.filter(name => !required.some(item => item.fieldPath === `fields.${name}`))
      .map(name => ({ fieldPath: `fields.${name}`, value: candidate.fields[name] })) : [];
    let values = [...required];
    const skeleton = (chosen: readonly ContextCandidateValue[], gaps: readonly ContextGap[] = []): ContextProjection => ({ taskGoal: input.taskGoal,
      candidate: identity ? { ...identity, values: chosen } : null, fragments: [], issues: [], gaps });
    if (!fits(skeleton(values))) invalid('input_too_large');
    const fieldGaps = (chosen: readonly ContextCandidateValue[]): ContextGap[] => {
      const omitted = optional.filter(item => !chosen.some(value => value.fieldPath === item.fieldPath));
      return omitted.length ? [{ code: 'candidate_fields_omitted', fieldPaths: omitted.map(item => item.fieldPath), source: null, omittedCount: omitted.length }] : [];
    };
    for (const field of optional) {
      if (fits(skeleton([...values, field], fieldGaps([...values, field])))) values.push(field);
    }

    function plansFor(chosen: readonly ContextCandidateValue[]): BlockPlan[] {
      if (!material) {
        if (chosen.some(value => value.value.sources.length)) invalid();
        return [];
      }
      const result: BlockPlan[] = [];
      const pages = [...material.parsed.pages].sort((a, b) => a.page - b.page);
      const blocks = pages.flatMap(page => [...page.blocks].sort((a, b) => a.sourceIndex - b.sourceIndex || a.id.localeCompare(b.id))
        .map(block => ({ page: page.page, block })));
      const add = (entry: { page: number; block: ParsedBlock }, reason: BlockPlan['reasons'][number], source?: SourceRef) => {
        let plan = result.find(saved => saved.page === entry.page && saved.block.id === entry.block.id);
        if (!plan) { plan = { ...entry, reasons: [], sources: [] }; result.push(plan); }
        if (!plan.reasons.includes(reason)) plan.reasons.push(reason);
        if (source && !plan.sources.some(saved => same(saved, source))) plan.sources.push(source);
      };
      if (selection?.kind === 'source') {
        if (selection.artifactId !== material.document.parsedArtifactId) invalid('selection_invalid');
        const matches = selection.block === undefined ? pages.filter(page => page.page === selection.page)
          : blocks.filter(entry => (selection.page === undefined || entry.page === selection.page) && entry.block.id === selection.block);
        if (matches.length !== 1) invalid('selection_invalid');
        if (selection.block !== undefined) {
          const entry = blocks.find(entry => entry.block.id === selection.block && (selection.page === undefined || entry.page === selection.page))!;
          add(entry, 'selection');
        }
      }
      for (const value of chosen) for (const raw of value.value.sources) {
        const checked = SourceRefSchema.safeParse(raw); if (!checked.success) invalid();
        const source = checked.data;
        if (source.documentId !== material.document.documentRef.id || source.version !== material.document.documentRef.version
          || source.artifactId !== material.document.parsedArtifactId || source.blockId === null || !source.quote) invalid();
        const entry = blocks.find(entry => entry.page === source.page && entry.block.id === source.blockId);
        if (!entry || !entry.block.text.includes(source.quote)) invalid();
        add(entry, 'candidate-source', source);
      }
      if (selection?.kind === 'source' && selection.page !== undefined) {
        for (const entry of blocks.filter(entry => entry.page === selection.page)) add(entry, 'selected-page');
      } else if (selection === null) for (const entry of blocks) add(entry, 'document-prefix');
      return result;
    }
    function applicableIssues(chosen: readonly ContextCandidateValue[]) {
      return (candidate?.issues ?? []).map((issue, index) => ({ issue, index }))
        .filter(({ issue }) => !chosen.length || issue.fieldPaths.some(path => chosen.some(value => value.fieldPath === issuePath(path))));
    }
    let plans = plansFor(values);
    const keptBlocks: string[] = [], keptIssues: number[] = [];
    function render(): ContextProjection {
      const gaps = fieldGaps(values), fragments: ContextFragment[] = [];
      if (!material && !candidate) gaps.push({ code: 'no-business-material', fieldPaths: [], source: null, omittedCount: 0 });
      let omittedBlocks = 0;
      for (const plan of plans) {
        const locator: SourceRef = { documentId: material!.document.documentRef.id, version: material!.document.documentRef.version,
          artifactId: material!.document.parsedArtifactId, page: plan.page, blockId: plan.block.id, quote: null };
        if (!plan.block.text) { gaps.push({ code: 'source_has_no_text', fieldPaths: [], source: locator, omittedCount: 1 }); continue; }
        if (!keptBlocks.includes(blockKey(plan))) { omittedBlocks++; continue; }
        const windowed = windowsFor(plan);
        for (const source of windowed.omitted) gaps.push({ code: 'source_window_omitted', source, omittedCount: 1,
          fieldPaths: values.filter(value => value.value.sources.some(saved => same(saved, source))).map(value => value.fieldPath).sort((a, b) => pathOrder(a) - pathOrder(b)) });
        const includedBytes = windowed.windows.reduce((sum, window) => sum + contextTextBytes(window.text), 0);
        const originalBytes = contextTextBytes(plan.block.text);
        fragments.push({ documentRef: material!.document.documentRef, artifactId: material!.document.parsedArtifactId, page: plan.page,
          blockId: plan.block.id, reasons: plan.reasons, sources: plan.sources, windows: windowed.windows, originalBytes,
          includedBytes, truncated: includedBytes < originalBytes });
      }
      if (omittedBlocks) gaps.push({ code: 'document_fragments_omitted', fieldPaths: [], source: null, omittedCount: omittedBlocks });
      const applicable = applicableIssues(values), issues = applicable.filter(item => keptIssues.includes(item.index)).map(item => item.issue);
      if (applicable.length > issues.length) gaps.push({ code: 'issues_omitted', fieldPaths: [], source: null, omittedCount: applicable.length - issues.length });
      return { ...skeleton(values), fragments, issues, gaps: mergeGaps(gaps) };
    }
    for (const plan of plans) {
      if (!plan.block.text || keptBlocks.length >= CONTEXT_POLICY.budgets.fragments) continue;
      keptBlocks.push(blockKey(plan));
      if (!fits(render())) keptBlocks.pop();
    }
    for (const item of applicableIssues(values)) {
      if (keptIssues.length >= CONTEXT_POLICY.budgets.issueCount) break;
      keptIssues.push(item.index);
      if (!fits(render())) keptIssues.pop();
    }
    while (!fits(render())) {
      if (keptIssues.length) keptIssues.pop();
      else if (keptBlocks.length) keptBlocks.pop();
      else {
        const lastOptional = [...values].reverse().find(value => optional.some(item => item.fieldPath === value.fieldPath));
        if (!lastOptional) invalid('input_too_large');
        values = values.filter(value => value.fieldPath !== lastOptional.fieldPath);
        plans = plansFor(values);
      }
    }
    return finish(render());
  } catch (error) {
    return fail(appError(error instanceof SelectionFault ? error.code : 'source_invalid', error instanceof SelectionFault ? error.category : 'input',
      'Selected context could not be verified.'));
  }
}
function finish(projection: ContextProjection): Result<ContextProjection> {
  if (!fits(projection)) return fail(appError('input_too_large', 'input', 'Required context exceeds its projection budget.'));
  return ok(ContextProjectionSchema.parse(projection));
}
