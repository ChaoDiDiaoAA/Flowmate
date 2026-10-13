# 评测源码

`datasets/` 严格只有 `cases.ts`、`gold.ts` 和 `review.ts` 三个数据声明文件，按 Harness 功能分组，加载后按 ID 排序。类型、严格校验和选集放在 `dataset-loader/`，私有场景与可独立读取的原始样本放在 `testing/`。

Case 的 `input.prompt` 保存首轮，`input.turns` 保存后续用户输入；场景通过 `turnId` 逐轮提交。源码复制和挂载排除 `datasets/`、`testing/`，Agent 只接收当前已授权输入和实际选用的产品资源，不能提前看到后续轮次、Gold、Review 或答案提示。

执行、评分、报告和平台模块沿用现有结构。公开版本固定 `v1`，评测数据和保存产物不含哈希／指纹；真实评测操作见外层中文 README，完整契约见 `docs/eval/`。

评测主模型、Judge 和 Langfuse 分别从 configs/.env 的专用字段读取；主模型可由 CLI 临时覆盖，密钥只经回调传给隔离 Host。模型容量复用 Pi SDK 原生目录，不设评测输入输出额度。
