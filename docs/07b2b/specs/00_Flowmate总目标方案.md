# Flowmate 总目标方案

> 文档类型：Target Design / Spec  
> 状态：等待用户审核  
> 日期：2026-08-26  
> 上游依据：`07B2B_数字化员工平台_分阶段开发方案_V1.2.md`  
> 适用背景：一名只会 Vibe Coding 的独立开发者负责开发、测试、部署和维护

## 1. 本文的职责

本文只决定：

- 最终要建设什么产品；
- 产品、数据和运行时各自负责什么；
- 哪些能力属于第一版；
- 各子项目的先后关系和完成条件；
- 哪些安全原则不能被阶段实现绕过；
- 后续目标方案和实施计划应该怎样拆分。

本文不包含：

- 安装命令；
- 逐步编码任务；
- 具体文件修改步骤；
- OpenCLI 的具体站点命令；
- 生产账号、密码或真实业务数据；
- 对任何子项目的实施授权。

本文审核通过后，才开始编写 `P0_Obsidian数据库目标方案.md`。P0 目标方案审核通过后，才使用 `superpowers:writing-plans` 编写 P0 实施计划。P0 实施计划再次审核通过后，才允许开始实际搭建。

## 2. 项目目标

Flowmate 是一个以 Pi SDK 为 Agent Runtime、以确定性业务控制和人工兜底为安全骨架的企业数字员工执行平台。

第一位数字员工负责：

```text
接收真实发票任务
→ 读取并理解发票
→ 校验业务字段
→ 匹配供应商与采购订单
→ 请求必要的人工复核或审批
→ 在授权范围内录入 07B2B
→ 确认最终提交状态
→ 回写 ERP/财务系统
→ 保存完整审计证据
```

最终产品不能被定义为“一个会自动点击网页的大模型”。最终定义是：

> 一个能够接收企业任务、调用受控能力、遵守业务状态和审批规则、在异常时安全转人工，并且可追踪、可恢复、可审计、可长期维护的数字员工平台。

## 3. 项目成功的业务含义

项目成功必须同时满足：

- 正常任务能够稳定完成；
- 异常任务能够分类、解释并转人工；
- 高风险写操作未经批准无法执行；
- B2B 提交超时不会造成盲目重复提交；
- 应用重启或 Agent Session 丢失不会丢失业务任务；
- 所有关键动作都有可验证的 Audit；
- 真实数据、模型、Prompt、Tool 和 Workflow 版本可追踪；
- 唯一维护者可以完成部署、备份、恢复、回滚和升级；
- 唯一维护者不可用时，业务可以停止自动写入并切回人工流程。

“演示一次成功”“OCR 单项准确”“Agent 能调用 Tool”或“Playwright 能填写页面”都不等于项目成功。

## 4. 已确认的现实约束

### 4.1 人员约束

```text
开发者：1 人
测试者：同一人
部署维护者：同一人
主要开发方式：Codex 辅助的 Vibe Coding
```

这意味着方案必须：

- 每次只引入一种主要不确定性；
- 每个子项目都能独立验收；
- 避免需要专职基础设施团队的架构；
- 失败时能够恢复到上一个可运行版本；
- 把人工检查写成明确门禁；
- 保留财务、ERP、B2B、IT 和信息安全的外部审批职责。

“一个人开发”不代表开发者可以代替数据 Owner、业务 Owner 或信息安全批准真实数据和生产权限。

### 4.2 第一版范围约束

第一版固定为：

```text
1 个数字员工
1 条发票录入主流程
1 个 07B2B 平台
1 个生产运行实例
单 Agent
单机优先
SQLite 优先
npm workspaces
```

第一版明确不建设：

- 多租户 SaaS；
- 多 Agent 编排；
- 多 B2B 平台；
- Kubernetes；
- Kafka；
- Redis；
- 微服务；
- 图形化 Workflow Designer；
- Agent、Skill 或插件市场；
- 自研 LLM Provider；
- 自研 Agent Loop、Streaming、Compaction 或 Session Runtime；
- 绕过验证码、MFA、扫码或安全设备；
- 无人工兜底的全量自动写入。

### 4.3 固定技术方向

