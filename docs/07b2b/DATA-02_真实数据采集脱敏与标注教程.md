# DATA-02 真实数据采集、脱敏与标注教程

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 获取经过授权的真实业务数据，形成可追踪、可复核的发票案例和人工正确答案。

**Architecture:** 原始数据只读保存；脱敏副本用于获准的开发活动；标注结果使用结构化 JSON；Obsidian 记录来源、授权、案例状态和业务复核。

**Tech Stack:** Obsidian、JSON、SHA-256、加密文件存储、后续阶段提供的 TypeScript 数据工具。

**Spec:** [项目总导航](00_从这里开始_项目总导航.md)

## Global Constraints

- 开发者不能替代数据 Owner 批准用途；
- 自己制作的数据只能标记为 `synthetic`，不能进入最终验收集；
- 原始数据只读，所有处理使用副本；
- 脱敏必须保留版式、字段位置、图像质量和业务异常特征；
- 业务正确答案必须由实际业务人员或权威系统结果确认。

---

## Task 1：发送数据申请

🏢 分别向财务 AP、采购/ERP、07B2B Owner、IT/安全提出申请。可复制下面的文本：

```text
项目：Flowmate 07B2B 发票录入数字员工

申请用途：开发、离线评估和受控试点。数据仅存放在公司批准的加密设备，不进入公开仓库，不上传到未经批准的第三方服务。

本次申请：
1. 脱敏历史发票及对应人工最终录入结果；
2. 供应商、PO、收货等关联数据样例；
3. 过去 3～6 个月需要人工特殊处理的异常案例；
4. 07B2B 操作 SOP、测试环境、测试账号和自动化访问规则；
5. 字段定义、审批规则和错误处理规则。

请同时确认：允许用途、允许保存期限、传输方式、脱敏责任、可访问人员、是否允许调用外部 OCR/LLM，以及删除要求。
```

- [ ] 在 Obsidian 为每个来源创建 DataSource 卡片。
- [ ] 把审批结果和允许用途写入卡片。
- [ ] 不把审批邮件正文中的敏感内容复制进代码仓库。

## Task 2：第一批数据规模

阶段 B 开始前的最低目标：

```text
真实脱敏发票：100 张以上
人工正确字段：每张都有
主要文件类型：PDF、OFD、PNG/JPG 至少覆盖实际存在的类型
正常案例：不能超过总集的 80%
异常案例：至少 20 张
供应商样例：覆盖明确匹配、无匹配、多匹配
PO 样例：覆盖存在、不存在、余额不足、币种或税率异常
```

如果只能取得 20 张，可以用于开发验证，但不能宣称 OCR 指标具有生产代表性。

最终 Shadow 前建议达到 500 张以上，并覆盖真实业务月份、供应商、票种和异常分布。

## Task 3：原始文件入库

👤 每批数据创建批次目录：

```text
D:\code\agent-learn\agent\FlowmateData\files\raw\BATCH-20260825-001\
```

保留数据 Owner 提供的原始文件名映射，但正式 Case ID 使用 `INV-000001` 形式。

计算 SHA-256：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\code\agent-learn\agent\FlowmateData\files\raw\BATCH-20260825-001\sample.pdf'
```

- [ ] 把 hash 记录到对应 Obsidian 案例卡片。
- [ ] 相同 hash 不创建第二个案例，改为记录重复来源。
- [ ] 设置原始目录为只读或通过流程约定禁止修改。

## Task 4：脱敏

脱敏副本放入：

```text
D:\code\agent-learn\agent\FlowmateData\files\sanitized\INV-000001.pdf
```

必须检查的敏感信息包括：

- 公司和个人联系信息；
- 银行账号；
- 地址、电话、邮箱；
- 个人姓名或员工编号；
- 系统账号、二维码、条形码；
- 可访问生产系统的 URL 参数；
- 业务不允许外发的金额、合同和组织信息。

👤 脱敏后逐页打开检查。仅覆盖视觉文字不一定会删除 PDF 文本层，必须确认复制文字、搜索文字和文件元数据也不泄露原值。

无法确认安全的文件只允许在公司批准的本地模型或内部服务中使用。

## Task 5：建立人工正确答案

每张发票创建：

```text
D:\code\agent-learn\agent\FlowmateData\labels\INV-000001.expected.json
```

统一结构：

```json
{
  "schemaVersion": "1.0",
  "caseId": "INV-000001",
  "invoice": {
    "invoiceNumber": "12345678",
    "invoiceDate": "2026-08-01",
    "sellerName": "脱敏供应商A",
    "sellerTaxId": "SANITIZED-TAX-ID-A",
    "buyerName": "脱敏购买方A",
    "buyerTaxId": "SANITIZED-TAX-ID-B",
    "amount": "100.00",
    "taxAmount": "13.00",
    "totalAmount": "113.00",
    "currency": "CNY",
    "invoiceType": "vat_normal"
  },
  "business": {
    "expectedSupplierCode": "VENDOR-A",
    "expectedPoNumber": "PO-DEMO-001",
    "expectedDecision": "ready_to_submit"
  },
  "review": {
    "source": "human_final_result",
    "reviewStatus": "approved",
    "reviewedDate": "2026-08-25"
  }
}
```

金额使用字符串保存，避免浮点数误差。日期统一为 `YYYY-MM-DD`。

## Task 6：标注异常分类

每个案例至少选择一个场景：

```text
normal
low_quality_scan
rotated_image
multi_page
multiple_tax_rates
red_invoice
duplicate_invoice
void_invoice
missing_field
amount_mismatch
supplier_not_found
supplier_ambiguous
po_not_found
po_insufficient_balance
permission_denied
captcha_or_mfa
unknown_commit
erp_writeback_failed
```

遇到列表外异常时，可以增加新分类，但必须在 `03_BusinessRules/异常分类.md` 中解释判断标准。

## Task 7：业务复核

🏢 让实际做发票录入的业务人员抽查并确认：

- 字段答案正确；
- 供应商和 PO 匹配正确；
- 正常/异常分类正确；
- 预期处理决策符合 SOP；
- 数据可用于约定的开发或测试用途。

如果只有你自己填写答案，Obsidian 状态只能是：

```text
label_status: complete
business_review_status: not_reviewed
```

这种案例可用于调试，不能进入最终验收集。

## Task 8：构建数据导入工具的实施要求

阶段 A 工程建立后，由 AI 在仓库内实现：

```text
packages/data-tools/
├─ src/import-case.ts
├─ src/hash-file.ts
├─ src/validate-label.ts
└─ test/
```

工具接口固定为：

```text
npm run data:import -- --source <文件> --case-id INV-000001
npm run data:validate -- --case-id INV-000001
```

工具必须：

- 拒绝重复 Case ID；
- 计算并保存 SHA-256；
- 不覆盖原始文件；
- 检查 expected.json 必填字段；
- 检查 amount + taxAmount = totalAmount；
- 输出机器可读错误；
- 不把真实数据复制到仓库。

## DATA-02 退出条件

```text
[ ] 每个来源都有授权记录
[ ] 原始文件只读保存
[ ] 每张发票有唯一 Case ID 和 hash
[ ] 每张发票有 expected.json
[ ] 异常类型已标注
[ ] 业务复核状态真实可信
[ ] 至少 100 张可用于阶段 B 的真实脱敏样本
[ ] 真实数据未进入 Git
[ ] 数据导入和校验需求已固定
```

达到阶段 B 最低数量后可以推进产品阶段 B；继续收集数据，直到满足 DATA-03 发布条件。
