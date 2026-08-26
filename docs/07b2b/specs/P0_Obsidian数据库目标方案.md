# P0 Obsidian 数据库与网络采集工作台目标方案

> 文档类型：Target Design / Spec  
> 状态：等待用户审核  
> 日期：2026-08-26  
> 上游 Spec：`docs/07b2b/specs/00_Flowmate总目标方案.md`  
> 本文批准后下一步：使用 `superpowers:writing-plans` 编写 P0 实施计划

## 1. 本文职责

本文定义 P0 最终要建成什么，以及 P0 完成后向后续子项目提供什么。

本文决定：

- Obsidian 数据库的职责和结构；
- Codex、OpenCLI 和 MinerU MCP 的职责；
- 网上原始数据如何保存；
- 三个逻辑数据库的数据模型；
- 自动采集、解析、去重、门禁和直接入库流程；
- Dataset Manifest Interface；
- 失败恢复、备份和验收目标；
- P0 明确不做的内容。

本文不包含：

- 具体安装或配置命令；
- OpenCLI 的特定站点 Adapter 名称；
- MinerU MCP 的假定工具名称；
- 逐文件编码步骤；
- 真实网络采集操作；
- Obsidian Vault 的实际创建；
- P0 实施授权。

## 2. P0 目标

在 Flowmate 产品编码开始前，先建立一个独立、可追踪、可去重、可恢复的数据工作台。

P0 最终负责：

```text
Codex 人工发起一次明确采集任务
→ OpenCLI 从获准公开来源读取或下载数据
→ 保存采集回执和允许留存的网络原始数据
→ MinerU MCP 或原生 Parser 生成派生内容
→ 自动去重
→ 自动检查许可、隐私和质量
→ 合格数据直接写入 Obsidian
→ 不合格数据进入 quarantine 或删除内容
→ 发布版本化 Dataset Manifest
```

P0 是 P1 全 Mock MVP 的硬前置条件。P0 未通过验收时，不开始产品工程脚手架和 Agent 业务开发。

## 3. P0 定位

P0 是开发数据工作台，不是 Flowmate 生产 Runtime 的一部分。

```text
P0 Data Workbench
├─ Codex
├─ OpenCLI
├─ MinerU MCP
├─ Obsidian
├─ Raw/Derived File Store
└─ Dataset Publisher

Flowmate Runtime
├─ Electron
├─ Pi SDK
├─ Kernel
├─ Tool Gateway
├─ SQLite
└─ Enterprise Adapters
```

两者唯一正式 seam 是：

```text
DatasetManifest
```

Flowmate Runtime 不依赖：

- OpenCLI 是否安装或运行；
- MinerU MCP 是否运行；
- Obsidian 是否打开；
- 某个网站是否仍可访问；
- P0 使用了哪个 OpenCLI Adapter。

## 4. 已确认约束

### 4.1 使用方式

- 由用户在 Codex 中人工发起采集任务；
- 每次只执行一个明确采集任务；
- P0 第一版不做定时采集；
- P0 第一版不做无人值守批量爬虫；
- 合格数据不需要逐条人工批准；
- 自动去重和自动门禁通过后直接写入 Obsidian；
- Dataset Release 是明确触发的版本冻结动作，不是逐条内容审批。

### 4.2 网络来源

- `PUBLIC` 策略优先；
- 每次任务开始时动态运行 `opencli list -f json` 发现当前能力；
- 目标方案不硬编码具体站点 Adapter；
- 第一版不自动使用 `COOKIE`、`INTERCEPT` 或 `UI` 策略；
- 第一版不自动采集需要登录的来源；
- 没有合适 Adapter 时不静默切换到未经审查的抓取方式；
- OpenCLI Adapter 或网站变化时保存失败证据并进入修复流程。

### 4.3 数据保存

- 源码仓库不保存网络原始数据和企业真实数据；
- Obsidian Vault 和数据文件位于源码仓库之外；
- 允许留存的网络原始数据完整保存；
- 原始数据不可原地修改；
- 禁止留存的数据删除正文和文件，只保存来源、hash、时间和拒绝原因；
- 大型文件和结构化标签不直接塞入 Obsidian Markdown；
- 所有正式关联使用稳定 ID、路径引用和 SHA-256。

### 4.4 MinerU MCP

