# P0 Obsidian Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成一个由 Codex 人工触发、OpenCLI 只读采集、MinerU MCP 解析、自动去重和自动门禁、Obsidian 编目、Dataset Manifest 发布，并且可备份恢复的 P0 数据工作台。

**Architecture:** P0 是 Flowmate 产品 Runtime 之外的独立数据流水线。TypeScript 数据工具通过稳定 Interface 管理采集、原始文件、派生文件、去重、Policy、Catalog 和 Release；包装后的 MinerU MCP 仅通过项目级 `.codex/config.toml` 注册，后续项目只消费版本化 `DatasetManifest`。

**Tech Stack:** Windows PowerShell、Git、Node.js、npm workspaces、TypeScript、Zod、Vitest、OpenCLI 1.8.6、Obsidian + Bases、MinerU MCP 3.4.7、Python 包装层、SHA-256。

**Spec:** [P0 Obsidian 数据库目标方案](../specs/P0_Obsidian数据库目标方案.md)

## Global Constraints

- P0 必须完成后才能开始 P1。
- 数据根目录固定为 `D:\code\agent-learn\agent\FlowmateData`。
- 源码仓库不得保存网络原始数据、企业真实数据、Token、Cookie、密码或 API Key。
- 用户级 `~/.codex/config.toml` 不修改。
- MinerU 通过项目级 `.codex/config.toml` 启动 `tools/mineru-mcp-wrapper`。
- MinerU 每次 `parse_documents` 最多 200 份文件；201 份必须在联网前拒绝。
- MinerU 会将内容上传到 `mineru.net`，未经数据 Owner 和信息安全允许的企业数据不得调用。
- P0 第一版只允许人工触发的单个采集任务。
- P0 第一版自动采集仅允许 OpenCLI `PUBLIC` 且 `read` 的命令。
- 数据通过去重、License、Privacy 和 Quality Gate 后直接写入 Catalog，不逐条人工批准。
- 许可或隐私禁止留存的内容必须删除正文，仅保留审计元数据。
- Obsidian 不是 Flowmate 生产事务数据库。
- 所有实现采用 TDD：先看到目标测试失败，再写最小实现。
- 每个 Task 通过自身验证后才提交；任何验证失败立即停止。

---

## 执行者使用说明

每次只执行一个 Task。Task 内按照复选框顺序执行，不合并多个步骤。

标记：

- `🤖`：Codex 可以在当前工作区完成；
- `👤`：用户必须亲自确认或操作桌面应用；
- `⛔`：条件不满足时立即停止。

当前基线事实：

```text
Git 仓库：尚未初始化
根 package.json：不存在
项目 .codex/config.toml：不存在
FlowmateData：不存在
MinerU 包装层：已实现，8 个自动测试通过
P0 目标 Spec：已批准
P0 实施：尚未开始
```

## 目标文件结构

```text
Flowmate/
├─ README.md
├─ docs/
│  └─ 07b2b/
│     └─ README.md
├─ .codex/
│  └─ config.toml
├─ .gitignore
├─ package.json
├─ package-lock.json
├─ tsconfig.base.json
├─ eslint.config.mjs
├─ packages/
│  └─ data-workbench/
│     ├─ README.md
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ tsconfig.build.json
│     ├─ src/
│     │  ├─ cli.ts
│     │  ├─ config.ts
│     │  ├─ types.ts
│     │  ├─ schemas.ts
│     │  ├─ ids.ts
│     │  ├─ filesystem-layout.ts
│     │  ├─ process-runner.ts
│     │  ├─ opencli-gateway.ts
│     │  ├─ source-policy-repository.ts
│     │  ├─ acquisition-orchestrator.ts
│     │  ├─ public-file-downloader.ts
│     │  ├─ raw-artifact-store.ts
│     │  ├─ dedupe-engine.ts
│     │  ├─ mineru-mcp-client.ts
│     │  ├─ parser-router.ts
│     │  ├─ policy-engine.ts
│     │  ├─ catalog-outbox.ts
│     │  ├─ obsidian-templates.ts
│     │  ├─ obsidian-catalog-writer.ts
│     │  ├─ dataset-publisher.ts
│     │  └─ backup-service.ts
│     └─ test/
│        ├─ fixtures/
│        └─ *.test.ts
├─ scripts/
│  ├─ backup-flowmate-data.ps1
│  ├─ download-public-file.ps1
│  └─ verify-flowmate-data-restore.ps1
└─ tools/
   └─ mineru-mcp-wrapper/
      └─ 已验证包装层

FlowmateData/
├─ README.md
├─ vault/
│  └─ README.md
├─ staging/
├─ web-raw/
├─ derived/
├─ files/
├─ labels/
├─ manifests/
├─ releases/
├─ quarantine/
├─ failures/
└─ backups/
```

---

### Task 0: 初始化 Git 并保护数据和密钥

**Files:**

- Create: `.gitignore`
- Create: `README.md`
- Create: `docs/07b2b/README.md`
- Inspect: `docs/07b2b/specs/P0_Obsidian数据库目标方案.md`
- Inspect: `tools/mineru-mcp-wrapper/`

**Interfaces:**

- Consumes: 已批准的 P0 Spec 和已验证 MinerU 包装层。
- Produces: `main` 分支、首个安全基线提交、不会收录数据和密钥的 Git 规则。

- [ ] **Step 1: 写入根 `.gitignore`** 🤖

使用 `apply_patch` 创建：

```gitignore
node_modules/
dist/
coverage/
.env
.env.*
!.env.example
*.db
*.db-shm
*.db-wal
.tmp-mineru-probe/
tools/mineru-mcp-wrapper/.venv/
tools/mineru-mcp-wrapper/.pytest_cache/
**/__pycache__/
*.pyc
FlowmateData/
data/raw/
data/private/
secrets/
auth.json
*.pem
*.key
```

- [ ] **Step 2: 创建项目和方案导航 README** 🤖

根 `README.md` 固定包含：

```markdown
# Flowmate

Flowmate 是单人开发的企业数字员工执行平台。第一位数字员工负责 07B2B 发票录入。

## 当前阶段

P0：Obsidian 数据库与公开发票数据采集工作台。

## P0职责

采集许可明确的公开发票数据，保存原始文件，使用MinerU解析，自动去重和门禁，写入Obsidian并发布Dataset Manifest。

## P0不负责

不开发Electron产品、不接真实07B2B、不构造企业供应商/PO、不建立最终验收集。

## Interface

P0对后续阶段只提供版本化DatasetManifest、Obsidian索引、Raw/Derived Archive和验证证据。

## 环境与命令

- 安装：npm install
- 检查：npm run lint && npm run typecheck && npm test && npm run build
- 数据目录：npm run data:init
- 采集发现：npm run data:discover
- 数据发布：npm run data:publish -- --version dataset-v0.1

## 从这里开始

1. [总目标方案](docs/07b2b/specs/00_Flowmate总目标方案.md)
2. [P0目标方案](docs/07b2b/specs/P0_Obsidian数据库目标方案.md)
3. [P0实施计划](docs/07b2b/plans/P0_Obsidian数据库实施计划.md)

## 安全

- 真实数据不进入 Git。
- Token、Cookie 和密码不写入文档或源码。
- MinerU 会上传内容到 mineru.net；企业数据必须先获得授权。
- P0 未通过 Gate 前不进入 P1。

## 常见失败和停止条件

- OpenCLI不是PUBLIC/read时停止。
- 许可不明的数据进入Quarantine。
- MinerU一次超过200份文件时拒绝。
- 备份未恢复验证时不得通过P0。

## 下一步

执行P0实施计划；P0 Gate通过后进入P1 Brainstorming。
```

`docs/07b2b/README.md` 固定提供四个索引：

```text
Target Specs
Implementation Plans
Research
Evidence
```

每个索引使用相对 Markdown 链接，明确 `specs → plans → evidence` 顺序，并把旧教程标记为 archive/draft，不作为执行入口。

- [ ] **Step 3: 初始化 Git** 👤

Run:

```powershell
Set-Location -LiteralPath 'D:\code\agent-learn\agent\Flowmate'
git init
git branch -M main
git status --short
```

Expected: Git 不再报告 `not a git repository`；输出中不包含 `.venv`、`__pycache__` 或 `.tmp-mineru-probe`。

- [ ] **Step 4: 执行密钥和真实数据检查** 👤

Run:

```powershell
git status --short
rg -n -i 'MINERU_API_TOKEN\s*=|API[_-]?KEY\s*=|PASSWORD\s*=|BEGIN PRIVATE KEY|Cookie:' . -g '!docs/**' -g '!tools/mineru-mcp-wrapper/README.md'
```

Expected: `git status` 不包含真实数据目录；`rg` 不返回真实密钥值。文档中出现的字段名称不是密钥值，可以保留。

- [ ] **Step 5: 建立基线提交** 👤

Run:

```powershell
git add .gitignore docs tools
git diff --cached --stat
git commit -m "docs: establish Flowmate P0 baseline"
```

Expected: commit 成功。若 Git 要求配置姓名或邮箱，只为当前仓库设置，不把账号密码写入配置。

