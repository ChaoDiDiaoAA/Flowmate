import { describe, expect, it } from 'bun:test';
import { invoiceHeaderFields, invoiceLineFields, ContextProjectionSchema, StoredCandidateDraftSchema } from '@flowmate/contracts';
import type { CandidateSnapshot, ContextParsedMaterial, Result, SourceRef, WorkspaceContext } from '@flowmate/contracts';
import { selectContextProjection } from '../../../packages/core/src/context/selection.ts';
import { CONTEXT_POLICY } from '../../../packages/core/src/context/policy.ts';
import { evaluateCandidate } from '@flowmate/employee-invoice';
import { checkSource } from '../../../packages/employee-invoice/src/tools/check_invoice_sources.ts';

const at = '2026-10-03T00:00:00.000Z';
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function missing() { return { raw: null, normalized: null, state: 'missing' as const, alternatives: [], sources: [] }; }
function source(blockId = 'b1', quote: string | null = 'Tax 13.00'): SourceRef {
  return { documentId: 7, version: 'v1', artifactId: 9, page: 1, blockId, quote };
}
function candidate(): CandidateSnapshot {
  const draft = StoredCandidateDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, missing()])),
    lines: [Object.fromEntries(invoiceLineFields.map(name => [name, missing()]))], notes: [] });
  draft.fields.taxAmount = { raw: '13.00', normalized: '13.00', state: 'ambiguous', alternatives: ['13.00', '14.00'], sources: [source()] };
  return { candidateId: 42, jobId: 12, runId: 30, toolCallId: 50, context: null, sequence: 2,
    status: 'generated', issueCount: 0, createdAt: at, ...draft, checks: [], issues: [], sources: [source()] };
}
function material(text = 'Tax 13.00'): ContextParsedMaterial {
  return { document: { documentRef: { id: 7, version: 'v1' }, displayName: 'Invoice', isHidden: false, status: 'available',
    pageCount: 1, originalArtifactId: 8, parsedArtifactId: 9, warnings: [], unavailableReason: null, createdAt: at, updatedAt: at },
    parsed: { formatVersion: 2, pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text, sourceIndex: 0, sourceType: 'text', bbox: null }] }],
      completeness: { status: 'complete', checks: [], warnings: [] } } };
}
function workspace(selection: WorkspaceContext['selection'] = null): WorkspaceContext {
  return { formatVersion: 1, revision: 3, documentRef: { id: 7, version: 'v1' }, jobId: 12, candidateRef: { id: 42, sequence: 2 },
    sessionId: 5, activeView: 'candidate', selection };
}
function choose(selection: WorkspaceContext['selection'] = null, saved = candidate(), parsed = material()) {
  return selectContextProjection({ taskGoal: 'Review invoice', goalMode: 'answer', workspaceContext: workspace(selection), candidate: saved, material: parsed });
}
const tax = { formatVersion: 1 as const, kind: 'field' as const, target: 'candidate' as const, targetId: 42, targetVersion: 2,
  fieldPath: 'fields.taxAmount' };

