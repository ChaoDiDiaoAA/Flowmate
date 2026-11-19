import type { NativeOutcome, SdkUsageValues, TokenColumns, UsageRecord, UsageRecordV2 } from '@flowmate/contracts';

type RunUsage = { usage: UsageRecord; tokens: TokenColumns };

const MAX_RECORDED_CALLS = 64; // Matches UsageRecordV2Schema.
const sdkFields: readonly (keyof SdkUsageValues)[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens',
  'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite', 'costTotal'];

function sumKnown(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}

function sumCost(values: readonly (string | null)[]): string | null {
  let total = 0n, scale = 0;
  for (const value of values) {
    if (value === null) return null;
    // Pi serializes numeric costs as strings, including scientific notation.
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
    if (!match) return null;
    const fraction = match[3] ?? '';
    const exponent = Number(match[4] ?? 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
    const places = fraction.length - exponent;
    const coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
    const nextScale = Math.max(scale, places);
    total = total * 10n ** BigInt(nextScale - scale) + coefficient * 10n ** BigInt(nextScale - places);
    scale = nextScale;
  }
  if (scale === 0) return String(total);
  const digits = String(total < 0n ? -total : total).padStart(scale + 1, '0');
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return `${total < 0n ? '-' : ''}${digits.slice(0, -scale)}${fraction ? '.' + fraction : ''}`;
}

function callDetails({ usage, tokens }: RunUsage): UsageRecordV2['calls'] {
  if (usage.version === 1) return [{ callSequence: 1, usage, tokens }];
  const { calls, ...aggregate } = usage;
  return calls.length ? calls : [{ callSequence: 1, usage: { ...aggregate, version: 1 }, tokens }];
}

export function addResearchReviewUsage(
  base: RunUsage,
  reviews: readonly Pick<NativeOutcome, 'usage' | 'tokens'>[],
): RunUsage {
  const attempted = reviews.filter(({ usage }) => usage.attempts !== 0);
  if (!attempted.length) return base;

  const entries = base.usage.attempts === 0 ? attempted : [base, ...attempted];
  const calls = base.usage.version === 2 ? [...base.usage.calls] : callDetails(base).filter(call => call.usage.attempts !== 0);
  let sequence = Math.max(0, ...calls.map(call => call.callSequence));
  for (const review of attempted) {
    for (const call of callDetails(review)) {
      if (calls.length >= MAX_RECORDED_CALLS) break;
      if (call.usage.attempts === 0) continue;
      do sequence = sequence === Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
      while (calls.some(existing => existing.callSequence === sequence));
      calls.push({ ...call, callSequence: sequence });
    }
  }

  const inputTokens = sumKnown(entries.map(({ tokens }) => tokens.inputTokens));
  const outputTokens = sumKnown(entries.map(({ tokens }) => tokens.outputTokens));
  const totalTokens = sumKnown(entries.map(({ tokens }) => tokens.totalTokens));
  const cost = sumCost(entries.map(({ tokens }) => tokens.cost));
  const usageComplete = entries.every(({ tokens }) => tokens.usageComplete)
    && inputTokens !== null && outputTokens !== null && totalTokens !== null;
  const source = entries.every(({ usage }) => usage.source === 'sdk') ? 'sdk' : 'unknown';
  let reason: string | null = null;
  if (source === 'unknown') reason = 'one-or-more-model-call-usages-unknown';
  else if (!usageComplete) reason = 'one-or-more-model-call-usages-incomplete';
  const sdkValues = entries.every(({ usage }) => usage.sdkValues !== null)
    ? Object.fromEntries(sdkFields.map(field => [field, sumKnown(entries.map(({ usage }) => usage.sdkValues?.[field] ?? null))])) as SdkUsageValues
    : null;
  const attempts = sumKnown(entries.map(({ usage }) => usage.attempts));
  const costSource = entries[0]!.usage.costSource;
  return {
    usage: {
      version: 2, source, reason, sdkValues, attempts, calls,
      attemptsComplete: attempts !== null && entries.every(({ usage }) => usage.attemptsComplete),
      costSource: entries.every(({ usage }) => usage.costSource === costSource) ? costSource : null,
      updatedAt: attempted.reduce((latest, { usage }) => usage.updatedAt > latest ? usage.updatedAt : latest, base.usage.updatedAt),
    },
    tokens: { inputTokens, outputTokens, totalTokens, cost, usageComplete },
  };
}
