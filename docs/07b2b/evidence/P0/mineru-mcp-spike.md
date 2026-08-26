# MinerU MCP 可用性验证证据

> 日期：2026-08-26  
> 范围：P0 实施计划前置 Spike  
> 测试数据：W3C 公开无敏感 PDF

## 原始状态

- `uvx mineru-open-mcp` 可以启动；
- MCP Server 版本：3.4.7；
- `mineru-open-mcp`：1.0.21；
- `mineru-open-sdk`：0.2.5；
- `get_ocr_languages` 成功；
- `parse_documents` 可以创建 MinerU 云任务并查询状态；
- Python/OpenSSL 从 `cdn-mineru.openxlab.org.cn` 下载结果 ZIP 时稳定出现 `SSL_UNEXPECTED_EOF_WHILE_READING`；
- Windows curl/Schannel 下载同一个公开测试结果成功。

## 根因

故障位于 `mineru-open-sdk` 使用 Python TLS 栈下载 MinerU CDN 结果的链路，不是 MCP 协议、Token、MinerU API、测试 PDF、Python 3.13 专属行为或 CA 校验错误。

## 修复

建立 `tools/mineru-mcp-wrapper`：

- 继续复用上游 MinerU MCP；
- 结果 ZIP 和 Flash 文本下载改用 Windows `curl.exe`；
- 不调用 shell；
- 错误和超时不输出签名 URL；
- Tool Schema 强制 `file_sources.maxItems = 200`；
- 运行时再次防御 201 份或更多文件；
- 不修改 uv 缓存中的第三方包。

## 自动测试

```text
8 passed
```

覆盖：

- 200 份文件允许；
- 201 份文件拒绝；
- Tool Patch 带 `maxItems=200`；
- curl 使用参数数组和 `shell=False`；
- curl 失败不泄露签名 URL；
- curl 超时不泄露签名 URL；
- launcher 在上游注册 Tool 前安装 Patch。

## 真实 MCP 验证

```text
tools/list:
parse_documents.file_sources.maxItems = 200

201-item call:
rejected by MCP input validation

W3C PDF parse:
status = success
content = Dummy PDF file
success_count = 1
error_count = 0
```

MinerU Tool 返回的原始 message：

```text
Parsing complete!
```

## 项目级配置门禁复验

> 日期：2026-08-26 16:25（Asia/Shanghai）  
> 配置：`D:\code\agent-learn\agent\Flowmate\.codex\config.toml`  
> 启动：`uv run --project D:\code\agent-learn\agent\Flowmate\tools\mineru-mcp-wrapper flowmate-mineru-mcp`  
> 输出目录：`D:\code\agent-learn\agent\Flowmate\FlowmateData\derived\mineru`

通过 MCP stdio 客户端直接启动项目配置对应的 wrapper，实测结果：

```text
tools = [get_ocr_languages, parse_documents]
parse_documents.file_sources.maxItems = 200
get_ocr_languages.status = success
W3C PDF:
status = success
content = Dummy PDF file
success_count = 1
error_count = 0
```

本次复验未读取或修改用户级 Codex 配置，也未将 Token 写入文件或输出。

## 结论

包装层和项目级 MCP 配置均已通过真实 MCP 调用验证，可作为 P0 实施计划中的 MinerU MCP 启动方式。用户级 Codex MCP 配置不修改；Flowmate 使用项目级 `.codex/config.toml` 注册包装层。