describe('P8 deterministic context selection', () => {
  it('keeps selected fields first and complete, optional headers in registered order and lines only when selected', () => {
    const selected = need(choose(tax));
    expect(selected.candidate?.values.map(value => value.fieldPath)).toEqual(['fields.taxAmount', ...invoiceHeaderFields.filter(name => name !== 'taxAmount').map(name => `fields.${name}`)]);
    expect(selected.candidate?.values[0]?.value).toEqual(candidate().fields.taxAmount);
    expect(selected.candidate?.values.some(value => value.fieldPath.startsWith('lines.'))).toBe(false);
    const line = need(choose({ formatVersion: 1, kind: 'line', target: 'candidate', targetId: 42, targetVersion: 2, lineIndex: 0 }));
    expect(line.candidate?.values.slice(0, 8).map(value => value.fieldPath)).toEqual(invoiceLineFields.map(name => `lines.0.${name}`));
    const field = need(choose({ ...tax, fieldPath: 'lines.0.quantity' }));
    expect(field.candidate?.values.filter(value => value.fieldPath.startsWith('lines.')).map(value => value.fieldPath)).toEqual(['lines.0.quantity']);
    expect(need(choose()).candidate?.values.map(value => value.fieldPath)).toEqual(invoiceHeaderFields.map(name => `fields.${name}`));
  });

  it('merges exact sources and reasons without changing human provenance or ambiguous alternatives', () => {
    const saved = candidate(); saved.origin = 'human_edit'; saved.runId = null; saved.toolCallId = null; saved.basedOnCandidateId = 41;
    saved.fields.netAmount = { raw: '100', normalized: '100', state: 'present', alternatives: [], sources: [], valueOrigin: 'user-provided' };
    saved.fields.totalAmount = { ...saved.fields.taxAmount, sources: [source()] };
    const projection = need(choose({ formatVersion: 1, kind: 'source', target: 'document', targetId: 7, targetVersion: 'v1', artifactId: 9,
      page: 1, block: 'b1' }, saved));
    expect(projection.candidate?.origin).toBe('human_edit');
    expect(projection.candidate?.values.find(value => value.fieldPath === 'fields.netAmount')?.value).toEqual(saved.fields.netAmount);
    expect(projection.fragments).toHaveLength(1);
    expect(projection.fragments[0]?.sources).toEqual([source()]);
    expect(projection.fragments[0]?.reasons).toEqual(['selection', 'candidate-source', 'selected-page']);
    expect(projection.candidate?.values.find(value => value.fieldPath === 'fields.taxAmount')?.value.alternatives).toEqual(['13.00', '14.00']);
  });

  it('rejects foreign, version, Artifact, absent quote, page-level and cross-block evidence', () => {
    for (const patch of [{ documentId: 99 }, { version: 'v2' }, { artifactId: 8 }, { page: 2 }, { blockId: null },
      { quote: null }, { quote: '13.00 normalized only' }, { quote: 'Tax 13.00other block' }]) {
      const saved = candidate(); saved.fields.taxAmount.sources = [{ ...source(), ...patch }];
      expect(choose(tax, saved)).toMatchObject({ ok: false, error: { code: 'source_invalid' } });
    }
  });

  it('uses the first real quote and independent Unicode windows, merges overlap and records late omitted windows once', () => {
    const text = '😀'.repeat(400) + 'FIRST税' + '😀'.repeat(1500) + 'LAST税' + '😀'.repeat(400) + 'FIRST税';
    const parsed = material(text), saved = candidate();
    saved.fields.taxAmount.sources = [source('b1', 'FIRST税'), source('b1', 'LAST税')];
    const projection = need(choose(tax, saved, parsed));
    const fragment = projection.fragments[0]!;
    expect(fragment.originalBytes).toBe(Buffer.byteLength(text));
    expect(fragment.includedBytes).toBe(fragment.windows.reduce((sum, window) => sum + Buffer.byteLength(window.text), 0));
    expect(fragment.windows).toHaveLength(2);
    expect(fragment.windows[0]?.start).toBe(text.indexOf('FIRST税') - 256);
    expect(fragment.truncated).toBe(true);
    for (const window of fragment.windows) {
      expect(window.text).toBe(text.slice(window.start, window.end));
      expect(window.text.startsWith('😀')).toBe(true);
      expect(window.text.endsWith('😀')).toBe(true);
    }
    saved.fields.taxAmount.sources = [source('b1', 'FIRST'), source('b1', 'FIRST税')];
    expect(need(choose(tax, saved, parsed)).fragments[0]?.windows).toHaveLength(1);
    const many = Array.from({ length: 8 }, (_, i) => `q${i}${'税'.repeat(500)}`);
    saved.fields.taxAmount.sources = many.map(quote => source('b1', quote));
    const omitted = need(choose(tax, saved, material(many.join('😀'.repeat(300)))));
    expect(omitted.fragments[0]?.includedBytes).toBeLessThanOrEqual(4096);
    expect(omitted.gaps.filter(gap => gap.code === 'source_window_omitted')).toHaveLength(6);
    expect(omitted.fragments[0]?.windows.some(window => window.text.includes(many[1]!))).toBe(true);
    expect(omitted.candidate?.values[0]?.value.sources).toHaveLength(8);
  });

  it('sorts page blocks stably, rejects ambiguous locators and never invents text for empty image or page', () => {
    const parsed = material();
    parsed.parsed.pages = [{ page: 2, blocks: [{ id: 'b1', kind: 'text', text: 'second', sourceIndex: 0, sourceType: 'text', bbox: null }] },
      { page: 1, blocks: [{ id: 'b3', kind: 'image', text: '', sourceIndex: 2, sourceType: 'image', bbox: null },
        { id: 'b2', kind: 'text', text: 'prefix', sourceIndex: 0, sourceType: 'text', bbox: null },
        { id: 'b1', kind: 'text', text: 'Tax 13.00', sourceIndex: 1, sourceType: 'text', bbox: null }] }];
    parsed.document.pageCount = 2;
    const page = { formatVersion: 1 as const, kind: 'source' as const, target: 'document' as const, targetId: 7, targetVersion: 'v1', artifactId: 9, page: 1 };
    const projection = need(choose(page, candidate(), parsed));
    expect(projection.fragments.map(fragment => fragment.blockId)).toEqual(['b1', 'b2']);
    expect(projection.gaps).toContainEqual({ code: 'source_has_no_text', fieldPaths: [], source: source('b3', null), omittedCount: 1 });
    expect(choose({ ...page, page: undefined, block: 'b1' }, candidate(), parsed)).toMatchObject({ ok: false, error: { code: 'selection_invalid' } });
    const empty = material(); empty.parsed.pages = [{ page: 1, blocks: [] }];
    const noCandidate = selectContextProjection({ taskGoal: 'Read', goalMode: 'answer', workspaceContext: { ...workspace(page), candidateRef: null }, candidate: null, material: empty });
    expect(need(noCandidate).fragments).toEqual([]);
    parsed.parsed.pages = [parsed.parsed.pages[1]!, parsed.parsed.pages[1]!];
    expect(choose(page, candidate(), parsed)).toMatchObject({ ok: false, error: { code: 'source_invalid' } });
  });

  it('bounds 32 fragments, 20 applicable issues and the complete escaped JSON with aggregated omissions', () => {
    const parsed = material(); parsed.parsed.pages = [{ page: 1, blocks: Array.from({ length: 40 }, (_, i) => ({ id: `b${i + 1}`,
      kind: 'text' as const, text: `block ${i}`, sourceIndex: i, sourceType: 'text', bbox: null })) }];
    const saved = candidate(); saved.fields.taxAmount = missing();
    saved.issues = Array.from({ length: 25 }, (_, i) => ({ code: `issue_${i}`, severity: 'warning', origin: 'rule', fieldPaths: ['fields.taxAmount'], message: 'tax', rule: null }));
    const projection = need(choose(null, saved, parsed));
    expect(projection.fragments).toHaveLength(32); expect(projection.issues).toHaveLength(20);
    expect(projection.gaps).toContainEqual({ code: 'document_fragments_omitted', source: null, fieldPaths: [], omittedCount: 8 });
    expect(projection.gaps).toContainEqual({ code: 'issues_omitted', source: null, fieldPaths: [], omittedCount: 5 });
    expect(ContextProjectionSchema.safeParse(projection).success).toBe(true);
    const large = candidate();
    for (const name of invoiceHeaderFields) large.fields[name] = { raw: '\u0000'.repeat(1024), normalized: '\u0000'.repeat(1024), state: 'present', alternatives: Array(5).fill('\u0000'.repeat(1024)), sources: [], valueOrigin: 'user-provided' };
    const bounded = need(choose(tax, large));
    expect(bytes(bounded)).toBeLessThanOrEqual(CONTEXT_POLICY.budgets.projectionBytes);
    expect(bounded.candidate?.values[0]?.value).toEqual(large.fields.taxAmount);
    expect(bounded.gaps.find(gap => gap.code === 'candidate_fields_omitted')?.fieldPaths).toHaveLength(9);
    large.lines[0] = StoredCandidateDraftSchema.parse({ fields: large.fields,
      lines: [Object.fromEntries(invoiceLineFields.map(name => [name, large.fields.taxAmount]))], notes: [] }).lines[0]!;
    expect(choose({ formatVersion: 1, kind: 'line', target: 'candidate', targetId: 42, targetVersion: 2, lineIndex: 0 }, large))
      .toMatchObject({ ok: false, error: { code: 'input_too_large' } });
  });

  it('keeps Fill as fixed candidate references and ordinary chat as no-business material', () => {
    const fill = need(selectContextProjection({ taskGoal: 'Fill', goalMode: 'fill-form', workspaceContext: workspace(), candidate: candidate(), material: material() }));
    expect(fill.candidate).toEqual({ id: 42, sequence: 2, origin: 'model', statusAtSelection: 'generated', values: [] });
    expect(fill.fragments).toEqual([]);
    expect(need(selectContextProjection({ taskGoal: 'Chat', goalMode: 'answer', workspaceContext: null, candidate: null, material: null })).gaps[0]?.code).toBe('no-business-material');
  });

  it('matches existing slash issue locators to the selected registered field while preserving original issue facts', () => {
    const saved = candidate();
    saved.issues = [{ code: 'tax_warning', severity: 'warning', origin: 'rule', fieldPaths: ['/fields/taxAmount'],
      message: 'Original rule warning', rule: 'header-total' }, { code: 'line_warning', severity: 'warning', origin: 'rule',
      fieldPaths: ['/lines/0/quantity'], message: 'Line warning', rule: null }, { code: 'unknown_path', severity: 'warning', origin: 'rule',
      fieldPaths: ['/fields.taxAmount', '/fields/*', '/fields/taxAmount/more', '/lines/00/quantity'], message: 'Unknown path', rule: null }];
    expect(need(choose(tax, saved)).issues).toEqual([saved.issues[0]!]);
    expect(need(choose({ ...tax, fieldPath: 'lines.0.quantity' }, saved)).issues).toEqual(saved.issues.slice(0, 2));
  });

  it('selects the actual evaluateCandidate rule issues without rewriting their slash locators or order', () => {
    const saved = candidate(), parsed = material();
    const evaluated = evaluateCandidate({ fields: saved.fields, lines: saved.lines, notes: saved.notes },
      [{ index: 0, ...checkSource(source(), parsed.document, { ...parsed.parsed,
        pages: parsed.parsed.pages.map(page => ({ page: page.page, blocks: [...page.blocks] })) }) }]);
    saved.issues = evaluated.issues;
    expect(saved.issues.some(issue => issue.fieldPaths.includes('/fields/invoiceNumber'))).toBe(true);
    expect(need(choose(tax, saved, parsed)).issues).toEqual(evaluated.issues);
  });

  it('retracts the last optional field and its exclusive source when a necessary omission gap crosses the JSON budget', () => {
    const saved = candidate(); saved.fields.taxAmount = missing();
    const actualSource = source('b2', 'Evidence');
    saved.fields.totalAmount = { raw: '113', normalized: '113', state: 'present', alternatives: [], sources: [actualSource] };
    const parsed = material('');
    parsed.parsed.pages = [{ page: 1, blocks: [...parsed.parsed.pages[0]!.blocks,
      { id: 'b2', kind: 'text', text: 'Evidence', sourceIndex: 1, sourceType: 'text', bbox: null }] }];
    // Independently encode the ten whole values before fragments and their necessary gaps exist.
    const skeleton = { taskGoal: '', candidate: { id: 42, sequence: 2, origin: 'model', statusAtSelection: 'generated',
      values: invoiceHeaderFields.map(name => ({ fieldPath: `fields.${name}`, value: saved.fields[name] })) }, fragments: [], issues: [], gaps: [] };
    const projection = need(selectContextProjection({ taskGoal: 'x'.repeat(65536 - bytes(skeleton)), goalMode: 'answer',
      workspaceContext: workspace(tax), candidate: saved, material: parsed }));
    expect(projection.candidate?.values[0]?.fieldPath).toBe('fields.taxAmount');
    expect(projection.candidate?.values.some(value => value.fieldPath === 'fields.totalAmount')).toBe(false);
    expect(projection.gaps).toContainEqual({ code: 'candidate_fields_omitted', source: null, fieldPaths: ['fields.totalAmount'], omittedCount: 1 });
    expect(projection.gaps.some(gap => gap.code === 'document_fragments_omitted')).toBe(false);
    expect(projection.gaps).toHaveLength(1);
    expect(bytes(projection)).toBeLessThanOrEqual(65536);
  });

  it('keeps a maximum complete Unicode prefix, merges adjacent windows and never truncates a quote that exceeds remaining capacity', () => {
    const saved = candidate(); saved.fields.taxAmount = missing();
    const prefix = need(choose(null, saved, material('😀'.repeat(1025)))).fragments[0]!;
    expect(prefix.windows).toEqual([{ start: 0, end: 2048, text: '😀'.repeat(1024) }]);
    expect(prefix.includedBytes).toBe(4096); expect(prefix.originalBytes).toBe(4100);
    const first = 'A' + '税'.repeat(1000), second = 'B' + '税'.repeat(1000);
    saved.fields.taxAmount = { raw: '13', normalized: '13', state: 'present', alternatives: [], sources: [source('b1', first), source('b1', second)] };
    const omitted = need(choose(tax, saved, material(first + '😀'.repeat(300) + second)));
    expect(omitted.fragments[0]?.windows[0]?.text.includes(first)).toBe(true);
    expect(omitted.fragments[0]?.windows.some(window => window.text.includes(second))).toBe(false);
    expect(omitted.gaps).toContainEqual({ code: 'source_window_omitted', source: source('b1', second), fieldPaths: ['fields.taxAmount'], omittedCount: 1 });
    saved.fields.taxAmount.sources = [source('b1', 'A'), source('b1', 'B')];
    const adjacent = need(choose(tax, saved, material('A' + 'x'.repeat(256) + 'B'))).fragments[0]!;
    expect(adjacent.windows).toEqual([{ start: 0, end: 258, text: 'A' + 'x'.repeat(256) + 'B' }]);
  });
});