```text
语言：TypeScript
桌面应用：Electron
界面：React
包管理与工作区：npm workspaces
Agent Runtime：Pi SDK
Schema：Zod
第一版业务数据库：SQLite
单元与模块测试：Vitest
浏览器测试与获准自动化：Playwright Test
数据资产工作台：Obsidian + Bases
开发期网络采集：Codex + OpenCLI
Windows 运维自动化：PowerShell
```

只有现有方案出现可复现并有测试证据的容量或可靠性问题，才允许增加新的基础设施。

## 5. 总体产品范围

### 5.1 产品体验

最终 Electron 应用至少具有：

1. 任务中心；
2. 任务详情与执行驾驶舱；
3. 发票字段与规则结果；
4. 人工复核中心；
5. 审批中心；
6. 人工接管入口；
7. Agent Timeline；
8. B2B 页面与截图证据；
9. Audit 查询；
10. 系统设置和健康状态；
11. Kill Switch；
12. 当前应用、数字员工、Prompt、Tool、Workflow 和 Dataset 版本。

产品的主要交互对象是任务，不是聊天。

### 5.2 数字员工定义

第一版数字员工是“07B2B 发票录入员”，其职责是：

```text
读取任务
→ 调用发票和业务能力
→ 依据规则提出动作
→ 在受控 Interface 内执行
→ 需要时请求人类
→ 返回结构化结果
```

数字员工不能：

- 直接持有原始凭证；
- 绕过 Tool Gateway；
- 自己批准自己的高风险动作；
- 直接修改业务最终状态；
- 把 Pi Session 当成业务数据库；
- 在结果未知时自行重复写入。

## 6. 最终业务流程

```text
真实 Invoice Source
        ↓
创建 InvoiceJob
        ↓
提取发票字段
        ↓
标准化和确定性校验
        ↓
查询 Supplier / PO / 收货 / 合同
        ↓
规则判断
   ┌────┴───────────┐
   │                │
可自动继续       需要人工复核
   │                │
   └──────┬─────────┘
          ↓
生成 B2B Submission Preview
          ↓
风险和审批检查
          ↓
真实 B2B Submit
          ↓
查询并确认外部状态
          ↓
ERP WriteBack Outbox
          ↓
回写成功或安全转人工
          ↓
完成 Job 和 Audit
```

## 7. 最终目标架构

```text
┌───────────────────────────────────────────────┐
│ Product Experience                            │
│ Task Center / Cockpit / Review / Approval     │
├───────────────────────────────────────────────┤
│ Flowmate Kernel                               │
│ Job / Workflow / State / Policy / Idempotency │
├───────────────────────────────────────────────┤
│ Enterprise Tool Gateway                       │
│ Schema / Risk / Approval / Mode / Audit        │
├───────────────────────────────────────────────┤
│ AgentRuntime Interface                        │
│ EmbeddedPiRuntime / IsolatedPiRuntime Adapter │
├───────────────────────────────────────────────┤
│ Pi SDK                                        │
│ Model / Session / Loop / Tools / Resources    │
├───────────────────────────────────────────────┤
│ Enterprise Adapter Interfaces                 │
│ Invoice / OCR / Verify / Supplier / PO         │
│ B2B / ERP / Credential / Audit Storage         │
└───────────────────────────────────────────────┘

业务事实：SQLite
文件资产：受控文件目录
开发数据：Obsidian → Dataset Manifest
```

### 7.1 Module 和 Interface 原则

主要 Module 通过小而稳定的 Interface 连接：

- Product Experience 只使用 Flowmate 命令和事件；
- Kernel 不依赖 Pi SDK 类型；
- Pi Runtime 不拥有业务最终状态；
- Tool Gateway 是企业动作的唯一安全 seam；
- Mock 和 Real Adapter 满足相同 Interface；
- 数据工作台只通过版本化 Dataset Manifest 向测试和 Eval 提供数据；
- Flowmate 生产 Runtime 不依赖 Codex、OpenCLI 或 Obsidian 是否正在运行。

这个形状允许在不修改业务核心的情况下，把 Mock Adapter 逐步替换成 Real Adapter。

## 8. Pi SDK 与 Flowmate 的职责

### 8.1 Pi SDK 负责

