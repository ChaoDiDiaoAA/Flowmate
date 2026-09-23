import type { LocalCase } from '../datasets/local.ts';
import type { CaseExecutionResult, EvidenceFact } from '../types.ts';
/** Controller-only setup and steps must never be copied wholesale into model input. */
export type AgentTrial = {
    identity: CaseExecutionResult['identity'];
    directory: string;
    input: CaseExecutionResult['input'];
    requires: string[];
    setup?: LocalCase['setup'];
    steps?: LocalCase['steps'];
    configuration: Record<string, unknown>;
};
export interface AgentTrialSession {
    /** Actual initial visible input after controlled setup, before any model call. */
    input: CaseExecutionResult['input'];
    execute(signal: AbortSignal): Promise<CaseExecutionResult>;
    snapshot(): Promise<CaseExecutionResult>;
    cancel(): Promise<void>;
    close(): Promise<EvidenceFact>;
}
export interface AgentKernel {
    readiness(): {
        ready: boolean;
        reason: string;
    };
    prepare(trial: AgentTrial, signal: AbortSignal): Promise<AgentTrialSession>;
}
// No environment flag can promote the current Provider implementation to an Agent.
export const productAgent: AgentKernel = {
    readiness: () => ({ ready: false, reason: '完整 Agent 尚未实现，统一 Benchmark 未启用。Provider 直调不能替代 Agent；本次未调用模型。' }),
    async prepare() { throw new Error('Agent product adapter is not implemented'); },
};
