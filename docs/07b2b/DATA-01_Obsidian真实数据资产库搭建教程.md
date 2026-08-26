# DATA-01 Obsidian 真实数据资产库搭建教程

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 建立一个不参与生产事务、只用于登记和管理真实数据资产的 Obsidian 工作台。

**Architecture:** Obsidian 保存数据卡片和属性；真实文件、JSON 标注和发布数据集存放在 Vault 外的加密目录；卡片只通过 Case ID、相对路径和 hash 引用文件。

**Tech Stack:** Obsidian、Bases、Markdown Properties、Windows 加密磁盘、JSON。

**Spec:** [项目总导航](00_从这里开始_项目总导航.md)

## Global Constraints

- Vault 不进入源码 Git 仓库；
- 不在笔记中保存密码、Cookie、Token 或完整银行账号；
- 未脱敏真实文件不得上传到未经批准的 AI；
- `acceptance` 数据在最终验收前不得用于调 Prompt、规则或代码；
- 一张数据卡片必须有唯一 `case_id` 和文件 hash。

---

## Task 1：创建数据根目录

- [ ] 👤 打开 PowerShell，创建目录：

```powershell
New-Item -ItemType Directory -Force -Path 'D:\code\agent-learn\agent\FlowmateData\vault'
New-Item -ItemType Directory -Force -Path 'D:\code\agent-learn\agent\FlowmateData\files\raw'
New-Item -ItemType Directory -Force -Path 'D:\code\agent-learn\agent\FlowmateData\files\sanitized'
New-Item -ItemType Directory -Force -Path 'D:\code\agent-learn\agent\FlowmateData\labels'
New-Item -ItemType Directory -Force -Path 'D:\code\agent-learn\agent\FlowmateData\manifests'
New-Item -ItemType Directory -Force -Path 'D:\code\agent-learn\agent\FlowmateData\releases'
New-Item -ItemType Directory -Force -Path 'D:\code\agent-learn\agent\FlowmateData\backups'
Get-ChildItem -LiteralPath 'D:\code\agent-learn\agent\FlowmateData'
```

期望看到 `vault`、`files`、`labels`、`manifests`、`releases`、`backups`。

- [ ] 👤 确认 `D:` 已启用 BitLocker 或等效磁盘加密。
- [ ] ⛔ 如果磁盘未加密，不导入真实数据。

## Task 2：创建 Obsidian Vault

- [ ] 👤 打开 Obsidian。
- [ ] 选择“打开文件夹作为仓库”。
- [ ] 选择 `D:\code\agent-learn\agent\FlowmateData\vault`。
- [ ] 在设置的 Core plugins 中启用 `Properties view`、`Templates` 和 `Bases`。

在 Vault 内创建：

```text
00_Dashboard/
01_DataSources/
02_InvoiceCases/
03_BusinessRules/
04_SystemAccess/
05_DatasetReleases/
06_Incidents/
90_Templates/
99_Archive/
```

正确结果：Obsidian 左侧文件树显示以上九个目录。

## Task 3：创建发票案例模板

在 `90_Templates/InvoiceCase.md` 保存：

```markdown
---
case_id: INV-000001
title: 示例发票案例
data_owner: finance-ap
source_id: SOURCE-FINANCE-001
file_type: pdf
privacy_level: sanitized
authorization_status: approved_for_development
label_status: not_started
business_review_status: not_reviewed
scenario:
  - normal
dataset_split: unassigned
dataset_version: unassigned
raw_file_ref: files/raw/INV-000001.pdf
sanitized_file_ref: files/sanitized/INV-000001.pdf
expected_json_ref: labels/INV-000001.expected.json
sha256: ""
created_date: 2026-08-25
updated_date: 2026-08-25
---

# 案例摘要

描述这张发票为什么被收录，不复制完整敏感字段。

## 人工处理结果

记录业务人员最终如何处理，以及对应外部业务记录 ID 的脱敏引用。

## 异常与规则

记录涉及的异常分类和业务规则链接。

## 复核记录

记录复核日期、复核角色和结论，不记录个人密码或账号。
```

`INV-000001` 只是模板示例。正式创建案例时，Case ID 必须递增且不可复用。

## Task 4：创建数据来源模板

在 `90_Templates/DataSource.md` 保存：

