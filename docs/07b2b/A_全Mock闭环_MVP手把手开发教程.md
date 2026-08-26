# A 全 Mock 闭环 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在 Electron 中跑通一张发票从创建任务到人工批准、Mock B2B 提交和完成审计的完整闭环。

**Architecture:** 使用单 Electron 应用、Embedded Pi SDK、SQLite、确定性状态机、Tool Gateway 和固定 Mock Adapter。LLM、Pi、Tool Calling 真实，其余外部系统全部 Mock。

**Tech Stack:** TypeScript、React、Electron、Pi SDK、Zod、SQLite、Vitest、Playwright Test、npm workspaces。

**Spec:** [项目总导航](00_从这里开始_项目总导航.md)、[架构白话说明](01_小白必读_产品架构与术语.md)

## Global Constraints

- 单 Agent、单机、单业务流程；
- Pi 已有 Runtime 能力全部复用；
- Job 是业务事实，Pi Session 不是业务数据库；
- Mock 必须由 `scenarioId + fixedSeed` 确定；
- 高风险提交必须经过一次性 Approval；
- 所有写动作和状态变化必须 Audit；
- 不接真实 OCR、真实 B2B、真实 ERP；
- 每个 Task 完成后运行相关测试并建立 Git 保存点。

---

## 进入条件

```text
[ ] 已完成基础文档阅读
[ ] Git、Node、npm 可用
[ ] Git 仓库已初始化
[ ] .gitignore 已保护密钥、数据库和真实数据
[ ] 已取得一个可用 LLM API Key
[ ] API Key 只保存在本机环境配置
```

## Task A1：创建最小 Monorepo

**Files:**

- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `apps/desktop/`
- Create: `packages/domain/`
- Create: `packages/runtime/`
- Create: `packages/adapters/`
- Create: `packages/shared/`

**Produces:** 根目录 `package.json` 使用 `"private": true` 和 `"workspaces": ["apps/*", "packages/*"]`，并提供统一的 `lint`、`typecheck`、`test`、`test:e2e`、`build` 命令。`npm install` 生成并提交 `package-lock.json`。

- [ ] 🤖 让 AI 只完成工程脚手架，不实现业务页面。
- [ ] 👤 运行：

```powershell
npm install
npm run typecheck
npm run test
npm run build
```

期望：四条命令退出码均为 0；应用可以打开一个显示 `Flowmate` 的空窗口。

- [ ] 👤 检查 `git status --short`，确认没有 `.env.local`、数据库或真实数据。
- [ ] 👤 保存点：`chore: scaffold flowmate workspace`。

## Task A2：建立唯一 Domain 模型和状态机

**Files:**

- Create: `packages/domain/src/job.ts`
- Create: `packages/domain/src/job-state-machine.ts`
- Create: `packages/domain/src/agent-run.ts`
- Create: `packages/domain/src/approval.ts`
- Create: `packages/domain/src/audit.ts`
- Test: `packages/domain/test/job-state-machine.test.ts`

**Interfaces:**

```ts
export type JobStatus =
  | "CREATED"
  | "EXTRACTING"
  | "EXTRACTED"
  | "VALIDATING"
  | "VALIDATED"
  | "MATCHING"
  | "MATCHED"
  | "PREPARING_SUBMISSION"
  | "WAITING_APPROVAL"
  | "SUBMITTING"
  | "SUBMITTED"
  | "VERIFYING"
  | "COMPLETED"
  | "NEEDS_REVIEW"
  | "PAUSED_FOR_HUMAN"
  | "RETRY_WAIT"
  | "UNKNOWN_COMMIT_STATE"
  | "FAILED"
  | "CANCELLED";

export function transitionJob(current: JobStatus, next: JobStatus): JobStatus;
```

- [ ] 🤖 先写非法跳转失败测试。
- [ ] 🤖 实现最小状态机。
- [ ] 👤 运行：`npm run test --workspace=@flowmate/domain`。
- [ ] 期望：合法路径通过；`CREATED → COMPLETED` 被拒绝。
- [ ] 👤 保存点：`feat: add invoice job state machine`。

## Task A3：SQLite 业务事实存储

**Files:**

- Create: `packages/domain/src/repositories.ts`
- Create: `apps/desktop/src/main/database.ts`
- Create: `apps/desktop/src/main/sqlite-job-repository.ts`
- Test: `apps/desktop/test/sqlite-job-repository.test.ts`

**Produces:** Job、AgentRun、ToolExecution、Approval、Audit 的创建、读取和追加接口。

- [ ] 🤖 测试应用退出再启动后 Job 仍存在。
- [ ] 🤖 测试 Pi Session ID 为空时 Job 仍可读取。
- [ ] 🤖 使用数据库迁移文件，不在启动代码中散落建表 SQL。
- [ ] 👤 运行相关测试两次，第二次不得依赖第一次的残留数据库。
- [ ] 👤 保存点：`feat: persist business facts in sqlite`。

## Task A4：接入 Pi Runtime

**Files:**