- LLM Provider；
- ModelRuntime；
- Provider 认证解析；
- LLM 请求和 Streaming；
- Agent Loop；
- Tool Calling Runtime；
- AgentSession 和 SessionManager；
- SettingsManager；
- Compaction；
- ResourceLoader；
- Skills 和 Extensions Runtime；
- abort、steer、followUp；
- Pi 已提供的 Runtime 或 RPC 语义。

### 8.2 Flowmate 负责

- DigitalEmployeeDefinition；
- ModelProfile 和每任务预算；
- InvoiceJob 和 AgentRun；
- Workflow 和业务状态机；
- Tool Registry 和 Tool Gateway；
- Policy、Approval、Review、Takeover；
- Idempotency 和 Unknown Commit；
- Mock/Real Adapter；
- Audit、Replay、Eval 和 Release；
- Task Center 和执行驾驶舱；
- 单人部署、备份、恢复和运维。

## 9. 业务事实与状态

### 9.1 唯一业务事实

SQLite 至少保存：

```text
DigitalEmployeeDefinition
InvoiceJob
AgentRun
ToolExecutionRecord
ApprovalRecord
HumanReviewRecord
ExternalSubmissionRecord
WriteBackOutbox
AuditEvent
ArtifactReference
ReleaseVersion
```

关系：

```text
InvoiceJob
├─ AgentRun
├─ ToolExecutionRecord
├─ ApprovalRecord
├─ HumanReviewRecord
├─ ExternalSubmissionRecord
├─ WriteBackOutbox
└─ AuditEvent
```

Pi Session ID 只是 AgentRun 的关联字段。Pi Session 丢失不等于 InvoiceJob 丢失。

### 9.2 唯一正式状态机

```text
CREATED
→ EXTRACTING
→ EXTRACTED
→ VALIDATING
→ VALIDATED
→ MATCHING
→ MATCHED
→ PREPARING_SUBMISSION
→ WAITING_APPROVAL
→ SUBMITTING
→ SUBMITTED
→ VERIFYING
→ COMPLETED
```

异常状态：

```text
NEEDS_REVIEW
PAUSED_FOR_HUMAN
RETRY_WAIT
UNKNOWN_COMMIT_STATE
FAILED
CANCELLED
```

所有子项目复用这套名称。阶段实现可以只使用其中一部分，但不能创建第二套状态机。

## 10. Tool 和企业安全 seam

Tool 分为：

```text
Read：invoice.get / invoice.extract / supplier.search / order.search
Decision：invoice.validate / duplicate.check / submission.preview
Write：b2b.submit / erp.write_back / invoice.update
Human：review.request / approval.request / human.takeover
System：task.complete / task.fail / task.retry
```

每个 Tool 必须声明：

- 名称；
- 版本；
- 输入和输出 Schema；
- 风险等级；
- 是否需要审批；
- 幂等策略；
- 超时；
- 允许的 Job 状态；
- 允许的运行模式；
- Audit 策略。

Tool Gateway 固定检查：

```text
Tool 是否注册
→ Schema 是否合法
→ Job 状态是否允许
→ 数字员工是否有权限
→ 当前 RunMode 是否允许
→ 是否触发高风险策略
→ Approval 是否有效
→ Idempotency 是否冲突
→ Kill Switch 是否开启
→ 执行 Adapter
→ 记录 Audit
```

## 11. 数据工作台是第一个子项目

### 11.1 P0 的定位

P0 在任何产品编码前完成。它不是 Flowmate Runtime 的一部分，而是独立的开发数据工作台。

```text
Codex：制定采集目标、调用工具、整理和审核建议
OpenCLI：从获准的网络来源读取或采集公开数据
Obsidian：保存来源、许可、元数据、知识、样本和版本状态
Dataset Tools：校验、去重、hash、分割、发布 Manifest
```

### 11.2 三个逻辑数据库

一个 Obsidian Vault 内建立三个互相区分的逻辑数据库。

#### 公开知识库

保存：

- 发票字段和格式知识；
- 公开税务和业务规则；
- OCR 技术资料；
- 07B2B 公开帮助和字段说明；
- 浏览器自动化的通用知识；
- 异常处理资料。

#### 公开样本库

保存：

