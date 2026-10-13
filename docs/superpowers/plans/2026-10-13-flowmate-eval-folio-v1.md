# Flowmate first-stage implementation v1

第一阶段仅交付数据、必要适配代码、操作说明和合成本地验证。真实 Agent／Judge、付费校准、Smoke／Full 和平台上传留后续阶段；合成测试通过不代表 Agent 效果通过。所有评测公开版本固定为 `v1`，评测数据及产物不保存哈希或指纹。产品内部完整性校验仅在内存或待清理的产品临时环境中进行。

```text
agent-eval/
├── configs/.env
├── src/
│   ├── datasets/
│   │   ├── cases.ts
│   │   ├── gold.ts
│   │   ├── review.ts
│   │   └── fixtures/
│   ├── dataset-loader/
│   ├── adapters/
│   ├── execution/
│   ├── scoring/
│   ├── reports/
│   ├── review/
│   ├── langfuse/
│   └── cli.ts
├── runs/<execution-id>/
│   ├── snapshot.json
│   ├── report.json
│   ├── evidence/<trial-id>/
│   │   ├── trial.json
│   │   ├── observation.json
│   │   ├── events.jsonl
│   │   └── artifacts/  # only actual artifacts
│   ├── review.json    # only actual feedback
│   └── export.json    # only export attempts/receipts
├── tests/
├── scripts/
└── README.md
```

1. Align documents and public contracts.
2. Audit and retain all 86 cases; write short English Cases, independent Gold, honest Review and minimal fixtures.
3. Move loader and update all consumers and input boundaries.
4. Connect one env configuration and model flags; implement the specified hash-free output files and optional receipts.
5. Verify with synthetic Agent/Judge/platform only, typecheck and source review; clean retired layouts. Do not commit, push or execute real evaluations.
