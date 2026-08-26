# B 真实发票与 OCR 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 用真实 PDF、OFD 和图片替换 Mock 发票输入，并用可替换 OCR/解析 Provider 生成经过校验和人工复核的标准字段。

**Architecture:** 原生结构化数据优先，随后是 PDF 文本层、专业发票 OCR、本地 OCR，LLM Vision 只作受控 fallback。07B2B 继续使用本地 Mock Web。

**Tech Stack:** TypeScript、Zod、PDF/OFD Parser、OCRProvider、Playwright、DATA-02 数据集。

**Spec:** [A 阶段](A_全Mock闭环_MVP手把手开发教程.md)、[DATA-02](DATA-02_真实数据采集脱敏与标注教程.md)

## Global Constraints

- 业务核心不能依赖某个 OCR 厂商字段名；
- 数字金额不以 LLM Vision 作为唯一来源；
- 原始真实文件不进入 Git；
- 每个字段保存 value、confidence、source 和修正记录；
- 低置信度和规则冲突必须进入人工复核；
- 最终评估只使用明确的数据集版本。

---

## 进入条件

```text
[ ] A 阶段验收通过
[ ] DATA-01 完成
[ ] DATA-02 至少有 100 张真实脱敏发票及人工正确答案
[ ] 已确认 OCR 服务的数据处理和隐私许可
[ ] 数据文件从 D:\code\agent-learn\agent\FlowmateData 读取，不复制进仓库
```

## Task B1：定义文档和 OCR Contract

**Files:**

- Create: `packages/adapters/src/document-source.ts`
- Create: `packages/adapters/src/ocr-provider.ts`
- Create: `packages/domain/src/invoice-extraction.ts`
- Test: `packages/adapters/test/ocr-contract.test.ts`

**Interfaces:**

```ts
export interface OCRProvider {
  recognize(input: DocumentInput): Promise<InvoiceExtraction>;
}

export interface ExtractedField<T> {
  value: T | null;
  confidence: number;
  source: string;
  rawValue?: string;
}
```

- [ ] 🤖 使用 Zod 验证所有 Provider 输出。
- [ ] 🤖 保留 MockOCRProvider 作为回归 Adapter。
- [ ] 🤖 Contract 测试对 Mock 和真实 Provider 使用同一组断言。
- [ ] 👤 保存点：`feat: define document and ocr contracts`。

## Task B2：文件导入和安全检查

**Files:**

- Create: `apps/desktop/src/main/document-import-service.ts`
- Create: `apps/desktop/src/renderer/components/InvoiceUpload.tsx`
- Test: `apps/desktop/test/document-import-service.test.ts`

- [ ] 🤖 只允许 PDF、OFD、PNG、JPG 和业务确认需要的 XML。
- [ ] 🤖 检查扩展名、MIME、大小、hash 和重复文件。
- [ ] 🤖 拒绝路径穿越和伪装扩展名。
- [ ] 🤖 文件复制到受控工作目录时记录来源 hash，不修改原始文件。
- [ ] 👤 分别导入一种受支持文件和一种禁止文件，检查结果。
- [ ] 👤 保存点：`feat: import invoice documents safely`。

## Task B3：实现解析优先级

**Files:**

- Create: `packages/adapters/src/parsers/xml-invoice-parser.ts`
- Create: `packages/adapters/src/parsers/ofd-invoice-parser.ts`
- Create: `packages/adapters/src/parsers/pdf-text-parser.ts`
- Create: `packages/adapters/src/ocr/primary-ocr-provider.ts`
- Create: `packages/adapters/src/extraction-router.ts`
- Test: `packages/adapters/test/extraction-router.test.ts`

固定路由：

```text
XML/OFD 结构化字段
→ PDF Text Layer
→ 获准的专业发票 OCR
→ 本地 OCR
→ 获准的 LLM Vision fallback
```