---

### Task 1: 建立 npm workspace 和 TypeScript 测试基线

**Files:**

- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `packages/data-workbench/package.json`
- Create: `packages/data-workbench/README.md`
- Create: `packages/data-workbench/tsconfig.json`
- Create: `packages/data-workbench/tsconfig.build.json`
- Create: `packages/data-workbench/test/config.test.ts`
- Create: `packages/data-workbench/src/config.ts`

**Interfaces:**

- Consumes: Node.js、npm、固定数据根目录。
- Produces: `DataWorkbenchConfig`、根级 `lint/typecheck/test/build` 命令。

- [ ] **Step 1: 创建 workspace 配置文件** 🤖

根 `package.json`：

```json
{
  "name": "flowmate",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "lint": "npm run lint --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "build": "npm run build --workspaces --if-present",
    "data:init": "npm run data:init --workspace=@flowmate/data-workbench --",
    "data:discover": "npm run data:discover --workspace=@flowmate/data-workbench --",
    "data:acquire": "npm run data:acquire --workspace=@flowmate/data-workbench --",
    "data:catalog:flush": "npm run data:catalog:flush --workspace=@flowmate/data-workbench --",
    "data:publish": "npm run data:publish --workspace=@flowmate/data-workbench --",
    "data:backup": "npm run data:backup --workspace=@flowmate/data-workbench --",
    "data:restore:verify": "npm run data:restore:verify --workspace=@flowmate/data-workbench --"
  }
}
```

`packages/data-workbench/package.json`：

```json
{
  "name": "@flowmate/data-workbench",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "eslint src test",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "tsc -p tsconfig.build.json",
    "data:init": "tsx src/cli.ts init",
    "data:discover": "tsx src/cli.ts discover",
    "data:acquire": "tsx src/cli.ts acquire",
    "data:catalog:flush": "tsx src/cli.ts catalog-flush",
    "data:publish": "tsx src/cli.ts publish",
    "data:backup": "tsx src/cli.ts backup",
    "data:restore:verify": "tsx src/cli.ts restore-verify"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "yaml": "2.9.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@types/node": "24.13.3",
    "eslint": "10.9.1",
    "tsx": "4.23.12",
    "typescript": "6.0.3",
    "typescript-eslint": "8.68.0",
    "vitest": "4.1.11"
  }
}
```

根 `tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`packages/data-workbench/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`packages/data-workbench/tsconfig.build.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["test/**/*.ts"]
}
```

根 `eslint.config.mjs`：

```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/.venv/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
```

`npm install` 产生的 `package-lock.json` 是实际版本锁定依据；后续不得手工删除。

`packages/data-workbench/README.md` 必须包含：

```text
职责：P0采集、原始保存、MinerU解析、去重、Policy、Catalog、Release、Backup
非职责：Flowmate Runtime、生产OCR、企业最终验收
阶段位置：P0，P1硬前置
输入：SourcePolicy、OpenCLI结果、公开文件
输出：DatasetManifest、Obsidian卡片、Raw/Derived Archive
根命令：data:init/discover/acquire/catalog:flush/publish/backup/restore:verify
测试：npm test、lint、typecheck、build
安全：PUBLIC/read、200文件、MinerU云上传、无密钥
失败：停止条件和证据位置
下一步：P0 Spec和Plan链接
```

README 中列出的每条命令必须与 `package.json` scripts 完全一致。

- [ ] **Step 2: 写 Config 失败测试** 🤖

`packages/data-workbench/test/config.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("uses the approved FlowmateData root", () => {
    expect(resolveConfig({}).dataRoot).toBe(
      "D:\\code\\agent-learn\\agent\\FlowmateData",
    );
  });

  it("never allows a MinerU batch above 200", () => {
    expect(() =>
      resolveConfig({ FLOWMATE_MINERU_MAX_FILES_PER_RUN: "201" }),
    ).toThrow(/between 1 and 200/);
  });
});
```

- [ ] **Step 3: 安装依赖并确认 RED** 👤

Run:

```powershell
npm install
npm run test --workspace=@flowmate/data-workbench -- test/config.test.ts
```

Expected: FAIL，因为 `src/config.ts` 尚不存在。

- [ ] **Step 4: 实现最小 Config** 🤖

`packages/data-workbench/src/config.ts`：

```ts
import path from "node:path";

export interface DataWorkbenchConfig {
  dataRoot: string;
  mineruMaxFilesPerRun: number;
}

export function resolveConfig(
  env: Record<string, string | undefined>,
): DataWorkbenchConfig {
  const dataRoot = path.win32.normalize(
    env.FLOWMATE_DATA_ROOT ?? "D:\\code\\agent-learn\\agent\\FlowmateData",
  );
  const mineruMaxFilesPerRun = Number(
    env.FLOWMATE_MINERU_MAX_FILES_PER_RUN ?? "200",
  );
  if (!Number.isInteger(mineruMaxFilesPerRun) || mineruMaxFilesPerRun < 1 || mineruMaxFilesPerRun > 200) {
    throw new Error("FLOWMATE_MINERU_MAX_FILES_PER_RUN must be between 1 and 200");
  }
  return { dataRoot, mineruMaxFilesPerRun };
}
```

- [ ] **Step 5: 验证 GREEN 和 workspace 基线** 👤

Run:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: 所有命令退出码为 0，`package-lock.json` 存在。

- [ ] **Step 6: 提交** 👤

```powershell
git add package.json package-lock.json tsconfig.base.json eslint.config.mjs packages/data-workbench
git commit -m "chore: scaffold P0 data workbench"
```

---

### Task 2: 定义 P0 类型、Schema 和 ID 分配

**Files:**

- Create: `packages/data-workbench/src/types.ts`
- Create: `packages/data-workbench/src/schemas.ts`
- Create: `packages/data-workbench/src/ids.ts`
- Create: `packages/data-workbench/test/schemas.test.ts`
- Create: `packages/data-workbench/test/ids.test.ts`

**Interfaces:**

- Consumes: `DataWorkbenchConfig`。
- Produces: `SourcePolicy`、`AcquisitionJob`、`RawArtifactRef`、`ParsedDocument`、`DedupeDecision`、`PolicyDecision`、`CatalogEntryRef`、`DatasetManifest`、`IdAllocator`。

- [ ] **Step 1: 写 Schema 失败测试** 🤖

至少包含：

```ts
import { describe, expect, it } from "vitest";
import { datasetManifestSchema, sourcePolicySchema } from "../src/schemas.js";

describe("sourcePolicySchema", () => {
  it("rejects authenticated sources for P0 automatic acquisition", () => {
    const result = sourcePolicySchema.safeParse({
      sourceId: "SRC-000001",
      domain: "example.com",
      sourceType: "public_web",
      accessStrategy: "authenticated",
      sourcePolicy: "allowed",
      rawRetention: "allowed",
      datasetUsage: "allowed",
      synthetic: false,
      containsSyntheticIdentifiers: false,
      enabled: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("datasetManifestSchema", () => {
  it("rejects an item without a raw SHA-256", () => {
    const result = datasetManifestSchema.safeParse({
      schemaVersion: "1.0",
      datasetVersion: "dataset-v0.1",
      createdAt: "2026-08-26T12:00:00+08:00",
      sourcePolicyVersion: "1.0",
      items: [{ itemId: "SAMPLE-000001" }],
      checksumsRef: "checksums.sha256",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行并确认 RED** 👤

```powershell
npm run test --workspace=@flowmate/data-workbench -- test/schemas.test.ts
```

Expected: FAIL，因为 Schema 尚不存在。

- [ ] **Step 3: 实现类型和 Zod Schema** 🤖

必须使用 Spec 中的名称和值域，不得创建同义字段。核心定义：

```ts
export type AcquisitionJobStatus =
  | "CREATED"
  | "DISCOVERING_ADAPTER"
  | "FETCHING"
  | "STAGED"
  | "RAW_SAVED"
  | "PARSING"
  | "DEDUPLICATING"
  | "POLICY_CHECKING"
  | "CATALOGING"
  | "COMPLETED"
  | "ADAPTER_NOT_FOUND"
  | "FETCH_FAILED"
  | "PARSER_UNAVAILABLE"
  | "PARSE_FAILED"
  | "RESULT_DOWNLOAD_TLS_FAILED"
  | "BATCH_LIMIT_EXCEEDED"
  | "POLICY_REJECTED"
  | "CATALOG_WRITE_FAILED"
  | "CANCELLED";

export type ArtifactPipelineStatus =
  | "DISCOVERED"
  | "STAGED"
  | "RAW_SAVED"
  | "PARSED"
  | "DEDUPED"
  | "POLICY_PASSED"
  | "CATALOGED"
  | "RELEASED"
  | "DUPLICATE_URL"
  | "DUPLICATE_RAW"
  | "DUPLICATE_CONTENT"
  | "QUARANTINED_LICENSE"
  | "QUARANTINED_PRIVACY"
  | "QUARANTINED_QUALITY"
  | "UNSUPPORTED_FORMAT"
  | "CONTENT_DELETED_BY_POLICY"
  | "WITHDRAWN";
