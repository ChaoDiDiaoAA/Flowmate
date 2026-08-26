# DATA-03 数据集校验与版本发布教程

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 把已授权、已标注、已复核的数据冻结成不可静默修改的版本，供回归、Shadow 和最终验收使用。

**Architecture:** 发布工具从 Obsidian 卡片和 JSON 标注生成 manifest；文件通过 SHA-256 锁定；开发、回归、验收三种 split 隔离；发布目录只读。

**Tech Stack:** TypeScript、Zod、Vitest、JSON、SHA-256、Obsidian。

**Spec:** [项目总导航](00_从这里开始_项目总导航.md)

## Global Constraints

- 发布版本不可原地修改；
- 修改任何文件或标签都发布新版本；
- 最终验收集不能用于开发和调参；
- Split 以供应商、月份、票种和异常分布分层，避免只随机切分相似文件；
- Manifest 不包含密码和不必要的敏感原值。

---

## Task 1：实现统一数据 Schema

由 AI 在 `packages/data-tools/src/schema.ts` 定义并导出：

```ts
export interface DatasetCaseManifest {
  caseId: string;
  fileType: "pdf" | "ofd" | "png" | "jpg" | "xml";
  sanitizedFileRef: string;
  expectedJsonRef: string;
  sha256: string;
  scenarios: string[];
  split: "development" | "regression" | "acceptance";
  authorizationStatus: "approved_for_development" | "approved_for_test" | "approved_for_production";
  businessReviewStatus: "approved";
}

export interface DatasetManifest {
  schemaVersion: "1.0";
  datasetVersion: string;
  createdAt: string;
  cases: DatasetCaseManifest[];
}
```

测试必须覆盖：缺少 hash、非法 split、未业务复核和未授权案例均被拒绝。

## Task 2：实现全量校验命令

根目录命令固定为：

```powershell
npm run data:validate -- --vault 'D:\code\agent-learn\agent\Flowmate\FlowmateData\vault' --data-root 'D:\code\agent-learn\agent\Flowmate\FlowmateData'
```

必须检查：

- Case ID 唯一；
- 文件存在；
- 当前 hash 与卡片一致；
- JSON Schema 正确；
- 金额关系正确；
- 业务复核为 approved；
- 授权状态符合目标用途；
- 文件没有出现在项目 Git 中；
- 案例具有场景分类；
- split 值合法。

正确结果示例：

```text
Validated cases: 500
Errors: 0
Warnings: 0
```

出现 Error 时禁止发布。Warning 必须逐条人工确认并在发布说明中记录。

## Task 3：划分数据集

推荐初始比例：

```text
development：60%
regression：20%
acceptance：20%
```

不是简单随机抽取。必须检查三组都覆盖：

- 主要供应商；
- 主要文件类型；
- 正常与异常；
- 月初、月中、月末；
- 金额区间；
- 主要票种；
- OCR 质量区间。

同一张发票的不同副本、同一业务记录的重复导出不能跨 split。

## Task 4：实现发布命令

命令固定为：

```powershell
npm run data:release -- --version dataset-v0.1 --vault 'D:\code\agent-learn\agent\Flowmate\FlowmateData\vault' --data-root 'D:\code\agent-learn\agent\Flowmate\FlowmateData'
```

输出目录：

```text
D:\code\agent-learn\agent\Flowmate\FlowmateData\releases\dataset-v0.1\
├─ manifest.json
├─ release-notes.md
├─ development.json
├─ regression.json
├─ acceptance.json
└─ checksums.sha256
```

发布工具不得复制未脱敏原始文件。Manifest 通过受控路径引用脱敏文件和标签。

## Task 5：发布说明

`release-notes.md` 必须记录：

```markdown
# dataset-v0.1

- 发布日期：2026-08-25
- 案例总数：500
- Development：300
- Regression：100
- Acceptance：100
- 数据来源类别：财务历史、B2B 历史、异常案例
- 文件类型分布：PDF/OFD/图片/XML
- 正常与异常分布：按 manifest 统计
- 已知偏差：记录未覆盖的真实场景
- 授权用途：开发、回归、受控验收
- 校验命令及结果：Errors 0
- 发布人：单人开发者
- 业务确认角色：财务 AP Owner
```

数字是格式示例。正式发布时必须由工具读取 manifest 生成真实统计，不可手工猜测。

## Task 6：冻结验收集

- [ ] 👤 把发布目录设置为只读。
- [ ] 👤 为 `acceptance.json` 计算额外 hash 并记录在发布说明。
- [ ] 👤 在 Obsidian 的 `05_DatasetReleases` 创建发布卡片。
- [ ] 👤 开发过程只加载 development 和 regression。
- [ ] 👤 最终验收运行前才由独立命令选择 acceptance。

如果没有第二名开发者，至少让业务 Owner 保管验收 manifest 的 hash，并在正式验收前确认未变化。

## Task 7：版本升级规则

出现以下任一变化必须发布新版本：

- 新增或删除案例；
- 修改 expected.json；
- 修改场景分类；
- 修改 split；
- 替换脱敏文件；
- 修改授权用途；
- 修正业务复核结论。

版本规则：

```text
dataset-v0.x：开发阶段
dataset-v1.0：首次生产验收基线
dataset-v1.x：兼容性新增和纠错
dataset-v2.0：Schema 或业务范围重大变化
```

## DATA-03 退出条件

```text
[ ] Schema 有自动测试
[ ] 全量校验 Errors = 0
[ ] development/regression/acceptance 已隔离
[ ] 没有重复业务案例跨 split
[ ] dataset 版本已发布
[ ] manifest 和 checksums 已生成
[ ] acceptance 已冻结
[ ] 发布说明来自真实统计
[ ] 业务 Owner 已确认数据代表性和允许用途
```

DATA-03 完成后，阶段 D、E、F 只能引用明确的数据集版本，不再使用“当前文件夹里的数据”这种不稳定输入。
