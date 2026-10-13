# 本地处理任务约束

Author: Codex, Flowmate evaluation task author.
Origin: synthetic local user requirements, not public observations or official policy.

本次仅设计处理方案并保存研究报告，不下载或运行实际影像处理。
对象：Landsat Collection 2 Level-2地表反射率，两条反射率波段和一条配套QA波段。
合成容量模型：每条波段为6000×6000像元，每个输入像元为uint16（2字节），两条反射率输出均为float32（4字节）。
可用于同时存活像元数组的内存上限为256 MiB，工作磁盘上限为1 GiB；1 MiB=1048576字节，1 GiB=1073741824字节。
要求保留输入原值、来源、QA及处理记录；输出明确单位，不把填充值当有效观测。
希望15分钟内完成，但没有给出网络、磁盘或CPU吞吐实测。
只依据给定公开资料说明可用下载选项与转换规则；缺少的QA位定义或吞吐依据应列为待补材料。