- 许可清晰的公开发票样例；
- 公开 OCR 数据集索引；
- 公开字段标注；
- 文件 hash；
- 来源 URL；
- 获取日期；
- 许可证或允许用途；
- 样本质量和适用限制。

#### 真实业务资产库

保存索引和状态，不把生产秘密直接写入普通笔记：

- 企业内部脱敏历史发票；
- 人工正确字段；
- 供应商和 PO 样例；
- 历史人工录入结果；
- 异常案例；
- 业务规则；
- 数据 Owner 和授权；
- Dataset 版本。

网上数据只能进入公开知识库和公开样本库。真实业务资产库必须由企业内部数据 Owner 提供和批准。

### 11.3 Codex + OpenCLI 获取流程

```text
定义采集问题和允许的数据类型
→ 运行 opencli list -f json 动态发现当前命令
→ 优先选择 PUBLIC Adapter
→ 获准后选择 COOKIE/INTERCEPT/UI Adapter
→ 没有 Adapter 时才评估浏览器采集
→ 原始输出进入 Staging
→ 记录来源、时间、Adapter 和 hash
→ 检查许可、隐私、敏感信息和重复内容
→ 检查内容真实性与适用范围
→ 人工批准
→ 导入 Obsidian
→ 发布版本化 Manifest
```

目标方案不硬编码具体网站 Adapter，因为 OpenCLI 的 Adapter 列表和站点能力会变化。每次采集任务都必须先动态发现当前命令并阅读对应帮助。

### 11.4 数据状态

所有采集内容使用统一状态：

```text
DISCOVERED
→ STAGED
→ LICENSE_REVIEWED
→ PRIVACY_REVIEWED
→ QUALITY_REVIEWED
→ APPROVED
→ RELEASED
```

拒绝状态：

```text
REJECTED_LICENSE
REJECTED_PRIVACY
REJECTED_QUALITY
DUPLICATE
WITHDRAWN
```

未到 `APPROVED` 的资料不能进入发布数据集。

### 11.5 数据物理存储

```text
FlowmateData/
├─ vault/                  Obsidian Vault
├─ staging/                网络采集临时区
├─ files/public/           已批准公开文件
├─ files/private-raw/      企业内部原始文件，只读
├─ files/private-sanitized/脱敏副本
├─ labels/                 expected.json
├─ manifests/              来源和数据清单
├─ releases/               dataset-v0.x / v1.x
├─ quarantine/             等待人工决定或拒绝数据
└─ backups/                加密备份
```

Obsidian 保存人可读卡片和属性；大型文件、原始真实文件和结构化标签保存在受控文件目录。Flowmate Runtime 不把 Obsidian Markdown 当成生产业务数据库。

### 11.6 数据工作台向产品暴露的唯一 Interface

P0 的外部 Interface 是版本化 Dataset Manifest：

```text
DatasetManifest
├─ schemaVersion
├─ datasetVersion
├─ createdAt
├─ sourcePolicyVersion
├─ cases[]
│  ├─ caseId
│  ├─ fileRef
│  ├─ expectedRef
│  ├─ sha256
│  ├─ sourceType
│  ├─ licenseStatus
│  ├─ privacyStatus
│  ├─ reviewStatus
│  ├─ scenarios[]
│  └─ split
└─ checksums
```

后续 OCR、Eval 和验收只依赖 Manifest，不直接依赖 OpenCLI 命令、Obsidian 内部目录或某个网站结构。

## 12. 真实生产数据不能从网络替代

最终必须从企业内部取得：

| 数据或权限 | 责任来源 |
|---|---|
| 真实发票和人工正确结果 | 财务 AP、发票业务 Owner |
| 供应商、PO、收货、合同 | 采购、ERP、主数据团队 |
| 业务规则和异常处理 | 实际录入人员、业务 Owner |
| 07B2B 测试与生产环境 | B2B Owner、平台方、IT |
| 测试账号和机器人账号 | 系统管理员、IAM、信息安全 |
| 自动化访问许可 | B2B Owner、平台方、信息安全 |
| 发票验真 | 财税平台负责人 |
| ERP 回写 | ERP、ESB、财务系统负责人 |
| 数据用途和保存期限 | 数据 Owner、信息安全 |

公开网络数据可以用于：