- 本机已部署 MinerU MCP；
- MinerU 用于解析已下载的 PDF 和图片等文档；
- MinerU 不负责网络采集；
- MinerU 输出属于派生数据，不是人工正确答案；
- MinerU 不覆盖网络原始文件；
- 同一原始文件的不同解析器版本分别保存；
- 已验证 MCP server 为 `MinerU — SOTA PDF & Document Parser for AI Workflows 3.4.7`；
- 已验证本机启动命令为 `uvx mineru-open-mcp`；
- 已验证 `mineru-open-mcp` 包版本为 `1.0.21`；
- 已验证 `mineru-open-sdk` 包版本为 `0.2.5`；
- 已验证工具为 `parse_documents` 和 `get_ocr_languages`；
- 当前 Codex 线程的可调用 Tool Registry 尚未暴露 MinerU，Spike 通过直接 stdio MCP 协议完成；
- Flowmate 使用项目级 `.codex/config.toml` 注册包装后的 MinerU MCP；
- 用户级 `~/.codex/config.toml` 保持不变，避免影响其他 Codex 项目；
- 项目必须被 Codex 标记为受信任后，项目级 MCP 配置才允许生效；
- 当前线程不会动态重新加载新 MCP，实施阶段需要重新打开 Flowmate Codex 会话验证原生 Tool；
- `parse_documents.file_sources` 是文件路径或 URL 数组；
- `parse_documents` 会把文件或 URL 内容上传到 `mineru.net` 云端处理，不是纯本地解析；
- 企业内部数据只有在数据 Owner 和信息安全明确允许上传 MinerU 云端时才能调用该 Tool；
- 不允许上传云端的企业数据必须使用独立的本地 Parser Adapter；
- 当前真实解析测试在 MinerU API 创建任务和状态查询成功后，下载 `cdn-mineru.openxlab.org.cn` 结果 ZIP 时稳定发生 `SSL_UNEXPECTED_EOF_WHILE_READING`；
- Windows curl 使用同一个签名 URL 可以成功下载，Python `httpx`、`requests` 和 `urllib` 均失败；
- 当前阻塞位于 `mineru-open-sdk 0.2.5` 使用 Python/OpenSSL 下载 CDN 结果的链路；
- 未包装的上游 MCP 状态为 `DEGRADED_RESULT_DOWNLOAD`，不能直接用于 P0；
- 已在 `tools/mineru-mcp-wrapper` 实现本地兼容包装层，不修改 uv 缓存；
- 包装层保留 `parse_documents` 和 `get_ocr_languages` Tool 名称；
- 包装层使用 Windows `curl.exe`/Schannel 下载 MinerU 结果 ZIP；
- 包装后的 Tool Schema 已验证包含 `file_sources.maxItems = 200`；
- 201 份文件已验证在发起 MinerU 网络请求前被拒绝；
- 包装层已使用 W3C 公开 PDF 完成真实解析，返回 `Dummy PDF file`；
- 包装层状态为 `VERIFIED_WITH_FLOWMATE_WRAPPER`；
- 后续 P0 必须启动包装层，不能退回直接运行未包装的 `uvx mineru-open-mcp`；
- 运行时能力预检或真实解析失败时仍进入 `PARSER_UNAVAILABLE` 或 `RESULT_DOWNLOAD_TLS_FAILED`，P0 不能通过验收。

### 4.5 MinerU 单次文件上限

MinerU MCP 的 CLI 参数和 `parse_documents` Tool Schema 都没有原生的文件数量上限字段，因此由 P0 的 `MinerUMcpAdapter` 强制以下配置：

```yaml
mineru:
  max_files_per_run: 200
```

规则：

- 每次 `parse_documents` 调用的 `file_sources.length` 必须小于或等于 200；
- 201 份或更多文件不能进入同一次 MCP 调用；
- 超限时返回 `BATCH_LIMIT_EXCEEDED`；
- Acquisition Orchestrator 可以创建多个独立子批次；
- 每个子批次拥有独立 Batch ID、状态、计数和 Audit；
- 不允许在 Adapter 内静默拆批，避免用户误以为它是一次执行；
- 200 是文件数量上限，不替代 MinerU 自身的单文件页数和文件大小限制；
- P0 测试只验证上限逻辑，不为了测试而实际上传 200 份文件。

## 5. 选择的总体方案

采用“Obsidian 管元数据，原始和派生文件独立保存”的方案。

```text
Obsidian
├─ 来源卡片
├─ 采集任务卡片
├─ 知识条目
├─ 公开样本
├─ 真实业务资产索引
├─ Quarantine
├─ Failure
└─ Dataset Release

FlowmateData
├─ staging
├─ web-raw
├─ derived
├─ files/public
├─ files/private-raw
├─ files/private-sanitized
├─ labels
├─ manifests
├─ releases
├─ quarantine
└─ backups
```

不采用：

- 把所有 PDF、图片和网页原始文件作为 Vault 附件堆入 Obsidian；
- 先建设 SQLite 数据目录，再开发双向 Obsidian 同步；
- 把 Obsidian 作为 Flowmate 生产事务数据库。

## 6. 总体架构

