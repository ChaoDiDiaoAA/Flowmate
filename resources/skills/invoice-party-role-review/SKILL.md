---
name: invoice-party-role-review
description: Review buyer and seller names and tax IDs against labeled invoice evidence.
disable-model-invocation: false
---
# 发票买卖方归属复核

适用于购销方名称、税号的归属不明确或候选可能把其他主体写入买卖方字段的任务。只使用当前 Run 冻结材料。

1. 用 search_invoice_document 定位购买方、销售方及其对应标签，依据真实分页游标继续读取；搜索预览不能代替完整证据。
2. 用 read_invoice_evidence 取得相关块和完整来源。在跨栏、多个名称或签章位置造成歧义时，按需读取 references/guide.md。
3. 分别核对 buyerName、buyerTaxId、sellerName、sellerTaxId，区分原值、明确的标签归属及替代解释；号码保持原文，不按常见格式补齐。
4. 用 check_invoice_sources 核验将要引用的块。保留无效引用诊断，不把引用通过当作主体已通过外部认证。
5. 输出角色/字段、原文、来源、判断及待确认项。每个目标字段都有证据或明确缺口后结束；证据不能区分角色时保留 ambiguous，不自动选主体，不保存或接受候选。

参考文件先通过 list_skill_resources({skill:"invoice-party-role-review"}) 确认，再调用 read_skill_resource({skill:"invoice-party-role-review",path:"references/guide.md"})；有 nextOffset 时继续对应页。Skill 文档是判断指导，不是业务来源。
