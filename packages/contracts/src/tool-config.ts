import { z } from 'zod';

export const MAX_TOOL_NAME_CHARS = 128;
export const MAX_TOOL_VERSION_CHARS = 32;
// This scope contract is shared with sandboxed preload; keep Node-only Context validation out of its import graph.
export const RunScopeSchema = z.object({ version: z.literal(2),
  allowedTools: z.array(z.string().min(1).max(MAX_TOOL_NAME_CHARS)).max(64),
  allowedDocumentIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(64),
  allowedArtifactIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(128),
  allowedResourcePaths: z.array(z.string().min(1).max(4_096)).max(64),
}).strict();

/** 业务工具的载荷保护与已有统计策略；Run 预算见 runtime-config.ts。 */
export const TOOL_CONFIG = {
  payload: {
    // 模型提交的原始业务工具参数上限，按 JSON 的 UTF-8 字节计算。
    maxRawArgumentsBytes: 256 * 1024,
    // SDK／Hook 处理后，实际执行参数的持久记录上限。
    maxFinalArgumentsBytes: 64 * 1024,
    // 单次业务工具 data 输出上限。
    maxOutputBytes: 256 * 1024,
    // ToolCall 成功或失败结果封套的持久记录上限，包含状态、错误和数据。
    maxStoredResultEnvelopeBytes: 256 * 1024,
  },
  statistics: {
    // 每个统计分组最多读取最近多少次执行尝试。
    maxAttempts: 200,
    // 在最近多少次尝试中检查超时、停止未确认等风险。
    riskWindowAttempts: 20,
    // 使用统计期限前所需的最少合格样本数。
    minEligibleSamples: 20,
    // 用 P95 执行时间计算统计期限的倍率。
    timeoutMultiplier: 1.5,
    // 统计期限下限；最终仍不得超过 Run 冻结的单工具期限，单位 ms。
    minTimeoutMs: 1_000,
    // 实际注入模型的运行经验摘要最多保留多少项，不放宽既有快照契约。
    maxExperienceItems: 64,
  },
} as const;