```text
Codex
│
│ 定义一次采集目标
│ 调用当前可用工具
│ 解释错误和生成结构化记录
↓
Acquisition Orchestrator
│
│ Job ID / 状态 / 幂等 / 恢复点
↓
OpenCLI Gateway
│
│ 动态发现只读 Adapter
│ 获取网页、JSON、文本和文件
↓
Staging + Acquisition Receipt
│
│ 临时内容 / URL / 时间 / 命令摘要 / hash
↓
Raw Artifact Store
│
│ 去重后的不可变原始数据
↓
Document Parser Interface
├─ NativeTextParser
├─ HtmlContentParser
└─ MinerUMcpAdapter
↓
Derived Artifact Store
│
│ Markdown / 结构 JSON / 图片 / 元数据
↓
Dedupe Engine
│
│ URL / Raw SHA-256 / Content SHA-256
↓
Policy Engine
│
│ License / Privacy / Quality
↓
Catalog Writer
│
│ 自动写入 Obsidian 或写入 Quarantine
↓
Dataset Publisher
│
│ Manifest / Checksums / Release Notes
↓
P1～P7
```

## 7. Module 与 Interface

### 7.1 Acquisition Orchestrator

职责：

- 为一次采集生成稳定 Job ID；
- 保存目标、查询、来源和状态；
- 控制一次只处理一个任务；
- 记录每个恢复点；
- 保证重试不会重复保存相同文件；
- 汇总成功、重复、隔离和失败数量。

Interface：

```ts
interface AcquisitionJob {
  jobId: string;
  objective: string;
  sourceId: string;
  query?: string;
  status: AcquisitionJobStatus;
  startedAt: string;
  finishedAt?: string;
  counts: {
    discovered: number;
    stored: number;
    duplicated: number;
    quarantined: number;
    failed: number;
  };
}
```

### 7.2 OpenCLI Gateway

职责：

- 动态读取 OpenCLI 当前命令注册表；
- 选择符合 Source Policy 的只读 Adapter；
- 执行采集；
- 保存非敏感命令摘要和原始输出；
- 不保存 Cookie、Token、密码或浏览器凭证；
- Adapter 失败时保存 trace 引用；
- 不静默降级到未经审查的抓取方式。

Interface：

```ts
interface OpenCliAcquisitionRequest {
  jobId: string;
  sourceId: string;
  objective: string;
  query?: string;
  outputFormat: "json";
}

interface AcquisitionResult {
  jobId: string;
  adapterRef: string;
  strategy: "public";
  retrievedAt: string;
  items: DiscoveredItem[];
  traceRef?: string;
}
```

### 7.3 Raw Artifact Store

职责：

- 在 Staging 中接收网络原始响应或文件；
- 计算 SHA-256；
- 精确去重后把新内容提升到不可变 Raw Archive；
- 对重复内容复用已有 Artifact；
- 记录同一 Artifact 的多个来源和采集任务；
- 删除明确禁止留存的正文，同时保留审计元数据。

Interface：

```ts
interface RawArtifactRef {
  artifactId: string;
  sourceIds: string[];
  acquisitionJobIds: string[];
  canonicalUrl?: string;
  rawRef?: string;
  rawSha256: string;
  mimeType: string;
  retentionStatus: "retained" | "metadata_only" | "deleted_by_policy";
}
```

### 7.4 Document Parser

职责：

- 根据 MIME 和文件能力选择 Parser；
- 原生处理 JSON、Markdown 和纯文本；
- 提取 HTML 正文；
- 通过 MinerU MCP 处理能力范围内的 PDF 和图片；
- 记录 Parser 名称、版本、输入 hash、输出文件和 warning；
- 解析失败时不修改 Raw Artifact。

Interface：

```ts
interface ParseDocumentInput {
  artifactId: string;
  sourceFileRef: string;
  sourceSha256: string;
  mimeType: string;
}

interface ParsedDocument {
  artifactId: string;
  parserName: string;
  parserVersion: string;
  parsedAt: string;
  contentRef: string;
  structureRef?: string;
  imageRefs: string[];
  contentSha256: string;
  pageCount?: number;
  warnings: string[];
}

interface DocumentParser {
  parse(input: ParseDocumentInput): Promise<ParsedDocument>;
}

interface MinerUMcpAdapterConfig {
  maxFilesPerRun: 200;
}
```

### 7.5 Dedupe Engine

职责：

- URL 去重；
- 原始文件 hash 去重；
- 标准化内容 hash 去重；
- 保存重复关系，不重复保存相同二进制；
- 区分“同 URL 内容更新”和“不同 URL 内容相同”。

Interface：

```ts
interface DedupeDecision {
  status: "unique" | "duplicate_url" | "duplicate_raw" | "duplicate_content" | "url_updated";
  canonicalArtifactId: string;
  relatedArtifactIds: string[];
}
```