- [ ] 🤖 路由记录实际命中的 source 和 fallback 原因。
- [ ] 🤖 单个 Provider 失败不能丢失 Job，应生成可恢复错误或 Review。
- [ ] 👤 使用每种真实存在的文件类型运行一次。
- [ ] 👤 保存点：`feat: route invoice extraction providers`。

## Task B4：标准化和确定性校验

**Files:**

- Create: `packages/domain/src/invoice-normalizer.ts`
- Create: `packages/domain/src/invoice-rules.ts`
- Test: `packages/domain/test/invoice-rules.test.ts`

至少实现：

- 金额、税额、价税合计关系；
- 税号格式；
- 日期合法性；
- 币种；
- 必填字段；
- 重复票；
- 红字/作废标记；
- 供应商名称和税号一致性。

- [ ] 🤖 金额使用 Decimal 或整数最小货币单位，不使用裸 JavaScript 浮点数比较。
- [ ] 🤖 每条规则输出 ruleId、pass/fail、severity 和解释。
- [ ] 👤 保存点：`feat: normalize and validate invoice fields`。

## Task B5：OCR 调试与人工复核页

**Files:**

- Create: `apps/desktop/src/renderer/pages/OcrReviewPage.tsx`
- Create: `apps/desktop/src/main/review-service.ts`
- Test: `apps/desktop/e2e/ocr-review.spec.ts`

页面并排显示：原始文件、原始字段、标准字段、confidence、source、规则错误、人工修正值。

- [ ] 🤖 保存 before、after、reason、时间和操作者角色。
- [ ] 🤖 人工修正不覆盖原始 OCR 结果。
- [ ] 👤 完成一个低置信度和一个金额冲突案例的复核。
- [ ] 👤 保存点：`feat: add ocr review workflow`。

## Task B6：本地 Mock B2B Web

**Files:**

- Create: `apps/mock-b2b/`
- Create: `packages/adapters/src/mock-web/playwright-b2b-adapter.ts`
- Test: `apps/desktop/e2e/mock-b2b-browser.spec.ts`

Mock Web 必须模拟：登录、导航、搜索、表单、下拉框、表格、Loading、Toast、Timeout、成功和错误。

- [ ] 🤖 Playwright 使用 role、label、text 或稳定 test id，不使用坐标点击。
- [ ] 🤖 测试 Timeout 和 Unknown Commit 页面。
- [ ] 👤 观看一次真实浏览器自动填表过程。
- [ ] 👤 保存点：`feat: automate realistic mock b2b web`。

## Task B7：真实数据集评估

**Files:**

- Create: `packages/evals/src/ocr-eval.ts`
- Create: `packages/evals/test/ocr-eval.test.ts`
- Modify: root `package.json` 增加 `eval:ocr`

运行：

```powershell
npm run eval:ocr -- --dataset dataset-v0.1 --split regression
```

报告至少包含每字段准确率、文件类型、Provider、异常类型、失败 Case ID、平均耗时和人工介入率。

- [ ] 👤 确认报告不输出完整敏感字段。
- [ ] 👤 对每个失败类别建立 Issue 或故障记录。
- [ ] 👤 保存点：`feat: evaluate ocr against versioned dataset`。

## B 阶段验收

```text
[ ] 真实 PDF/OFD/图片可批量导入
[ ] OCR Adapter 可替换
[ ] 字段来源和 confidence 可追踪
[ ] 低置信度进入人工复核
[ ] 关键数字字段准确率达到业务确认的阶段门，目标 ≥ 98%
[ ] 真实发票 → OCR → Normalize → Validate → Mock B2B E2E ≥ 95%
[ ] 数据集版本和 split 写入报告
[ ] 真实数据未进入 Git 和普通日志
[ ] `npm run lint`、`npm run typecheck`、`npm run test`、`npm run test:e2e`、`npm run build` 全通过
```

证据写入 `docs/07b2b/evidence/phase-b/summary.md`。全部通过后进入阶段 C。
