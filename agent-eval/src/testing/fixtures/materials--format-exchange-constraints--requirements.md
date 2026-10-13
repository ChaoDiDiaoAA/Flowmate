# Local data exchange constraints

Author: Codex. Synthetic task requirements; not observed data or institutional guidance.

比较RFC 4180描述的CSV与RFC 8259描述的JSON，用于两套独立系统的网络交换。必须原样表达Unicode客户名、保留前后空格的备注、带逗号/引号/换行的备注，以及每张发票的可变长明细数组、数值金额与显式缺失null。接收方未约定CSV的自定义平铺、类型或缺失值协议；允许建议补充协议，但不得说基础CSV自带JSON式类型/嵌套。金额要求十进制精确，实际解析器数值范围/精度未提供；只出比较报告，不实现或执行解析器。