### 7.6 Policy Engine

职责：

- 检查来源策略；
- 检查许可是否允许保存和用于数据集；
- 检查敏感信息；
- 检查 Parser 输出质量；
- 决定自动入库、隔离或删除内容；
- 产生可审计且可解释的机器决策。

Interface：

```ts
interface PolicyDecision {
  itemId: string;
  licenseStatus: "allowed" | "unknown" | "denied";
  privacyStatus: "passed" | "quarantined" | "delete_content";
  qualityStatus: "passed" | "quarantined";
  action: "catalog" | "quarantine" | "delete_content_keep_metadata";
  reasonCodes: string[];
  policyVersion: string;
  decidedAt: string;
}
```

### 7.7 Obsidian Catalog Writer

职责：

- 根据 Schema 生成 Markdown Properties；
- 写入正确的逻辑数据库目录；
- 维护 Source、Job、Artifact、Knowledge、Sample 和 Release 关联；
- Obsidian 未运行时保存待写队列；
- 重试时不生成第二张相同 ID 的卡片；
- 不把大型原始文件复制进 Vault。

Interface：

```ts
interface CatalogEntryRef {
  entryId: string;
  entryType: "knowledge" | "public_sample" | "business_asset" | "quarantine" | "failure";
  noteRef: string;
  sourceId: string;
  artifactId?: string;
  pipelineStatus: string;
}
```

### 7.8 Dataset Publisher

职责：

- 选择可发布的 `CATALOGED` 条目；
- 校验 Schema、引用和 hash；
- 拒绝 license/privacy/quality 未通过的条目；
- 生成 Manifest、checksums 和 release notes；
- 冻结发布目录；
- 创建 Dataset Release 卡片。

P0 对后续子项目的正式 Interface：

```ts
interface DatasetManifest {
  schemaVersion: "1.0";
  datasetVersion: string;
  createdAt: string;
  sourcePolicyVersion: string;
  items: DatasetManifestItem[];
  checksumsRef: string;
}

interface DatasetManifestItem {
  itemId: string;
  itemType: "knowledge" | "public_sample" | "business_asset";
  sourceId: string;
  artifactId: string;
  rawRef?: string;
  derivedRef?: string;
  expectedRef?: string;
  rawSha256: string;
  contentSha256?: string;
  parserName?: string;
  parserVersion?: string;
  licenseStatus: "allowed";
  privacyStatus: "passed";
  qualityStatus: "passed";
  scenarios: string[];
  split?: "development" | "regression" | "acceptance";
}
```

## 8. 数据物理结构

默认数据根目录：

```text
D:\code\agent-learn\agent\Flowmate\FlowmateData\
├─ README.md
├─ vault\
│  └─ README.md
├─ staging\
├─ web-raw\
├─ derived\
│  ├─ mineru\
│  ├─ html\
│  └─ native\
├─ files\
│  ├─ public\
│  ├─ private-raw\
│  └─ private-sanitized\
├─ labels\
├─ manifests\
├─ releases\
├─ quarantine\
├─ failures\
└─ backups\
```

### 8.1 Staging

临时接收：

- OpenCLI 原始结构化输出；
- 下载过程中的临时文件；
- canonical URL；
- 获取时间；
- Adapter 引用；
- 非敏感请求参数；
- 初始 hash。

Staging 内容经过精确去重后：

- 新内容提升到 `web-raw`；
- 重复内容删除临时副本并关联已有 Artifact；
- 失败内容进入 `failures`；
- 等待策略决定的内容进入 `quarantine`。

### 8.2 Web Raw Archive

```text
D:\code\agent-learn\agent\Flowmate\FlowmateData\web-raw\
└─ <source-domain>\
   └─ <acquisition-job-id>\
      └─ <artifact-id>\
         ├─ source.json
         ├─ request.json
         ├─ response.json
         ├─ files\
         └─ checksums.sha256
```

其中：

- `source.json` 保存来源、URL、获取时间和 Adapter 引用；
- `request.json` 只保存非敏感采集参数；
- `response.json` 保存 OpenCLI 原始结构化输出；
- `files` 保存允许留存的下载文件；
- `checksums.sha256` 锁定原始内容。

### 8.3 MinerU 派生目录

```text
D:\code\agent-learn\agent\Flowmate\FlowmateData\derived\mineru\
└─ <artifact-id>\
   └─ <parser-version>\
      ├─ content.md
      ├─ structure.json
      ├─ metadata.json
      ├─ images\
      └─ checksums.sha256
```

`metadata.json` 至少记录：

```text
artifactId
sourceSha256
parserName
parserVersion
parsedAt
outputFiles
outputHashes
pageCount
warnings
```

