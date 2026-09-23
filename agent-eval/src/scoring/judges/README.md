# 本地 LLM Judge

answer-relevance.ts 是首个 Judge，Rubric v4 根据任务成功/失败标准评价回答相关性、解释完整性与材料支持；只评价其中语义要求，不能证明保存、金额或文件事实。client.ts 请求模型，harness.ts 校验结构并记录每次调用；这些均由本地 Runner 控制，不调用平台 Evaluator。本次标准投影和 Rubric 变更尚未进行真实调用或人工校准。

.env 独立配置 FLOWMATE_JUDGE_PROVIDER（anthropic/openai-compatible）、MODEL、BASE_URL（API 根地址）、API_KEY、TEMPERATURE=0.8、MAX_TOKENS=256、TIMEOUT_MS=30000。不继承 Agent 参数或密钥。完全未配置允许 auto 下未测；部分填写或 required 缺配置在 Agent 启动前报错。

整个 Trial 到达终点、选中且适用、必要证据齐全、冻结预算足够才调用。多轮还要求实际 interaction-history；不包含 Gold 或未来交互脚本。确定性高低分均不控制 Judge。每 Trial 至多一次，累计输出上限 15000 Token，重复计划重新校验，不自动扩额、重试或切模。

任务语义无法由确定性约束证明时，清单 judges.requiredFor 引用对应 Case ID。auto 缺必要配置时预检失败；显式 off 仍保存必要 Judge 未测状态，任务不可 PASS。该引用不额外注册评分器或增加调用次数。

输出仅 JSON：score 为 0、0.5、1，reason 非空。结构错误、非法分数、空解释、接口失败、超时均保存 null/error，保留实际尝试，不静默夹取分数，不自动生成“人工已审核”。所有待评证据作为不可信数据。

tests/fixtures/judges 保留六类历史校准样例（参考 pending）；协议 Mock 不是质量校准。模型、Rubric 或关键参数变化需保存新配置身份并重新对照人工参考。当前真实模型兼容、人工校准尚未完成；运行记录在 runs/，此目录不放成绩。
