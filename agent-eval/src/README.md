# 评测源码

Badcase附加专项复用dataset-loader及Harness，声明位于datasets/badcase/；基线声明、Full62／Smoke14及默认all不扩充。regression-origin.ts校验质量侧来源，reports/regressions.ts只从保存完成的实际启动Trial登记来源批次CSV，并在status核对报告事实及收录视图；缺声明或CSV错误单独提示。controlled与model明确区分，来源和核验说明不进入Agent输入，平台仅显式上传白名单身份，不上传核验正文。

`datasets/` 基线直属声明保持 `cases.ts`、`gold.ts` 和 `review.ts` 三个文件，附加专项使用 `badcase/` 子目录的成员引用及独立声明；按 Harness 功能分组，加载后按 ID 排序。类型、严格校验和选集放在 `dataset-loader/`，私有场景与可独立读取的原始样本放在 `testing/`。

Case 的 `input.prompt` 保存首轮，`input.turns` 保存后续用户输入；场景通过 `turnId` 逐轮提交。源码复制和挂载排除 `datasets/`、`testing/`，Agent 只接收当前已授权输入和实际选用的产品资源，不能提前看到后续轮次、Gold、Review 或答案提示。

执行、评分、报告和平台模块沿用现有结构。公开版本固定 `v1`，评测数据和保存产物不含哈希／指纹；真实评测操作见外层中文 README，完整契约见[公开评测指南](../../docs/public/EVALUATION.zh-CN.md)。

`reports/paths.ts` 统一创建与按 ID 查找业务、研究、混合及校准结果，兼容旧平铺目录并拒绝重复身份。`reports/badcases.ts` 从原报告、实际反馈和已经通过可比性检查的结果派生 `flowmate-badcase-index/v1`；`badcases.json` 与 `badcases.md` 不更改分数或代替人审。`status` 只读重新派生，`compare` 保留原逐题数组并附加待核验 `badcase`。

详细工具记录在 `evidence/<trial-id>/observation.json`；`events.jsonl` 保存 Run span。新运行按声明全集归入 `runs/business/`、`research/` 或 `mixed/`，校准归入 `runs/calibration/`。跨执行的问题和实际暴露／复测记录放在 `agent-eval/records/<批次>/`，总目录见[公开评测指南](../../docs/public/EVALUATION.zh-CN.md#reports)，职责及生成条件见[公开评测指南](../../docs/public/EVALUATION.zh-CN.md#reports)。

评测主模型、Judge 和 Langfuse 分别从 configs/.env 的专用字段读取；主模型可由 CLI 临时覆盖，密钥只经回调传给隔离 Host。模型容量复用 Pi SDK 原生目录，不设评测输入输出额度。


## Trial次数、Case指标及重复诊断

CLI统一--trials N（默认1，范围1–20），旧--repeat启动前拒绝。Case定义不加repetition／trialId；它们位于Trial记录。内部repeat／repetition和历史报告／CSV兼容。Smoke、Full、单题及专项共同支持；Full --trials 5计划310个Trial，Smoke为70。每次Trial显示结论，最终保存后每Case打印自己的适用指标一次，必需未测项仍显示，stderr不打印整段JSON。trialStatistics独立记录pass@k／pass^k及波动，不修改39项公式；旧status可只读派生，不重评分。完整命令、字段及解释见[重复试验说明](../../docs/public/EVALUATION.zh-CN.md#trials)。受控测试不证明真实业务稳定性。