## 9. Obsidian Vault 结构

```text
D:\code\agent-learn\agent\Flowmate\FlowmateData\vault\
├─ 00_Dashboard\
├─ 10_Sources\
├─ 20_AcquisitionJobs\
├─ 30_PublicKnowledge\
├─ 40_PublicSamples\
├─ 50_BusinessAssets\
├─ 60_DatasetReleases\
├─ 70_Quarantine\
├─ 80_Failures\
└─ 90_Templates\
```

### 9.1 三个逻辑数据库

#### 公开知识库

保存：

- 发票格式和字段知识；
- 公开税务与业务规则；
- OCR 资料；
- 07B2B 公开帮助和字段说明；
- 浏览器自动化通用知识；
- 异常处理资料。

#### 公开样本库

保存：

- 许可清晰的公开发票样例；
- 公开 OCR 数据集索引；
- 公开字段标注；
- 样本质量；
- 适用限制；
- 原始和派生文件引用。

#### 真实业务资产库

只接收企业内部数据：

- 企业脱敏发票；
- 人工正确字段；
- 供应商和 PO 样例；
- 历史人工录入结果；
- 异常案例；
- 业务规则；
- 数据 Owner 和授权；
- Dataset 版本。

OpenCLI 不能把网络数据写入真实业务资产库。

## 10. Obsidian Schema

### 10.1 Source

```yaml
---
source_id: SRC-000001
name: 来源名称
domain: example.com
source_type: public_web
access_strategy: public
source_policy: allowed
raw_retention: allowed
dataset_usage: allowed
license_rule: explicit_or_verified
privacy_rule: no_sensitive_personal_data
synthetic: false
contains_synthetic_identifiers: false
enabled: true
---
```

公开合成数据集必须设置：

```yaml
synthetic: true
contains_synthetic_identifiers: true
```

这种标记允许 Policy Engine 区分“真实个人敏感信息”和“数据集明确声明的合成姓名、地址、Tax ID、IBAN”；仍需记录 `SYNTHETIC_IDENTIFIERS_PRESENT`，且不能进入最终企业验收集。

### 10.2 Acquisition Job

```yaml
---
job_id: ACQ-20260826-0001
source_id: SRC-000001
objective: 采集目标
query: 查询内容
adapter_ref: dynamically_discovered
strategy: public
started_at: 2026-08-26T10:00:00+08:00
finished_at: 2026-08-26T10:02:00+08:00
items_discovered: 12
items_stored: 8
items_duplicated: 2
items_quarantined: 1
items_failed: 1
status: completed
---
```

### 10.3 Public Knowledge

```yaml
---
knowledge_id: KNOW-000001
title: 增值税发票字段说明
source_id: SRC-000001
artifact_id: ART-000001
category: invoice_rule
source_url: https://example.com/page
retrieved_at: 2026-08-26T10:00:00+08:00
raw_sha256: sha256-value
content_sha256: sha256-value
license_status: allowed
privacy_status: passed
quality_status: passed
pipeline_status: cataloged
tags:
  - invoice
  - field-definition
---
```

### 10.4 Public Sample

```yaml
---
sample_id: SAMPLE-000001
source_id: SRC-000002
artifact_id: ART-000002
sample_type: invoice_pdf
raw_file_ref: ../web-raw/example.com/ACQ-20260826-0001/ART-000002/files/sample.pdf
derived_ref: ../derived/mineru/ART-000002/mineru-version/content.md
raw_sha256: sha256-value
content_sha256: sha256-value
file_format: pdf
parser_name: mineru
parser_version: mineru-version
label_status: unlabeled
scenarios:
  - normal
license_status: allowed
privacy_status: passed
quality_status: passed
pipeline_status: cataloged
dataset_version: unassigned
---
```

### 10.5 Business Asset

```yaml
---
business_asset_id: BIZ-000001
source_type: internal_finance
data_owner_role: finance_ap
authorization_status: approved_for_development
raw_file_ref: ../files/private-raw/BIZ-000001.pdf
sanitized_file_ref: ../files/private-sanitized/BIZ-000001.pdf
expected_ref: ../labels/BIZ-000001.expected.json
raw_sha256: sha256-value
business_review_status: approved
dataset_version: unassigned
---
```

### 10.6 Dataset Release

```yaml
---
dataset_version: dataset-v0.1
manifest_ref: ../releases/dataset-v0.1/manifest.json
checksums_ref: ../releases/dataset-v0.1/checksums.sha256
knowledge_count: 100
public_sample_count: 50
business_asset_count: 0
created_at: 2026-08-26T12:00:00+08:00
status: released
---
```

## 11. ID 规则