```markdown
---
source_id: SOURCE-FINANCE-001
name: 财务历史发票导出
system: 财务发票系统
data_owner_role: 财务AP负责人
access_method: approved_export
contains_personal_data: true
contains_credentials: false
authorization_status: requested
retention_policy: encrypted_storage
last_received_date: 2026-08-25
---

# 可提供的数据

- 发票原文件
- 人工录入结果
- 最终业务状态

# 获取流程

记录申请人、审批方式、交付渠道和允许用途。

# 禁止事项

- 不通过个人聊天工具传输未加密真实文件
- 不上传到未批准的在线服务
- 不把原始文件提交到 Git
```

## Task 5：建立真实数据总清单

在 `00_Dashboard/真实数据总清单.md` 建立以下表格：

| 数据资产 | 来源角色 | 开发所需 | Shadow 所需 | 生产所需 | 当前状态 |
|---|---|---:|---:|---:|---|
| 发票 PDF/OFD/图片/XML | 财务 AP | 是 | 是 | 是 | 未申请 |
| 人工正确字段 | 财务 AP | 是 | 是 | 是 | 未申请 |
| 供应商主数据 | ERP/采购 | 样例 | 是 | 是 | 未申请 |
| PO/PO 行/收货/合同 | ERP/采购 | 样例 | 是 | 是 | 未申请 |
| 历史人工录入结果 | 财务/B2B | 是 | 是 | 是 | 未申请 |
| 历史异常案例 | 财务业务员 | 是 | 是 | 是 | 未申请 |
| 业务规则与 SOP | 业务 Owner | 是 | 是 | 是 | 未申请 |
| 07B2B 测试环境 | B2B Owner | 否 | 否 | 否 | 未申请 |
| 07B2B 生产环境 | B2B Owner | 否 | 只读 | 是 | 未申请 |
| 测试账号 | B2B 管理员 | 否 | 否 | 否 | 未申请 |
| 机器人生产账号 | IAM/安全 | 否 | 只读 | 是 | 未申请 |
| OCR 服务与凭证 | IT/采购 | 是 | 是 | 是 | 未申请 |
| 发票验真 | 财税平台负责人 | 可选 | 是 | 是 | 未申请 |
| ERP 回写 | ERP 团队 | Mock | 测试 | 是 | 未申请 |
| 审计存储和监控 | IT | 本地 | 是 | 是 | 未申请 |

每项状态只能使用：`未申请`、`申请中`、`已取得样例`、`已授权开发`、`已授权测试`、`已授权生产`、`已失效`。

## Task 6：创建 Bases 看板

- [ ] 👤 在 Obsidian 中选择“Create new base”。
- [ ] 数据源选择 `02_InvoiceCases`。
- [ ] 创建表格视图 `全部案例`。
- [ ] 显示 `case_id`、`file_type`、`label_status`、`scenario`、`dataset_split`、`dataset_version`、`business_review_status`。
- [ ] 创建过滤视图 `等待标注`：`label_status != complete`。
- [ ] 创建过滤视图 `等待业务复核`：`business_review_status != approved`。
- [ ] 创建过滤视图 `最终验收集`：`dataset_split == acceptance`。

正确结果：你可以在 Bases 中筛选案例，但原始 PDF 不会被复制进 Markdown。

## Task 7：建立备份并恢复验证

- [ ] 👤 关闭 Obsidian。
- [ ] 将空结构复制到加密备份目录：

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath 'D:\code\agent-learn\agent\FlowmateData\vault' -Destination "D:\code\agent-learn\agent\FlowmateData\backups\vault-$stamp" -Recurse
Get-ChildItem -LiteralPath 'D:\code\agent-learn\agent\FlowmateData\backups'
```

- [ ] 👤 用 Obsidian 临时打开备份目录，确认模板和 Dashboard 可见。
- [ ] 关闭备份 Vault，重新打开正式 Vault。

## DATA-01 退出条件

```text
[ ] 数据目录位于加密磁盘
[ ] Vault 不在源码仓库内
[ ] 发票案例模板可用
[ ] 数据来源模板可用
[ ] 真实数据总清单已创建
[ ] Bases 可以看到案例属性
[ ] 备份已恢复验证
[ ] Vault 中不存在密码、Token、Cookie
```

全部通过后进入 [DATA-02](DATA-02_真实数据采集脱敏与标注教程.md)。
