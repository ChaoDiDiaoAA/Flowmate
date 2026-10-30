import type { Api, Model, TranscriptContext } from '@earendil-works/pi-ai';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { appError, fail, ok, RUNTIME_CONFIG, type Result } from '@flowmate/contracts';

/** Assess the final transcript, after product facts and the effective tool set were assembled. */
export function assessDurableContextCapacity(context: TranscriptContext, model: Pick<Model<Api>, 'contextWindow' | 'maxTokens'>,
  maxOutputTokens?: number): Result<{ inputTokens: number; reserveTokens: number; contextWindow: number }> {
  const inputTokens = estimateContextTokens(context).tokens;
  const reserveTokens = Math.max(RUNTIME_CONFIG.compaction.reserveTokens, maxOutputTokens ?? model.maxTokens);
  return inputTokens + reserveTokens <= model.contextWindow
    ? ok({ inputTokens, reserveTokens, contextWindow: model.contextWindow })
    : fail(appError('context_capacity_exceeded', 'runtime', 'The estimated invoice context and reserved output space exceed the original model window.'));
}