```text
SRC-000001           Source
ACQ-YYYYMMDD-0001    Acquisition Job
ART-000001           Raw Artifact
KNOW-000001          Knowledge Entry
SAMPLE-000001        Public Sample
BIZ-000001           Business Asset
dataset-v0.1         Dataset Release
```

ID 一经分配不可复用。重命名 Markdown 文件不改变 ID。

## 12. 自动采集流程

```text
用户在 Codex 中定义一个采集目标
→ Acquisition Orchestrator 创建 Job
→ OpenCLI Gateway 动态发现当前 Adapter
→ 仅选择符合 Source Policy 的 PUBLIC Adapter
→ 输出写入 Staging
→ 生成 Acquisition Receipt
→ 计算 URL 和 Raw SHA-256
→ 精确重复则复用已有 Artifact
→ 新内容提升到 Web Raw Archive
→ File Router 选择 Parser
→ MinerU 或原生 Parser 生成 Derived Artifact
→ 计算 Content SHA-256
→ 执行内容去重
→ Policy Engine 检查 License / Privacy / Quality
→ action=catalog：直接写入 Obsidian
→ action=quarantine：写入 Quarantine
→ action=delete_content_keep_metadata：删除内容并保留审计元数据
→ 更新 Acquisition Job 统计
```

没有逐条人工批准步骤。

## 13. 三级去重

### 13.1 Canonical URL

同一 canonical URL 再次采集：

- 内容 hash 相同：关联已有 Artifact；
- 内容 hash 变化：创建新 Artifact，并记录 `url_updated` 关系。

### 13.2 Raw SHA-256

不同 URL 下载到相同二进制：

- 不保留第二份文件；
- 新 Source 和新 Job 关联已有 Artifact；
- 状态为 `duplicate_raw`。

### 13.3 Content SHA-256

不同文件封装解析出相同标准化正文：

- 原始二进制可以分别保留；
- 派生内容标记 `duplicate_content`；
- Dataset Publisher 默认只选择一个 canonical item。

P0 不建设向量相似度、模糊图片相似度和语义聚类去重。

## 14. 自动门禁

### 14.1 License Gate

```text
source_policy=allowed + raw_retention=allowed
→ 允许保留内容

source_policy=unknown
→ QUARANTINED_LICENSE

source_policy=denied 或 raw_retention=denied
→ 删除内容
→ 保留 URL、hash、时间、策略版本和原因
```

### 14.2 Privacy Gate

自动检测：

- 个人证件号；
- 银行账号；
- 个人手机号和邮箱；
- 个人住址；
- 密码、Token、Cookie 和 API Key；
- 未预期的人脸和身份材料；
- 页面或响应中的隐藏凭证。

结果：

```text
未发现风险
→ PRIVACY_PASSED

发现可隔离风险
→ QUARANTINED_PRIVACY

明确不能留存
→ 删除内容
→ 保留审计元数据
```

### 14.3 Quality Gate

知识条目必须满足：

- 正文非空；
- 来源 URL 存在；
- 标题可识别；
- 获取时间存在；
- 原始 hash 存在；
- Parser 版本存在；
- 内容引用可读取。

公开文档样本必须满足：

- 原始文件可读取；
- Raw SHA-256 存在；
- MinerU 或对应 Parser 输出非空；
- 页数和输出文件数量合理；
- 派生文件 hash 完整；
- Parser 没有致命 warning。

质量不通过进入 `QUARANTINED_QUALITY`。

## 15. 状态机

### 15.1 Acquisition Job

```text
CREATED
→ DISCOVERING_ADAPTER
→ FETCHING
→ STAGED
→ RAW_SAVED
→ PARSING
→ DEDUPLICATING
→ POLICY_CHECKING
→ CATALOGING
→ COMPLETED
```

失败状态：

```text
ADAPTER_NOT_FOUND
FETCH_FAILED
PARSER_UNAVAILABLE
PARSE_FAILED
RESULT_DOWNLOAD_TLS_FAILED
BATCH_LIMIT_EXCEEDED
POLICY_REJECTED
CATALOG_WRITE_FAILED
CANCELLED
```

### 15.2 Artifact Pipeline

```text
DISCOVERED
→ STAGED
→ RAW_SAVED
→ PARSED
→ DEDUPED
→ POLICY_PASSED
→ CATALOGED
→ RELEASED
```

分支状态：

```text
DUPLICATE_URL
DUPLICATE_RAW
DUPLICATE_CONTENT
QUARANTINED_LICENSE
QUARANTINED_PRIVACY
QUARANTINED_QUALITY
UNSUPPORTED_FORMAT
CONTENT_DELETED_BY_POLICY
WITHDRAWN
```

## 16. 失败恢复

