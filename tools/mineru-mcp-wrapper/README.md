# Flowmate MinerU MCP Wrapper

This local wrapper keeps the upstream MinerU MCP tool surface and adds two Windows safeguards:

1. `parse_documents.file_sources` has a hard maximum of 200 items per MCP call.
2. MinerU result artifacts are downloaded with Windows `curl.exe`/Schannel instead of Python/OpenSSL.

The wrapper pins:

- `mineru-open-mcp==1.0.21`
- `mineru-open-sdk==0.2.5` through the upstream dependency lock

## Security

MinerU uploads provided files or URLs to `mineru.net` for processing. Do not submit enterprise or personal data unless its data owner and security policy explicitly allow that transfer.

Signed result URLs and API tokens must not be written to logs. Curl is invoked with an argument array and `shell=False`.

## Batch limit

The default and hard ceiling is 200 files per MCP call:

```text
FLOWMATE_MINERU_MAX_FILES_PER_RUN=200
```

The configured value may be lowered to 1–199. Values above 200 are rejected at startup. More than 200 files must be represented as separate, explicitly tracked acquisition batches.

## Test

```powershell
uv run --group dev pytest -q
```

## Start

```powershell
uv run flowmate-mineru-mcp --output-dir D:\code\agent-learn\agent\Flowmate\FlowmateData\derived\mineru
```

The process uses stdio transport by default and preserves the upstream tools:

- `parse_documents`
- `get_ocr_languages`

## Project-scoped Codex MCP command shape

Flowmate should register the wrapper in the repository's `.codex/config.toml`, not in the user's global `~/.codex/config.toml`. After verification, the project-scoped MCP entry should launch the wrapper instead of calling `uvx mineru-open-mcp` directly:

```text
command = uv
args = run --project <absolute-wrapper-path> flowmate-mineru-mcp
```

Keep `MINERU_API_TOKEN` in the MCP environment. Do not place the token in `args` or this repository.

Codex only loads project-scoped MCP configuration for trusted projects. A new Flowmate Codex session is required after creating or changing `.codex/config.toml`.
