# Task 8 review report

## Code-review corrections

- Per-result `RESULT_DOWNLOAD_TLS_FAILED` errors now raise `MineruResultDownloadTlsError`, even when another file succeeded.
- Warning and error text from MCP results is redacted before it can be persisted in `metadata.json` or returned in `ParsedDocument`. Regression coverage includes signed URL query parameters, Bearer credentials, and API keys.
- Parser-controlled temporary copies now reduce `SealedStagedFile.fileName` to a basename and verify containment, preventing traversal-like filenames from escaping the temporary work directory.
- The MinerU request timeout is explicit (three minutes by default, configurable from one to fifteen minutes) and resets on MCP progress. SDK request timeouts map to retryable `PARSER_UNAVAILABLE`.

## Real local JPEG acceptance

The retained public raw JPEG was sent only as a sealed local staging copy to the project wrapper. The strict invoice-number assertion was run for official wrapper defaults, `ch + enable_ocr`, `en + enable_ocr`, and `latin + enable_ocr`. All four returned parsed Markdown without `84652373`.

The image visibly contains `Invoice no: 84652373`. `output_dir` is supported but cannot alter a non-truncated single-file inline response; the Tool Schema has no `save_to_file` request parameter. No annotation, manual OCR text, or synthetic fallback was used.

Result: the code-review findings are fixed and covered by tests, but real MinerU acceptance remains a P1 OCR-quality blocker. It must not be reported as passed until an approved MinerU mode or approved local parser extracts the visible invoice number.
