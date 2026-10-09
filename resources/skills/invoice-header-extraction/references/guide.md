# 头字段判定

常见头字段为 invoiceNumber、issueDate、sellerName、sellerTaxId、buyerName、buyerTaxId、currency、netAmount、taxAmount、totalAmount，具体以当前工具 schema 为准。

- present 保留非空 raw 和真实来源；normalized 可以在规范化尚未解决时为 null。
- 号码、税号等身份字段保留前导零及标点。标签关系和证据决定归属，不能从常见格式推定某个主体。
- 日期存在多种解释时保留原文并标明歧义；不能用当前日期补全。
- 币种以材料明示或工具核验结果为准；货币符号有多种含义时保持待确认。
- 未取得字段用 missing，已有区域无法辨认用 unreadable；不适用须说明对应字段的具体依据。
- ambiguous 至少需要两个有证据的替代值；保留替代值和出处，无法建立两个依据时保持缺失或无法辨认。
- 非 present 的 normalized 为 null；missing/not_applicable 的 alternatives 为空。