- 理解格式；
- 构建 Mock；
- 建立公开知识库；
- 建立初期 OCR 试验集；
- 发现异常类型；
- 验证数据工具。

公开网络数据不能证明：

- 企业真实字段准确率；
- 企业供应商匹配准确率；
- 企业 PO 匹配准确率；
- 真实 B2B 提交正确率；
- 企业生产 STP；
- 最终交付是否通过。

## 13. 生产真实系统目标

最终生产执行路径需要：

| Interface | Real Adapter 来源 | 安全降级 |
|---|---|---|
| InvoiceSource | 财务系统、发票池、受控文件来源 | 暂停新任务或人工导入 |
| OCRProvider | Parser、获准 OCR Provider | 备用 Provider 或人工复核 |
| InvoiceVerifier | 企业验真平台 | 转人工 |
| SupplierReader | ERP/SRM/MDM | 转人工匹配 |
| OrderReader | ERP、采购或数据中台 | 转人工，不猜测 |
| B2BConnector | 正式接口或获准 Playwright | Kill Switch + 人工录入 |
| CredentialAdapter | Secret Store、机器人账号 | 停止自动登录 |
| ERPWriteBack | 正式接口或 ESB | Outbox 保留并转人工 |
| AuditStore | 加密本地或企业批准存储 | 停止生产写入 |

生产执行路径不使用 Mock；开发、测试和回归环境继续保留 Mock Adapter 和固定 Scenario。

## 14. 安全不变量

以下规则必须由确定性代码强制执行，不能只写进 Prompt：

1. Agent 不获得原始密码、Cookie 或 Token；
2. Renderer 不读取密钥；
3. 高风险 Tool 未审批不能执行；
4. Shadow 模式禁止真实写入；
5. Canary 只允许白名单任务和批准流量；
6. Kill Switch 开启后禁止新的写操作；
7. Unknown Commit 禁止自动二次提交；
8. 相同业务动作使用稳定幂等键；
9. Agent 不能直接修改业务最终状态；
10. 写操作保存意图、参数摘要、审批和外部结果；
11. 验证码、MFA、扫码和安全设备必须人工处理；
12. 真实数据不进入源码 Git；
13. 最终验收集不得用于调 Prompt、规则或代码；
14. 外部系统权威结果优先于本地推测；
15. 无法安全自动完成时转人工；
16. Codex 和 OpenCLI 不能绕过来源许可或访问控制；
17. 未审核网络数据不能进入正式 Dataset Release。

## 15. 关键异常目标行为

### 15.1 低置信度和业务冲突

```text
NEEDS_REVIEW
→ 人工查看原文和候选值
→ 记录 before/after/reason
→ 重新校验
→ 继续或拒绝
```

### 15.2 验证码、MFA 和未知页面

```text
PAUSED_FOR_HUMAN
→ 停止自动页面操作
→ 人工接管
→ 验证恢复位置
→ Resume
```

### 15.3 B2B Submit 超时

```text
保存提交意图
→ 发送一次 Submit
→ 响应未知
→ UNKNOWN_COMMIT_STATE
→ 查询外部权威状态
→ 已提交：SUBMITTED
→ 明确未提交：重新进入人工决定
→ 无法确认：保持暂停并升级人工
```

### 15.4 ERP 回写失败

```text
B2B 成功事实保持不变
→ WriteBack Outbox 保留
→ 受控幂等重试
→ 重试耗尽转人工
```

### 15.5 唯一维护者不可用

```text
禁止新的高风险写入
→ 授权业务人员开启 Kill Switch
→ 必要时停用机器人账号
→ 切回人工流程
→ 保存 Job ID 和外部状态
```

## 16. 子项目拆分

总项目拆为八个可独立验收的子项目。

### P0：Obsidian 数据库与网络采集工作台

目标结果：

- Obsidian 三个逻辑数据库可用；
- Codex + OpenCLI 采集流程可用；
- 来源、许可、隐私、质量和去重门禁可用；
- Dataset Manifest 可以发布；
- 备份和恢复经过验证。

P0 是 P1 的硬前置条件。

### P1：全 Mock MVP

目标结果：

