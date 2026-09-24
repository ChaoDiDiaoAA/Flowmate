import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type FetchFunction,
  type Model,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { appError, fail, ok } from '@flowmate/contracts';
import type {
  ProviderConfig,
  Result,
} from '@flowmate/contracts';
import { normalizeUsage, prepareModelRuntime, safeUrl } from './model-runtime.ts';
import type { FetchLike, PiProviderDependencies } from './model-runtime.ts';
export type { FetchLike, PiProviderDependencies } from './model-runtime.ts';
import type {
  NativeInput,
  NativeObservation,
  NativeOutcome,
  PreparedProvider,
  ProviderPort,
} from '@flowmate/contracts';

type FetchFacts = {
  attempts: number;
  responseStatus: number | null;
  requestStarted: boolean;
  responseStarted: boolean;
  complete: boolean;
};

const maxOutputBytes = 256 * 1024;

function normalizeText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function mapPiFailure(
  facts: { responseStatus: number | null; responseStarted: boolean; aborted: boolean; stopReason: string; text: string },
): ReturnType<typeof appError> {
  if (facts.aborted || facts.stopReason === 'aborted') {
    return appError('provider_cancelled', 'provider', 'Provider 请求已中止。');
  }
  if (facts.responseStatus === 401 || facts.responseStatus === 403) {
    return appError('provider_auth_failed', 'provider', 'Provider 认证失败。');
  }
  if (facts.responseStatus === 429) {
    return appError('provider_rate_limited', 'provider', 'Provider 请求受到限流。', true);
  }
  if (facts.stopReason === 'output_limit') {
    return appError('provider_output_limit', 'provider', 'Provider 响应超过输出限制。', false);
  }
  if (!facts.responseStarted && facts.stopReason === 'error') {
    return appError('provider_network_error', 'provider', 'Provider 请求未建立响应。', true);
  }
  if (facts.stopReason === 'length') {
    return appError('provider_incomplete_response', 'provider', 'Provider 因模型或服务端输出限制提前结束，未返回完整文本。');
  }
  if (facts.stopReason === 'toolUse' || facts.stopReason === 'deferred' || !facts.text) {
    return appError('provider_incomplete_response', 'provider', 'Provider 未返回完整文本。');
  }
  return appError(
    facts.responseStarted ? 'provider_stream_interrupted' : 'provider_network_error',
    'provider',
    facts.responseStarted ? 'Provider 响应流中断。' : 'Provider 请求未建立响应。',
    true,
  );
}

function projectUserText(input: NativeInput): string {
  return `${input.goal}\n\n${input.text}`;
}

function appendWithinUtf8Limit(current: string, delta: string, currentBytes: number): { text: string; bytes: number; exceeded: boolean } {
  const encoder = new TextEncoder();
  let text = '';
  let bytes = currentBytes;
  for (const character of delta) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxOutputBytes) return { text: current + text, bytes, exceeded: true };
    text += character;
    bytes += characterBytes;
  }
  return { text: current + text, bytes, exceeded: false };
}

export class PiProviderAdapter implements ProviderPort {
  private readonly dependencies: PiProviderDependencies;
  private activeExecutions = 0;
  private activePreparations = 0;
  private closed = false;
  private readonly closeErrors = new Map<string, ReturnType<typeof appError>>();

  public constructor(dependencies: PiProviderDependencies = {}) {
    this.dependencies = dependencies;
  }

  public async prepare(
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
  ): Promise<Result<PreparedProvider>> {
    if (this.closed) return fail(appError('provider_closed', 'provider', 'Provider Runtime 已关闭。'));
    this.activePreparations += 1;
    try {
      return await this.prepareInternal(config, limits, signal);
    } finally {
      this.activePreparations -= 1;
    }
  }

