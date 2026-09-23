# 评测设施测试

验证设施，不生成 Agent Benchmark 成绩。由根 `test:unit`、`test:integration` 和 `test` 统一发现，类型检查包含全部文件。使用 Bun 文件隔离。

| 模块 | 验证内容 |
|---|---|
| datasets/ | 严格契约、选集、hash、来源隔离、可选 Gold |
| execution/ | 快照、独立 Trial、证据、停止、输入投影、未就绪门禁 |
| scoring/evaluators/ | 正反例、缺证据、错身份、必要失败、一对一匹配 |
| scoring/judges/ | 独立配置、解析、超时、必要性、独立触发 |
| reports/ | 本地记录、比较、审核、导出失败不改分 |
| review/ | 平台标注的身份、作者、分页、重复导入 |
| langfuse/ | 层级、稳定 ID、null、部分回执、补传 |
| cli/ | 参数、退役入口、帮助、零 Dataset 诊断与拒绝运行、已有报告操作 |
| fixtures/、support/ | 三条合成最小任务、临时仓库及裁判参考 |

fixtures/minimal-dataset.ts 独立定义合成数据，测试时写到自身临时目录，不依赖业务 Dataset，不读取或修改原始发票。旧业务 Dataset 删除后以及未来尚未制作时，测试均可独立运行。Runner 使用小型临时 Git 仓库，结果只写该临时根，结束清理。六类 Judge 参考仍为 pending，不冒充真实校准。

Judge/平台注入受控请求或客户端，不发真实模型请求、不写平台。失败、超时、中止和未启动不得进入任务质量评分；模拟 Kernel 不表示真实 Agent 已接通。

单文件调试：`bun --no-env-file test --isolate ./agent-eval/tests/execution/runner.integration.test.ts`。日常使用根 [测试入口](../../tests/README.md)。