- 真实 Pi SDK 和真实 LLM；
- 真实 Electron/React/SQLite；
- 真实 Job、状态机、Tool Gateway、Approval 和 Audit；
- 外部业务系统全部使用固定 Mock；
- 完整 E2E 闭环可重复运行。

### P2：真实发票与 OCR

目标结果：

- 真实 PDF/OFD/图片/XML；
- 可替换 OCRProvider；
- 字段来源、confidence、标准化和规则结果可追踪；
- 人工复核可用；
- 使用 P0 发布的数据集进行评估。

### P3：真实 07B2B 测试环境

目标结果：

- 获准测试账号和测试数据；
- API 优先或获准 Playwright Adapter；
- 凭证隔离；
- 人工接管；
- 截图审计；
- Unknown Commit 测试通过。

### P4：生产 Shadow

目标结果：

- 使用真实生产分布数据；
- 技术上禁止真实写入；
- 机器结果与人工结果独立比较；
- 完整业务周期指标可用。

### P5：Canary

目标结果：

- 专用机器人账号；
- 白名单和风险策略；
- 真实 Approval；
- Idempotency 和 Unknown Commit；
- Kill Switch；
- 小流量真实写入通过。

### P6：正式生产与最终交付

目标结果：

- 生产执行路径全部使用 Real Adapter；
- ERP 回写可恢复；
- 部署、迁移、备份、恢复和回滚通过；
- 最终验收集通过；
- 完整交付包形成。

### P7：单人运维

目标结果：

- 每日、每周、每月运维机制；
- 故障分级和 Runbook；
- 自动备份和恢复演练；
- 安全升级和回归；
- 数据漂移管理；
- 唯一维护者不可用预案。

## 17. 每个子项目必须严格执行的流程

```text
1. Brainstorming
   明确范围、接口、依赖、风险和成功标准

2. Target Design / Spec
   写 specs/Pn_目标方案.md

3. Spec 自审
   检查占位、矛盾、范围和歧义

4. 用户审核 Spec
   用户明确批准后才继续

5. Writing Plans
   写 plans/Pn_实施计划.md

6. 用户审核 Plan
   用户明确批准后才实施

7. Implementation
   按计划逐任务执行，代码遵循测试先行

8. Verification
   运行完整验证，保存实际输出和证据

9. Gate Review
   退出条件全部通过后才进入下一子项目
```

不能把 Spec、Plan 和 Implementation 合并到同一次操作中。

## 18. 文档目标结构

```text
docs/07b2b/
├─ README.md
│
├─ specs/
│  ├─ 00_Flowmate总目标方案.md
│  ├─ P0_Obsidian数据库目标方案.md
│  ├─ P1_全Mock_MVP目标方案.md
│  ├─ P2_真实发票与OCR目标方案.md
│  ├─ P3_真实07B2B测试环境目标方案.md
│  ├─ P4_Shadow目标方案.md
│  ├─ P5_Canary目标方案.md
│  ├─ P6_正式生产与最终交付目标方案.md
│  └─ P7_单人运维目标方案.md
│
├─ plans/
│  └─ 每份计划只在对应 Spec 审核后创建
│
├─ evidence/
│  ├─ P0/
│  ├─ P1/
│  ├─ P2/
│  ├─ P3/
│  ├─ P4/
│  ├─ P5/
│  ├─ P6/
│  └─ P7/
│
└─ archive/
   └─ 旧草稿和被替代方案
```

当前已经生成的教程文档在本 Spec 审核前继续保留原位。审核通过后，它们移动到 `archive/draft-before-superpowers-reset/`，不能直接充当新的实施计划。

### 18.1 README 规则

以下目录必须有 README：

- 可以独立运行、测试或部署的 App/Tool；
- 每个 npm workspace 根目录；
- 暴露稳定 Interface 的 Module 根目录；
- 有独立配置、凭证或数据安全要求的目录；
- 数据资产根目录；
- 运维、Shadow、Canary 和部署根目录。

以下目录不要求 README：

- 普通 `src/` 和 `test/`；
- 单个页面、函数和内部实现目录；
- 已经由上级 README 完整解释的纯内部目录。

第一版预计需要：

