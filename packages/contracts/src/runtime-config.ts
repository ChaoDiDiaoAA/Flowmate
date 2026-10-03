/** 当前 LLM／Run 默认值与请求范围；历史政策字面量留在对应读取契约。 */
export const RUNTIME_CONFIG = {
  runBudget: {
    // 一个新 Run 默认允许的工具调用次数。
    maxToolCalls: 24,
    maxModelCalls: {
      // 有工作区的 Run 默认允许的模型调用次数。
      workspace: 16,
      // 纯文本会话 Run 默认允许的模型调用次数。
      chat: 12,
    },
    // 单工具默认执行期限，单位 ms。
    toolTimeoutMs: 10_000,
    // 一个 Run 累计回送工具结果的容量保护，单位 UTF-8 bytes。
    maxToolFeedbackBytes: 8 * 1024 * 1024,
  },
  request: {
    // 普通 Run 与 Provider 连接测试的默认总期限，单位 ms。
    timeoutMs: 60_000,
    // save-candidate 模式的默认 Run 总期限，单位 ms。
    saveCandidateTimeoutMs: 120_000,
    // 请求停止后等待确认实际停止的时间，单位 ms。
    stopGraceMs: 5_000,
  },
  provider: {
    // Provider 请求默认重试次数，由 Pi 的请求机制执行。
    maxRetries: 0,
    // Provider 重试等待时间限制，单位 ms。
    maxRetryDelayMs: 2_000,
  },
  llmPayload: {
    // 纯文本模型上下文的 UTF-8 字节保护，不是 token 上限。
    maxChatContextBytes: 524_288,
    // 工作区模型上下文的 UTF-8 字节保护，不是 token 上限。
    maxWorkspaceContextBytes: 8_388_608,
    // 模型输出文字的容量保护，沿用现有累计检查语义，单位 UTF-8 bytes。
    maxOutputTextBytes: 262_144,
    // 单条原生 Assistant 内容容量，包含文字与工具请求，单位 UTF-8 bytes。
    maxAssistantContentBytes: 524_288,
  },
  ranges: {
    // 新 Run 工具次数覆盖范围，单位次。
    maxToolCalls: { min: 0, max: 100 },
    // 新 Run 模型次数覆盖范围，单位次。
    maxModelCalls: { min: 1, max: 64 },
    // 单工具期限覆盖范围，单位 ms。
    toolTimeoutMs: { min: 100, max: 1_800_000 },
    // Agent Run 总期限覆盖范围，单位 ms。
    timeoutMs: { min: 100, max: 1_800_000 },
    // Provider 连接测试期限，保留较小的现有上限，单位 ms。
    providerTestTimeoutMs: { min: 100, max: 120_000 },
    // 停止确认时间覆盖范围，单位 ms。
    stopGraceMs: { min: 100, max: 10_000 },
    // Provider 请求重试次数范围，单位次。
    maxRetries: { min: 0, max: 1 },
    // Provider 重试等待时间范围，单位 ms。
    maxRetryDelayMs: { min: 1, max: 5_000 },
  },
} as const;
