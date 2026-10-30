import { expect, test } from 'bun:test';
import { controlledReplayTools } from '../../src/adapters/replay-policy.ts';

test('controlled replay admits known isolated business tools and rejects undeclared tools even if they claim read access', () => {
  const tools = ['bash', 'write', 'fill_invoice_form', 'export_invoice', 'new_read_tool', 'save_invoice_candidate', 'read_invoice_document', 'read_research_local']
    .map(name => ({ name, effect: 'READ' }));
  expect(controlledReplayTools(tools).map(tool => tool.name)).toEqual(['save_invoice_candidate', 'read_invoice_document', 'read_research_local']);
});
