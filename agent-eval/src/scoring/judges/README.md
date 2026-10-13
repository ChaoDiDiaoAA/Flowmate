# 独立 Judge

仅从评测 configs/.env 读取独立模型与凭据。OpenAI-compatible 不发送输出 Token 或温度参数；Anthropic 的必填输出字段采用 Models API 声明的原生能力，DeepSeek 使用官方 /models 元数据及 /anthropic/v1/messages 路径。无隐藏额度、自动重试或校准总预算，超时和实际用量照实记录。

每 Trial 最多一次生成请求，输出普通 JSON r／f 及适用的 research atoms／links／chains。没有事实、失败明细、引用、链或原文位置的固定输出配额；保留实际分母、范围、来源及计数校验，研究比例由本地推导。

完成原因、结构错误、截断、缺证据与注入均检查。旧 packed.ts 只保留历史报告的定宽解码和 Prompt 身份，不用于新生成；旧报告不补造新分数。数据校验、Judge off 和本地结果上传不调用评分模型。
