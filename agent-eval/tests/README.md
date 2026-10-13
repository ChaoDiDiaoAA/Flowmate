# 评测设施测试

验证加载、执行、采证、评分和保存设施，不生成真实 Agent Benchmark 成绩。根 `test:unit`、`test:integration` 和 `test` 统一发现测试，类型检查包含全部文件；使用 Bun 文件隔离。

| 模块 | 验证内容 |
|---|---|
| `datasets/` | 严格字段、62 题选集、轮次与场景引用、来源隔离、无哈希产物 |
| `execution/` | 快照、独立 Trial、多轮提交／接受／消费、输入投影、停止与清理 |
| `scoring/evaluators/` | 正反例、缺证据、调用计数、主子去重、必要约束、Runtime 六项 |
| `scoring/judges/` | 独立配置、无固定温度／预算、模型元数据、结构解析、超时和必要性 |
| `reports/` | 指定目录、证据引用、旧报告、实际条件比较、导出失败不改分 |
| `review/` | 平台反馈的身份、作者、分页及重复导入 |
| `langfuse/` | 层级、稳定 ID、未知值、部分回执及补传 |
| `cli/` | 参数、退役入口、无数据诊断、已有报告操作及本地零平台请求 |
| `fixtures/`、`support/` | 独立最小合成任务、临时仓库和待人工复核的裁判参考 |

最小测试数据独立于业务 Dataset，测试只读业务原件；Runner 使用小型临时仓库，合成结果写入测试临时目录并清理。Judge 和平台注入模拟 Transport／客户端，使用假密钥，不发真实模型请求、不写真实平台。缺证据和设施错误不能伪装成成功；已启动失败／取消仍核验适用过程和安全事实。

单文件调试：`bun --no-env-file test --isolate ./agent-eval/tests/execution/runner.integration.test.ts`。日常入口见根目录测试说明。独立人工审核、本机Host与独立数据目录和 Agent 效果不能由这些合成测试替代。
