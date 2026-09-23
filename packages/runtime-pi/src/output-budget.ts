import { appError, fail, ok, type OutputBudget, type Result } from '@flowmate/contracts';

// A product cost/latency default, never a claim about an unknown model's capacity.
const automaticCap = 8192;

export function resolveOutputBudget(requested: number | undefined, modelMaxTokens: number | null): Result<OutputBudget> {
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1
    || (modelMaxTokens !== null && requested > modelMaxTokens))) {
    return fail(appError('config_output_budget_invalid', 'input', '输出预算必须为正安全整数，且不能超过已知模型输出上限。'));
  }
  return ok({
    version: 1, policy: 'model-aware/v1', requestedMaxTokens: requested ?? null,
    selectedMaxTokens: requested ?? Math.min(modelMaxTokens ?? automaticCap, automaticCap),
    modelMaxTokens, automaticCap,
    source: requested !== undefined ? 'explicit' : modelMaxTokens === null ? 'fallback' : 'model-metadata',
  });
}
