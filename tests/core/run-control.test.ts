import { describe, expect, it } from "vitest";
import { BudgetExceededError, BudgetLedger } from "../../packages/core/src/runtime/budget.ts";

describe("run budget ledger", () => {
  it("enforces model and tool reservations without treating unknown usage as zero", () => {
    const ledger = new BudgetLedger({ maxModelRequests: 2, maxToolCalls: 1, wallTimeMs: 1_000 });
    ledger.reserveModelRequest();
    ledger.reserveModelRequest();
    expect(() => ledger.reserveModelRequest()).toThrow(BudgetExceededError);
    ledger.reserveToolCall();
    expect(() => ledger.reserveToolCall()).toThrow("TOOL_CALL_BUDGET_EXCEEDED");
    ledger.recordUsage({ inputTokens: null, outputTokens: null });
    expect(ledger.remaining()).toMatchObject({ modelRequests: 0, toolCalls: 0, usage: { known: false, unknownSamples: 1 } });
  });

  it("shares a parent budget with a child ledger", () => {
    const parent = new BudgetLedger({ maxModelRequests: 2, maxToolCalls: 2, wallTimeMs: 1_000 });
    const child = parent.child({ maxModelRequests: 2, maxToolCalls: 2, wallTimeMs: 1_000 });
    child.reserveModelRequest();
    parent.reserveModelRequest();
    expect(() => child.reserveModelRequest()).toThrow("MODEL_REQUEST_BUDGET_EXCEEDED");
  });
});
