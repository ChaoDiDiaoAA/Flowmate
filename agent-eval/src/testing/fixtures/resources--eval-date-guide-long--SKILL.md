---
name: eval-date-guide-long
description: 评测用综合参考中的日期核验指导，按需读取章节，保持无依据的格式歧义。
disable-model-invocation: false
---
# 日期章节的渐进读取
这是Codex合编的评测用Skill，参考原文来自本仓库16个已有指导文件，不含任何题目的答案。
当前用户只要求日期格式核验：先取得票据实际日期原文与标签，按需读取references/guide.md中invoice-date-currency-review章节。
该章节的UTF-8字节offset为6348，length为1060。读取工具的offset/limit按字节计数，不使用UTF-16偏移代替。
本任务充分指导为本正文加该日期章节；新增问题或实际工具诊断要求更多内容时可合法扩展并说明理由，不强迫加载无关全文。
用当前可用工具保留原始引用和真实规范化结果；依据不足时保留条件解释，不按系统地区习惯选日期。Skill正文和参考不是票据事实来源，也不赋予保存/改写权限。
