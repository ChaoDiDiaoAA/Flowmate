import { expect, test } from 'bun:test';
import { Type, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { checkPayload, checkResourcePayload, checkResourceWire, checkWire, preparePayloadCodec,
  type ResourcePayloadText } from '../../packages/runtime-pi/src/context-evidence.ts';
import type { Result } from '@flowmate/contracts';

function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
const model: Model<'anthropic-messages'> = { api: 'anthropic-messages', provider: 'controlled', id: 'offline', name: 'Offline',
  baseUrl: 'https://unused.invalid', reasoning: false, input: ['text', 'image'], contextWindow: 200000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const assistant = (ids: string[]): AssistantMessage => ({ role: 'assistant', api: 'openai-responses', provider: 'original', model: 'original',
  content: ids.map(id => ({ type: 'toolCall', id, name: 'read', arguments: {} })), stopReason: 'toolUse', timestamp: 2,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

async function sample(context: Context, resources: ResourcePayloadText[] = [], requestModel = model) {
  const codec = need(preparePayloadCodec(requestModel.api, context, true));
  let payload: unknown, wire: Awaited<ReturnType<typeof checkWire>> | undefined;
  let resourceWire: Awaited<ReturnType<typeof checkResourceWire>> | undefined;
  const result = await streamSimple(requestModel, normalizeContext(context), { apiKey: 'synthetic-codec-key', maxRetries: 0,
    onPayload: outgoing => { payload = structuredClone(outgoing); },
    fetch: Object.assign(async (request: RequestInfo | URL, init?: RequestInit) => {
      wire = await checkWire(codec, request, init);
      resourceWire = await checkResourceWire(requestModel.api, request, init, resources);
      const events = [{ type: 'message_start', message: { id: 'offline-response', type: 'message', role: 'assistant', content: [],
        model: requestModel.id, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } },
      { type: 'message_stop' }];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    }, { preconnect() {} }) }).result();
  expect(result.stopReason).toBe('stop');
  return { codec, payload: payload as { messages: Array<{ role: string; content: any }> }, wire, resourceWire };
}

test('Anthropic native system updates retain resource proof beside tool additions and removals', async () => {
  const context: Context = { messages: [
    { role: 'system', content: 'Initial policy.', toolsAdded: [{ name: 'read_a', description: 'Old scoped reader.', parameters: Type.Object({}) }], timestamp: 0 },
    { role: 'user', content: 'Review this invoice.', timestamp: 1 },
    { role: 'system', content: 'REVISED_SCOPED_POLICY', toolsRemoved: [{ name: 'read_a' }],
      toolsAdded: [{ name: 'read_b', description: 'Current scoped reader.', parameters: Type.Object({}) }], timestamp: 2 },
  ] };
  const resources: ResourcePayloadText[] = [{ role: 'system', text: 'REVISED_SCOPED_POLICY' }];
  const { codec, payload, wire, resourceWire } = await sample(context, resources, { ...model,
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } });
  expect(payload.messages.some(message => message.role === 'system' && Array.isArray(message.content)
    && message.content.some(block => block.type === 'tool_addition'))).toBe(true);
  expect(need(checkPayload(codec, payload)).inclusion).toBe('confirmed');
  expect(need(wire!).inclusion).toBe('confirmed');
  expect(checkResourcePayload(model.api, payload, resources)).toEqual([{ inclusion: 'confirmed', reason: null }]);
  expect(resourceWire).toEqual([{ inclusion: 'confirmed', reason: null }]);
});

test('Anthropic SDK payload and wire preserve user text blocks, order and surrogate normalization', async () => {
  const context: Context = { messages: [{ role: 'user', timestamp: 1,
    content: [{ type: 'text', text: 'a\ud800' }, { type: 'text', text: '  ' }, { type: 'text', text: 'b😀' }] },
  { role: 'user', timestamp: 2, content: 'second' }] };
  const { codec, payload, wire } = await sample(context);
  expect(need(checkPayload(codec, payload))).toEqual({ inclusion: 'confirmed', reason: null });
  expect(wire).toEqual({ ok: true, data: { inclusion: 'confirmed', reason: null } });
  expect(payload.messages[0]!.content).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b😀' }]);
  const merged = structuredClone(payload); merged.messages[0]!.content = [{ type: 'text', text: 'ab😀' }];
  expect(checkPayload(codec, merged)).toMatchObject({ ok: false, error: { code: 'context_payload_mismatch' } });
  const reordered = structuredClone(payload); reordered.messages.reverse();
  expect(checkPayload(codec, reordered)).toMatchObject({ ok: false, error: { code: 'context_payload_mismatch' } });
});

test('Anthropic grouped tool results retain normalized identity, exact text and assistant bridges', async () => {
  const context: Context = { messages: [{ role: 'user', content: 'Read', timestamp: 1 }, assistant(['call/a|response', 'call-b']),
    { role: 'toolResult', toolCallId: 'call/a|response', toolName: 'read', isError: false, timestamp: 3,
      content: [{ type: 'text', text: 'First\ud800' }, { type: 'text', text: 'Second😀' }] },
    { role: 'toolResult', toolCallId: 'call-b', toolName: 'read', isError: true, timestamp: 4, content: [{ type: 'text', text: 'Denied' }] }] };
  const { codec, payload, wire } = await sample(context);
  expect(need(checkPayload(codec, payload)).inclusion).toBe('confirmed');
  expect(wire).toMatchObject({ ok: true, data: { inclusion: 'confirmed' } });
  expect(payload.messages.at(-1)!.content).toMatchObject([
    { type: 'tool_result', tool_use_id: 'call_a_response', content: 'First\nSecond😀', is_error: false },
    { type: 'tool_result', tool_use_id: 'call-b', content: 'Denied', is_error: true }]);
  for (const mutate of [
    (body: typeof payload) => { body.messages.at(-1)!.content[0].tool_use_id = 'call-b'; },
    (body: typeof payload) => { body.messages.at(-1)!.content[0].content = 'FirstSecond😀'; },
    (body: typeof payload) => { body.messages.at(-1)!.content.reverse(); },
    (body: typeof payload) => { body.messages[1]!.content[0].id = 'other-call'; },
  ]) {
    const changed = structuredClone(payload); mutate(changed);
    expect(checkPayload(codec, changed)).toMatchObject({ ok: false, error: { code: 'context_payload_mismatch' } });
  }
});

test('Anthropic user and tool images preserve bytes, media types and block positions', async () => {
  const context: Context = { messages: [{ role: 'user', timestamp: 1, content: [{ type: 'image', mimeType: 'image/png', data: 'USER' },
    { type: 'text', text: 'Look' }] }, assistant(['image-call']),
  { role: 'toolResult', toolCallId: 'image-call', toolName: 'read', isError: false, timestamp: 3,
    content: [{ type: 'image', mimeType: 'image/jpeg', data: 'TOOL' }] }] };
  const { codec, payload, wire } = await sample(context);
  expect(need(checkPayload(codec, payload)).inclusion).toBe('confirmed');
  expect(wire).toMatchObject({ ok: true, data: { inclusion: 'confirmed' } });
  expect(payload.messages.at(-1)!.content[0].content).toEqual([{ type: 'text', text: '(see attached image)' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'TOOL' } }]);
  for (const mutate of [
    (body: typeof payload) => { body.messages[0]!.content.reverse(); },
    (body: typeof payload) => { body.messages.at(-1)!.content[0].content[1].source.data = 'CHANGED'; },
    (body: typeof payload) => { body.messages.at(-1)!.content[0].content[1].source.media_type = 'image/png'; },
  ]) {
    const changed = structuredClone(payload); mutate(changed);
    expect(checkPayload(codec, changed)).toMatchObject({ ok: false, error: { code: 'context_payload_mismatch' } });
  }
  expect(preparePayloadCodec(model.api, context, false)).toMatchObject({ ok: false, error: { code: 'context_payload_mismatch' } });
});

test('Anthropic resource checks use system, user and identified tool carriers in SDK and wire', async () => {
  const resources: ResourcePayloadText[] = [{ role: 'system', text: 'Policy\ud800' }, { role: 'user', text: 'Expanded\ud800\nSkill' },
    { role: 'tool', text: 'Read\ud800\nSkill', toolCallId: 'read-call' }, { role: 'tool', text: 'Read\nSkill', toolCallId: 'other-call' }];
  const context: Context = { systemPrompt: 'Prefix\nPolicy\ud800\nSuffix', messages: [{ role: 'user', timestamp: 1,
    content: [{ type: 'text', text: 'Expanded\ud800' }, { type: 'text', text: 'Skill' }] }, assistant(['read-call']),
  { role: 'toolResult', toolCallId: 'read-call', toolName: 'read', isError: false, timestamp: 3,
    content: [{ type: 'text', text: 'Read\ud800' }, { type: 'text', text: 'Skill' }] }] };
  const { payload, resourceWire } = await sample(context, resources);
  expect(checkResourcePayload(model.api, payload, resources)).toEqual([
    { inclusion: 'confirmed', reason: null }, { inclusion: 'confirmed', reason: null },
    { inclusion: 'confirmed', reason: null }, { inclusion: 'not-included', reason: null }]);
  expect(resourceWire).toEqual(checkResourcePayload(model.api, payload, resources));
  const quoted = { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Policy\nExpanded\nSkill\nRead\nSkill' }] }] };
  expect(checkResourcePayload(model.api, quoted, resources).every(fact => fact.inclusion === 'not-included')).toBe(true);
  expect(checkResourcePayload('unsupported-api', payload, resources).every(fact => fact.inclusion === 'unknown')).toBe(true);
});

test('unobservable Anthropic resource blocks and opaque wire bodies remain unknown', async () => {
  const expected: ResourcePayloadText[] = [{ role: 'tool', text: 'Skill body', toolCallId: 'read-call' }];
  const deferred = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-call',
    content: [{ type: 'tool_reference', tool_name: 'read' }] }, { type: 'text', text: 'Skill body' }] }] };
  expect(checkResourcePayload(model.api, deferred, expected)).toEqual([{ inclusion: 'unknown', reason: 'payload_shape_unavailable' }]);
  expect(await checkResourceWire(model.api, 'https://unused.invalid', { body: new Blob(['opaque']) }, expected))
    .toEqual([{ inclusion: 'unknown', reason: 'body_unavailable' }]);
  const codec = need(preparePayloadCodec(model.api, { messages: [{ role: 'user', content: 'Authorized', timestamp: 0 }] }, false));
  expect(need(await checkWire(codec, 'https://unused.invalid', { body: new Blob(['opaque']) })))
    .toEqual({ inclusion: 'unavailable', reason: 'body_unavailable' });
  expect(await checkWire(codec, 'https://unused.invalid', { body: '{invalid' }))
    .toMatchObject({ ok: false, error: { code: 'context_payload_mismatch' } });
});

test('unsupported deferred tool references stay unavailable and cannot bypass image checks', () => {
  const legacyResult = { role: 'toolResult' as const, toolCallId: 'read-call', toolName: 'read',
    timestamp: 3, isError: false, addedToolNames: ['read'], content: [{ type: 'text' as const, text: 'Deferred result' }] };
  const context: Context = { messages: [assistant(['read-call']), legacyResult] };
  const codec = need(preparePayloadCodec(model.api, context, true));
  expect(need(checkPayload(codec, {}))).toEqual({ inclusion: 'unavailable', reason: 'payload_codec_unavailable' });
  context.messages.push({ role: 'user', timestamp: 4, content: [{ type: 'image', mimeType: 'image/png', data: 'IMAGE' }] });
  expect(preparePayloadCodec(model.api, context, true)).toMatchObject({ ok: false, error: { code: 'context_payload_mismatch' } });
});
