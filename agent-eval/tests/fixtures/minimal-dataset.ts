// Independent synthetic facility data. Never derive expectations from business drafts.
import type { LocalCase, LocalDataset } from '../../src/dataset-loader/local.ts';
export const material = 'Synthetic invoice TEST-001\nNet 10.00\nTax 1.00\nTotal 11.00';
export const tasks: LocalCase[] = [
  { id: 'test-fields', version: 1, name: 'Synthetic field task', category: 'fields', tags: ['synthetic'], requires: ['agent'],
    input: { prompt: 'Read the provided synthetic invoice.', materials: [{ source: 'voxel51', sample: '000001', file: 'content.md',  }] },
    expected: { success: ['Save the stated number.'], failure: ['Invent a different number.'], checks: [{ metric: 'reference-fields', required: true }], reference: { status: 'pending', fields: { invoiceNumber: 'TEST-001' }, excerpt: material, basis: 'visible-parsed-material' } }, review: { status: 'pending' } },
  { id: 'test-lines', version: 1, name: 'Synthetic row task', category: 'lines', tags: ['synthetic'], requires: ['agent'], input: { prompt: 'Compare the synthetic rows.', materials: [] },
    expected: { success: ['Retain both distinct rows.'], failure: ['Duplicate or omit a row.'], checks: [{ metric: 'line-items', required: true }], reference: { status: 'pending', fields: { invoiceNumber: 'TEST-002' }, lineItems: [{ description: 'one', amount: '2.00' }, { description: 'two', amount: '3.00' }], excerpt: 'one 2.00; two 3.00', basis: 'visible-parsed-material' } }, review: { status: 'pending' } },
  { id: 'test-clarification', version: 1, name: 'Synthetic clarification', category: 'context', tags: ['synthetic'], requires: ['agent'], input: { prompt: 'Explain what information is missing.', materials: [] },
    expected: { success: ['Request missing information.'], failure: ['Invent facts.'], checks: [{ metric: 'fact-check', required: true, evidence: 'task-facts', path: ['saved'], equals: false }] }, review: { status: 'pending' } }
];
export const manifest: LocalDataset['manifest'] = {
  contract: 'flowmate-agent-dataset/v1', id: 'facility-test', version: 1, name: 'Synthetic facility data', members: tasks.map(t => `cases/${t.id}.json`), smoke: ['test-fields', 'test-clarification'],
  environment: { profile: 'isolated-agent/v1', source: 'voxel51', risks: ['synthetic-only'] },
  scoring: { version: 1, required: ['task-result', 'input-isolation', 'environment-isolation', 'no-secret', 'closed'], judges: [{ id: 'answer-relevance', required: false, requiredFor: ['test-clarification'] }] }
};
