import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@earendil-works/pi-ai';
import { sanitizeSurrogates } from '@earendil-works/pi-ai/utils/sanitize-unicode';
import { appError, fail, ok } from '@flowmate/contracts';
import type { ContextEvidenceReason, Result } from '@flowmate/contracts';

export type InclusionFact = { inclusion: 'confirmed'; reason: null } | { inclusion: 'unavailable'; reason: ContextEvidenceReason };
type ExpectedUser = { texts: string[]; images: string[]; toolIds?: string[]; order?: ('text' | 'image')[] };
type AnthropicContent = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
type AnthropicBlock = AnthropicContent | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicContent[]; is_error: boolean };
type OpenAIPayloadCodec = { api: 'openai-completions' | 'openai-responses'; users: ExpectedUser[]; toolImages: { callId: string; texts: string[]; images: string[] }[] };
export type PayloadCodec = OpenAIPayloadCodec
  | { api: 'anthropic-messages'; users: AnthropicBlock[][] };
const imageCaption = 'Attached image(s) from tool result:';
const mismatch = () => fail(appError('context_payload_mismatch', 'runtime', 'The outgoing payload does not preserve the request inputs.'));
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const anthropicToolId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
function anthropicContent(block: { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }): AnthropicContent {
  return block.type === 'text' ? { type: 'text', text: sanitizeSurrogates(block.text) }
    : { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } };
}
function withoutAnthropicCache(raw: unknown): unknown {
  const block = record(raw); if (!block) return raw;
  const { cache_control: _cache, ...content } = block;
  return Array.isArray(content.content) ? { ...content, content: content.content.map(withoutAnthropicCache) } : content;
}

