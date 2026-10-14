# 独立 Judge

Judge仅评判Case事前选择且适用的语义指标；空语义集合不生成计划、不准备模型或读取Judge配置。数据集按requiredFor登记有语义计划的成员，required模式不强制纯确定性Case调用。已选指标的缺证据、未触发、取消及设施错误分别保留，不改成不适用。每Trial最多一次生成表示上限，正常零调用不算漏判。

Judge 复用现有 Pi SDK ModelRuntime.completeSimple、模型目录和原生能力解析；模型、凭据与主 Agent 独立，不装配业务工具。FLOWMATE_JUDGE_API 显式优先，未设置时兼容旧 PROVIDER 的 anthropic／openai-compatible 映射，均未设置时默认 openai-completions。默认及本次采用的超时为180000毫秒，可显式覆盖；取消有效，SDK 自动生成重试关闭，每 Trial 最多一次生成。 新增 SDK 调用事实记录实际 API、解析模型、SDK 信息、完成原因和原始用量；未知用量不填零。旧 HTTP Judge 记录按原协议只读校验，保留原参数和成绩，不以新 SDK 规则重解释。

新生成使用 `semantic-metrics-business-v2`／`semantic-metrics-research-v2` 模板，公开版本仍为 v1，以明确模板身份及 `metric-json-fence-strict-counts/v1` parsePolicy 选择解析规则，不凭数字版本推断。results 每项包含 metricId、counts（numerator／denominator／unassessable）及 failures（opportunityIndex／code）；分母、范围、来源和类型严格核验，已知失败的数量必须与原机会见证完全一致。仅剥一层完整外部 json／无语言 Markdown 围栏，不截取子串、补括号、转换字符串数值或重写 raw。compact 另记 normalization（none／markdown-fence），并保留实际模板与逐指标错误。

研究模板给出数字 block／start／length、links.atom 和 numeric chains 的类型示例，业务模板不混入研究见证。研究比例由 atoms／links／chains 在本地计算；缺项、重复或计数错误仅影响对应指标，研究见证错误仅影响依赖项；整 JSON 结构或未知指标身份错误使本次 Judge 无效。旧 semantic-metrics-business／research 的 exact prompt 和 parser、r/f、packed 及 HTTP 记录保持原解释，不用新政策重判历史失败／成功。没有固定失败条数、事实、引用或原文位置配额。

完成原因、结构错误、截断、缺证据与注入均检查。旧 packed.ts 只保留历史报告的定宽解码和 Prompt 身份，不用于新生成；旧报告不补造新分数。数据校验、Judge off 和本地结果上传不调用评分模型。

Execution 与校准保存实际连接参数及模板集合。调用／完成错误、逐指标 validationErrors、parsePolicy／normalization 与实际 transportStatus 分开记录、导出；HTTP 402／401／403 取受控传输实际状态，不从模型文字猜外部故障。回读以 exact prompt 和明确政策核对原始响应，缺字段的旧记录保持原语义。原始 Judge JSON 保留未知字段形状复现错误，其中摘要值替换为 `[omitted]`，其他公开元数据继续移除摘要字段。配置密钥在请求前检查、原响应及错误经同一脱敏边界保存。

完整采证确认当前没有 Report 时，研究遗漏和整链缺失由本地规则计算，不请求模型编造见证。回读核对完整报告分页、当前报告指针，以及实际版本、required、触发条件和非空分母；不可观察的集合不适用这条规则。源码条件快照包含研究帧／见证计数、精确十进制和引用核验的实际实现，使用实际内容限定比较范围。
