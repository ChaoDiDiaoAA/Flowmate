import { isDeepStrictEqual } from 'node:util';
import type { CandidateSnapshot, DocumentRef, InvoiceWorkSourceLocator, StoredInvoiceField } from '@flowmate/contracts';
import type { InvoiceWorkTodoDefinition } from './repository.ts';

function fieldSources(fields: readonly StoredInvoiceField[]): InvoiceWorkSourceLocator[] {
  const sourceRefs: InvoiceWorkSourceLocator[] = [];
  for (const field of fields) for (const { documentId, version, artifactId, page, blockId } of field.sources) {
    const source = { documentId, version, artifactId, page, blockId };
    if (!sourceRefs.some(previous => isDeepStrictEqual(previous, source))) sourceRefs.push(source);
  }
  return sourceRefs;
}

export function invoiceCandidateTodos(input: { candidate: CandidateSnapshot; documentRefs: readonly DocumentRef[];
  inputIds: readonly number[] }): InvoiceWorkTodoDefinition[] {
  const candidate = input.candidate, todos: InvoiceWorkTodoDefinition[] = [];
  const fields = new Map<string, { fieldPath: string; value: StoredInvoiceField }>();
  for (const [name, value] of Object.entries(candidate.fields)) fields.set(`/fields/${name}`, { fieldPath: `fields.${name}`, value });
  for (const [index, line] of candidate.lines.entries()) for (const [name, value] of Object.entries(line))
    fields.set(`/lines/${index}/${name}`, { fieldPath: `lines.${index}.${name}`, value });
  const basis = { origin: 'rule' as const, documentRefs: [...input.documentRefs], inputIds: [...input.inputIds],
    candidateRef: { id: candidate.candidateId, sequence: candidate.sequence } };
  const satisfiedBy = 'A saved clarification is considered with a newly validated candidate, or an explicit invoice disposition is recorded.';
  for (const issue of candidate.issues) {
    if (issue.origin !== 'rule') continue;
    const paths = issue.fieldPaths.filter(path => fields.has(path));
    if (!paths.length) continue;
    const missing = issue.code === 'required_header_missing', ambiguous = issue.code === 'required_header_ambiguous';
    const check = candidate.checks.find(value => value.rule === issue.rule && value.status === 'failed'
      && isDeepStrictEqual(value.fieldPaths, issue.fieldPaths));
    const targets = missing || ambiguous ? paths : [paths.at(-1)!];
    for (const path of targets) {
      const fieldPath = fields.get(path)!.fieldPath;
      const sourceRefs = fieldSources((missing || ambiguous ? [path] : paths).map(original => fields.get(original)!.value));
      let needed = `Review the competing original sources for ${fieldPath} and clarify the intended value.`;
      if (missing) needed = `Provide the missing value or readable invoice material for ${fieldPath}.`;
      else if (check && check.actual !== null && check.expected !== null)
        needed = `Review the original invoice amounts for ${fieldPath}: saved ${check.actual}; ${check.rule} expects ${check.expected}.`;
      todos.push({ actor: 'user', action: missing ? 'supplement' : 'review', fieldPath, problem: issue.message,
        needed, satisfiedBy, basis: { ...basis, sourceRefs } });
    }
  }
  for (const { fieldPath, value } of fields.values()) {
    if (value.state !== 'ambiguous' || todos.some(todo => todo.fieldPath === fieldPath)) continue;
    todos.push({ actor: 'user', action: 'review', fieldPath, problem: `The saved invoice field ${fieldPath} is ambiguous.`,
      needed: `Review the competing original sources for ${fieldPath} and clarify the intended value.`, satisfiedBy,
      basis: { ...basis, sourceRefs: fieldSources([value]) } });
  }
  return todos.length ? todos : [{ actor: 'user', action: 'review', fieldPath: null,
    problem: 'An original invoice candidate awaits human review.', needed: 'Review the saved candidate against the original invoice.',
    satisfiedBy: 'The user confirms an invoice disposition or supplies clarification.', basis: { ...basis, sourceRefs: [] } }];
}
