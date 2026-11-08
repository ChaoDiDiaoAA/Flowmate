import { appError, fail, ok, type CloudModelAttemptRequest, type Result } from '@flowmate/contracts';
import type { CloudModelAttempts } from '../packages/core/src/personal-agent/cloud-model-attempts.ts';

type Options = {
  ledger: CloudModelAttempts;
  readApiKey(): string | undefined | Promise<string | undefined>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  onText?(request: CloudModelAttemptRequest, text: string): void;
  onTextGap?(request: CloudModelAttemptRequest): void;
};
const unknown = () => fail(appError('cloud_model_result_unknown', 'runtime', 'The original model transport result is not safely repeatable.', true));

function deepSeekTerminal() {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', overflow = false, afterCR = false, dataCount = 0, data = '', invalid = false, done = false;
  const finishLine = () => {
    if (!line && !overflow) {
      if (dataCount === 1 && data === '[DONE]') done = true;
      dataCount = 0; data = '';
    } else if (line === 'data' || line.startsWith('data:')) {
      dataCount++; data = overflow || line === 'data' ? '' : line.slice(5).replace(/^ /, '');
    }
    line = ''; overflow = false;
  };
  return (chunk: Uint8Array): boolean => {
    if (done || invalid) return done;
    try {
      for (const character of decoder.decode(chunk, { stream: true })) {
        if (afterCR) { afterCR = false; if (character === '\n') continue; }
        if (character === '\r' || character === '\n') { finishLine(); afterCR = character === '\r'; }
        else if (line.length < 64) line += character;
        else overflow = true;
      }
    } catch { invalid = true; }
    return done;
  };
}

function deepSeekText(onText: (text: string) => void, onGap: () => void) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', data: string[] = [], size = 0, lineOverflow = false, eventOverflow = false, afterCR = false, invalid = false;
  const gap = () => { try { onGap(); } catch { /* A temporary preview never changes the model transport. */ } };
  const finishLine = () => {
    if (!line && !lineOverflow) {
      if (eventOverflow) gap();
      else if (data.length) {
        const payload = data.join('\n');
        if (payload !== '[DONE]') {
          try {
            const event: unknown = JSON.parse(payload), choices = event && typeof event === 'object' && 'choices' in event ? event.choices : null;
            const first: unknown = Array.isArray(choices) ? choices.find((value: unknown) => value && typeof value === 'object'
              && 'index' in value && value.index === 0) : null;
            const delta = first && typeof first === 'object' && 'delta' in first ? first.delta : null;
            const content = delta && typeof delta === 'object' && 'content' in delta ? delta.content : null;
            if (typeof content === 'string' && content) { try { onText(content); } catch { gap(); } }
          } catch { gap(); }
        }
      }
      data = []; size = 0; eventOverflow = false;
    } else if (lineOverflow) eventOverflow = true;
    else if (line === 'data' || line.startsWith('data:')) {
      const part = line === 'data' ? '' : line.slice(5).replace(/^ /, ''); size += part.length;
      if (size > 65_536) eventOverflow = true; else data.push(part);
    }
    line = ''; lineOverflow = false;
  };
  return (chunk: Uint8Array) => {
    if (invalid) return;
    try {
      for (const character of decoder.decode(chunk, { stream: true })) {
        if (afterCR) { afterCR = false; if (character === '\n') continue; }
        if (character === '\r' || character === '\n') { finishLine(); afterCR = character === '\r'; }
        else if (line.length < 65_536) line += character;
        else lineOverflow = true;
      }
    } catch { invalid = true; gap(); }
  };
}

/** The runtime supplies a bound request body; only Authority supplies the fixed endpoint and credential. */
export class CloudDeepSeekProxy {
  constructor(private readonly options: Options) {}

  async send(request: CloudModelAttemptRequest, signal?: AbortSignal): Promise<Result<Response>> {
    if (signal?.aborted) return fail(appError('run_cancelled', 'runtime', 'The model request was cancelled before transport.'));
    let original: CloudModelAttemptRequest;
    try { original = structuredClone(request); }
    catch { return fail(appError('input_invalid', 'input', 'The cloud model request is invalid.')); }
    const reserved = await this.options.ledger.reserve(original); if (!reserved.ok) return reserved;
    if (reserved.data.state === 'confirmed') {
      const saved = await this.options.ledger.confirmedStatus(original); if (!saved.ok) return saved;
      // A confirmed failure status can be observed again without repeating its provider request.
      return saved.data !== null && saved.data >= 400
        ? ok(new Response(null, { status: saved.data, headers: { 'content-type': 'application/json' } })) : unknown();
    }
    if (reserved.data.state !== 'reserved') return unknown();
    let key: string | undefined;
    try { key = await this.options.readApiKey(); } catch { /* Authentication remains unavailable. */ }
    if (!key?.trim()) return fail(appError('provider_auth_failed', 'provider', 'The Authority model credential is unavailable.'));
    if (signal?.aborted) return fail(appError('run_cancelled', 'runtime', 'The model request was cancelled before transport.'));
    const started = await this.options.ledger.begin(original); if (!started.ok) return started;
    let upstream: Response;
    try {
      upstream = await (this.options.fetch ?? globalThis.fetch)('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: original.body, signal,
      });
    } catch {
      await this.options.ledger.settle(original, { kind: 'uncertain' });
      return unknown();
    }
    const status = upstream.status;
    let settled: Promise<Result<void>> | undefined;
    const settle = (outcome: { kind: 'uncertain' } | { kind: 'confirmed'; httpStatus: number }) =>
      settled ??= this.options.ledger.settle(original, outcome);
    const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    const headers = { 'content-type': contentType === 'text/event-stream' ? 'text/event-stream' : 'application/json' };
    if (!upstream.body) {
      const saved = await settle(contentType === 'text/event-stream' ? { kind: 'uncertain' } : { kind: 'confirmed', httpStatus: status });
      return saved.ok && contentType !== 'text/event-stream' ? ok(new Response(null, { status, headers })) : unknown();
    }
    const reader = upstream.body.getReader(), terminal = deepSeekTerminal(); let cancelled = false, complete = false;
    const preview = contentType === 'text/event-stream' && status === 200 && original.kind !== 'compaction' && !original.child && !original.participant && this.options.onText
      ? deepSeekText(text => this.options.onText!(original, text), () => this.options.onTextGap?.(original)) : null;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (cancelled) return;
          if (!part.done) {
            preview?.(part.value);
            if (contentType === 'text/event-stream' && terminal(part.value)) {
              complete = true;
              const saved = await settle({ kind: 'confirmed', httpStatus: status });
              if (!saved.ok) { controller.error(Error('cloud_model_result_unknown')); return; }
              if (cancelled) return;
            }
            controller.enqueue(part.value); return;
          }
          const incomplete = contentType === 'text/event-stream' && !complete;
          const saved = await settle(incomplete ? { kind: 'uncertain' } : { kind: 'confirmed', httpStatus: status });
          if (saved.ok && !incomplete) controller.close(); else controller.error(Error('cloud_model_result_unknown'));
        } catch {
          await settle({ kind: 'uncertain' });
          if (!cancelled) controller.error(Error('cloud_model_result_unknown'));
        }
      },
      async cancel() {
        cancelled = true;
        const saved = settle({ kind: 'uncertain' });
        try { await reader.cancel(); } finally { await saved; }
      },
    });
    return ok(new Response(body, { status, headers }));
  }
}