  private async prepareInternal(
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
  ): Promise<Result<PreparedProvider>> {
    const prepared = await prepareModelRuntime(config, limits, signal, this.dependencies);
    if (!prepared.ok) return prepared;
    const { runtime, model, snapshot } = prepared.data;

    return ok({
      snapshot,
      execute: async (input, executionSignal, observe) => {
        if (this.closed) return this.closedOutcome();
        this.activeExecutions += 1;
        let deferredRelease = false;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          this.activeExecutions -= 1;
        };
        try {
          return await this.execute(runtime, model, config, input, executionSignal, observe, limits.stopGraceMs, (settled) => {
            deferredRelease = true;
            void settled.then(release, release);
          });
        } finally {
          if (!deferredRelease) release();
        }
      },
    });
  }

  private closedOutcome(): NativeOutcome {
    const error = appError('provider_closed', 'provider', 'Provider Runtime 已关闭。');
    return {
      text: '', partial: false, stopReason: 'closed', responseId: null, responseModel: null, error,
      usage: { version: 1, source: 'not-requested', reason: 'provider-closed', sdkValues: null, attempts: 0, attemptsComplete: true, costSource: null, updatedAt: new Date().toISOString() },
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      stopped: true, cleanupErrors: [],
    };
  }

  private async execute(
    runtime: ModelRuntime,
    model: Model<Api>,
    config: ProviderConfig,
    input: NativeInput,
    signal: AbortSignal,
    observe: (event: NativeObservation) => void,
    stopGraceMs: number,
    deferReleaseUntil: (settled: Promise<unknown>) => void,
  ): Promise<NativeOutcome> {
    const facts: FetchFacts = { attempts: 0, responseStatus: null, requestStarted: false, responseStarted: false, complete: false };
    const baseFetch: FetchLike = this.dependencies.fetch ?? ((request, init) => globalThis.fetch(request, init));
    const fetch: FetchLike = async (request, init) => {
      facts.attempts += 1;
      facts.requestStarted = true;
      const requestUrl = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
      this.dependencies.witness?.({ type: 'fetch_entered', attempt: facts.attempts, url: safeUrl(requestUrl), at: new Date().toISOString() });
      observe({ type: 'request_dispatched', at: new Date().toISOString(), monotonicMs: performance.now(), data: { attempt: facts.attempts, url: safeUrl(requestUrl) } });
      try {
        const response = await baseFetch(request, init);
        facts.responseStatus = response.status;
        facts.responseStarted = true;
        this.dependencies.witness?.({ type: 'fetch_response', attempt: facts.attempts, status: response.status });
        return response;
      } catch (error) {
        this.dependencies.witness?.({ type: 'fetch_error', attempt: facts.attempts, aborted: signal.aborted });
        throw error;
      }
    };

    let finalMessage: AssistantMessage | undefined;
    let streamError: AssistantMessage | undefined;
    let text = '';
    let textBytes = 0;
    let outputLimitExceeded = false;
    let streamFailed = false;
    let wireMaxTokens: number | null = null;
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort(signal.reason);
    if (signal.aborted) abortRequest();
    else signal.addEventListener('abort', abortRequest, { once: true });
    try {
      const context = {
        messages: [{ role: 'user' as const, content: projectUserText(input), timestamp: input.messageTimestamp }],
        tools: [],
      };
      observe({ type: 'model_request', at: new Date().toISOString(), monotonicMs: performance.now(), data: context });
      const stream = runtime.streamSimple(model, context, {
        signal: requestController.signal,
        fetch: fetch as FetchFunction,
        maxRetries: config.parameters.maxRetries,
        maxRetryDelayMs: config.parameters.maxRetryDelayMs,
        onResponse: (response) => {
          facts.responseStatus = response.status;
          facts.responseStarted = true;
          observe({ type: 'response_started', at: new Date().toISOString(), monotonicMs: performance.now(), data: { status: response.status } });
        },
        onPayload: (payload) => {
          if (payload && typeof payload === 'object') {
            const record = payload as Record<string, unknown>;
            const generationConfig = record.generationConfig as Record<string, unknown> | undefined;
            const payloadBudget = record.max_output_tokens ?? record.max_completion_tokens ?? record.max_tokens ?? generationConfig?.maxOutputTokens;
            wireMaxTokens = typeof payloadBudget === 'number' ? payloadBudget : null;
            observe({ type: 'request_budget', at: new Date().toISOString(), monotonicMs: performance.now(), data: {
              wireMaxTokens: typeof wireMaxTokens === 'number' ? wireMaxTokens : null,
            } });
            observe({ type: 'request_dispatched', at: new Date().toISOString(), monotonicMs: performance.now(), data: { model: model.id, keys: Object.keys(record).sort() } });
          }
          return undefined;
        },
      });
      const iterator = (stream as AsyncIterable<AssistantMessageEvent>)[Symbol.asyncIterator]();
      let stopDeadline: number | null = null;
      while (true) {
        const pending = iterator.next();
        let next: IteratorResult<AssistantMessageEvent>;
        if (stopDeadline === null) {
          next = await pending;
        } else {
          const remaining = Math.max(0, stopDeadline - Date.now());
          let timer: ReturnType<typeof setTimeout> | undefined;
          let settled: { kind: 'event'; value: IteratorResult<AssistantMessageEvent> } | { kind: 'timeout' };
          try {
            settled = await Promise.race([
              pending.then((value) => ({ kind: 'event' as const, value })),
              new Promise<{ kind: 'timeout' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining); }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          if (settled.kind === 'timeout') {
            void pending.catch(() => undefined);
            void iterator.return?.().catch(() => undefined);
            deferReleaseUntil(stream.result());
            break;
          }
          next = settled.value;
        }
        if (next.done) {
          facts.complete = true;
          break;
        }
        const event = next.value;
        if (event.type === 'text_delta') {
          if (!outputLimitExceeded) {
            const appended = appendWithinUtf8Limit(text, event.delta, textBytes);
            const acceptedLength = appended.text.length - text.length;
            text = appended.text;
            textBytes = appended.bytes;
            observe({ type: 'text_delta', at: new Date().toISOString(), monotonicMs: performance.now(), data: { length: acceptedLength } });
            if (appended.exceeded) {
              outputLimitExceeded = true;
              stopDeadline = Date.now() + stopGraceMs;
              requestController.abort('output_limit');
            }
          }
        }
        if (event.type === 'start') facts.responseStarted = true;
        if (event.type === 'error') streamError = event.error;
        if (event.type === 'done') finalMessage = event.message;
      }
      if (!outputLimitExceeded) finalMessage ??= await stream.result();
    } catch (error) {
      streamFailed = true;
      const fallback = error instanceof Error ? error.message : '';
      streamError ??= {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: signal.aborted ? 'aborted' : 'error', errorMessage: fallback, timestamp: Date.now(),
      };
    }
    signal.removeEventListener('abort', abortRequest);

    if (streamFailed || (!facts.responseStarted && streamError?.stopReason === 'error')) facts.complete = false;

    if (outputLimitExceeded) {
      this.dependencies.witness?.({ type: 'output_limit_stop', stopped: facts.complete, streamFailed, aborted: requestController.signal.aborted });
      const error = mapPiFailure({ responseStatus: facts.responseStatus, responseStarted: facts.responseStarted, aborted: signal.aborted, stopReason: 'output_limit', text });
      observe({ type: 'native_terminal', at: new Date().toISOString(), monotonicMs: performance.now(), data: { stopReason: 'output_limit' } });
      return {
        wireMaxTokens,
        text,
        partial: true,
        stopReason: 'output_limit',
        responseId: null,
        responseModel: model.id,
        error,
        usage: { version: 1, source: 'unknown', reason: 'output-limit', sdkValues: null, attempts: facts.attempts || null, attemptsComplete: false, costSource: null, updatedAt: new Date().toISOString() },
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        stopped: facts.complete,
        cleanupErrors: facts.complete ? [] : [appError('stop_unconfirmed', 'runtime', 'Provider 停止未确认。', true)],
      };
    }
    const message = finalMessage ?? streamError;
    if (!message) {
      const error = mapPiFailure({ responseStatus: facts.responseStatus, responseStarted: facts.responseStarted, aborted: signal.aborted, stopReason: 'error', text });
      observe({ type: 'native_terminal', at: new Date().toISOString(), monotonicMs: performance.now(), data: { stopReason: 'error' } });
      return { wireMaxTokens, text, partial: text.length > 0, stopReason: 'error', responseId: null, responseModel: null, error, usage: { version: 1, source: 'unknown', reason: 'no-final-message', sdkValues: null, attempts: facts.attempts || null, attemptsComplete: facts.complete, costSource: null, updatedAt: new Date().toISOString() }, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false }, stopped: facts.complete, cleanupErrors: [] };
    }
    const finalText = text || normalizeText(message);
    const error = message.stopReason === 'stop' && finalText.length > 0 ? null : mapPiFailure({ responseStatus: facts.responseStatus, responseStarted: facts.responseStarted, aborted: signal.aborted, stopReason: message.stopReason, text: finalText });
    const usage = normalizeUsage(message, facts, config.connection === undefined);
    observe({ type: 'native_terminal', at: new Date().toISOString(), monotonicMs: performance.now(), data: { stopReason: message.stopReason, responseId: message.responseId ?? null } });
    return {
      wireMaxTokens,
      text: finalText,
      partial: finalText.length > 0 && error !== null,
      stopReason: message.stopReason,
      responseId: message.responseId ?? null,
      responseModel: message.responseModel ?? null,
      error,
      usage: usage.usage,
      tokens: usage.tokens,
      stopped: facts.complete,
      cleanupErrors: [],
    };
  }

  public async close(): Promise<{ stopped: boolean; closed: boolean; errors: readonly ReturnType<typeof appError>[] }> {
    if (this.closed) return { stopped: true, closed: true, errors: [...this.closeErrors.values()] };
    if (this.activeExecutions + this.activePreparations > 0) {
      this.closeErrors.set('stop_unconfirmed', appError('stop_unconfirmed', 'runtime', 'Provider 请求仍在收口。', true));
      return { stopped: false, closed: false, errors: [...this.closeErrors.values()] };
    }
    this.closed = true;
    return { stopped: true, closed: true, errors: [...this.closeErrors.values()] };
  }
}
