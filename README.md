# Flowmate

Flowmate is a digital-employee platform. This repository is currently at **P0: the Obsidian data workbench** stage. P0 establishes a traceable, deduplicated, recoverable dataset workflow before product-runtime engineering begins.

## P0 boundary

P0 is responsible for acquisition receipts, approved public-source collection, immutable raw artifacts, parser-derived content, deduplication, privacy/licence/quality gates, quarantine and failure evidence, Obsidian metadata, and versioned `DatasetManifest` releases. It is not the Flowmate runtime: no Electron app, Pi SDK/kernel, enterprise adapter, production SQLite, scheduled crawler, unattended bulk crawl, or production business-agent behavior is built here.

The only formal seam to the later runtime is the `DatasetManifest` interface: stable IDs, file paths/references, SHA-256 hashes, schema/version metadata, and release status. The runtime must not depend on Obsidian, OpenCLI, MinerU, or a particular website adapter being available.

## Start here

1. Read the target design: [`docs/07b2b/specs/P0_Obsidian数据库目标方案.md`](docs/07b2b/specs/P0_Obsidian数据库目标方案.md).
2. Read the implementation plan: [`docs/07b2b/plans/P0_Obsidian数据库实施计划.md`](docs/07b2b/plans/P0_Obsidian数据库实施计划.md).
3. Review the MinerU spike evidence and wrapper documentation before parser work.
4. Follow [`docs/07b2b/README.md`](docs/07b2b/README.md) for the documentation map.

## Commands

The repository uses npm workspaces. Run `npm install`, then the documented root scripts (`npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`). The MinerU wrapper is a separate Python project under `tools/mineru-mcp-wrapper`; run its tests from that directory with `pytest` and use its README for the launcher command.

## Security and data handling

Never commit tokens, cookies, passwords, API keys, private keys, real enterprise data, or network raw data. The working data root is `D:\code\agent-learn\agent\Flowmate\FlowmateData`; it lives under the project directory but is protected by `.gitignore` and must never be staged. `.env.example` may document variable names but must contain placeholders only. The project-level MinerU wrapper is required for P0; do not upload private data to MinerU cloud unless the owner and security policy explicitly allow it.

## Stop conditions

Stop and record evidence when an approved public adapter is unavailable, a source requires login/cookies/UI interception, licensing or privacy is unclear, a parser is unavailable, a result download fails TLS, a batch exceeds its configured limit, hashes/IDs are missing, or a gate cannot prove quality. Quarantine or delete disallowed content according to the P0 spec; never silently downgrade safeguards or overwrite raw artifacts.

## Next step

After this baseline, continue with the approved P0 implementation plan. Do not start P1 product-runtime scaffolding until P0 acceptance and a versioned Dataset Manifest release are complete.
