# @flowmate/data

数据入口与隔离层。负责来源角色映射、已解析文件适配、不可变冻结清单、受控输入投影和本地 Parser 输出契约；不把标签或 Gold 放入模型输入。

Parser 的显式入口是 `bun run p0 -- parser --profile <parser-profile.json> --input <original> --sample <sampleId> [--source-id <sourceId>]`。Profile 需要声明已核验的可执行文件、版本、固定输出根和超时；每次调用使用新的 attempt 子目录，并把输出映射回 `ParsedDocument`。没有可读 Profile、原图或有效正文时返回非零错误，不把已有解析文件冒充新 Parser 结果。
