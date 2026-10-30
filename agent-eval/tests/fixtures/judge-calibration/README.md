# 合成 Judge 参考素材

本目录是测试素材，不是 Agent 评测数据集。保留原始 56 份单指标参考，并新增 8 份组合参考，共 64 份，覆盖 28 项正式语义指标和 2 项语义诊断。任务／工具、历史／压缩、安全／正常任务、研究见证四类组合各有独立 tune／validation 实例；研究部分复用已核对来源。没有真实模型输出或独立人工批准记录。公开版本固定 `v1`，不保存哈希；重复实例、跨分区复用、路径越界和非法字段在加载时拒绝。

第一阶段仅注入模拟 Transport，验证结构评分协议、错误、截断、取消、模型元数据和实际用量。参考答案不发送给 Agent，也不进入 Judge 请求。每份参考最多一次生成，无自动重试；已取消固定输出额度、温度和校准总 Token 预算。工程报告 `acceptance` 保持 `not-assessed`，不能当作真实校准通过。

新参考可用 `parsePolicy: "metric-json-fence-strict-counts/v1"` 明确选择当前解析政策，并提供 referenceWire 的真实机会见证；没有该字段的旧参考保持原解析规则。当前 DR01 调参与验证样本显式登记此政策，原 wire 和真值未改。非研究项 failures 数必须与已知失败计数及原机会索引完全相符；研究项 counts 为 null，比例由 atoms／links／chains 独立推导。

研究见证的类型示例为 `{"atoms":[{"block":0,"start":0,"length":1,"correct":1,"needsCitation":true,"covered":1,"gold":0,"matchUncertain":false}],"links":[{"atom":0,"state":1}],"chains":[1,0,2]}`。索引／偏移／长度和 chain 状态是 JSON 数字，两个布尔字段保持 boolean；示例只解释类型，实际数组长度、正文位置和证据状态必须取本份参考。受控回归组合检查完整围栏、错误前后文字、缺失失败见证、字符串研究偏移、403／402 和脱敏错误，保留逐指标隔离，不执行真实模型。

真实校准属于后续阶段。本轮合成结果只在测试临时目录生成并清理，不执行真实 Judge 请求，不在这里保存真实运行结果。

`--metric <metricId>` 从同一份参考中筛选执行目标，原始计划、标签、独立证据和作者身份保持不变；不指定时执行该参考的完整组合。新请求使用 `semantic-metric-batch` v1 / `metric-json-independent/v1`，原始 `referenceWire` 仍按文档声明的冻结规则核对。单项与组合输出按 Metric ID 匹配，不按位置配对。新增组合样例完全合成，未修改原始 56 份参考、Benchmark 成员或其 Gold；需要真人验收时应另行提供有独立来源的 human-reference。
