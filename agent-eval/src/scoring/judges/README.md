# 独立 Judge

Judge 复用现有 Pi SDK ModelRuntime.completeSimple、模型目录和原生能力解析；模型、凭据与主 Agent 独立，不装配业务工具。FLOWMATE_JUDGE_API 显式优先，未设置时兼容旧 PROVIDER 的 anthropic／openai-compatible 映射，均未设置时默认 openai-completions。默认及本次采用的超时为180000毫秒，可显式覆盖；取消有效，SDK 自动生成重试关闭，每 Trial 最多一次生成。 新增 SDK 调用事实记录实际 API、解析模型、SDK 信息、完成原因和原始用量；未知用量不填零。旧 HTTP Judge 记录按原协议只读校验，保留原参数和成绩，不以新 SDK 规则重解释。

新生成使用按指标 ID 组织的普通 JSON：results 每项包含 metricId、counts（numerator／denominator／unassessable）及 failures（opportunityIndex／code）。业务、研究使用各自固定模板；研究比例由原始 atoms／links／chains 见证在本地计算。单指标缺项、重复或计数错误仅影响该项；研究见证错误仅影响依赖指标。JSON／根结构不可识别或未知指标身份使本次 Judge 无效。保持分母、范围、来源、计数校验和每 Trial 最多一次生成；旧 r/f、packed 及 HTTP 记录按原格式、原提示身份只读校验。没有事实、失败明细、引用、链或原文位置的固定输出配额；保留实际分母、范围、来源及计数校验，研究比例由本地推导。

完成原因、结构错误、截断、缺证据与注入均检查。旧 packed.ts 只保留历史报告的定宽解码和 Prompt 身份，不用于新生成；旧报告不补造新分数。数据校验、Judge off 和本地结果上传不调用评分模型。

Execution 与校准保存实际连接参数及本次固定模板集合。调用／完成错误与逐指标 validationErrors 分开记录、导出；回读按原模板重新校验。原始 Judge JSON 保留未知字段的形状以复现协议错误，其中摘要值替换为 `[omitted]`，不保存摘要或指纹；其他公开元数据继续移除摘要字段。

完整采证确认当前没有 Report 时，研究遗漏和整链缺失由本地规则计算，不请求模型编造见证。回读核对完整报告分页、当前报告指针，以及冻结的版本、required、触发条件和非空分母；不可观察的集合不适用这条规则。源码条件快照包含研究帧／见证计数、精确十进制和引用核验的实际实现，使用实际内容限定比较范围。
