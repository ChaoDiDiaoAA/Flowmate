# 阶段评测资产

每个阶段只维护一套版本化 Case：`stage-evals/Pn/v1/cases.json`。Case 的 Fixture/Live 模式、F/A/B 类型和 `source.kind` 分别表达运行环境、评测类别和数据来源，不能混用。

当前只有 P1 已实现。P2–P13 在对应产品入口实现时创建目录；阶段启动命令统一为：

```powershell
bun run eval -- sync --stage Pn
bun run eval -- run --stage Pn --mode fixture
bun run eval -- run --stage Pn --mode live
bun run eval -- status --stage Pn
Start-Process http://localhost:3000
```

其中 `Pn` 替换为具体阶段。当前 CLI 对 P2–P13 会明确拒绝，直到该阶段 Case、入口、Adapter 和 Grader 实现，避免用空数据制造成绩。