- Staging 已写入后，采集任务可从 Staging 继续；
- Raw Artifact 已存在后，不重新下载相同内容；
- MinerU 失败后从 `RAW_SAVED` 重试；
- MinerU 不可用时不自动换成未经批准的外部解析服务；
- MinerU CDN 结果下载发生 TLS EOF 时记录 `RESULT_DOWNLOAD_TLS_FAILED`，不把任务标记为解析成功；
- 超过 200 份文件时在调用 MCP 前返回 `BATCH_LIMIT_EXCEEDED`；
- Catalog 写入失败时保留待写队列；
- Obsidian 未运行时不丢失合格条目；
- 同一 Job 重试不创建第二个 Job ID；
- 网络错误最多自动重试三次；
- Adapter 变化失败时保存 trace 引用；
- 失败 Adapter 不静默降级到手写 fetch；
- 禁止留存的内容删除后不能通过重试恢复正文；
- 所有恢复动作追加事件记录，不覆盖原失败事实。

## 17. Dataset 发布

每条合格数据自动进入 Obsidian。Dataset Release 由用户明确触发，用于冻结一组数据版本。

```text
选择 CATALOGED 条目
→ 全量 Schema 校验
→ 文件引用校验
→ Raw/Content hash 校验
→ Policy 状态校验
→ 去重关系校验
→ 生成 manifest.json
→ 生成 checksums.sha256
→ 生成 release-notes.md
→ 发布目录只读
→ 创建 Dataset Release 卡片
```

P0 Release 只包含：

- 公开知识；
- 公开样本；
- 后续获得并已完成内部授权的真实业务资产索引。

P0 公开网络数据可以用于：

- P1 Mock 设计；
- P2 OCR 技术试验；
- 公开知识检索；
- 数据工具测试；
- 场景分类参考。

P0 公开网络数据不能替代：

- 企业真实发票准确率评估；
- 企业供应商匹配评估；
- 企业 PO 匹配评估；
- 真实 B2B 提交评估；
- 生产 STP；
- 最终验收集。

## 18. 测试目标

### 18.1 Schema Test

覆盖：

```text
Source
AcquisitionJob
RawArtifactRef
ParsedDocument
DedupeDecision
PolicyDecision
CatalogEntryRef
DatasetManifest
```

缺少 ID、来源、状态、hash 或策略字段时必须失败。

### 18.2 Dedupe Test

覆盖：

- 相同 URL 和相同内容；
- 相同 URL 和更新内容；
- 不同 URL 和相同文件；
- 不同文件和相同派生内容；
- 相同 Job 重试；
- 重复项的多来源关系。

### 18.3 Policy Test

覆盖：

- 公开且允许保存；
- 许可未知；
- 明确禁止保存；
- 个人手机号；
- 银行账号；
- Token/API Key；
- 登录态来源；
- 质量不合格文档。

### 18.4 MinerU Contract Test

使用固定非敏感测试文件覆盖：

- PDF 成功解析；
- 图片成功解析；
- 空 PDF；
- 损坏 PDF；
- 加密 PDF；
- 重复解析；
- MinerU 不可用；
- 解析中途失败；
- 同一文件使用不同 Parser 版本；
- 200 份文件通过 Adapter 上限校验；
- 201 份文件在调用 MCP 前被拒绝；
- 超限拒绝不会产生 MinerU 网络请求；
- MinerU API 成功但 CDN 结果下载失败；
- `RESULT_DOWNLOAD_TLS_FAILED` 可以被明确识别和恢复。

### 18.5 Integration Test

验证：

```text
OpenCLI Fixture
→ Staging
→ Raw Archive
→ MinerU/原生 Parser
→ Dedupe
→ Policy
→ Obsidian Card
→ Dataset Manifest
```

### 18.6 Real Smoke Test

P0 验收时实际完成：

1. 使用 OpenCLI 搜索公开发票数据集；
2. 选择许可证明确的 `Voxel51/high-quality-invoice-images-for-ocr`；
3. 下载一张已标注合成发票 `data/batch1-0494.jpg` 和 `samples.json` 中对应标注；
4. 保存 Hugging Face Dataset Card、API 元数据、原始图片和标注来源；
5. 使用本地 MinerU MCP 包装层解析发票图片；
6. 再次采集同一数据并证明没有重复文件；
7. 自动通过门禁并直接写入 Obsidian 公开样本库；
8. 发布 `dataset-v0.1`；
9. 从备份恢复到隔离目录；
10. 打开恢复后的 Vault 并验证 Manifest。

论文搜索结果只能进入公开知识库，不能作为发票样本库或 P0 Smoke Test 的输入。

## 19. 备份与恢复目标

备份包含：

```text
vault
web-raw
derived
files/public
files/private-raw
files/private-sanitized
labels
manifests
releases
quarantine元数据
failures
配置和Schema版本
```

