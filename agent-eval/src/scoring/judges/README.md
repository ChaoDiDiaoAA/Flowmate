# 独立 Judge

Judge 复用现有 Pi SDK ModelRuntime.completeSimple、模型目录和原生能力解析；模型、凭据与主 Agent 独立，不装配业务工具。FLOWMATE_JUDGE_API 显式优先，未设置时兼容旧 PROVIDER 的 anthropic／openai-compatible 映射，均未设置时默认 openai-completions。默认及本次采用的超时为180000毫秒，可显式覆盖；取消有效，SDK 自动生成重试关闭，每 Trial 最多一次生成。 新增 SDK 调用事实记录实际 API、解析模型、SDK 信息、完成原因和原始用量；未知用量不填零。旧 HTTP Judge 记录按原协议只读校验，保留原参数和成绩，不以新 SDK 规则重解释。

每 Trial 最多一次生成请求，输出普通 JSON r／f 及适用的 research atoms／links／chains。没有事实、失败明细、引用、链或原文位置的固定输出配额；保留实际分母、范围、来源及计数校验，研究比例由本地推导。

完成原因、结构错误、截断、缺证据与注入均检查。旧 packed.ts 只保留历史报告的定宽解码和 Prompt 身份，不用于新生成；旧报告不补造新分数。数据校验、Judge off 和本地结果上传不调用评分模型。
