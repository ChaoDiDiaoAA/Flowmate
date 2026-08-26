# D 生产 Shadow 只读试点计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 让 Flowmate 使用真实生产分布数据产生预测结果，与人工真实处理结果对比，但从技术上禁止真实提交和回写。

**Architecture:** 接入真实 Invoice、Supplier、PO、Verify 的只读能力；所有写 Tool 由运行模式在 Tool Gateway 拒绝；ShadowResult 与 HumanResult 独立保存后比较。

**Tech Stack:** 真实只读 Adapter、版本化数据集、SQLite、Shadow Comparator、指标报表。

**Spec:** [C 阶段](C_真实07B2B测试环境集成教程.md)、[DATA-03](DATA-03_数据集校验与版本发布教程.md)

## Global Constraints

- `runMode=shadow` 时真实写 Adapter 永远不可到达；
- Shadow 不能仅依靠 Prompt 提醒“不提交”；
- 机器结果在人工完成前封存，避免人工被机器答案影响；
- 真实数据和结果使用最小权限；
- 指标使用生产分布，不用开发数据替代；
- 至少观察一个完整业务周期。

---

## 进入条件

```text
[ ] C 阶段验收通过
[ ] DATA-03 已发布明确数据集版本
[ ] 生产只读访问已获批准
[ ] 真实数据允许用于 Shadow
[ ] 人工对照流程和结果来源已确定
[ ] 写 Tool 的技术禁用测试已通过
[ ] 生产问题联系人和停止联系人已记录
```

## Task D1：运行模式成为系统事实

**Files:**

- Create: `packages/domain/src/run-mode.ts`
- Modify: `packages/runtime/src/tool-gateway.ts`
- Test: `packages/runtime/test/shadow-write-block.test.ts`

```ts
export type RunMode = "mock" | "test" | "shadow" | "canary" | "production";
```

- [ ] 🤖 在 Tool Gateway 硬编码策略：shadow 拒绝所有 external write risk。
- [ ] 🤖 测试即使 Agent 直接请求 `b2b.submit` 和 `erp.write_back` 也不会触达 Adapter。
- [ ] 🤖 Audit 记录拒绝原因 `shadow_write_blocked`。
- [ ] 👤 保存点：`feat: enforce shadow read-only mode`。

## Task D2：接入真实只读数据

**Files:**

- Create: `packages/adapters/src/invoice/real-invoice-source.ts`
- Create: `packages/adapters/src/supplier/real-supplier-reader.ts`
- Create: `packages/adapters/src/order/real-order-reader.ts`
- Create: `packages/adapters/src/verify/real-invoice-verifier.ts`
- Test: `packages/adapters/test/production-read-contract.test.ts`

- [ ] 🏢 为每个数据源取得只读账号、字段说明、限流和联系人员。
- [ ] 🤖 Adapter 使用最小字段，不做 `SELECT *` 式无差别读取。
- [ ] 🤖 日志只记录 ID、hash、状态和必要摘要。
- [ ] 👤 用一个获准案例对照源系统核对字段。
- [ ] 👤 保存点：`feat: connect production read adapters`。

## Task D3：Shadow 结果模型

**Files:**

- Create: `packages/domain/src/shadow-result.ts`
- Create: `packages/domain/src/human-result.ts`
- Create: `packages/evals/src/shadow-comparator.ts`
- Test: `packages/evals/test/shadow-comparator.test.ts`

比较至少包括：

- OCR 字段；
- 供应商；
- PO 和订单行；
- 是否允许提交；
- B2B 待填字段；
- 异常分类；
- 是否需要人工；
- 预计外部结果。

- [ ] 🤖 机器结果在人工结果导入前写入 hash 并锁定。
- [ ] 🤖 Comparator 输出字段级和任务级差异。
- [ ] 👤 保存点：`feat: compare shadow and human results`。

## Task D4：指标看板

**Files:**

- Create: `packages/evals/src/shadow-metrics.ts`
- Create: `apps/desktop/src/renderer/pages/ShadowDashboardPage.tsx`
- Test: `packages/evals/test/shadow-metrics.test.ts`

统计：

```text
Field Accuracy
Submission Decision Accuracy
STP Potential
Human Review Rate
Exception Rate
False Positive
False Negative
Average Processing Time
P95 Processing Time
Agent Cost
Selector Failure Rate
```

- [ ] 🤖 指标可以按供应商、文件类型、异常类型、月份和金额区间切分。
- [ ] 🤖 小样本切片必须显示样本数，不展示误导性百分比。
- [ ] 👤 保存点：`feat: report production shadow metrics`。

## Task D5：完整业务周期运行

- [ ] 🏢 选择业务周期，例如月初到月末。
- [ ] 👤 每天检查失败、数据权限和写操作阻断日志。
- [ ] 👤 每周与业务 Owner 复核差异案例。
- [ ] 🤖 把已确认的新异常加入下一版 development/regression 数据集。
- [ ] ⛔ 不修改已冻结 acceptance 集。

## D 阶段退出门

连续一个业务周期满足：

```text
[ ] Shadow 真实写入 = 0
[ ] 任务可追踪率 = 100%
[ ] 严重错误预测 = 0 或已形成明确禁止自动化规则
[ ] 自动提交决策准确率达到业务批准门槛，建议 ≥ 95%
[ ] 潜在 STP ≥ 70%
[ ] 人工介入率 ≤ 30%，或已解释业务原因
[ ] 数据漂移和页面变化可以被检测
[ ] Kill Switch 演练成功
[ ] 业务 Owner 书面同意进入受控 Canary
```

证据写入 `docs/07b2b/evidence/phase-d/summary.md`。未获书面同意时继续 Shadow，不进入 E。