不包含：

- 浏览器 Cookie；
- 登录 Token；
- API Key；
- 明文密码；
- 未获准保留的网络内容。

最低备份形态：

```text
工作数据：D:\code\agent-learn\agent\Flowmate\FlowmateData
第一备份：同机加密备份目录
第二备份：另一块加密磁盘或批准的企业存储
```

恢复验证必须证明：

- Vault 可打开；
- Source 可查询；
- Public Sample 可查询；
- Raw Artifact hash 正确；
- MinerU 派生文件存在且 hash 正确；
- Dataset Manifest 引用有效；
- 被策略删除的内容不会从备份重新出现。

## 20. P0 完成标准

```text
[ ] D:\code\agent-learn\agent\Flowmate\FlowmateData 逻辑结构符合本 Spec
[ ] 仓库根 `README.md` 可作为项目入口
[ ] `docs/07b2b/README.md` 可导航 Spec、Plan 和 Evidence
[ ] `packages/data-workbench/README.md` 的命令已验证
[ ] `tools/mineru-mcp-wrapper/README.md` 与当前包装层一致
[ ] `FlowmateData/README.md` 说明数据结构和禁止事项
[ ] `FlowmateData/vault/README.md` 说明三个逻辑数据库
[ ] Obsidian Vault 可打开
[ ] 三个逻辑数据库可查询
[ ] Source、Job、Artifact 和 Release 可关联
[ ] OpenCLI 动态发现流程可运行
[ ] 只读 PUBLIC 采集成功
[ ] 允许留存的网络原始数据完整保存
[ ] MinerU MCP 能力预检通过
[ ] MinerU MCP 真实解析成功
[ ] MinerU CDN 结果下载链路成功
[ ] `max_files_per_run` 固定为 200
[ ] 201 份文件在 MCP 调用前被拒绝
[ ] 原始和派生数据分离
[ ] URL、Raw SHA-256、Content SHA-256 三级去重通过
[ ] 重复采集不产生第二份相同原始文件
[ ] 自动 License Gate 通过测试
[ ] 自动 Privacy Gate 通过测试
[ ] 自动 Quality Gate 通过测试
[ ] 不合格数据进入 Quarantine 或按策略删除
[ ] 合格数据无需人工批准直接写入 Obsidian
[ ] Dataset Manifest 生成成功
[ ] dataset-v0.1 发布成功
[ ] 备份成功
[ ] 隔离恢复成功
[ ] 所有测试与实际输出保存在 evidence/P0
```

只要有一项未通过，P0 就不能结束，也不能进入 P1。

## 21. P0 明确不做

- 不做定时采集；
- 不做无人值守后台爬虫；
- 不自动使用登录态 Adapter；
- 不编写特定网站的自定义 OpenCLI Adapter；
- 不把 OpenCLI 集成进 Flowmate Runtime；
- 不把 MinerU MCP 集成进 Flowmate 生产 OCR；
- 不把 Obsidian 当 Flowmate 生产数据库；
- 不从网上构造企业真实供应商、PO 和历史结果；
- 不把 MinerU 输出当人工正确答案；
- 不把论文搜索结果当作发票样本数据；
- 不建立最终生产验收集；
- 不训练 OCR 模型；
- 不建设向量数据库；
- 不建设 Web 管理后台；
- 不建设多人权限系统；
- 不同步到未经批准的云服务；
- 不在 P0 中开始 Electron、Pi SDK 或 07B2B 产品开发。

## 22. P0 完成后的输出

P0 对 P1 提供：

```text
DatasetManifest
Obsidian Vault
允许留存的 Raw Archive
MinerU/Parser Derived Archive
项目、子项目、数据根和 Vault README
Source Policy
Schema 和模板
Backup/Restore Evidence
P0 Verification Evidence
```

P1 不依赖：

- 某个具体 OpenCLI Adapter；
- MinerU MCP 调用细节；
- Obsidian CLI 调用细节；
- 某个网站结构；
- P0 内部采集状态机。

## 23. 本 Spec 审核后的唯一下一步

本文审核通过后，只允许：

```text
确认用户批准包含 MinerU 包装层的新版本 P0 Spec
→ 读取 superpowers:writing-plans
→ 创建 docs/07b2b/plans/P0_Obsidian数据库实施计划.md
→ 自审实施计划
→ 交给用户审核
```

在用户批准 P0 实施计划之前：

- 不创建 `D:\code\agent-learn\agent\Flowmate\FlowmateData`；
- 不启动数据库搭建；
- 不执行网络采集；
- 不调用 MinerU 解析真实文件；
- 不修改 Obsidian Vault；
- 不修改用户级 `~/.codex/config.toml`；
- 不进入 P1。
