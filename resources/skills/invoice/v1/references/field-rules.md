# 发票字段与缺失表达

头字段包含 invoiceNumber、issueDate、sellerName、buyerName、currency、totalAmount，以及 netAmount、taxAmount；具体结构和其他字段遵循当前候选工具契约。

- 模型候选中的 present 需要非空 raw 和可核验 sources。来源引用完整保留工具返回的 documentId、version、artifactId、page、blockId、quote；不猜测或拼造引用。
- normalized 尚未解决时可以保持 null，并解释真实规范化诊断。非 present 的 normalized 必须为 null。
- ambiguous 表示至少两个有证据依据的替代值；alternatives 不是来源对象，不足两个依据时使用 missing 或 unreadable 说明情况。
- missing 表示没有取得字段；unreadable 表示已有资料无法辨认。两者都不能替换成零、空字符串或推测值。
- missing 和 not_applicable 不得附 alternatives。not_applicable 需要在 notes 中写出包含对应字段名称的具体原因。
- 金额和日期使用当前 normalize_invoice_values 处理，sources 通过 check_invoice_sources 核验，候选通过 validate_invoice_candidate 检查。saveable=true 只表示验证结果；保存、接受和表单应用遵循各自真实工具回执。

这些规则用于指导读取和表达。实际结构、来源及数值检查由现有业务代码执行，资源内容不增加工具权限或业务执行资格。
