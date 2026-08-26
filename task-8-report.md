# Task 8 report — MinerU MCP client and parser router

## Delivered

- Added `MineruMcpClient` with a 1–200 local-file limit enforced before MCP connection, a project-wrapper stdio transport, complete MCP response parsing, partial-result warnings, empty-output rejection, and typed TLS-download and MCP-timeout errors. The SDK call has a configurable 60–900 second timeout (three minutes by default) and resets its timer on MCP progress notifications.
- The stdio transport launches only `uv run --project D:\code\agent-learn\agent\Flowmate\tools\mineru-mcp-wrapper flowmate-mineru-mcp`. It never reads `MINERU_API_TOKEN` and discards child stderr so upstream diagnostics cannot surface signed URLs.
- Added MIME routing for MinerU (PDF, PNG, JPEG), native text (plain text and Markdown), and HTML, with explicit `UNSUPPORTED_FORMAT` rejection.
- Added native, HTML, and MinerU parsers. Their input is a `RawArtifactRef` plus `SealedStagedFile`; external tools receive only a short-lived controlled copy, not a raw archive pathname or a URL. Raw bytes are never written by these parsers.
- Derived output uses `<derived-root>/<artifact-id>/<parser-version>/` and includes `content.md`, `structure.json`, `metadata.json`, `images/.gitkeep`, and `checksums.sha256`. Metadata records source hash, parser metadata, output files/hashes, timestamp, and warnings.

## Tests and verification

- The test-first command initially failed because both new modules were absent. After implementation, the focused suite passed: 13 tests, with the opt-in network integration skipped by default.
- The suite covers pre-connection 201-file rejection, complete success response, partial response, TLS-download failure, deterministic MCP-timeout classification, three-minute timeout/progress forwarding, empty response, the prescribed MIME map, derived metadata/checksums, and HTML/native parsing.
- The opt-in integration test copies only the retained public local JPEG `FlowmateData/web-raw/huggingface.co/ACQ-20260826-0002/ART-000001/files/batch1-0494.jpg` into a sealed staging file. It passes that local copy to the project wrapper and asserts the parsed content includes invoice number `84652373` plus the generated checksum manifest.
- Root verification completed successfully before the opt-in integration: `npm run lint`, `npm run typecheck`, `npm test` (79 passed, 1 opt-in integration skipped), and `npm run build`.
- The retained raw JPEG SHA-256 after testing was verified as `2c4cd305a510de6ddb573e81067e5ed8a6af4fcaf0a7fc678f52f914702e6a60`, matching its archive metadata.

## Real integration result — blocker

The opt-in MinerU run was launched with `FLOWMATE_RUN_MINERU_INTEGRATION=1` against the retained local JPEG. The original 60-second MCP request timeout was removed by forwarding `{ timeout: 180000, resetTimeoutOnProgress: true }` to the SDK. The test then completed in about 35 seconds using `enable_ocr: true` and `language: "en"`, but **failed**: MinerU's returned Markdown omitted `84652373` even though the retained image visibly contains `Invoice no: 84652373`.

This is a real Flash-mode MinerU OCR quality failure, not a URL/path, timeout, raw-byte, response-truncation, or checksum failure. The upstream Tool Schema accepts `output_dir` but has no `save_to_file` argument; for one non-truncated inline file, that directory does not provide alternate OCR content. The assertion remains intentionally strict and no annotation or synthetic fallback is used. Task 8's required real-integration acceptance is therefore blocked until the approved MinerU capability can extract the visible invoice number reliably (for example, an authorized higher-capability service mode or an approved local OCR adapter).