/** Message boundaries remain intact; identity was established before this text codec. */
export function preparePayloadCodec(api: string, context: Pick<Context, 'messages'>, supportsImages: boolean): Result<PayloadCodec | undefined> {
  const hasImages = context.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image'));
  if (hasImages && (!supportsImages || !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(api))) return mismatch();
  if (api === 'anthropic-messages') {
    const users: AnthropicBlock[][] = [], toolIds = new Map<string, string>();
    for (const message of context.messages) if (message.role === 'assistant') for (const block of message.content) {
      if (block.type === 'toolCall') toolIds.set(block.id, message.api === api ? block.id : anthropicToolId(block.id));
    }
    for (let index = 0; index < context.messages.length; index++) {
      const message = context.messages[index]!;
      if (message.role === 'user') {
        const blocks = typeof message.content === 'string'
          ? message.content.trim() ? [{ type: 'text' as const, text: sanitizeSurrogates(message.content) }] : []
          : message.content.map(anthropicContent).filter(block => block.type !== 'text' || block.text.trim());
        if (blocks.length) users.push(blocks);
      } else if (message.role === 'toolResult') {
        const blocks: AnthropicBlock[] = [];
        while (index < context.messages.length && context.messages[index]!.role === 'toolResult') {
          const result = context.messages[index]!;
          if (result.role !== 'toolResult') return mismatch();
          // shortcut: deferred tool references displace content; require a dedicated codec before confirming them.
          if ('addedToolNames' in result && Array.isArray(result.addedToolNames) && result.addedToolNames.length)
            return hasImages ? mismatch() : ok(undefined);
          const content = result.content.some(block => block.type === 'image') ? result.content.map(anthropicContent)
            : sanitizeSurrogates(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'));
          if (Array.isArray(content) && !content.some(block => block.type === 'text')) content.unshift({ type: 'text', text: '(see attached image)' });
          blocks.push({ type: 'tool_result', tool_use_id: toolIds.get(result.toolCallId) ?? result.toolCallId, content, is_error: result.isError });
          index++;
        }
        index--; users.push(blocks);
      }
    }
    return ok({ api, users });
  }
  if (api !== 'openai-completions' && api !== 'openai-responses') return ok(undefined);
  const users: ExpectedUser[] = []; const toolImages: OpenAIPayloadCodec['toolImages'] = [];
  for (let index = 0; index < context.messages.length; index++) {
    const message = context.messages[index]!;
    if (message.role === 'user') {
      const texts = typeof message.content === 'string' ? [sanitizeSurrogates(message.content)]
        : message.content.filter(block => block.type === 'text').map(block => sanitizeSurrogates(block.text));
      const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
      users.push({ texts, images: blocks.flatMap(block => block.type === 'image' ? [`data:${block.mimeType};base64,${block.data}`] : []), order: blocks.map(block => block.type) });
    } else if (api === 'openai-responses' && message.role === 'toolResult' && message.content.some(b => b.type === 'image')) {
      const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      toolImages.push({ callId: message.toolCallId.split('|')[0]!, texts: text ? [sanitizeSurrogates(text)] : [], images: message.content.flatMap(b => b.type === 'image' ? [`data:${b.mimeType};base64,${b.data}`] : []) });
    } else if (api === 'openai-completions' && message.role === 'toolResult') {
      const images: string[] = [], toolIds: string[] = [];
      while (index < context.messages.length && context.messages[index]!.role === 'toolResult') {
        const result = context.messages[index]!;
        if (result.role !== 'toolResult') return mismatch();
        toolIds.push(result.toolCallId);
        if (supportsImages) for (const block of result.content) if (block.type === 'image') images.push(`data:${block.mimeType};base64,${block.data}`);
        index++;
      }
      index--;
      if (images.length) users.push({ texts: [imageCaption], images, toolIds });
    }
  }
  return ok({ api, users, toolImages });
}

/** No payload, image URL, or tool result text leaves this request-local comparison. */
export function checkPayload(codec: PayloadCodec | undefined, payload: unknown): Result<InclusionFact> {
  if (!codec) return ok({ inclusion: 'unavailable', reason: 'payload_codec_unavailable' });
  const body = record(payload), messages = body?.[codec.api === 'openai-responses' ? 'input' : 'messages'];
  if (!Array.isArray(messages)) return mismatch();
  if (codec.api === 'anthropic-messages') {
    let userIndex = 0;
    for (let index = 0; index < messages.length; index++) {
      const message = record(messages[index]); if (!message) return mismatch();
      if (message.role !== 'user') continue;
      const expected = codec.users[userIndex++];
      const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content) ? message.content.map(withoutAnthropicCache) : null;
      if (!expected || !isDeepStrictEqual(blocks, expected)) return mismatch();
      const tools = expected.filter(block => block.type === 'tool_result');
      if (tools.length) {
        const previous = record(messages[index - 1]), previousBlocks = previous?.content;
        if (previous?.role !== 'assistant' || !Array.isArray(previousBlocks) || tools.some(tool =>
          previousBlocks.filter(raw => record(raw)?.type === 'tool_use' && record(raw)?.id === tool.tool_use_id).length !== 1)) return mismatch();
      }
    }
    return userIndex === codec.users.length ? ok({ inclusion: 'confirmed', reason: null }) : mismatch();
  }
  let userIndex = 0; let toolImageIndex = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = record(messages[index]);
    if (!message) return mismatch();
    if (message.type === 'function_call_output' && Array.isArray(message.output) && message.output.some(b => record(b)?.type === 'input_image')) {
      const expected = codec.toolImages[toolImageIndex++];
      if (!expected || expected.callId !== message.call_id || !isDeepStrictEqual(message.output, [
        ...expected.texts.map(text => ({ type: 'input_text', text })), ...expected.images.map(image_url => ({ type: 'input_image', detail: 'auto', image_url }))])) return mismatch();
    }
    if (message.role !== 'user') continue;
    const expected = codec.users[userIndex++];
    if (!expected) return mismatch();
    const texts: string[] = [], images: string[] = []; const order: ('text' | 'image')[] = [];
    if (typeof message.content === 'string' && codec.api === 'openai-completions') { texts.push(message.content); order.push('text'); }
    else {
      if (!Array.isArray(message.content)) return mismatch();
      for (const raw of message.content) {
        const block = record(raw);
        if (!block) return mismatch();
        if (block.type === (codec.api === 'openai-responses' ? 'input_text' : 'text') && typeof block.text === 'string') { texts.push(block.text); order.push('text'); }
        else if (codec.api === 'openai-completions' && block.type === 'image_url' && typeof record(block.image_url)?.url === 'string')
          { images.push(record(block.image_url)!.url as string); order.push('image'); }
        else if (codec.api === 'openai-responses' && block.type === 'input_image' && typeof block.image_url === 'string' && block.detail === 'auto')
          { images.push(block.image_url); order.push('image'); }
        else return mismatch();
      }
    }
    if (expected.order && !isDeepStrictEqual(order, expected.order)) return mismatch();
    if (!isDeepStrictEqual(texts, expected.texts) || !isDeepStrictEqual(images, expected.images)) return mismatch();
    if (expected.toolIds) {
      const blocks = message.content;
      if (!Array.isArray(blocks) || record(blocks[0])?.type !== 'text' || blocks.length !== expected.images.length + 1
        || blocks.slice(1).some(block => record(block)?.type !== 'image_url')) return mismatch();
      let previous = index - 1;
      const bridge = record(messages[previous]);
      if (bridge?.role === 'assistant' && bridge.content === 'I have processed the tool results.') previous--;
      for (let tool = expected.toolIds.length - 1; tool >= 0; tool--, previous--) {
        const actual = record(messages[previous]);
        if (actual?.role !== 'tool' || actual.tool_call_id !== expected.toolIds[tool]) return mismatch();
      }
    }
  }
  return userIndex === codec.users.length && toolImageIndex === codec.toolImages.length ? ok({ inclusion: 'confirmed', reason: null }) : mismatch();
}