- Create: `packages/runtime/src/agent-runtime.ts`
- Create: `packages/runtime/src/embedded-pi-runtime.ts`
- Create: `packages/runtime/src/pi-event-adapter.ts`
- Test: `packages/runtime/test/pi-event-adapter.test.ts`

**Interfaces:**

```ts
export interface AgentRuntime {
  createRun(input: CreateAgentRunInput): Promise<RuntimeRun>;
  prompt(runId: string, message: string): AsyncIterable<AgentEvent>;
  abort(runId: string): Promise<void>;
  close(runId: string): Promise<void>;
}
```

- [ ] 🤖 使用 Pi ModelRuntime、SessionManager、ResourceLoader、Tool Runtime 和 Streaming。
- [ ] 🤖 不实现自定义 Agent Loop、Provider Adapter 或 Compaction。
- [ ] 🤖 把 Pi 原始事件转换成 Flowmate `AgentEvent`，UI 不接触 Pi 类型。
- [ ] 👤 使用非敏感提示运行一次真实 LLM 请求。
- [ ] 👤 点击停止后确认 Pi Run 被 abort，Job 业务事实仍存在。
- [ ] 👤 保存点：`feat: integrate embedded pi runtime`。

## Task A5：Tool Gateway 和 Mock Adapter

**Files:**

- Create: `packages/runtime/src/tool-gateway.ts`
- Create: `packages/runtime/src/tool-registry.ts`
- Create: `packages/adapters/src/contracts.ts`
- Create: `packages/adapters/src/mock/`
- Create: `packages/adapters/src/scenarios/`
- Test: `packages/runtime/test/tool-gateway.test.ts`

**Tools:**

```text
invoice.get
invoice.extract
invoice.validate
supplier.search
order.search
b2b.preview
approval.request
b2b.submit
b2b.get_status
task.complete
```

- [ ] 🤖 Tool Gateway 固定检查：注册、Schema、Job 状态、风险、运行模式、Approval、幂等键、Audit。
- [ ] 🤖 创建 [测试手册](03_测试验收与排错操作手册.md) 中的固定 Scenario。
- [ ] 🤖 测试未审批 `b2b.submit` 必须失败且不调用 Adapter。
- [ ] 🤖 测试相同 idempotency key 不能产生第二次有效提交。
- [ ] 👤 保存点：`feat: add governed tool gateway and mock adapters`。

## Task A6：Task Center 和任务详情

**Files:**

- Create: `apps/desktop/src/renderer/pages/TaskListPage.tsx`
- Create: `apps/desktop/src/renderer/pages/TaskDetailPage.tsx`
- Create: `apps/desktop/src/renderer/pages/ReviewPage.tsx`
- Create: `apps/desktop/src/renderer/pages/SettingsPage.tsx`
- Create: `apps/desktop/src/preload/index.ts`
- Test: `apps/desktop/test/ipc-contract.test.ts`

页面必须展示：

- Job 状态；
- 发票 Mock 数据；
- 标准化字段；
- 校验结果；
- 结构化 Agent Timeline；
- Tool 名称、开始时间和结果摘要；
- 审批入口；
- 最终 B2B Mock ID；
- Audit 摘要。

- [ ] 🤖 Preload 只暴露白名单 IPC，不暴露文件系统、数据库和密钥。
- [ ] 🤖 不显示模型完整思维链，只显示结构化状态。
- [ ] 👤 人工完成一次创建、启动、暂停、恢复、取消和重试。
- [ ] 👤 保存点：`feat: add task center and execution cockpit`。

## Task A7：人工审批和完整 E2E

**Files:**

- Create: `apps/desktop/src/main/approval-service.ts`
- Create: `apps/desktop/src/renderer/components/ApprovalDialog.tsx`
- Test: `apps/desktop/e2e/invoice-job.spec.ts`

- [ ] 🤖 Approval Token 绑定 Job、动作摘要、一次使用和过期时间。
- [ ] 🤖 人工拒绝后 Job 进入可解释状态，不执行提交。
- [ ] 🤖 E2E 覆盖 happy path、低置信度、金额不一致、重复票、超时未知结果和 Prompt Injection 发票。
- [ ] 👤 连续运行：

```powershell
1..20 | ForEach-Object { npm run test:e2e }
```

期望：20 次全部通过，无重复提交、非法状态跳转和 Audit 缺失。

- [ ] 👤 保存点：`test: prove mock invoice workflow end to end`。

## A 阶段验收

```text
[ ] Happy Path 完成率 ≥ 95%
[ ] Tool Schema 合法率 = 100%
[ ] 未审批直接 Submit = 0
[ ] 重复提交 = 0
[ ] 非法状态跳转 = 0
[ ] 应用重启后任务不丢失
[ ] 写动作 Audit 完整率 = 100%
[ ] 20 次连续 E2E 通过
[ ] `npm run lint`、`npm run typecheck`、`npm run test`、`npm run test:e2e`、`npm run build` 全通过
[ ] Demo 可在 5 分钟内完成
```

验收证据写入 `docs/07b2b/evidence/phase-a/summary.md`。全部通过后进入阶段 B；此时 DATA-01 必须已经完成，DATA-02 应至少取得第一批真实样本。
