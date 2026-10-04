import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@earendil-works/pi-ai';
import { sanitizeSurrogates } from '@earendil-works/pi-ai/utils/sanitize-unicode';
import { appError, fail, ok } from '@flowmate/contracts';
import type { ContextEvidenceReason, Result } from '@flowmate/contracts';

export type InclusionFact = { inclusion: 'confirmed'; reason: null } | { inclusion: 'unavailable'; reason: ContextEvidenceReason };
type ExpectedUser = { texts: string[]; images: string[]; toolIds?: string[]; order?: ('text' | 'image')[] };
export type PayloadCodec = { api: 'openai-completions' | 'openai-responses'; users: ExpectedUser[]; toolImages: { callId: string; texts: string[]; images: string[] }[] };
const imageCaption = 'Attached image(s) from tool result:';
const mismatch = () => fail(appError('context_payload_mismatch', 'runtime', 'The outgoing payload does not preserve the request inputs.'));
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Message boundaries remain intact; identity was established before this text codec. */
export function preparePayloadCodec(api: string, context: Pick<Context, 'messages'>, supportsImages: boolean): Result<PayloadCodec | undefined> {
  const hasImages = context.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image'));
  if (hasImages && (!supportsImages || !['openai-completions', 'openai-responses'].includes(api))) return mismatch();
  if (api !== 'openai-completions' && api !== 'openai-responses') return ok(undefined);
  const users: ExpectedUser[] = []; const toolImages: PayloadCodec['toolImages'] = [];
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
