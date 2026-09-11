export type BudgetLimits = { maxModelRequests: number; maxToolCalls: number; wallTimeMs: number };
export type UsageSample = { inputTokens: number | null; outputTokens: number | null };
export type BudgetRemaining = { modelRequests: number; toolCalls: number; wallTimeMs: number; usage: { known: boolean; inputTokens: number; outputTokens: number; unknownSamples: number } };

export class BudgetExceededError extends Error {
  constructor(public readonly code: "MODEL_REQUEST_BUDGET_EXCEEDED" | "TOOL_CALL_BUDGET_EXCEEDED" | "WALL_TIME_BUDGET_EXCEEDED", message = code) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

type Pool = { limits: BudgetLimits; modelRequests: number; toolCalls: number; startedAt: number; inputTokens: number; outputTokens: number; unknownSamples: number };

export class BudgetLedger {
  private readonly pool: Pool;
  private readonly limits: BudgetLimits;
  private modelRequests = 0;
  private toolCalls = 0;

  constructor(limits: BudgetLimits, pool?: Pool) {
    this.limits = limits;
    this.pool = pool ?? { limits, modelRequests: 0, toolCalls: 0, startedAt: Date.now(), inputTokens: 0, outputTokens: 0, unknownSamples: 0 };
  }

  child(limits: BudgetLimits): BudgetLedger {
    return new BudgetLedger(limits, this.pool);
  }

  reserveModelRequest(): void {
    this.ensureWallTime();
    if (this.modelRequests >= this.limits.maxModelRequests || this.pool.modelRequests >= this.pool.limits.maxModelRequests) throw new BudgetExceededError("MODEL_REQUEST_BUDGET_EXCEEDED");
    this.modelRequests += 1;
    this.pool.modelRequests += 1;
  }

  reserveToolCall(): void {
    this.ensureWallTime();
    if (this.toolCalls >= this.limits.maxToolCalls || this.pool.toolCalls >= this.pool.limits.maxToolCalls) throw new BudgetExceededError("TOOL_CALL_BUDGET_EXCEEDED");
    this.toolCalls += 1;
    this.pool.toolCalls += 1;
  }

  recordUsage(sample: UsageSample): void {
    if (sample.inputTokens === null || sample.outputTokens === null) {
      this.pool.unknownSamples += 1;
      return;
    }
    this.pool.inputTokens += sample.inputTokens;
    this.pool.outputTokens += sample.outputTokens;
  }

  remaining(): BudgetRemaining {
    const elapsed = Date.now() - this.pool.startedAt;
    return {
      modelRequests: Math.max(0, Math.min(this.limits.maxModelRequests - this.modelRequests, this.pool.limits.maxModelRequests - this.pool.modelRequests)),
      toolCalls: Math.max(0, Math.min(this.limits.maxToolCalls - this.toolCalls, this.pool.limits.maxToolCalls - this.pool.toolCalls)),
      wallTimeMs: Math.max(0, Math.min(this.limits.wallTimeMs - elapsed, this.pool.limits.wallTimeMs - elapsed)),
      usage: { known: this.pool.unknownSamples === 0, inputTokens: this.pool.inputTokens, outputTokens: this.pool.outputTokens, unknownSamples: this.pool.unknownSamples },
    };
  }

  private ensureWallTime(): void {
    if (Date.now() - this.pool.startedAt >= this.limits.wallTimeMs || Date.now() - this.pool.startedAt >= this.pool.limits.wallTimeMs) throw new BudgetExceededError("WALL_TIME_BUDGET_EXCEEDED");
  }
}