```

`types.ts` 同时固定以下 Interface：

```ts
export interface SourcePolicy {
  sourceId: string;
  domain: string;
  sourceType: "public_web" | "internal_business";
  accessStrategy: "public";
  sourcePolicy: "allowed" | "unknown" | "denied";
  rawRetention: "allowed" | "metadata_only" | "denied";
  datasetUsage: "allowed" | "denied";
  synthetic: boolean;
  containsSyntheticIdentifiers: boolean;
  enabled: boolean;
}

export interface AcquisitionJob {
  jobId: string;
  sourceId: string;
  objective: string;
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

export interface OpenCliCommandDescriptor {
  command: string;
  site: string;
  name: string;
  access: "read" | "write";
  strategy: string;
  browser: boolean;
}

export interface AcquisitionResult {
  jobId: string;
  adapterRef: string;
  strategy: "public";
  retrievedAt: string;
  items: unknown[];
  traceRef?: string;
}

export interface RawArtifactRef {
  artifactId: string;
  sourceIds: string[];
  acquisitionJobIds: string[];
  canonicalUrl?: string;
  rawRef?: string;
  rawSha256: string;
  mimeType: string;
  retentionStatus: "retained" | "metadata_only" | "deleted_by_policy";
}

export interface ParsedDocument {
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

export interface DedupeDecision {
  status: "unique" | "duplicate_url" | "duplicate_raw" | "duplicate_content" | "url_updated";
  canonicalArtifactId: string;
  relatedArtifactIds: string[];
}

export interface PolicyDecision {
  itemId: string;
  licenseStatus: "allowed" | "unknown" | "denied";
  privacyStatus: "passed" | "quarantined" | "delete_content";
  qualityStatus: "passed" | "quarantined";
  action: "catalog" | "quarantine" | "delete_content_keep_metadata";
  reasonCodes: string[];
  policyVersion: "p0-policy-1.0";
  decidedAt: string;
}

export interface CatalogEntryRef {
  entryId: string;
  entryType: "knowledge" | "public_sample" | "business_asset" | "quarantine" | "failure";
  noteRef: string;
  sourceId: string;
  artifactId?: string;
  pipelineStatus: string;
}

export interface DatasetManifestItem {
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
}

export interface DatasetManifest {
  schemaVersion: "1.0";
  datasetVersion: string;
  createdAt: string;
  sourcePolicyVersion: string;
  items: DatasetManifestItem[];
  checksumsRef: string;
}
```

`sourcePolicySchema` 必须只允许 `accessStrategy: "public"` 进入自动采集。

- [ ] **Step 4: 写 ID 失败测试** 🤖

测试必须证明：

```text
Source ID: SRC-000001
Artifact ID: ART-000001
Knowledge ID: KNOW-000001
Sample ID: SAMPLE-000001
Business ID: BIZ-000001
Job ID: ACQ-20260826-0001
```

并证明两个连续分配不会得到相同 ID。

- [ ] **Step 5: 实现原子 ID Allocator** 🤖

Interface：

```ts
export interface IdAllocator {
  next(kind: "source" | "artifact" | "knowledge" | "sample" | "business" | "acquisition"): Promise<string>;
}
```

计数写入 `<dataRoot>/manifests/id-counters.json`，通过“写临时文件 → rename”更新，禁止直接覆盖半写状态。

- [ ] **Step 6: 验证并提交** 👤

```powershell
npm run lint
npm run typecheck
npm test
git add packages/data-workbench/src packages/data-workbench/test
git commit -m "feat: define P0 data contracts"
```

---

### Task 3: 创建受控文件系统布局

**Files:**

- Create: `packages/data-workbench/src/filesystem-layout.ts`
- Create: `packages/data-workbench/test/filesystem-layout.test.ts`
- Create: `packages/data-workbench/src/cli.ts`
- Create at execution time: `D:\code\agent-learn\agent\FlowmateData\README.md`
- Create at execution time: `D:\code\agent-learn\agent\FlowmateData\vault\README.md`

**Interfaces:**

- Consumes: `DataWorkbenchConfig.dataRoot`。
- Produces: `DataPaths`、`initializeDataLayout(root)`、CLI `init`。

- [ ] **Step 1: 写失败测试** 🤖

使用 Vitest 的临时目录，断言创建以下相对路径：

```text
vault
staging
web-raw
derived/mineru
derived/html
derived/native
files/public
files/private-raw
files/private-sanitized
labels
manifests
releases
quarantine
failures
backups
```

测试同时断言重复运行不会删除已有文件。

测试还必须断言 `README.md` 和 `vault/README.md` 被创建，并且重复运行不覆盖用户后来追加的内容。

- [ ] **Step 2: 确认 RED** 👤

```powershell
npm run test --workspace=@flowmate/data-workbench -- test/filesystem-layout.test.ts
```

Expected: FAIL，缺少 `initializeDataLayout`。

- [ ] **Step 3: 实现布局初始化** 🤖

```ts
export interface DataPaths {
  root: string;
  vault: string;
  staging: string;
  webRaw: string;
  derivedMineru: string;
  manifests: string;
  releases: string;
  quarantine: string;
  failures: string;
  backups: string;
}

export async function initializeDataLayout(root: string): Promise<DataPaths>;
```

只能使用 `mkdir({ recursive: true })`，不得删除或清空目录。

`FlowmateData/README.md` 必须说明：

```text
目录职责和完整树
web-raw不可原地修改
private-raw禁止进入Git和未经批准的云服务
derived不是人工正确答案
quarantine不能发布
备份和恢复规则
数据删除与审计规则
```

`FlowmateData/vault/README.md` 必须说明：

```text
公开知识库
公开样本库
真实业务资产库
Source/Job/Release目录
Properties和ID规则
Bases入口
哪些文件保存在Vault外
```

- [ ] **Step 4: 实现 CLI `init` 并验证测试** 🤖

`cli.ts` 必须解析第一个位置参数；只有 `init` 分支调用 `initializeDataLayout`，未知命令退出码非 0。

最小实现形状：

```ts
import { parseArgs } from "node:util";
import { resolveConfig } from "./config.js";
import { initializeDataLayout } from "./filesystem-layout.js";

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [command] = positionals;
  if (command !== "init") {
    throw new Error(`Unknown data-workbench command: ${command ?? "<missing>"}`);
  }
  const config = resolveConfig(process.env);
  await initializeDataLayout(config.dataRoot);
  process.stdout.write(`${config.dataRoot}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
```

Run:

```powershell
npm run lint
npm run typecheck
npm test
```

- [ ] **Step 5: 第一次创建真实数据根目录** 👤

Run:

```powershell
npm run data:init
Get-ChildItem -LiteralPath 'D:\code\agent-learn\agent\FlowmateData'
```

Expected: 只出现 Spec 规定的目录。⛔ 若命令指向 `Flowmate` 源码目录，立即停止。

- [ ] **Step 6: 提交** 👤

```powershell
git add packages/data-workbench
git commit -m "feat: initialize P0 data layout"
```

---

### Task 4: 注册项目级 MinerU MCP 并验证原生 Tool

**Files:**

- Create: `.codex/config.toml`
- Inspect: `tools/mineru-mcp-wrapper/README.md`
- Inspect: `docs/07b2b/evidence/P0/mineru-mcp-spike.md`

**Interfaces:**

- Consumes: `flowmate-mineru-mcp` 包装层、进程环境中的 `MINERU_API_TOKEN`。
- Produces: 项目级 `mineru` MCP、`parse_documents`、`get_ocr_languages`、`maxItems=200`。

- [ ] **Step 1: 创建项目级配置** 🤖

`.codex/config.toml`：

```toml
[mcp_servers.mineru]
command = "uv"
args = [
  "run",
  "--project",
  "D:\\code\\agent-learn\\agent\\Flowmate\\tools\\mineru-mcp-wrapper",
  "flowmate-mineru-mcp",
  "--output-dir",
  "D:\\code\\agent-learn\\agent\\FlowmateData\\derived\\mineru"
]

[mcp_servers.mineru.env]
FLOWMATE_MINERU_MAX_FILES_PER_RUN = "200"
```

不要把 `MINERU_API_TOKEN` 写进文件；包装进程从已存在的进程环境继承。

- [ ] **Step 2: 解析 TOML 并确认用户级配置未修改** 👤

Run:

```powershell
python -c "import tomllib, pathlib; p=pathlib.Path(r'.codex/config.toml'); d=tomllib.loads(p.read_text(encoding='utf-8')); assert d['mcp_servers']['mineru']['command']=='uv'; assert d['mcp_servers']['mineru']['env']['FLOWMATE_MINERU_MAX_FILES_PER_RUN']=='200'; print('project-mcp-config-ok')"
git diff -- .codex/config.toml
```

Expected: `project-mcp-config-ok`。不得编辑 `C:\Users\yyc\.codex\config.toml`。

- [ ] **Step 3: 运行包装层回归** 👤

```powershell
Set-Location -LiteralPath 'D:\code\agent-learn\agent\Flowmate\tools\mineru-mcp-wrapper'
uv run --group dev pytest -q
```

Expected: `8 passed`。

- [ ] **Step 4: 重新打开 Flowmate Codex 会话** 👤

1. 确认 Flowmate 被标记为受信任项目。
2. 结束当前执行会话前保存进度。
3. 从 `D:\code\agent-learn\agent\Flowmate` 打开新 Codex 会话。
4. 让新会话列出 MinerU Tool。

Expected: 新会话可看到 `parse_documents` 和 `get_ocr_languages`；`parse_documents.file_sources.maxItems` 为 200。

⛔ 若 Tool 不出现，停止，不进入 Task 5；检查项目信任、路径和 Token 环境，但不修改用户级配置。

- [ ] **Step 5: 原生 Tool Smoke Test** 👤

在新会话使用公开文件：

```text
https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf
```

Expected:

```text
status = success
content = Dummy PDF file
success_count = 1
error_count = 0
```

该 W3C PDF 仅用于验证 MCP 包装层和项目级 Tool 注册，不写入 Obsidian、Raw Archive 或 Dataset Release，也不代表发票数据。

- [ ] **Step 6: 提交** 👤

```powershell
git add .codex/config.toml
git commit -m "chore: register project MinerU MCP wrapper"
```

---

### Task 5: 实现 OpenCLI 只读 Gateway

**Files:**

- Create: `packages/data-workbench/src/process-runner.ts`
- Create: `packages/data-workbench/src/opencli-gateway.ts`
- Create: `packages/data-workbench/test/fixtures/opencli-registry.json`
- Create: `packages/data-workbench/test/opencli-gateway.test.ts`
- Modify: `packages/data-workbench/src/cli.ts`

**Interfaces:**

- Consumes: 当前 `opencli list -f json` 注册表、显式 `SourcePolicy`、参数数组。
- Produces: `OpenCliCommandDescriptor`、`OpenCliAcquisitionRequest`、`AcquisitionResult`、CLI `discover`。

- [ ] **Step 1: 创建完整 Registry Fixture** 🤖

Fixture 至少包含两个真实形状的命令：

```json
[
  {
    "command": "brave/search",
    "site": "brave",
    "name": "search",
    "aliases": [],
    "description": "Search Brave Search",
    "access": "read",
    "strategy": "public",
    "browser": true,
    "args": [],
    "columns": ["rank", "title", "url", "snippet"]
  },
  {
    "command": "private-site/search",
    "site": "private-site",
    "name": "search",
    "aliases": [],
    "description": "Authenticated search",
    "access": "read",
    "strategy": "cookie",
    "browser": true,
    "args": [],
    "columns": ["title", "url"]
  }
]
```

- [ ] **Step 2: 写 Gateway 失败测试** 🤖

必须证明：

```ts
it("runs a discovered public read command with an argv array", async () => {
  const runner = new RecordingProcessRunner({ stdout: '[{"id":"1"}]', exitCode: 0 });
  const gateway = new OpenCliGateway(runner, registryFixture);

  const result = await gateway.runPublic({
    sourceId: "SRC-000001",
    site: "brave",
    command: "search",
    args: ["site:huggingface.co/datasets invoice OCR dataset license", "--limit", "10"],
  });

  expect(runner.lastCommand).toBe("opencli");
  expect(runner.lastArgs).toEqual([
    "brave", "search", "site:huggingface.co/datasets invoice OCR dataset license", "--limit", "10",
    "-f", "json", "--trace", "retain-on-failure",
  ]);
  expect(result.items).toEqual([{ id: "1" }]);
});

it("rejects cookie commands before spawning opencli", async () => {
  const runner = new RecordingProcessRunner({ stdout: "[]", exitCode: 0 });
  const gateway = new OpenCliGateway(runner, registryFixture);

  await expect(gateway.runPublic({
    sourceId: "SRC-000002",
    site: "private-site",
    command: "search",
    args: [],
  })).rejects.toThrow(/PUBLIC read/);

  expect(runner.callCount).toBe(0);
});
```

`RecordingProcessRunner` 放在 `test/helpers`，只模拟外部进程，不模拟 Gateway 逻辑。

- [ ] **Step 3: 运行并确认 RED** 👤

```powershell
npm run test --workspace=@flowmate/data-workbench -- test/opencli-gateway.test.ts
```

Expected: FAIL，缺少 `OpenCliGateway`。

- [ ] **Step 4: 实现 ProcessRunner 和 Gateway** 🤖

```ts
export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(command: string, args: string[]): Promise<ProcessResult>;
}

export interface OpenCliAcquisitionRequest {
  sourceId: string;
  site: string;
  command: string;
  args: string[];
}

export class OpenCliGateway {
  discover(): Promise<OpenCliCommandDescriptor[]>;
  runPublic(request: OpenCliAcquisitionRequest): Promise<AcquisitionResult>;
}
```

真实 ProcessRunner 使用 `node:child_process.spawn`，固定 `shell: false`。Gateway 必须先查找 `${site}/${command}`，再检查 `strategy === "public"` 和 `access === "read"`。每次调用都追加 `--trace retain-on-failure`；失败时把 OpenCLI 返回的 trace 路径写入 `AcquisitionResult.traceRef`，不得静默丢弃。

- [ ] **Step 5: 验证 GREEN** 👤

```powershell
npm run lint
npm run typecheck
npm test
```

- [ ] **Step 6: 真实发现和 Public Smoke Test** 👤

Run:

```powershell
opencli list -f json
opencli doctor
opencli brave search "site:huggingface.co/datasets invoice OCR dataset license" --limit 10 -f json
npm run data:discover
```

Expected: 四条命令成功；`brave/search` 的当前 Registry 显示 `strategy=public`、`access=read`。结果中包含 `Voxel51/high-quality-invoice-images-for-ocr`。

⛔ 若实际 Registry 不再满足条件，停止并更新 Source Policy，不改成登录态采集。

- [ ] **Step 7: 提交** 👤

```powershell
git add packages/data-workbench
git commit -m "feat: add public OpenCLI gateway"
```

---

### Task 6: 实现 Acquisition Job 和 Staging Receipt

**Files:**

- Create: `packages/data-workbench/src/acquisition-orchestrator.ts`
- Create: `packages/data-workbench/src/source-policy-repository.ts`
- Create: `packages/data-workbench/test/acquisition-orchestrator.test.ts`
- Create: `packages/data-workbench/test/source-policy-repository.test.ts`
- Modify: `packages/data-workbench/src/cli.ts`

**Interfaces:**

- Consumes: `IdAllocator`、`OpenCliGateway`、`DataPaths`、`SourcePolicy`。
- Produces: `AcquisitionJob`、`AcquisitionReceipt`、Staging JSON、CLI `acquire`。

- [ ] **Step 1: 写 Orchestrator 失败测试** 🤖

测试一个真实行为链：

```text
创建 ACQ ID
→ 状态 CREATED
→ 调用 Gateway
→ 保存 Staging receipt
→ 状态 STAGED
→ 统计 discovered
```

同时测试恢复：

```text
同一 jobId 在 STAGED 后失败
→ resume(jobId)
→ 复用已有 acquisition-result.json
→ 不再次调用 OpenCLI
→ 从下一恢复点继续
```

断言 receipt 含：

```json
{
  "jobId": "ACQ-20260826-0001",
  "sourceId": "SRC-000001",
  "adapterRef": "brave/search",
  "strategy": "public",
  "retrievedAt": "2026-08-26T12:00:00+08:00",
  "items": []
}
```

使用注入的固定 Clock；生产代码不得在测试中直接调用真实时间。

Clock Interface：

```ts
export interface Clock {
  now(): string;
}
```

- [ ] **Step 2: 写 Source Policy 失败测试** 🤖

Repository 从 `vault/10_Sources/SRC-000001.md` 读取 YAML frontmatter。测试必须证明：

- `enabled: false` 被拒绝；
- `access_strategy: authenticated` 被拒绝；
- 缺少 `raw_retention` 被 Schema 拒绝；
- `public + allowed + enabled` 可以加载。

- [ ] **Step 3: 确认 RED** 👤

```powershell
npm run test --workspace=@flowmate/data-workbench -- test/acquisition-orchestrator.test.ts test/source-policy-repository.test.ts
```

- [ ] **Step 4: 实现最小 Orchestrator** 🤖

```ts
export interface AcquisitionReceipt {
  jobId: string;
  sourceId: string;
  adapterRef: string;
  strategy: "public";
  retrievedAt: string;
  items: unknown[];
}

export class AcquisitionOrchestrator {
  run(request: OpenCliAcquisitionRequest): Promise<AcquisitionJob>;
  resume(jobId: string): Promise<AcquisitionJob>;
}
```

Receipt 写入：

```text
<dataRoot>/staging/<jobId>/acquisition-result.json
<dataRoot>/staging/<jobId>/job.json
```

文件更新必须“临时文件 → rename”。日志不得输出 OpenCLI Cookie、Token 或完整环境变量。

- [ ] **Step 5: 实现 CLI 参数** 🤖

使用 `node:util.parseArgs`，固定命令形状：

```powershell
npm run data:acquire -- --source-id SRC-000001 --site brave --command search --arg "site:huggingface.co/datasets invoice OCR dataset license" --arg "--limit" --arg "10"
```

未知 flag、缺少 source ID 或重复运行中的 Job 必须退出码非 0。

- [ ] **Step 6: 验证并提交** 👤

```powershell
npm run lint
npm run typecheck
npm test
git add packages/data-workbench
git commit -m "feat: stage OpenCLI acquisition jobs"
```

---

### Task 7: 实现 Raw Artifact Store 和三级去重

**Files:**

- Create: `packages/data-workbench/src/raw-artifact-store.ts`
- Create: `packages/data-workbench/src/public-file-downloader.ts`
- Create: `packages/data-workbench/src/dedupe-engine.ts`
- Create: `packages/data-workbench/test/raw-artifact-store.test.ts`
- Create: `packages/data-workbench/test/public-file-downloader.test.ts`
- Create: `packages/data-workbench/test/dedupe-engine.test.ts`
- Create: `scripts/download-public-file.ps1`

**Interfaces:**

- Consumes: Staging item、`IdAllocator`、Source Policy、文件系统、canonical URL。
- Produces: `RawArtifactRef`、`DedupeDecision`、不可变 `web-raw` 文件和关联记录。

- [ ] **Step 1: 写 Raw Store 失败测试** 🤖

测试必须证明：

- 新文件计算 SHA-256 并提升到 `web-raw`；
- 相同文件第二次写入不产生第二个二进制；
- 重复项追加新的 source ID 和 job ID；
- 已保存原始文件不会被覆盖；
- `retentionStatus=metadata_only` 时不保留正文。

Public File Downloader 测试必须证明：

- 只允许 `https`；
- URL 域名必须等于 Source Policy 的允许域名；
- 使用参数数组调用 PowerShell 脚本且 `shell: false`；
- PowerShell 下载失败不打印带 query 的完整 URL；
- 下载先写临时文件，成功后才 rename；
- 相同目标 hash 已存在时不重复下载。

- [ ] **Step 2: 写 Dedupe 失败测试** 🤖

覆盖手工推导的五个结果：

```text
unique
duplicate_url
url_updated
duplicate_raw
duplicate_content
```

标准化内容只做：统一换行、去除行尾空白、合并连续空白行、UTF-8；不做语义相似去重。

- [ ] **Step 3: 确认 RED** 👤

```powershell
npm run test --workspace=@flowmate/data-workbench -- test/raw-artifact-store.test.ts test/public-file-downloader.test.ts test/dedupe-engine.test.ts
```

- [ ] **Step 4: 实现 Raw Store** 🤖

```ts
export class RawArtifactStore {
  ingest(input: {
    sourceId: string;
    jobId: string;
    canonicalUrl?: string;
    stagedFile: string;
    mimeType: string;
    retentionStatus: RawArtifactRef["retentionStatus"];
  }): Promise<RawArtifactRef>;
}
```

Public File Downloader Interface：

```ts
export interface PublicFileDownloader {
  download(input: {
    url: string;
    allowedDomain: string;
    targetFile: string;
  }): Promise<{ fileRef: string; rawSha256: string }>;
}
```

实现通过 `ProcessRunner` 使用参数数组调用 `powershell.exe -NoProfile -File scripts/download-public-file.ps1`，固定 `shell: false`。只接受 `https` 和精确允许域名；不能在日志或错误中输出 URL query。

`scripts/download-public-file.ps1`：

```powershell
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$TargetFile
)

$targetFullPath = [IO.Path]::GetFullPath($TargetFile)
$targetDirectory = [IO.Path]::GetDirectoryName($targetFullPath)
[IO.Directory]::CreateDirectory($targetDirectory) | Out-Null
$temporaryFile = "$targetFullPath.download"

try {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $temporaryFile -TimeoutSec 120
  Move-Item -LiteralPath $temporaryFile -Destination $targetFullPath
} catch {
  if (Test-Path -LiteralPath $temporaryFile) {
    Remove-Item -LiteralPath $temporaryFile
  }
  throw "Public file download failed"
}
```

Node 侧在启动脚本前验证 `TargetFile` 解析后仍位于当前 Job 的 Staging 目录，防止路径穿越。PowerShell 脚本不把 URL 写入成功或失败输出。

目标目录：

```text
<dataRoot>/web-raw/<domain>/<jobId>/<artifactId>/
```

必须生成 `source.json`、`request.json`、`response.json`、`files/` 和 `checksums.sha256`。禁止把签名 URL 的 query 写入普通日志；Source receipt 中只保存允许的 canonical URL。

- [ ] **Step 5: 实现 Dedupe Engine** 🤖

```ts
export class DedupeEngine {
  decide(input: {
    canonicalUrl?: string;
    rawSha256: string;
    contentSha256?: string;
  }): Promise<DedupeDecision>;
}
```

索引写入 `<dataRoot>/manifests/dedupe-index.json`，采用原子更新。

- [ ] **Step 6: 验证并提交** 👤

```powershell
npm run lint
npm run typecheck
npm test
git add packages/data-workbench
git commit -m "feat: store and deduplicate raw artifacts"
```

---

### Task 8: 实现 MinerU MCP Client 和 Parser Router

**Files:**

- Create: `packages/data-workbench/src/mineru-mcp-client.ts`
- Create: `packages/data-workbench/src/parser-router.ts`
- Create: `packages/data-workbench/test/mineru-mcp-client.test.ts`
- Create: `packages/data-workbench/test/parser-router.test.ts`
- Create: `packages/data-workbench/test/fixtures/plain-document.txt`

**Interfaces:**

- Consumes: `RawArtifactRef`、`PublicFileDownloader`、项目 MinerU MCP、`DataWorkbenchConfig.mineruMaxFilesPerRun`。
- Produces: `DocumentParser`、`ParsedDocument`、MinerU/HTML/Native 派生目录。

- [ ] **Step 1: 写 201 文件失败测试** 🤖

```ts
it("rejects 201 files before connecting to MinerU", async () => {
  const transport = new RecordingMcpTransport();
  const client = new MineruMcpClient(transport, { maxFilesPerRun: 200 });
  const sources = Array.from({ length: 201 }, (_, index) => `document-${index}.pdf`);

  await expect(client.parseDocuments(sources)).rejects.toThrow(/maximum.*200/i);
  expect(transport.callCount).toBe(0);
});
```

- [ ] **Step 2: 写响应失败测试** 🤖

完整 fake response 必须镜像实际 MCP 结构：

```json
{
  "status": "success",
  "results": [
    {
      "filename": "dummy.pdf",
      "status": "success",
      "content": "Dummy PDF file",
      "content_chars": 14,
      "truncated": false
    }
  ],
  "summary": { "total_files": 1, "success_count": 1, "error_count": 0 },
  "message": "Parsing complete!\n"
}
```

该 `dummy.pdf` response 只用于测试 MCP 响应解析，不作为 P0 数据样本。

测试 success、partial_success、`RESULT_DOWNLOAD_TLS_FAILED` 和输出为空。

- [ ] **Step 3: 写 Router 失败测试** 🤖

断言：

```text
application/pdf → MinerU
image/png → MinerU
text/plain → NativeTextParser
text/markdown → NativeTextParser
text/html → HtmlContentParser
application/octet-stream → UNSUPPORTED_FORMAT
```

- [ ] **Step 4: 确认 RED** 👤

```powershell
npm run test --workspace=@flowmate/data-workbench -- test/mineru-mcp-client.test.ts test/parser-router.test.ts
```

- [ ] **Step 5: 实现 MinerU Client** 🤖

使用官方 MCP SDK：

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class MineruMcpClient {
  parseDocuments(fileSources: string[]): Promise<ParsedDocument[]>;
  close(): Promise<void>;
}
```

Transport 命令固定指向项目包装层：

```text
uv run --project D:\code\agent-learn\agent\Flowmate\tools\mineru-mcp-wrapper flowmate-mineru-mcp
```

不得读取或打印 `MINERU_API_TOKEN`。派生输出目录：

```text
<dataRoot>/derived/mineru/<artifactId>/<parserVersion>/
```

- [ ] **Step 6: 实现 Parser Router** 🤖

```ts
export interface DocumentParser {
  parse(input: ParseDocumentInput): Promise<ParsedDocument>;
}

export class ParserRouter {
  parserFor(mimeType: string): DocumentParser;
}
```

保存 `content.md`、`structure.json`、`metadata.json`、`images/` 和 `checksums.sha256`；单文件 Inline 结果也必须转成相同派生目录结构。

- [ ] **Step 7: 验证自动测试和真实集成** 👤

```powershell
npm run lint
npm run typecheck
npm test
```

然后让 Task 7 的 `PublicFileDownloader` 把 `https://huggingface.co/datasets/Voxel51/high-quality-invoice-images-for-ocr/resolve/main/data/batch1-0494.jpg` 下载到临时 Staging，再把本地文件路径交给 MinerU integration test。不要把 Hugging Face URL 直接交给 MinerU，因为已验证会返回区域访问限制。Expected: 输出非空并包含已知发票号 `84652373`，结果目录 hash 完整。正式 Raw Archive 关联在 Task 13 完成。

- [ ] **Step 8: 提交** 👤

```powershell
git add packages/data-workbench
git commit -m "feat: parse artifacts through MinerU MCP"
```

---

### Task 9: 实现自动 License、Privacy 和 Quality Gate

**Files:**

- Create: `packages/data-workbench/src/policy-engine.ts`
- Create: `packages/data-workbench/test/policy-engine.test.ts`
- Create: `packages/data-workbench/test/fixtures/policy-cases.json`

**Interfaces:**

- Consumes: `SourcePolicy`、`RawArtifactRef`、`ParsedDocument`。
- Produces: `PolicyDecision` 和 `catalog/quarantine/delete_content_keep_metadata` 动作。

- [ ] **Step 1: 创建完整 Policy Fixture** 🤖

Fixture 明确列出预期 action：

```json
[
  { "name": "allowed-public", "license": "allowed", "synthetic": false, "containsSyntheticIdentifiers": false, "text": "public invoice rule", "quality": "good", "want": "catalog" },
  { "name": "allowed-synthetic-invoice", "license": "allowed", "synthetic": true, "containsSyntheticIdentifiers": true, "text": "IBAN GB91YXO05542456978150 Tax Id 991-72-5826", "quality": "good", "want": "catalog" },
  { "name": "unknown-license", "license": "unknown", "synthetic": false, "containsSyntheticIdentifiers": false, "text": "content", "quality": "good", "want": "quarantine" },
  { "name": "denied-license", "license": "denied", "synthetic": false, "containsSyntheticIdentifiers": false, "text": "content", "quality": "good", "want": "delete_content_keep_metadata" },
  { "name": "api-key", "license": "allowed", "synthetic": false, "containsSyntheticIdentifiers": false, "text": "API_KEY=secret-value", "quality": "good", "want": "delete_content_keep_metadata" },
  { "name": "phone", "license": "allowed", "synthetic": false, "containsSyntheticIdentifiers": false, "text": "联系电话 13800138000", "quality": "good", "want": "quarantine" },
  { "name": "empty", "license": "allowed", "synthetic": false, "containsSyntheticIdentifiers": false, "text": "", "quality": "bad", "want": "quarantine" }
]
```

- [ ] **Step 2: 写失败测试** 🤖

逐行读取 Fixture，断言 `PolicyDecision.action` 等于手工给定的 `want`。额外断言 reason code 包括：

```text
SYNTHETIC_IDENTIFIERS_PRESENT
LICENSE_UNKNOWN
LICENSE_DENIED
SECRET_DETECTED
PHONE_DETECTED
CONTENT_EMPTY
```

- [ ] **Step 3: 确认 RED** 👤

```powershell
npm run test --workspace=@flowmate/data-workbench -- test/policy-engine.test.ts
```

- [ ] **Step 4: 实现确定性 Policy Engine** 🤖

```ts
export class PolicyEngine {
  evaluate(input: {
    itemId: string;
    sourcePolicy: SourcePolicy;
    rawArtifact: RawArtifactRef;
    parsedDocument: ParsedDocument;
  }): PolicyDecision;
}
```

Policy 版本固定记录为 `p0-policy-1.0`。第一版不让 LLM 决定许可或隐私；Source Policy 和确定性扫描结果是唯一依据。

`synthetic=true + containsSyntheticIdentifiers=true` 可以让许可证明确的合成发票进入 Catalog，但必须追加 `SYNTHETIC_IDENTIFIERS_PRESENT`，并禁止进入最终企业 acceptance split。真实或来源不明的手机号、银行账号和身份信息继续 quarantine/delete，不能靠调用参数伪装为 synthetic。

`delete_content_keep_metadata` 必须删除正文和文件引用，同时保留 URL、hash、时间、policyVersion 和 reasonCodes。

- [ ] **Step 5: 验证并提交** 👤

```powershell
npm run lint
npm run typecheck
npm test
git add packages/data-workbench
git commit -m "feat: enforce automatic P0 data policy"
```

---

### Task 10: 建立 Obsidian Vault、Catalog Outbox 和三类数据库

**Files:**

- Create: `packages/data-workbench/src/catalog-outbox.ts`
- Create: `packages/data-workbench/src/obsidian-catalog-writer.ts`
- Create: `packages/data-workbench/src/obsidian-templates.ts`
- Create: `packages/data-workbench/test/catalog-outbox.test.ts`
- Create: `packages/data-workbench/test/obsidian-catalog-writer.test.ts`
- Modify: `packages/data-workbench/src/cli.ts`
- Create at execution time: `D:\code\agent-learn\agent\FlowmateData\vault\90_Templates\*.md`

**Interfaces:**

- Consumes: `PolicyDecision(action="catalog")`、Source、Job、Artifact、ParsedDocument。
- Produces: `CatalogOutboxEntry`、原子 Markdown 写入、三个逻辑数据库、CLI `catalog-flush`。

- [ ] **Step 1: 写 Outbox 失败测试** 🤖

测试必须证明：

- 合格数据先进入 outbox；
- 相同 `entryId` 重试不会重复排队；
- flush 成功后状态为 `written`；
- Markdown 写入失败时条目保持 `pending`；
- `delete_content_keep_metadata` 不进入公开知识或样本目录。

- [ ] **Step 2: 写 Catalog Writer 失败测试** 🤖

测试使用临时 Vault，并断言：

```text
KNOW-* → 30_PublicKnowledge
SAMPLE-* → 40_PublicSamples
BIZ-* → 50_BusinessAssets
quarantine → 70_Quarantine
failure → 80_Failures
```

手工期望的知识卡片必须包含：

```yaml
---
knowledge_id: KNOW-000001
source_id: SRC-000001
artifact_id: ART-000001
license_status: allowed
privacy_status: passed
quality_status: passed
pipeline_status: cataloged
---
```

断言 Vault 内不复制原始 PDF，只写 `raw_ref` 和 `derived_ref`。

- [ ] **Step 3: 确认 RED** 👤

```powershell
npm run test --workspace=@flowmate/data-workbench -- test/catalog-outbox.test.ts test/obsidian-catalog-writer.test.ts
```

- [ ] **Step 4: 实现 Outbox 和 Writer** 🤖

```ts
export interface CatalogOutboxEntry {
  entryId: string;
  entryType: CatalogEntryRef["entryType"];
  payloadRef: string;
  status: "pending" | "written" | "failed";
  attempts: number;
  lastErrorCode?: string;
}

export class ObsidianCatalogWriter {
  flush(entries: CatalogOutboxEntry[]): Promise<CatalogEntryRef[]>;
}
```

Markdown 采用“临时文件 → rename”写入。任何 YAML 值都通过 `yaml` 包序列化，不用字符串拼接未转义的网页内容。

- [ ] **Step 5: 生成 Vault 目录和模板** 🤖

`data:init` 增加：

```text
00_Dashboard
10_Sources
20_AcquisitionJobs
30_PublicKnowledge
40_PublicSamples
50_BusinessAssets
60_DatasetReleases
70_Quarantine
80_Failures
90_Templates
```

模板必须严格采用 P0 Spec 的 Source、Acquisition Job、Public Knowledge、Public Sample、Business Asset 和 Dataset Release Schema。

- [ ] **Step 6: 验证 GREEN** 👤

```powershell
npm run lint
npm run typecheck
npm test
npm run data:init
```

Expected: Vault 结构和模板创建成功，重复执行不覆盖已有卡片。

- [ ] **Step 7: 打开 Obsidian 并验证 CLI** 👤

1. 启动 Obsidian。
2. 选择“打开文件夹作为仓库”。
3. 打开 `D:\code\agent-learn\agent\FlowmateData\vault`。
4. 启用 Core plugins：Properties、Templates、Bases。
5. 运行：

```powershell
opencli obsidian --help
obsidian help
```

Expected: 不再出现“unable to find Obsidian”。

- [ ] **Step 8: 创建 Bases 视图** 👤

使用 Obsidian UI 创建：

```text
公开知识：目录 30_PublicKnowledge，显示 knowledge_id/category/source_id/pipeline_status
公开样本：目录 40_PublicSamples，显示 sample_id/file_format/parser_version/scenarios/dataset_version
真实业务资产：目录 50_BusinessAssets，显示 business_asset_id/data_owner_role/authorization_status/business_review_status
Quarantine：目录 70_Quarantine，显示 reason_codes/source_id/artifact_id
Release：目录 60_DatasetReleases，显示 dataset_version/counts/status
```

⛔ 如果 Bases 无法持久保存或重新打开丢失，停止并记录 Obsidian 版本和错误。

- [ ] **Step 9: 提交源码，不提交 Vault** 👤

```powershell
git status --short
git add packages/data-workbench
git commit -m "feat: catalog approved data in Obsidian"
```

Expected: Git 输出不包含 `FlowmateData`。

---

### Task 11: 实现 Dataset Publisher

**Files:**

- Create: `packages/data-workbench/src/dataset-publisher.ts`
- Create: `packages/data-workbench/test/dataset-publisher.test.ts`
- Modify: `packages/data-workbench/src/cli.ts`

**Interfaces:**

- Consumes: `CATALOGED` entries、`DedupeDecision`、`PolicyDecision`、文件 hash。
- Produces: `manifest.json`、`checksums.sha256`、`release-notes.md`、Release 卡片、CLI `publish`。

- [ ] **Step 1: 写 Publisher 失败测试** 🤖

必须证明：

- 只包含 license/privacy/quality 全部通过的条目；
- quarantine 和 deleted 条目被排除；
- `duplicate_content` 默认只发布 canonical item；
- 缺少文件引用或 hash 时发布失败；
- 已存在的 `dataset-v0.1` 不能原地覆盖；
- 统计数字来自 Manifest，不接受手工数字；
- release notes 包含 policyVersion、parserVersion 和来源分布。

- [ ] **Step 2: 确认 RED** 👤

```powershell
npm run test --workspace=@flowmate/data-workbench -- test/dataset-publisher.test.ts
```

- [ ] **Step 3: 实现 Publisher** 🤖

```ts
export class DatasetPublisher {
  publish(input: {
    datasetVersion: string;
    items: CatalogEntryRef[];
  }): Promise<DatasetManifest>;
}
```

版本只接受：

```text
dataset-v0.<正整数>
dataset-v1.<非负整数>
```

输出：

```text
<dataRoot>/releases/<datasetVersion>/manifest.json
<dataRoot>/releases/<datasetVersion>/checksums.sha256
<dataRoot>/releases/<datasetVersion>/release-notes.md
```

发布成功后设置文件只读属性；发布失败时不得留下半成品版本目录。

- [ ] **Step 4: 实现 CLI `publish`** 🤖

固定命令：

```powershell
npm run data:publish -- --version dataset-v0.1
```

缺少版本、版本非法或目录已存在时退出码非 0。

- [ ] **Step 5: 验证并提交** 👤

```powershell
npm run lint
npm run typecheck
npm test
git add packages/data-workbench
git commit -m "feat: publish versioned P0 datasets"
```

---

### Task 12: 实现加密备份清单和隔离恢复验证

**Files:**

- Create: `packages/data-workbench/src/backup-service.ts`
- Create: `packages/data-workbench/test/backup-service.test.ts`
- Create: `scripts/backup-flowmate-data.ps1`
- Create: `scripts/verify-flowmate-data-restore.ps1`
- Modify: `packages/data-workbench/src/cli.ts`

**Interfaces:**

- Consumes: `DataPaths`、发布 Manifest、备份目标目录。
- Produces: 备份目录、`backup-manifest.json`、hash 校验、恢复报告。

- [ ] **Step 1: 写 Backup 失败测试** 🤖

测试临时数据根目录，证明：

- 包含 Vault、Raw、Derived、Manifest、Release、Quarantine 元数据；
- 排除 `.env`、Token、Cookie、密码文件；
- 每个备份文件有 SHA-256；
- 修改一个恢复文件后 verify 失败；
- 被 Policy 删除的正文不会从备份中重新出现；
- 源目录不存在时不创建“成功”备份。

- [ ] **Step 2: 确认 RED** 👤

```powershell
npm run test --workspace=@flowmate/data-workbench -- test/backup-service.test.ts
```

- [ ] **Step 3: 实现 Backup Service** 🤖

```ts
export class BackupService {
  createBackup(input: { sourceRoot: string; backupRoot: string }): Promise<BackupManifest>;
  verifyRestore(input: { restoredRoot: string; manifestRef: string }): Promise<RestoreReport>;
}
```

对应类型：

```ts
export interface BackupManifest {
  backupId: string;
  createdAt: string;
  sourceRoot: string;
  files: Array<{ relativePath: string; sha256: string; size: number }>;
}

export interface RestoreReport {
  status: "PASS" | "FAIL";
  checkedFiles: number;
  missingFiles: string[];
  hashMismatches: string[];
}
```

备份目录命名：

```text
backup-YYYYMMDD-HHmmss
```

文件复制完成后才原子写入 `backup-manifest.json`。没有 Manifest 的目录不能被视为有效备份。

- [ ] **Step 4: 创建 PowerShell 薄入口** 🤖

`backup-flowmate-data.ps1` 只负责设置工作目录并调用：

```powershell
npm run data:backup -- --backup-root 'D:\code\agent-learn\agent\FlowmateData\backups'
```

`verify-flowmate-data-restore.ps1` 调用：

```powershell
param(
  [Parameter(Mandatory = $true)][string]$RestoredRoot,
  [Parameter(Mandatory = $true)][string]$Manifest
)

npm run data:restore:verify -- --restored-root $RestoredRoot --manifest $Manifest
```

脚本必须使用参数对象和 `-LiteralPath`，不能拼接执行字符串。

- [ ] **Step 5: 验证 GREEN** 👤

```powershell
npm run lint
npm run typecheck
npm test
```

- [ ] **Step 6: 执行真实备份和隔离恢复** 👤

1. 创建备份。
2. 选择 `D:\code\agent-learn\agent\FlowmateData\restore-drill` 作为隔离恢复目录。
3. 恢复一份备份。
4. 运行 verify。
5. 用 Obsidian 打开恢复后的 Vault。
6. 检查 Source、Public Sample、Raw hash、MinerU 派生文件和 Dataset Manifest。
7. 用户提供一条不在工作数据同一物理磁盘上的加密备份路径，执行第二份备份并记录该路径的存储类型。

Expected: restore report 为 PASS。⛔ 未完成恢复验证不能进入 Task 13。

⛔ 如果没有第二块加密磁盘或批准的企业存储，Task 12 标记 FAIL，P0 不能通过 Gate；不得把同一磁盘的另一个目录伪装成第二份备份。

- [ ] **Step 7: 提交** 👤

```powershell
git add packages/data-workbench scripts
git commit -m "feat: back up and verify P0 data restores"
```

---

### Task 13: 运行 P0 端到端公开数据 Smoke Test

**Files:**

- Create: `packages/data-workbench/test/p0-smoke.integration.test.ts`
- Create external evidence: `D:\code\agent-learn\agent\FlowmateData\manifests\smoke-test-result.json`
- Create: `docs/07b2b/evidence/P0/p0-smoke-summary.md`
- Read: `docs/07b2b/research/公开发票数据源核验.md`

**Interfaces:**

- Consumes: P0 所有 Module、公开 Source Policy、OpenCLI、MinerU 包装层、Obsidian、Publisher、Backup。
- Produces: 两条公开数据的完整证据、`dataset-v0.1`、恢复证据。

- [ ] **Step 1: 创建两个 Source Policy** 🤖

```text
SRC-000001：search.brave.com，public/read，discovery only，dataset_usage=denied，raw_retention=metadata_only
SRC-000002：huggingface.co，public/read，source_policy=allowed，raw_retention=allowed，dataset_usage=allowed
```

`SRC-000002` 额外固定：

```yaml
dataset_id: Voxel51/high-quality-invoice-images-for-ocr
license: odbl
synthetic: true
contains_synthetic_identifiers: true
allowed_sample_limit: 1
```

Source 卡片必须写入 `vault/10_Sources`，不使用登录态。

- [ ] **Step 2: 写 Smoke 集成测试** 🤖

测试使用环境开关 `FLOWMATE_RUN_LIVE_SMOKE=1` 才运行真实网络；默认测试套件跳过 live 部分但继续运行 Fixture integration。

Live 流程：

```text
OpenCLI brave/search 搜索 Hugging Face 发票数据集
→ Staging
→ 找到 Voxel51/high-quality-invoice-images-for-ocr
→ 保存 Dataset Card、Hugging Face API 元数据和 Kaggle 许可元数据
→ 从 samples.json 定位 data/batch1-0494.jpg 的 JSON annotation
→ Public HTTPS 下载一张合成发票到 Staging
→ Raw JPEG Artifact
→ MinerU MCP
→ Dedupe
→ Policy
→ Public Sample Card
```

不能下载整个约 2.39 GB 数据集。P0 Smoke 的 `allowed_sample_limit` 固定为 1，且一次 MinerU 调用仍受 200 文件硬上限保护。

公开 PDF 原始文件必须保存到 `web-raw`；不能只保存 MinerU Markdown。

- [ ] **Step 3: 验证受控 Public File Downloader** 🤖

确认 Task 7 的 `PublicFileDownloader` 被端到端流程真实调用，并且 `data/batch1-0494.jpg` 先保存到 Staging、计算 hash，再提升到 `web-raw`。Dataset Card、API 元数据、`samples.json` 中对应 annotation、图片和 MinerU 派生内容都要有关联 hash；不得让 MinerU 直接成为唯一文件来源。

- [ ] **Step 4: 运行完整自动测试** 👤

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: 全部通过。

- [ ] **Step 5: 运行 Live Smoke** 👤

```powershell
$env:FLOWMATE_RUN_LIVE_SMOKE='1'
npm run test --workspace=@flowmate/data-workbench -- test/p0-smoke.integration.test.ts
Remove-Item Env:FLOWMATE_RUN_LIVE_SMOKE
```

Expected:

```text
OpenCLI public acquisition = success
MinerU parse = success
invoice image = data/batch1-0494.jpg
invoice number expected = 84652373
MinerU content contains invoice number = true
annotation linked = true
duplicate raw files = 0
policy rejected items = 0
cataloged knowledge >= 1
cataloged public samples = 1
```

若 MinerU 没有提取出已知发票号 `84652373`，Smoke Test 标记 FAIL；不能把 annotation 值偷偷覆盖为 MinerU 输出。

- [ ] **Step 6: 证明去重** 👤

再次运行相同 Live Smoke。Expected:

```text
new binary files = 0
duplicate_url or duplicate_raw >= 1
existing Artifact reused = true
```

- [ ] **Step 7: 发布 dataset-v0.1** 👤

```powershell
npm run data:catalog:flush
npm run data:publish -- --version dataset-v0.1
```

Expected: Manifest、checksums、release notes 和 Obsidian Release 卡片存在，内容只含通过 Policy 的 canonical items。

- [ ] **Step 8: 备份与恢复** 👤

执行 Task 12 的真实备份和隔离恢复。把实际结果写入 `docs/07b2b/evidence/P0/p0-smoke-summary.md`，不复制签名 URL、Token 或未脱敏内容。

- [ ] **Step 9: 提交** 👤

```powershell
git add packages/data-workbench docs/07b2b/evidence/P0
git commit -m "test: prove P0 data workbench end to end"
```

---

### Task 14: 执行 P0 Gate Review

**Files:**

- Create: `docs/07b2b/evidence/P0/gate-review.md`
- Inspect: `README.md`
- Inspect: `docs/07b2b/README.md`
- Inspect: `packages/data-workbench/README.md`
- Inspect: `tools/mineru-mcp-wrapper/README.md`
- Inspect: `D:\code\agent-learn\agent\FlowmateData\README.md`
- Inspect: `D:\code\agent-learn\agent\FlowmateData\vault\README.md`
- Inspect: `docs/07b2b/specs/P0_Obsidian数据库目标方案.md`
- Inspect: `D:\code\agent-learn\agent\FlowmateData\releases\dataset-v0.1\manifest.json`
- Inspect: 最新 `backup-manifest.json`

**Interfaces:**

- Consumes: 所有测试输出、真实 Smoke、Dataset、备份恢复证据。
- Produces: P0 PASS/FAIL 结论；只有 PASS 才允许 P1 brainstorming。

- [ ] **Step 1: 运行最终命令集** 👤

```powershell
Set-Location -LiteralPath 'D:\code\agent-learn\agent\Flowmate'
npm run lint
npm run typecheck
npm test
npm run build
Set-Location -LiteralPath 'D:\code\agent-learn\agent\Flowmate\tools\mineru-mcp-wrapper'
uv run --group dev pytest -q
```

Expected: 所有命令退出码为 0；MinerU wrapper 为 `8 passed` 或更多，不允许减少测试数。

- [ ] **Step 2: 检查密钥和数据泄漏** 👤

```powershell
Set-Location -LiteralPath 'D:\code\agent-learn\agent\Flowmate'
git status --short
git ls-files | rg 'FlowmateData|web-raw|private-raw|\.env$|auth\.json|\.pem$|\.key$'
rg -n -i 'MINERU_API_TOKEN\s*=|BEGIN PRIVATE KEY|Cookie:' . -g '!docs/**' -g '!tools/mineru-mcp-wrapper/README.md'
```

Expected: Git 跟踪文件中没有数据目录、凭证和密钥值。

- [ ] **Step 3: 执行 README Gate** 👤

Run:

```powershell
$requiredReadmes = @(
  'D:\code\agent-learn\agent\Flowmate\README.md',
  'D:\code\agent-learn\agent\Flowmate\docs\07b2b\README.md',
  'D:\code\agent-learn\agent\Flowmate\packages\data-workbench\README.md',
  'D:\code\agent-learn\agent\Flowmate\tools\mineru-mcp-wrapper\README.md',
  'D:\code\agent-learn\agent\FlowmateData\README.md',
  'D:\code\agent-learn\agent\FlowmateData\vault\README.md'
)
$missingReadmes = @($requiredReadmes | Where-Object { -not (Test-Path -LiteralPath $_) })
if ($missingReadmes.Count -gt 0) { throw "Missing README: $($missingReadmes -join ', ')" }
```

人工核对每份 README 都包含：职责、非职责、阶段、Interface、依赖、命令、测试、安全、失败、停止条件、下一文档。运行 README 中列出的命令，确认与实际 `package.json` 和 CLI 一致。

Expected: 六份 README 全部存在且命令可执行；README 不含 Token、Cookie、密码和真实数据。

- [ ] **Step 4: 逐项核对 P0 完成标准** 👤

`gate-review.md` 必须逐条列出 Spec 第 20 节的每项条件，并附：

```text
PASS/FAIL
验证命令
输出摘要
证据路径
执行日期
已知限制
```

不得用“已完成”替代证据。

- [ ] **Step 5: 确认 P0 不越界** 👤

确认没有：

- 定时采集；
- 登录态 Adapter；
- 向量数据库；
- Web 管理后台；
- Electron/Pi 产品开发；
- 最终企业验收集；
- 用户级 MCP 配置修改。

- [ ] **Step 6: 写 Gate 结论** 👤

只有所有条件有证据且为 PASS 时写：

```text
P0_GATE_STATUS=PASS
NEXT_ALLOWED_ACTION=P1_BRAINSTORMING
```

任一条件失败时写：

```text
P0_GATE_STATUS=FAIL
NEXT_ALLOWED_ACTION=FIX_P0_ONLY
```

- [ ] **Step 7: 最终提交** 👤

```powershell
git add docs/07b2b/evidence/P0
git commit -m "docs: record P0 gate review"
git status --short
```

Expected: 工作区干净。P0 PASS 后仍不能直接实现 P1；下一步必须先执行 P1 brainstorming 和 P1 Target Design。

---

## 计划执行停止条件

出现以下任一情况立即停止当前 Task：

- 命令路径不在 `Flowmate` 或 `FlowmateData`；
- 测试未先失败就准备实现新行为；
- `MINERU_API_TOKEN`、Cookie 或密码出现在文件或输出；
- OpenCLI 命令不是 `PUBLIC + read`；
- 真实企业数据准备上传 MinerU，但没有明确授权；
- 201 份文件到达 MinerU 网络调用；
- 原始网络文件没有保存 hash；
- Quarantine 数据进入 Dataset Release；
- 重复采集产生第二份相同二进制；
- 备份没有完成恢复验证；
- 用户级 Codex 配置被修改；
- 当前 Task 的验证失败。

## Spec 覆盖矩阵

| P0 Spec 要求 | 实施 Task | 验证证据 |
|---|---|---|
| 固定数据根目录和仓库隔离 | 0、3 | Git 文件清单、目录检查 |
| README 导航和子项目说明 | 0、1、3、14 | README Gate |
| npm workspaces 和 TypeScript 工具 | 1 | lint/typecheck/test/build |
| 统一类型、Schema、状态和 ID | 2 | Schema 与 ID 测试 |
| 物理目录结构 | 3 | 临时目录测试、真实目录检查 |
| 项目级 MinerU MCP，不改用户配置 | 4 | TOML 解析、新会话 Tool List |
| 单次最多 200 份文件 | 4、8 | maxItems=200、201 项拒绝测试 |
| OpenCLI 动态发现、PUBLIC/read 限制 | 5 | Registry Fixture、真实发票数据集搜索 |
| Acquisition Job 和 Staging Receipt | 6 | Orchestrator 测试、Job JSON |
| 网络原始文件保存 | 7、13 | web-raw 文件和 checksums |
| URL/Raw/Content 三级去重 | 7 | Dedupe 测试、重复 Smoke |
| MinerU/Native/HTML Parser | 8、13 | Router 测试、合成发票图片真实解析 |
| MinerU 云上传限制 | 4、8、14 | Source Policy、Gate Review |
| 自动 License/Privacy/Quality Gate | 9 | Policy Fixture 测试 |
| 无逐条人工批准直接入库 | 9、10 | action=catalog、Outbox flush |
| Obsidian 三个逻辑数据库 | 10 | Vault、Templates、Bases |
| Dataset Manifest 和不可变 Release | 11 | Publisher 测试、dataset-v0.1 |
| 备份和隔离恢复 | 12 | backup manifest、restore report |
| 完整公开数据闭环 | 13 | p0-smoke-summary.md |
| P0 完成门和非目标 | 14 | gate-review.md |

## 完成后状态

P0 实施计划执行完毕并不自动表示 P0 通过。只有 `gate-review.md` 记录 `P0_GATE_STATUS=PASS`，且证据可以重新验证，才能开始 P1 brainstorming。