```text
README.md
docs/07b2b/README.md
packages/data-workbench/README.md
tools/mineru-mcp-wrapper/README.md
FlowmateData/README.md
FlowmateData/vault/README.md

apps/desktop/README.md
packages/domain/README.md
packages/runtime/README.md
packages/adapters/README.md
packages/shared/README.md
apps/mock-b2b/README.md
packages/evals/README.md
packages/adapters/b2b/README.md
tools/pi-runtime-host/README.md（仅实际创建独立 Runtime Host 时）
docs/runbooks/shadow/README.md
docs/runbooks/canary/README.md
deploy/README.md
runbooks/README.md
```

每份 README 固定说明：职责、非职责、所处阶段、Interface、依赖、命令、测试、数据和密钥规则、常见失败、停止条件和下一份文档。README 中的命令必须通过对应阶段验证，不能复制过期命令。

## 19. 验收底线

最终具体业务阈值由业务 Owner 正式批准。在批准前，工程底线为：

| 指标 | 底线 |
|---|---:|
| 关键数字字段准确率 | ≥ 98% |
| 允许自动化任务的提交成功率 | ≥ 95% |
| 稳定期 STP | ≥ 80%，高风险场景除外 |
| 未审批真实写入 | 0 |
| 严重错录 | 0 |
| 重复有效提交 | 0 |
| 非法状态跳转 | 0 |
| 写操作 Audit 完整率 | 100% |
| 任务可追踪率 | 100% |
| 可恢复错误自动恢复率 | ≥ 90% |
| Unknown Commit 自动二次提交 | 0 |
| 备份恢复演练 | 成功 |
| Kill Switch 演练 | 成功 |

指标必须记录应用版本、数据集版本、样本数量、分母口径、失败案例 ID 和已知限制。

最终验收数据必须来自企业真实生产分布，并完成业务复核和冻结。公开网络数据、合成数据和开发 Mock 不能替代最终验收数据。

## 20. 最终交付物

```text
源码和 Git 提交 ID
可安装应用包及 SHA-256
package-lock.json 和依赖许可证清单
不含密钥的配置模板
数据库 Schema、迁移和回滚脚本
部署、升级、卸载和回滚说明
真实 Adapter 与外部系统清单
凭证 Profile 清单，不含密钥值
Obsidian Vault 结构、模板和数据治理规则
OpenCLI 采集来源、许可和审计记录
Dataset Manifest、版本和授权说明
Mock Scenario 和回归数据
单元、模块、集成、E2E、性能和安全测试摘要
最终验收报告
业务规则、异常矩阵和人工 SOP
监控、告警和 Kill Switch 手册
备份与恢复演练记录
已知问题和暂不自动化范围
唯一维护者不可用预案
业务培训和维护培训记录
外部系统 Owner 和问题升级路径
```

## 21. 总目标完成定义

第一版只有同时满足以下条件才算达到目标：

```text
[ ] P0～P7 全部通过各自 Gate Review
[ ] Obsidian 三个逻辑数据库可用并可恢复
[ ] Codex + OpenCLI 公开数据采集可追踪、可审核
[ ] 网络数据与企业真实数据严格区分
[ ] 一张真实发票可从真实来源进入 Flowmate
[ ] 真实 OCR/Parser 产生可追踪字段
[ ] 真实 Supplier/PO/Verify 可以查询
[ ] 低置信度和业务冲突能转人工
[ ] 真实 07B2B 可在授权下完成提交
[ ] Unknown Commit 不会自动重复提交
[ ] ERP 回写可以恢复
[ ] 全过程 Audit 完整
[ ] Shadow 和 Canary 均通过
[ ] 冻结的最终验收集通过
[ ] 安装、备份、恢复和回滚演练成功
[ ] 唯一维护者不可用时业务可以切回人工
[ ] 生产执行路径不使用 Mock
[ ] 开发和测试仍保留 Mock 与固定 Scenario
```

## 22. 本 Spec 审核后的唯一下一步

本文审核通过后，只允许开始：

```text
Brainstorming：P0 Obsidian 数据库与网络采集工作台
→ 编写 specs/P0_Obsidian数据库目标方案.md
→ 自审
→ 用户审核
```

在 P0 Spec 审核通过前，不创建 P0 实施计划；在 P0 实施计划审核通过前，不安装、配置、采集或写入真实数据。
