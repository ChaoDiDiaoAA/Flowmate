# Benchmark 当前设计协议

当前处于方案设计阶段。11 项有效 Benchmark 引用同一套初始 Agent 任务和产品契约检查；BM-06 已退役，BM-10 真实业务成员为 0。

## 目录与状态

- `catalog.json`：当前有效定义入口及退役编号。
- `BM-xx/definition.json`：目标、输入输出、环境、执行、评分、比较及所需配置，结构版本从 1 开始。
- `BM-xx/README.md`：对应协议的中文解释及当前成员数量。
- `../data/manifests/benchmarks/`：成员、精确文件摘要、直接 checkIds、安全 guardCheckIds、对照和阻断原因；不复制 Case。
- `../runs/`：实际执行后才创建的证据与报告，不是固定数据。

完整 Agent 任务与确定性契约分别统计。F 为机制、A 为实际模型行为、B 为适用业务结果；离线装配不是 Trial，设施测试不是产品成绩。

## 使用

```powershell
python agent-eval/tools/initial_dataset.py verify --project .
python agent-eval/src/runner/initial_dataset.py BM-08 --project . --stage P2 --split development --subset capability
```

`capability` 与 `regression` 是测量目的；development/regression/acceptance 是数据用途。当前 regression 仅为契约保护候选，没有历史通过表现。

模型、预算、k、重置、并发、环境和门槛未固定时保留阻断。必须的合法对照不会被筛选静默删除。真实产品适配器与采证尚未接入，当前全部 NOT_RUN，Baseline 为 0。

各定义的 sourceRefs 固定两份主方案摘要；requirementRefs 与 checkIds 对应直接判据。修改资产后必须重建成员摘要，不覆盖旧身份而伪称可比。当前只保留有效定义，不积累旧数据副本。

## 当前成员数量

| Benchmark | 完整任务 | 产品契约场景 | 依赖对照 |
|---|---:|---:|---:|
| BM-01 | 20 | 0 | 0 |
| BM-02 | 9 | 56 | 2 |
| BM-03 | 39 | 53 | 1 |
| BM-04 | 17 | 128 | 2 |
| BM-05 | 6 | 50 | 0 |
| BM-07 | 22 | 118 | 16 |
| BM-08 | 10 | 55 | 8 |
| BM-09 | 13 | 213 | 7 |
| BM-10 | 0 | 0 | 0 |
| BM-11 | 45 | 227 | 1 |
| BM-12 | 5 | 27 | 1 |