export async function checkWire(codec: PayloadCodec | undefined, request: RequestInfo | URL, init?: RequestInit): Promise<Result<InclusionFact>> {
  if (!codec) return ok({ inclusion: 'unavailable', reason: 'payload_codec_unavailable' });
  let body: string;
  try {
    if (typeof init?.body === 'string') body = init.body;
    else if (init?.body === undefined && request instanceof Request) body = await request.clone().text();
    else return ok({ inclusion: 'unavailable', reason: 'body_unavailable' });
  } catch { return ok({ inclusion: 'unavailable', reason: 'body_unavailable' }); }
  try { return checkPayload(codec, JSON.parse(body)); } catch { return mismatch(); }
}

export function sdkRequestId(headers: Record<string, string>): string | null {
  const value = headers['x-request-id'] ?? headers['request-id'];
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

export type ResourcePayloadText = { role: 'system' | 'user' | 'tool'; text: string | null; toolCallId?: string; contains?: boolean };
export type ResourceInclusion = { inclusion: 'confirmed' | 'not-included' | 'unknown'; reason: string | null };
/** Compare only the declared carrier; an assistant quoting a Skill is not input evidence. */
export function checkResourcePayload(api: string, payload: unknown, expected: readonly ResourcePayloadText[]): ResourceInclusion[] {
  const unknown = (reason: string) => expected.map(() => ({ inclusion: 'unknown' as const, reason }));
  if (api !== 'openai-completions' && api !== 'openai-responses' && api !== 'anthropic-messages') return unknown('payload_codec_unavailable');
  const body = record(payload), messages = body?.[api === 'openai-responses' ? 'input' : 'messages'];
  if (!Array.isArray(messages)) return unknown('payload_shape_unavailable');
  const text = (content: unknown): string | null => {
    if (typeof content === 'string') return content;
    if (content === undefined) return '';
    if (!Array.isArray(content) || content.some(raw => {
      const block = record(raw);
      return !block || !['text', 'image', 'tool_result'].includes(String(block.type)) || block.type === 'text' && typeof block.text !== 'string';
    })) return null;
    return content.flatMap(block => record(block)?.type === 'text' ? [record(block)!.text as string] : []).join('\n');
  };
  const carriers = messages.flatMap<{ role: unknown; text: string | null; toolCallId: unknown }>(raw => {
    const message = record(raw); if (!message) return [];
    if (api === 'anthropic-messages') {
      if (message.role === 'system') {
        const content = Array.isArray(message.content) ? message.content.filter(raw =>
          !['tool_addition', 'tool_removal'].includes(String(record(raw)?.type))) : message.content;
        return [{ role: 'system', text: text(content), toolCallId: undefined }];
      }
      if (message.role !== 'user') return [];
      const blocks = Array.isArray(message.content) ? message.content : [];
      return [{ role: 'user', text: text(message.content), toolCallId: undefined }, ...blocks.flatMap(raw => {
        const block = record(raw);
        return block?.type === 'tool_result' ? [{ role: 'tool', text: text(block.content), toolCallId: block.tool_use_id }] : [];
      })];
    }
    const role = message.type === 'function_call_output' ? 'tool' : message.role === 'developer' ? 'system' : message.role;
    const content = message.type === 'function_call_output' ? message.output : message.content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content)
      ? content.flatMap(block => typeof record(block)?.text === 'string' ? [record(block)!.text as string] : []) : [];
    return [{ role, text: texts.join('\n'), toolCallId: message.tool_call_id ?? message.call_id }];
  });
  if (api === 'anthropic-messages') carriers.push({ role: 'system', text: text(body?.system), toolCallId: undefined });
  return expected.map(item => {
    if (item.text === null) return { inclusion: 'unknown', reason: 'derived-source-only' };
    const matching = carriers.filter(carrier => carrier.role === item.role && (item.toolCallId === undefined ||
      carrier.toolCallId === (api === 'anthropic-messages' ? anthropicToolId(item.toolCallId) : item.toolCallId.split('|')[0])));
    if (matching.some(carrier => carrier.text !== null && (item.role === 'system' || item.contains
      ? carrier.text.includes(sanitizeSurrogates(item.text!)) : carrier.text === sanitizeSurrogates(item.text!)))) return { inclusion: 'confirmed', reason: null };
    return matching.some(carrier => carrier.text === null) ? { inclusion: 'unknown', reason: 'payload_shape_unavailable' }
      : { inclusion: 'not-included', reason: null };
  });
}

export async function checkResourceWire(api: string, request: RequestInfo | URL, init: RequestInit | undefined,
  expected: readonly ResourcePayloadText[]): Promise<ResourceInclusion[]> {
  try {
    const body = typeof init?.body === 'string' ? init.body : init?.body === undefined && request instanceof Request ? await request.clone().text() : null;
    return body === null ? expected.map(() => ({ inclusion: 'unknown', reason: 'body_unavailable' }))
      : checkResourcePayload(api, JSON.parse(body), expected);
  } catch { return expected.map(() => ({ inclusion: 'unknown', reason: 'body_unavailable' })); }
}
