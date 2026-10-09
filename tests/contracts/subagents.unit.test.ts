import { expect, it } from 'bun:test';
import * as contracts from '../../packages/contracts/src/index.ts';

const schema = () => {
  const value = Reflect.get(contracts, 'DelegateArgsSchema'); expect(value).toBeDefined(); return value;
};
const args = { prompt: '核对原始依据', description: '发票证据检查', subagent_type: 'invoice-evidence-checker' } as const;
it('accepts the fixed foreground role and preserves the exact task text', () => {
  expect(schema().parse({ ...args, prompt: '  原文\n', run_in_background: false })).toEqual({ ...args, prompt: '  原文\n', run_in_background: false });
  expect(schema().parse(args)).toEqual({ ...args, run_in_background: false });
});
it('rejects model-controlled authority, background and byte-limit expansion', () => {
  for (const value of [{ ...args, prompt: ' ' }, { ...args, description: '\n' }, { ...args, run_in_background: true },
    { ...args, subagent_type: '../general-purpose' }, { ...args, prompt: '界'.repeat(21667) },
    { ...args, description: '界'.repeat(171) }, ...['model', 'scope', 'childRunId', 'tools', 'extensions', 'resume', 'schedule']
      .map(key => ({ ...args, [key]: 'untrusted' }))]) expect(schema().safeParse(value).success).toBe(false);
  expect(schema().safeParse({ ...args, prompt: 'x'.repeat(65000), description: 'x'.repeat(512) }).success).toBe(true);
  expect(schema().safeParse({ ...args, subagent_type: 'general-analyst' }).success).toBe(true);
});
it('keeps the exact Agent exception without allowing other capitalized tool definitions', () => {
  const schema = Reflect.get(contracts, 'RegisteredToolNameSchema'); expect(schema).toBeDefined();
  for (const name of ['Agent', 'read', 'check_invoice_sources']) expect(schema.safeParse(name).success).toBe(true);
  for (const name of ['AGENT', 'Read', 'subAgent', 'read-file', 'a'.repeat(129)]) expect(schema.safeParse(name).success).toBe(false);
});

it('validates strict public commands and rejects a result from another child owner or page', () => {
  const parse = Reflect.get(contracts, 'parseSubagentCommand'), matches = Reflect.get(contracts, 'matchesSubagentResponse');
  expect(parse).toBeDefined(); expect(matches).toBeDefined();
  const command = { type: 'list_subagents', input: { parentRunId: 1, parentSessionId: 1, limit: 1, beforeRunId: 4 } };
  expect(parse(command)).not.toBeNull();
  for (const input of [{ ...command.input, limit: 101 }, { ...command.input, role: 'other' }, { ...command.input, parentSessionId: 0 }])
    expect(parse({ ...command, input })).toBeNull();
  const item = { childRunId: 3, childSessionId: 2, childNativeSessionId: 'child-native', parentRunId: 1, parentSessionId: 1,
    originToolCallId: 1, parentNativeToolCallId: 'delegate-1', pluginAgentId: 'plugin-1', role: 'invoice-evidence-checker',
    description: 'Check', status: 'completed', createdAt: '2026-10-06T00:00:00Z', startedAt: '2026-10-06T00:00:00Z',
    endedAt: '2026-10-06T00:00:01Z', stoppedAt: '2026-10-06T00:00:01Z', cancelRequestedAt: null };
  const reply = { ok: true, data: { items: [item], nextBeforeRunId: null,
    totals: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false } } };
  expect(matches(command, reply)).toBe(true);
  for (const changed of [{ ...item, parentRunId: 2 }, { ...item, parentSessionId: 2 }, { ...item, childRunId: 4 }])
    expect(matches(command, { ...reply, data: { ...reply.data, items: [changed] } })).toBe(false);
  expect(matches(command, { ...reply, data: { ...reply.data, items: [item, { ...item, childRunId: 2 }], nextBeforeRunId: null } })).toBe(false);
  expect(matches(command, { ...reply, data: { ...reply.data, items: [item], nextBeforeRunId: 2 } })).toBe(false);
  expect(matches(command, { ...reply, data: { ...reply.data, totals: { ...reply.data.totals, inputTokens: -1 } } })).toBe(false);
  expect(parse({ type: 'cancel_subagent', input: { parentRunId: 1, childRunId: 3, pluginAgentId: 'untrusted' } })).toBeNull();
});
